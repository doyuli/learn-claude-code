#!/usr/bin/env npx ts-node
// Harness: tool dispatch -- expanding what the model can reach.
/**
 * s02_tool_use.ts - Tool dispatch + message normalization
 *
 * The agent loop from s01 didn't change. We added tools to the dispatch map,
 * and a normalizeMessages() function that cleans up the message list before
 * each API call.
 *
 * Key insight: "The loop didn't change at all. I just added tools."
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

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.`;

function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR + path.sep) && resolved !== WORKDIR) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
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
    const fp = safePath(p);
    const lines = fs.readFileSync(fp, "utf-8").split("\n");
    const result = limit && limit < lines.length
      ? [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`]
      : lines;
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

// -- Concurrency safety classification --
// Read-only tools can safely run in parallel; mutating tools must be serialized.
const CONCURRENCY_SAFE = new Set(["read_file"]);
const CONCURRENCY_UNSAFE = new Set(["write_file", "edit_file"]);

// -- The dispatch map: {tool_name: handler} --
const TOOL_HANDLERS: Record<string, (kw: Record<string, any>) => string> = {
  bash:       (kw) => runBash(kw.command),
  read_file:  (kw) => runRead(kw.path, kw.limit),
  write_file: (kw) => runWrite(kw.path, kw.content),
  edit_file:  (kw) => runEdit(kw.path, kw.old_text, kw.new_text),
};

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

function normalizeMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  /**
   * Clean up messages before sending to the API.
   *
   * Three jobs:
   * 1. Strip internal metadata fields the API doesn't understand
   * 2. Ensure every tool_use has a matching tool_result (insert placeholder if missing)
   * 3. Merge consecutive same-role messages (API requires strict alternation)
   */
  const cleaned: Anthropic.MessageParam[] = messages.map((msg) => {
    if (typeof msg.content === "string") return { role: msg.role, content: msg.content };
    if (Array.isArray(msg.content)) {
      const filteredContent = msg.content
        .filter((b): b is any => typeof b === "object" && b !== null)
        .map((b) => Object.fromEntries(Object.entries(b).filter(([k]) => !k.startsWith("_"))));
      return { role: msg.role, content: filteredContent as unknown as Anthropic.ContentBlock[] };
    }
    return { role: msg.role, content: msg.content ?? "" };
  });

  // Collect existing tool_result IDs
  const existingResults = new Set<string>();
  for (const msg of cleaned) {
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (typeof b === "object" && b !== null && (b as any).type === "tool_result") {
          existingResults.add((b as any).tool_use_id);
        }
      }
    }
  }

  // Find orphaned tool_use blocks and insert placeholder results
  for (const msg of cleaned) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (typeof b === "object" && b !== null && (b as any).type === "tool_use" && !existingResults.has((b as any).id)) {
        cleaned.push({ role: "user", content: [{ type: "tool_result", tool_use_id: (b as any).id, content: "(cancelled)" } as any] });
      }
    }
  }

  // Merge consecutive same-role messages
  if (!cleaned.length) return cleaned;
  const merged: Anthropic.MessageParam[] = [cleaned[0]];
  for (const msg of cleaned.slice(1)) {
    const prev = merged[merged.length - 1];
    if (msg.role === prev.role) {
      const prevC = Array.isArray(prev.content) ? prev.content : [{ type: "text", text: String(prev.content) }];
      const currC = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content) }];
      prev.content = [...prevC, ...currC] as Anthropic.ContentBlock[];
    } else {
      merged.push(msg);
    }
  }
  return merged;
}

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL, 
      system: SYSTEM,
      messages: normalizeMessages(messages),
      tools: TOOLS, 
      max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        const output = handler ? handler(block.input as Record<string, any>) : `Unknown tool: ${block.name}`;
        console.log(`> ${block.name}:`);
        console.log(String(output).slice(0, 200));
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
      }
    }
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "\x1b[36ms02 >> \x1b[0m" });
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
