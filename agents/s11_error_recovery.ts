#!/usr/bin/env npx ts-node
// Harness: resilience -- a robust agent recovers instead of crashing.
/**
 * s11_error_recovery.ts - Error Recovery
 *
 * Teaching demo of three recovery paths:
 *
 * - continue when output is truncated
 * - compact when context grows too large
 * - back off when transport errors are temporary
 *
 *     LLM response
 *          |
 *          v
 *     [Check stop_reason]
 *          |
 *          +-- "max_tokens" ----> [Strategy 1: max_output_tokens recovery]
 *          |                       Inject continuation message.
 *          |                       Retry up to MAX_RECOVERY_ATTEMPTS (3).
 *          |
 *          +-- API error --------> [Check error type]
 *          |                       |
 *          |                       +-- prompt_too_long --> [Strategy 2: compact + retry]
 *          |                       |
 *          |                       +-- connection/rate --> [Strategy 3: backoff retry]
 *          |
 *          +-- "end_turn" ------> [Normal exit]
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

const MAX_RECOVERY_ATTEMPTS = 3;
const BACKOFF_BASE_DELAY = 1.0;  // seconds
const BACKOFF_MAX_DELAY = 30.0;  // seconds
const TOKEN_THRESHOLD = 50000;   // chars / 4 ~ tokens for compact trigger

const CONTINUATION_MESSAGE =
  "Output limit hit. Continue directly from where you stopped -- " +
  "no recap, no repetition. Pick up mid-sentence if needed.";

function estimateTokens(messages: Anthropic.MessageParam[]): number {
  return Math.floor(JSON.stringify(messages).length / 4);
}

async function autoCompact(messages: Anthropic.MessageParam[]): Promise<Anthropic.MessageParam[]> {
  const conversationText = JSON.stringify(messages).slice(0, 80000);
  const prompt =
    "Summarize this conversation for continuity. Include:\n" +
    "1) Task overview and success criteria\n" +
    "2) Current state: completed work, files touched\n" +
    "3) Key decisions and failed approaches\n" +
    "4) Remaining next steps\n" +
    "Be concise but preserve critical details.\n\n" +
    conversationText;
  let summary: string;
  try {
    const response = await client.messages.create({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4000,
    });
    summary = (response.content[0] as Anthropic.TextBlock).text;
  } catch (e: any) {
    summary = `(compact failed: ${e.message}). Previous context lost.`;
  }

  const continuation =
    "This session continues from a previous conversation that was compacted. " +
    `Summary of prior context:\n\n${summary}\n\n` +
    "Continue from where we left off without re-asking the user.";
  return [{ role: "user", content: continuation }];
}

function backoffDelay(attempt: number): number {
  /** Exponential backoff with jitter: base * 2^attempt + random(0, 1). */
  const delay = Math.min(BACKOFF_BASE_DELAY * Math.pow(2, attempt), BACKOFF_MAX_DELAY);
  const jitter = Math.random();
  return delay + jitter;
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
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

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`;

/**
 * Error-recovering agent loop with three paths:
 *
 * 1. continue after max_tokens
 * 2. compact after prompt-too-long
 * 3. back off after transient transport failure
 */
async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  let maxOutputRecoveryCount = 0;

  while (true) {
    // -- Attempt the API call with connection retry --
    let response: Anthropic.Message | null = null;
    for (let attempt = 0; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
      try {
        response = await client.messages.create({
          model: MODEL, system: SYSTEM, messages, tools: TOOLS, max_tokens: 8000,
        });
        break; // success

      } catch (e: any) {
        const errBody = String(e).toLowerCase();

        // Strategy 2: prompt_too_long -> compact and retry
        if (errBody.includes("overlong_prompt") || (errBody.includes("prompt") && errBody.includes("long"))) {
          console.log(`[Recovery] Prompt too long. Compacting... (attempt ${attempt + 1})`);
          const compacted = await autoCompact(messages);
          messages.splice(0, messages.length, ...compacted);
          continue;
        }

        // Strategy 3: connection/rate errors -> backoff
        if (attempt < MAX_RECOVERY_ATTEMPTS) {
          const delay = backoffDelay(attempt);
          console.log(`[Recovery] API error: ${e.message}. Retrying in ${delay.toFixed(1)}s (attempt ${attempt + 1}/${MAX_RECOVERY_ATTEMPTS})`);
          await sleep(delay);
          continue;
        }

        // All retries exhausted
        console.log(`[Error] API call failed after ${MAX_RECOVERY_ATTEMPTS} retries: ${e.message}`);
        return;
      }
    }

    if (!response) { console.log("[Error] No response received."); return; }

    messages.push({ role: "assistant", content: response.content });

    // -- Strategy 1: max_tokens recovery --
    if (response.stop_reason === "max_tokens") {
      maxOutputRecoveryCount++;
      if (maxOutputRecoveryCount <= MAX_RECOVERY_ATTEMPTS) {
        console.log(`[Recovery] max_tokens hit (${maxOutputRecoveryCount}/${MAX_RECOVERY_ATTEMPTS}). Injecting continuation...`);
        messages.push({ role: "user", content: CONTINUATION_MESSAGE });
        continue; // retry the loop
      } else {
        console.log(`[Error] max_tokens recovery exhausted (${MAX_RECOVERY_ATTEMPTS} attempts). Stopping.`);
        return;
      }
    }

    // Reset max_tokens counter on successful non-max_tokens response
    maxOutputRecoveryCount = 0;

    // -- Normal end_turn: no tool use requested --
    if (response.stop_reason !== "tool_use") return;

    // -- Process tool calls --
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

    // Check if we should auto-compact (proactive, not just reactive)
    if (estimateTokens(messages) > TOKEN_THRESHOLD) {
      console.log("[Recovery] Token estimate exceeds threshold. Auto-compacting...");
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
    }
  }
}

async function main() {
  console.log("[Error recovery enabled: max_tokens / prompt_too_long / connection backoff]");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "\x1b[36ms11 >> \x1b[0m" });
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
