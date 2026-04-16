#!/usr/bin/env npx ts-node
// Harness: on-demand knowledge -- discover skills cheaply, load them only when needed.
/**
 * s05_skill_loading.ts - Skills
 *
 * This chapter teaches a two-layer skill model:
 *
 * 1. Put a cheap skill catalog in the system prompt.
 * 2. Load the full skill body only when the model asks for it.
 *
 * That keeps the prompt small while still giving the model access to reusable,
 * task-specific guidance.
 */

import Anthropic from "@anthropic-ai/sdk";
import * as readline from "readline";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import "dotenv/config";

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID!;
const SKILLS_DIR = path.join(WORKDIR, "skills");

interface SkillManifest {
  name: string;
  description: string;
  filePath: string;
}

interface SkillDocument {
  manifest: SkillManifest;
  body: string;
}

class SkillRegistry {
  private documents: Map<string, SkillDocument> = new Map();

  constructor(private skillsDir: string) {
    this._loadAll();
  }

  private _loadAll(): void {
    if (!fs.existsSync(this.skillsDir)) return;
    this._findSkillFiles(this.skillsDir).sort().forEach((filePath) => {
      const text = fs.readFileSync(filePath, "utf-8");
      const { meta, body } = this._parseFrontmatter(text);
      const name = meta.name ?? path.basename(path.dirname(filePath));
      const description = meta.description ?? "No description";
      const manifest: SkillManifest = { name, description, filePath };
      this.documents.set(name, { manifest, body: body.trim() });
    });
  }

  private _findSkillFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) results.push(...this._findSkillFiles(full));
      else if (entry.name === "SKILL.md") results.push(full);
    }
    return results;
  }

  private _parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
    const match = text.match(/^---\n(.*?)\n---\n(.*)/s);
    if (!match) return { meta: {}, body: text };
    const meta: Record<string, string> = {};
    for (const line of match[1].trim().split("\n")) {
      const idx = line.indexOf(":");
      if (idx >= 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return { meta, body: match[2] };
  }

  describeAvailable(): string {
    if (!this.documents.size) return "(no skills available)";
    return [...this.documents.keys()]
      .sort()
      .map((name) => `- ${name}: ${this.documents.get(name)!.manifest.description}`)
      .join("\n");
  }

  loadFullText(name: string): string {
    const doc = this.documents.get(name);
    if (!doc) {
      const known = [...this.documents.keys()].sort().join(", ") || "(none)";
      return `Error: Unknown skill '${name}'. Available skills: ${known}`;
    }
    return `<skill name="${doc.manifest.name}">\n${doc.body}\n</skill>`;
  }
}

const SKILL_REGISTRY = new SkillRegistry(SKILLS_DIR);

const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use load_skill when a task needs specialized instructions before you act.

Skills available:
${SKILL_REGISTRY.describeAvailable()}
`;

function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR + path.sep) && resolved !== WORKDIR)
    throw new Error(`Path escapes workspace: ${p}`);
  return resolved;
}

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) return "Error: Dangerous command blocked";
  try {
    const out = execSync(command, { cwd: WORKDIR, timeout: 120000, encoding: "utf-8", stdio: ["pipe","pipe","pipe"] });
    return out.trim().slice(0, 50000) || "(no output)";
  } catch (e: any) {
    if (e.signal === "SIGTERM") return "Error: Timeout (120s)";
    return (((e.stdout || "") + (e.stderr || "")).trim()).slice(0, 50000) || `Error: ${e.message}`;
  }
}

function runRead(p: string, limit?: number): string {
  try {
    const lines = fs.readFileSync(safePath(p), "utf-8").split("\n");
    const result = limit && limit < lines.length ? [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`] : lines;
    return result.join("\n").slice(0, 50000);
  } catch (e: any) { return `Error: ${e.message}`; }
}

function runWrite(p: string, content: string): string {
  try {
    const fp = safePath(p);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf-8");
    return `Wrote ${content.length} bytes to ${p}`;
  } catch (e: any) { return `Error: ${e.message}`; }
}

function runEdit(p: string, oldText: string, newText: string): string {
  try {
    const fp = safePath(p);
    const content = fs.readFileSync(fp, "utf-8");
    if (!content.includes(oldText)) return `Error: Text not found in ${p}`;
    fs.writeFileSync(fp, content.replace(oldText, newText), "utf-8");
    return `Edited ${p}`;
  } catch (e: any) { return `Error: ${e.message}`; }
}

const TOOL_HANDLERS: Record<string, (kw: Record<string, any>) => string> = {
  bash:       (kw) => runBash(kw.command),
  read_file:  (kw) => runRead(kw.path, kw.limit),
  write_file: (kw) => runWrite(kw.path, kw.content),
  edit_file:  (kw) => runEdit(kw.path, kw.old_text, kw.new_text),
  load_skill: (kw) => SKILL_REGISTRY.loadFullText(kw.name),
};

const TOOLS: Anthropic.Tool[] = [
  { name: "bash", description: "Run a shell command.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.",
    input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to a file.",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in a file once.",
    input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "load_skill", description: "Load the full body of a named skill into the current context.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
];

function extractText(content: Anthropic.ContentBlock[] | string): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL, system: SYSTEM, messages, tools: TOOLS, max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const handler = TOOL_HANDLERS[block.name];
      let output: string;
      try {
        output = handler ? handler(block.input as Record<string, any>) : `Unknown tool: ${block.name}`;
      } catch (e: any) { output = `Error: ${e.message}`; }
      console.log(`> ${block.name}: ${String(output).slice(0, 200)}`);
      results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
    }
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "\x1b[36ms05 >> \x1b[0m" });
  const history: Anthropic.MessageParam[] = [];
  rl.prompt();
  rl.on("line", async (query) => {
    rl.pause();
    if (!query.trim() || ["q", "exit"].includes(query.trim().toLowerCase())) { rl.close(); return; }
    history.push({ role: "user", content: query });
    await agentLoop(history);
    const last = history[history.length - 1];
    const finalText = extractText(last.content as Anthropic.ContentBlock[]);
    if (finalText) console.log(finalText);
    console.log();
    rl.resume(); rl.prompt();
  });
  rl.on("close", () => process.exit(0));
}

main().catch(console.error);
