#!/usr/bin/env npx ts-node
// Harness: assembly -- the system prompt is a pipeline, not a string.
/**
 * s10_system_prompt.ts - System Prompt Construction
 *
 * This chapter teaches one core idea:
 * the system prompt should be assembled from clear sections, not written as one
 * giant hardcoded blob.
 *
 * Teaching pipeline:
 *   1. core instructions
 *   2. tool listing
 *   3. skill metadata
 *   4. memory section
 *   5. CLAUDE.md chain
 *   6. dynamic context
 *
 * Key insight: "Prompt construction is a pipeline with boundaries, not one
 * big string."
 */

import Anthropic from "@anthropic-ai/sdk";
import * as readline from "readline";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import "dotenv/config";

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID!;

const DYNAMIC_BOUNDARY = "=== DYNAMIC_BOUNDARY ===";

/**
 * Assemble the system prompt from independent sections.
 *
 * The teaching goal here is clarity:
 * each section has one source and one responsibility.
 */
class SystemPromptBuilder {
  private workdir: string;
  private tools: Anthropic.Tool[];
  private skillsDir: string;
  private memoryDir: string;

  constructor(workdir: string = WORKDIR, tools: Anthropic.Tool[] = []) {
    this.workdir = workdir;
    this.tools = tools;
    this.skillsDir = path.join(workdir, "skills");
    this.memoryDir = path.join(workdir, ".memory");
  }

  // -- Section 1: Core instructions --
  private _buildCore(): string {
    return (
      `You are a coding agent operating in ${this.workdir}.\n` +
      "Use the provided tools to explore, read, write, and edit files.\n" +
      "Always verify before assuming. Prefer reading files over guessing."
    );
  }

  // -- Section 2: Tool listings --
  private _buildToolListing(): string {
    if (!this.tools.length) return "";
    const lines = ["# Available tools"];
    for (const tool of this.tools) {
      const props = (tool.input_schema as any)?.properties ?? {};
      const params = Object.keys(props).join(", ");
      lines.push(`- ${tool.name}(${params}): ${tool.description}`);
    }
    return lines.join("\n");
  }

  // -- Section 3: Skill metadata (layer 1 from s05 concept) --
  private _buildSkillListing(): string {
    if (!fs.existsSync(this.skillsDir)) return "";
    const skills: string[] = [];
    for (const entry of fs.readdirSync(this.skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(this.skillsDir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillMd)) continue;
      const text = fs.readFileSync(skillMd, "utf-8");
      const match = text.match(/^---\s*\n(.*?)\n---/s);
      if (!match) continue;
      const meta: Record<string, string> = {};
      for (const line of match[1].split("\n")) {
        const idx = line.indexOf(":");
        if (idx >= 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      const name = meta.name ?? entry.name;
      const desc = meta.description ?? "";
      skills.push(`- ${name}: ${desc}`);
    }
    if (!skills.length) return "";
    return "# Available skills\n" + skills.join("\n");
  }

  // -- Section 4: Memory content --
  private _buildMemorySection(): string {
    if (!fs.existsSync(this.memoryDir)) return "";
    const memories: string[] = [];
    for (const file of fs.readdirSync(this.memoryDir).sort()) {
      if (!file.endsWith(".md") || file === "MEMORY.md") continue;
      const text = fs.readFileSync(path.join(this.memoryDir, file), "utf-8");
      const match = text.match(/^---\s*\n(.*?)\n---\s*\n(.*)/s);
      if (!match) continue;
      const meta: Record<string, string> = {};
      for (const line of match[1].split("\n")) {
        const idx = line.indexOf(":");
        if (idx >= 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      const name = meta.name ?? path.basename(file, ".md");
      const memType = meta.type ?? "project";
      const desc = meta.description ?? "";
      const body = match[2].trim();
      memories.push(`[${memType}] ${name}: ${desc}\n${body}`);
    }
    if (!memories.length) return "";
    return "# Memories (persistent)\n\n" + memories.join("\n\n");
  }

  // -- Section 5: CLAUDE.md chain --
  /**
   * Load CLAUDE.md files in priority order (all are included):
   * 1. ~/.claude/CLAUDE.md (user-global instructions)
   * 2. <project-root>/CLAUDE.md (project instructions)
   * 3. <current-subdir>/CLAUDE.md (directory-specific instructions)
   */
  private _buildClaudeMd(): string {
    const sources: Array<[string, string]> = [];

    const userClaude = path.join(os.homedir(), ".claude", "CLAUDE.md");
    if (fs.existsSync(userClaude)) sources.push(["user global (~/.claude/CLAUDE.md)", fs.readFileSync(userClaude, "utf-8")]);

    const projectClaude = path.join(this.workdir, "CLAUDE.md");
    if (fs.existsSync(projectClaude)) sources.push(["project root (CLAUDE.md)", fs.readFileSync(projectClaude, "utf-8")]);

    const cwd = process.cwd();
    if (cwd !== this.workdir) {
      const subdirClaude = path.join(cwd, "CLAUDE.md");
      if (fs.existsSync(subdirClaude))
        sources.push([`subdir (${path.basename(cwd)}/CLAUDE.md)`, fs.readFileSync(subdirClaude, "utf-8")]);
    }

    if (!sources.length) return "";
    const parts = ["# CLAUDE.md instructions"];
    for (const [label, content] of sources) {
      parts.push(`## From ${label}`);
      parts.push(content.trim());
    }
    return parts.join("\n\n");
  }

  // -- Section 6: Dynamic context --
  private _buildDynamicContext(): string {
    const lines = [
      `Current date: ${new Date().toISOString().slice(0, 10)}`,
      `Working directory: ${this.workdir}`,
      `Model: ${MODEL}`,
      `Platform: ${os.platform()}`,
    ];
    return "# Dynamic context\n" + lines.join("\n");
  }

  // -- Assemble all sections --
  build(): string {
    /**
     * Assemble the full system prompt from all sections.
     *
     * Static sections (1-5) are separated from dynamic (6) by
     * the DYNAMIC_BOUNDARY marker. In real CC, the static prefix
     * is cached across turns to save prompt tokens.
     */
    const sections: string[] = [];

    const core = this._buildCore();
    if (core) sections.push(core);

    const tools = this._buildToolListing();
    if (tools) sections.push(tools);

    const skills = this._buildSkillListing();
    if (skills) sections.push(skills);

    const memory = this._buildMemorySection();
    if (memory) sections.push(memory);

    const claudeMd = this._buildClaudeMd();
    if (claudeMd) sections.push(claudeMd);

    sections.push(DYNAMIC_BOUNDARY);

    const dynamic = this._buildDynamicContext();
    if (dynamic) sections.push(dynamic);

    return sections.join("\n\n");
  }
}

/**
 * Build a system-reminder user message for per-turn dynamic content.
 *
 * The teaching version keeps reminders outside the stable system prompt so
 * short-lived context does not get mixed into the long-lived instructions.
 */
function buildSystemReminder(extra?: string): Anthropic.MessageParam | null {
  const parts: string[] = [];
  if (extra) parts.push(extra);
  if (!parts.length) return null;
  const content = `<system-reminder>\n${parts.join("\n")}\n</system-reminder>`;
  return { role: "user", content };
}

// -- Tool implementations --
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
    const result = limit && limit < lines.length ? [...lines.slice(0, limit), `... (${lines.length - limit} more)`] : lines;
    return result.join("\n").slice(0, 50000);
  } catch (e: any) { return `Error: ${e.message}`; }
}

function runWrite(p: string, content: string): string {
  try {
    const fp = safePath(p);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf-8");
    return `Wrote ${content.length} bytes`;
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

const TOOLS: Anthropic.Tool[] = [
  { name: "bash", description: "Run a shell command.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.",
    input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.",
    input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
];

const TOOL_HANDLERS: Record<string, (kw: Record<string, any>) => string> = {
  bash:       (kw) => runBash(kw.command),
  read_file:  (kw) => runRead(kw.path, kw.limit),
  write_file: (kw) => runWrite(kw.path, kw.content),
  edit_file:  (kw) => runEdit(kw.path, kw.old_text, kw.new_text),
};

const promptBuilder = new SystemPromptBuilder(WORKDIR, TOOLS);

/**
 * Agent loop with assembled system prompt.
 *
 * The system prompt is rebuilt each iteration. In real CC, the static
 * prefix is cached and only the dynamic suffix changes per turn.
 */
async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    const system = promptBuilder.build();
    const response = await client.messages.create({
      model: MODEL, system, messages, tools: TOOLS, max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const handler = TOOL_HANDLERS[block.name];
      let output: string;
      try {
        output = handler ? handler(block.input as Record<string, any>) : `Unknown: ${block.name}`;
      } catch (e: any) { output = `Error: ${e.message}`; }
      console.log(`> ${block.name}: ${String(output).slice(0, 200)}`);
      results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
    }
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const fullPrompt = promptBuilder.build();
  const sectionCount = (fullPrompt.match(/\n# /g) || []).length;
  console.log(`[System prompt assembled: ${fullPrompt.length} chars, ~${sectionCount} sections]`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "\x1b[36ms10 >> \x1b[0m" });
  const history: Anthropic.MessageParam[] = [];
  rl.prompt();
  rl.on("line", async (query) => {
    rl.pause();
    if (!query.trim() || ["q", "exit"].includes(query.trim().toLowerCase())) { rl.close(); return; }

    if (query.trim() === "/prompt") {
      console.log("--- System Prompt ---");
      console.log(promptBuilder.build());
      console.log("--- End ---");
      rl.resume(); rl.prompt(); return;
    }

    if (query.trim() === "/sections") {
      const prompt = promptBuilder.build();
      for (const line of prompt.split("\n")) {
        if (line.startsWith("# ") || line === DYNAMIC_BOUNDARY) console.log(`  ${line}`);
      }
      rl.resume(); rl.prompt(); return;
    }

    history.push({ role: "user", content: query });
    await agentLoop(history);
    const last = history[history.length - 1];
    if (Array.isArray(last.content)) {
      for (const b of last.content) {
        if (typeof b === "object" && b !== null && (b as any).type === "text") console.log((b as any).text);
      }
    }
    console.log();
    rl.resume(); rl.prompt();
  });
  rl.on("close", () => process.exit(0));
}

main().catch(console.error);
