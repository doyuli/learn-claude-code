#!/usr/bin/env npx ts-node
// Harness: the loop -- keep feeding real tool results back into the model.
/**
 * s01_agent_loop.ts - The Agent Loop
 *
 * This file teaches the smallest useful coding-agent pattern:
 *
 *     user message
 *       -> model reply
 *       -> if tool_use: execute tools
 *       -> write tool_result back to messages
 *       -> continue
 *
 * It intentionally keeps the loop small, but still makes the loop state explicit
 * so later chapters can grow from the same structure.
 */

import Anthropic from "@anthropic-ai/sdk";
import * as readline from "readline";
import { execSync } from "child_process";
import "dotenv/config";

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
});
const MODEL = process.env.MODEL_ID!;

const SYSTEM =
  `You are a coding agent at ${process.cwd()}. ` +
  "Use bash to inspect and change the workspace. Act first, then report clearly.";

const TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",
    description: "Run a shell command in the current workspace.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

// The minimal loop state: history, loop count, and why we continue.
interface LoopState {
  messages: Anthropic.MessageParam[];
  turnCount: number;
  transitionReason: string | null;
}

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((item) => command.includes(item))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const output = execSync(command, {
      cwd: process.cwd(),
      timeout: 120000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output.trim().slice(0, 50000) || "(no output)";
  } catch (e: any) {
    if (e.signal === "SIGTERM") return "Error: Timeout (120s)";
    const out = ((e.stdout || "") + (e.stderr || "")).trim();
    return out.slice(0, 50000) || `Error: ${e.message}`;
  }
}

function extractText(
  content: Anthropic.ContentBlock[] | string | null
): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function executeToolCalls(
  responseContent: Anthropic.ContentBlock[]
): Anthropic.ToolResultBlockParam[] {
  const results: Anthropic.ToolResultBlockParam[] = [];
  for (const block of responseContent) {
    if (block.type !== "tool_use") continue;
    const command = (block.input as { command: string }).command;
    process.stdout.write(`\x1b[33m$ ${command}\x1b[0m\n`);
    const output = runBash(command);
    console.log(output.slice(0, 200));
    results.push({
      type: "tool_result",
      tool_use_id: block.id,
      content: output,
    });
  }
  return results;
}

async function agentLoop(state: LoopState): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages: state.messages,
      tools: TOOLS,
      max_tokens: 8000,
    });
    state.messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") break;

    const results = executeToolCalls(response.content);
    if (results.length === 0) break;

    state.messages.push({ role: "user", content: results });
    state.turnCount += 1;
    state.transitionReason = "tool_result";
  }
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\x1b[36ms01 >> \x1b[0m",
  });

  const history: Anthropic.MessageParam[] = [];

  rl.prompt();
  rl.on("line", async (query) => {
    rl.pause();
    if (!query.trim() || ["q", "exit"].includes(query.trim().toLowerCase())) {
      rl.close();
      return;
    }

    history.push({ role: "user", content: query });
    const state: LoopState = { messages: history, turnCount: 1, transitionReason: null };
    await agentLoop(state);

    const lastMsg = history[history.length - 1];
    const finalText = extractText(lastMsg.content as Anthropic.ContentBlock[]);
    if (finalText) console.log(finalText);
    console.log();

    rl.resume();
    rl.prompt();
  });
  rl.on("close", () => process.exit(0));
}

main().catch(console.error);
