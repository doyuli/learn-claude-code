#!/usr/bin/env npx ts-node
// Harness: context isolation -- protecting the model's clarity of thought.
/**
 * s04_subagent.ts - Subagents
 *
 * Spawn a child agent with fresh messages=[]. The child works in its own
 * context, sharing the filesystem, then returns only a summary to the parent.
 *
 *     Parent agent                     Subagent
 *     +------------------+             +------------------+
 *     | messages=[...]   |             | messages=[]      |  <- fresh
 *     |                  |  dispatch   |                  |
 *     | tool: task       | ----------> | while tool_use:  |
 *     |   prompt="..."   |            |   call tools     |
 *     |   description="" |            |   append results |
 *     |                  |  summary   |                  |
 *     |   result = "..." | <--------- | return last text |
 *     +------------------+             +------------------+
 *               |
 *     Parent context stays clean.
 *     Subagent context is discarded.
 *
 * Key insight: "Fresh messages=[] gives context isolation. The parent stays clean."
 *
 * Note: Real Claude Code also uses in-process isolation (not OS-level process
 * forking). The child runs in the same process with a fresh message array and
 * isolated tool context -- same pattern as this teaching implementation.
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

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use the task tool to delegate exploration or subtasks.`;
const SUBAGENT_SYSTEM = `You are a coding subagent at ${WORKDIR}. Complete the given task, then summarize your findings.`;

/**
 * Parse agent definition from markdown frontmatter.
 *
 * Real Claude Code loads agent definitions from .claude/agents/*.md.
 * Frontmatter fields: name, tools, disallowedTools, skills, hooks,
 * model, effort, permissionMode, maxTurns, memory, isolation, color,
 * background, initialPrompt, mcpServers.
 * 3 sources: built-in, custom (.claude/agents/), plugin-provided.
 */
class AgentTemplate {
  name: string;
  config: Record<string, string> = {};
  systemPrompt: string = "";

  constructor(private filePath: string) {
    this.name = path.basename(filePath, path.extname(filePath));
    this._parse();
  }

  private _parse(): void {
    const text = fs.readFileSync(this.filePath, "utf-8");
    const match = text.match(/^---\s*\n(.*?)\n---\s*\n(.*)/s);
    if (!match) { this.systemPrompt = text; return; }
    for (const line of match[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx >= 0) this.config[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    this.systemPrompt = match[2].trim();
    if (this.config.name) this.name = this.config.name;
  }
}

// -- Tool implementations shared by parent and child --
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

const TOOL_HANDLERS: Record<string, (kw: Record<string, any>) => string> = {
  bash:       (kw) => runBash(kw.command),
  read_file:  (kw) => runRead(kw.path, kw.limit),
  write_file: (kw) => runWrite(kw.path, kw.content),
  edit_file:  (kw) => runEdit(kw.path, kw.old_text, kw.new_text),
};

// Child gets all base tools except task (no recursive spawning)
const CHILD_TOOLS: Anthropic.Tool[] = [
  { name: "bash", description: "Run a shell command.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.",
    input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.",
    input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
];

// -- Subagent: fresh context, filtered tools, summary-only return --
async function runSubagent(prompt: string): Promise<string> {
  const subMessages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }]; // fresh context
  let response!: Anthropic.Message;
  for (let i = 0; i < 30; i++) { // safety limit
    response = await client.messages.create({
      model: MODEL, system: SUBAGENT_SYSTEM, messages: subMessages,
      tools: CHILD_TOOLS, max_tokens: 8000,
    });
    subMessages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") break;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        const output = handler ? handler(block.input as Record<string, any>) : `Unknown tool: ${block.name}`;
        results.push({ type: "tool_result", tool_use_id: block.id, content: String(output).slice(0, 50000) });
      }
    }
    subMessages.push({ role: "user", content: results });
  }
  // Only the final text returns to the parent -- child context is discarded
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("") || "(no summary)";
}

// -- Parent tools: base tools + task dispatcher --
const PARENT_TOOLS: Anthropic.Tool[] = [
  ...CHILD_TOOLS,
  { name: "task", description: "Spawn a subagent with fresh context. It shares the filesystem but not conversation history.",
    input_schema: { type: "object", properties: { prompt: { type: "string" }, description: { type: "string", description: "Short description of the task" } }, required: ["prompt"] } },
];

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL, system: SYSTEM, messages, tools: PARENT_TOOLS, max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        let output: string;
        if (block.name === "task") {
          const inp = block.input as { prompt: string; description?: string };
          const desc = inp.description ?? "subtask";
          console.log(`> task (${desc}): ${inp.prompt.slice(0, 80)}`);
          output = await runSubagent(inp.prompt);
        } else {
          const handler = TOOL_HANDLERS[block.name];
          output = handler ? handler(block.input as Record<string, any>) : `Unknown tool: ${block.name}`;
        }
        console.log(`  ${String(output).slice(0, 200)}`);
        results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
      }
    }
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "\x1b[36ms04 >> \x1b[0m" });
  const history: Anthropic.MessageParam[] = [];
  rl.prompt();
  rl.on("line", async (query) => {
    rl.pause();
    if (!query.trim() || ["q", "exit"].includes(query.trim().toLowerCase())) { rl.close(); return; }
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
