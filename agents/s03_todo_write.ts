#!/usr/bin/env npx ts-node
// Harness: planning -- keep the current session plan outside the model's head.
/**
 * s03_todo_write.ts - Session Planning with TodoWrite
 *
 * This chapter is about a lightweight session plan, not a durable task graph.
 * The model can rewrite its current plan, keep one active step in focus, and get
 * nudged if it stops refreshing the plan for too many rounds.
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
const PLAN_REMINDER_INTERVAL = 3;

const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use the todo tool for multi-step work.
Keep exactly one step in_progress when a task has multiple steps.
Refresh the plan as work advances. Prefer tools over prose.`;

interface PlanItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

interface PlanningState {
  items: PlanItem[];
  roundsSinceUpdate: number;
}

class TodoManager {
  private state: PlanningState = { items: [], roundsSinceUpdate: 0 };

  update(items: Array<Record<string, string>>): string {
    if (items.length > 12) throw new Error("Keep the session plan short (max 12 items)");

    const normalized: PlanItem[] = [];
    let inProgressCount = 0;
    for (let i = 0; i < items.length; i++) {
      const raw = items[i];
      const content = String(raw.content ?? "").trim();
      const status = String(raw.status ?? "pending").toLowerCase() as PlanItem["status"];
      const activeForm = String(raw.activeForm ?? "").trim();

      if (!content) throw new Error(`Item ${i}: content required`);
      if (!["pending", "in_progress", "completed"].includes(status))
        throw new Error(`Item ${i}: invalid status '${status}'`);
      if (status === "in_progress") inProgressCount++;

      normalized.push({ content, status, activeForm });
    }

    if (inProgressCount > 1) throw new Error("Only one plan item can be in_progress");

    this.state.items = normalized;
    this.state.roundsSinceUpdate = 0;
    return this.render();
  }

  noteRoundWithoutUpdate(): void {
    this.state.roundsSinceUpdate++;
  }

  reminder(): string | null {
    if (!this.state.items.length) return null;
    if (this.state.roundsSinceUpdate < PLAN_REMINDER_INTERVAL) return null;
    return "<reminder>Refresh your current plan before continuing.</reminder>";
  }

  render(): string {
    if (!this.state.items.length) return "No session plan yet.";

    const marker: Record<string, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
    const lines = this.state.items.map((item) => {
      let line = `${marker[item.status]} ${item.content}`;
      if (item.status === "in_progress" && item.activeForm) line += ` (${item.activeForm})`;
      return line;
    });

    const completed = this.state.items.filter((i) => i.status === "completed").length;
    lines.push(`\n(${completed}/${this.state.items.length} completed)`);
    return lines.join("\n");
  }

  resetRounds(): void { this.state.roundsSinceUpdate = 0; }
}

const TODO = new TodoManager();

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
  todo:       (kw) => TODO.update(kw.items),
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
  { name: "todo", description: "Rewrite the current session plan for multi-step work.",
    input_schema: { type: "object", properties: {
      items: { type: "array", items: { type: "object", properties: {
        content: { type: "string" },
        status: { type: "string", enum: ["pending", "in_progress", "completed"] },
        activeForm: { type: "string", description: "Optional present-continuous label." },
      }, required: ["content", "status"] } },
    }, required: ["items"] } },
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
    let usedTodo = false;
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      const handler = TOOL_HANDLERS[block.name];
      let output: string;
      try {
        output = handler ? handler(block.input as Record<string, any>) : `Unknown tool: ${block.name}`;
      } catch (e: any) {
        output = `Error: ${e.message}`;
      }

      console.log(`> ${block.name}: ${String(output).slice(0, 200)}`);
      results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
      if (block.name === "todo") usedTodo = true;
    }

    if (usedTodo) {
      TODO.resetRounds();
    } else {
      TODO.noteRoundWithoutUpdate();
      const reminder = TODO.reminder();
      if (reminder) results.unshift({ type: "tool_result", tool_use_id: "reminder", content: reminder } as any);
    }

    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "\x1b[36ms03 >> \x1b[0m" });
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
