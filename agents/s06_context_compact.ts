#!/usr/bin/env npx ts-node
// Harness: compression -- keep the active context small enough to keep working.
/**
 * s06_context_compact.ts - Context Compact
 *
 * This teaching version keeps the compact model intentionally small:
 *
 * 1. Large tool output is persisted to disk and replaced with a preview marker.
 * 2. Older tool results are micro-compacted into short placeholders.
 * 3. When the whole conversation gets too large, the agent summarizes it and
 *    continues from that summary.
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

const SYSTEM =
  `You are a coding agent at ${WORKDIR}. ` +
  "Keep working step by step, and use compact if the conversation gets too long.";

const CONTEXT_LIMIT = 50000;
const KEEP_RECENT_TOOL_RESULTS = 3;
const PERSIST_THRESHOLD = 30000;
const PREVIEW_CHARS = 2000;
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const TOOL_RESULTS_DIR = path.join(WORKDIR, ".task_outputs", "tool-results");

interface CompactState {
  hasCompacted: boolean;
  lastSummary: string;
  recentFiles: string[];
}

function estimateContextSize(messages: Anthropic.MessageParam[]): number {
  return JSON.stringify(messages).length;
}

function trackRecentFile(state: CompactState, p: string): void {
  const idx = state.recentFiles.indexOf(p);
  if (idx >= 0) state.recentFiles.splice(idx, 1);
  state.recentFiles.push(p);
  if (state.recentFiles.length > 5) state.recentFiles = state.recentFiles.slice(-5);
}

function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR + path.sep) && resolved !== WORKDIR)
    throw new Error(`Path escapes workspace: ${p}`);
  return resolved;
}

function persistLargeOutput(toolUseId: string, output: string): string {
  if (output.length <= PERSIST_THRESHOLD) return output;
  fs.mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
  const storedPath = path.join(TOOL_RESULTS_DIR, `${toolUseId}.txt`);
  if (!fs.existsSync(storedPath)) fs.writeFileSync(storedPath, output, "utf-8");
  const preview = output.slice(0, PREVIEW_CHARS);
  const relPath = path.relative(WORKDIR, storedPath);
  return `<persisted-output>\nFull output saved to: ${relPath}\nPreview:\n${preview}\n</persisted-output>`;
}

function collectToolResultBlocks(messages: Anthropic.MessageParam[]): Array<[number, number, Record<string, any>]> {
  const blocks: Array<[number, number, Record<string, any>]> = [];
  messages.forEach((msg, mi) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return;
    (msg.content as any[]).forEach((b, bi) => {
      if (typeof b === "object" && b !== null && b.type === "tool_result") blocks.push([mi, bi, b]);
    });
  });
  return blocks;
}

function microCompact(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const toolResults = collectToolResultBlocks(messages);
  if (toolResults.length <= KEEP_RECENT_TOOL_RESULTS) return messages;
  const toCompact = toolResults.slice(0, -KEEP_RECENT_TOOL_RESULTS);
  for (const [, , block] of toCompact) {
    const content = block.content;
    if (typeof content !== "string" || content.length <= 120) continue;
    block.content = "[Earlier tool result compacted. Re-run the tool if you need full detail.]";
  }
  return messages;
}

function writeTranscript(messages: Anthropic.MessageParam[]): string {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const filePath = path.join(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  const lines = messages.map((m) => JSON.stringify(m, (_, v) => (typeof v === "bigint" ? String(v) : v)));
  fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
  return filePath;
}

async function summarizeHistory(messages: Anthropic.MessageParam[]): Promise<string> {
  const conversation = JSON.stringify(messages).slice(0, 80000);
  const prompt =
    "Summarize this coding-agent conversation so work can continue.\n" +
    "Preserve:\n1. The current goal\n2. Important findings and decisions\n3. Files read or changed\n4. Remaining work\n5. User constraints and preferences\nBe compact but concrete.\n\n" +
    conversation;
  const response = await client.messages.create({
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 2000,
  });
  return (response.content[0] as Anthropic.TextBlock).text.trim();
}

async function compactHistory(
  messages: Anthropic.MessageParam[],
  state: CompactState,
  focus?: string
): Promise<Anthropic.MessageParam[]> {
  const transcriptPath = writeTranscript(messages);
  console.log(`[transcript saved: ${transcriptPath}]`);

  let summary = await summarizeHistory(messages);
  if (focus) summary += `\n\nFocus to preserve next: ${focus}`;
  if (state.recentFiles.length) {
    const recentLines = state.recentFiles.map((p) => `- ${p}`).join("\n");
    summary += `\n\nRecent files to reopen if needed:\n${recentLines}`;
  }

  state.hasCompacted = true;
  state.lastSummary = summary;

  return [{
    role: "user",
    content: `This conversation was compacted so the agent can continue working.\n\n${summary}`,
  }];
}

function runBash(command: string, toolUseId: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) return "Error: Dangerous command blocked";
  try {
    const out = execSync(command, { cwd: WORKDIR, timeout: 120000, encoding: "utf-8", stdio: ["pipe","pipe","pipe"] });
    const output = out.trim() || "(no output)";
    return persistLargeOutput(toolUseId, output);
  } catch (e: any) {
    if (e.signal === "SIGTERM") return "Error: Timeout (120s)";
    return (((e.stdout || "") + (e.stderr || "")).trim()).slice(0, 50000) || `Error: ${e.message}`;
  }
}

function runRead(p: string, toolUseId: string, state: CompactState, limit?: number): string {
  try {
    trackRecentFile(state, p);
    const lines = fs.readFileSync(safePath(p), "utf-8").split("\n");
    const result = limit && limit < lines.length ? [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`] : lines;
    return persistLargeOutput(toolUseId, result.join("\n"));
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

const TOOLS: Anthropic.Tool[] = [
  { name: "bash", description: "Run a shell command.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.",
    input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to a file.",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in a file once.",
    input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "compact", description: "Summarize earlier conversation so work can continue in a smaller context.",
    input_schema: { type: "object", properties: { focus: { type: "string" } } } },
];

function extractText(content: Anthropic.ContentBlock[] | string): string {
  if (!Array.isArray(content)) return "";
  return content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
}

function executeTool(block: Anthropic.ToolUseBlock, state: CompactState): string {
  const inp = block.input as Record<string, any>;
  if (block.name === "bash") return runBash(inp.command, block.id);
  if (block.name === "read_file") return runRead(inp.path, block.id, state, inp.limit);
  if (block.name === "write_file") return runWrite(inp.path, inp.content);
  if (block.name === "edit_file") return runEdit(inp.path, inp.old_text, inp.new_text);
  if (block.name === "compact") return "Compacting conversation...";
  return `Unknown tool: ${block.name}`;
}

async function agentLoop(messages: Anthropic.MessageParam[], state: CompactState): Promise<void> {
  while (true) {
    messages.splice(0, messages.length, ...microCompact(messages));

    if (estimateContextSize(messages) > CONTEXT_LIMIT) {
      console.log("[auto compact]");
      messages.splice(0, messages.length, ...(await compactHistory(messages, state)));
    }

    const response = await client.messages.create({
      model: MODEL, system: SYSTEM, messages, tools: TOOLS, max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;

    const results: Anthropic.ToolResultBlockParam[] = [];
    let manualCompact = false;
    let compactFocus: string | undefined;

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const output = executeTool(block, state);
      if (block.name === "compact") {
        manualCompact = true;
        compactFocus = (block.input as any).focus;
      }
      console.log(`> ${block.name}: ${String(output).slice(0, 200)}`);
      results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
    }

    messages.push({ role: "user", content: results });

    if (manualCompact) {
      console.log("[manual compact]");
      messages.splice(0, messages.length, ...(await compactHistory(messages, state, compactFocus)));
    }
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "\x1b[36ms06 >> \x1b[0m" });
  const history: Anthropic.MessageParam[] = [];
  const compactState: CompactState = { hasCompacted: false, lastSummary: "", recentFiles: [] };
  rl.prompt();
  rl.on("line", async (query) => {
    rl.pause();
    if (!query.trim() || ["q", "exit"].includes(query.trim().toLowerCase())) { rl.close(); return; }
    history.push({ role: "user", content: query });
    await agentLoop(history, compactState);
    const last = history[history.length - 1];
    const finalText = extractText(last.content as Anthropic.ContentBlock[]);
    if (finalText) console.log(finalText);
    console.log();
    rl.resume(); rl.prompt();
  });
  rl.on("close", () => process.exit(0));
}

main().catch(console.error);
