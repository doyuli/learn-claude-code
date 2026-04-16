#!/usr/bin/env npx ts-node
// Harness: background execution -- the model thinks while the harness waits.
/**
 * s13_background_tasks.ts - Background Tasks
 *
 * Run slow commands in background threads. Before each LLM call, the loop
 * drains a notification queue and hands finished results back to the model.
 *
 *     Main thread                Background thread (Worker)
 *     +-----------------+        +-----------------+
 *     | agent loop      |        | task executes   |
 *     | ...             |        | ...             |
 *     | [LLM call] <---+-------- | enqueue(result) |
 *     |  ^drain queue   |        +-----------------+
 *     +-----------------+
 *
 * Background tasks here are runtime execution slots, not the durable task-board
 * records introduced in s12.
 */

import Anthropic from "@anthropic-ai/sdk";
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { execSync, spawnSync } from "child_process";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import "dotenv/config";

// Worker thread code (inline)
if (!isMainThread && workerData?.isBackgroundWorker) {
  const { taskId, command, workdir } = workerData;
  let output: string;
  let status: string;
  try {
    const r = spawnSync(command, { shell: true, cwd: workdir, timeout: 300000, encoding: "utf-8" });
    output = ((r.stdout ?? "") + (r.stderr ?? "")).trim().slice(0, 50000) || "(no output)";
    status = r.status === 0 ? "completed" : "error";
  } catch (e: any) {
    output = `Error: ${e.message}`;
    status = "error";
  }
  parentPort?.postMessage({ taskId, status, output });
  process.exit(0);
}

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const RUNTIME_DIR = path.join(WORKDIR, ".runtime-tasks");
fs.mkdirSync(RUNTIME_DIR, { recursive: true });
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID!;

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use background_run for long-running commands.`;
const STALL_THRESHOLD_S = 45;

interface TaskRecord {
  id: string;
  status: "running" | "completed" | "timeout" | "error";
  result: string | null;
  command: string;
  startedAt: number;
  finishedAt: number | null;
  resultPreview: string;
  outputFile: string;
}

interface Notification {
  taskId: string;
  status: string;
  command: string;
  preview: string;
  outputFile: string;
}

class BackgroundManager {
  private tasks: Map<string, TaskRecord> = new Map();
  private notificationQueue: Notification[] = [];

  private _preview(output: string, limit = 500): string {
    return output.replace(/\s+/g, " ").trim().slice(0, limit);
  }

  run(command: string): string {
    const taskId = Math.random().toString(36).slice(2, 10);
    const outputFile = path.join(RUNTIME_DIR, `${taskId}.log`);
    const record: TaskRecord = {
      id: taskId,
      status: "running",
      result: null,
      command,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      resultPreview: "",
      outputFile: path.relative(WORKDIR, outputFile),
    };
    this.tasks.set(taskId, record);

    const worker = new Worker(__filename, {
      workerData: { isBackgroundWorker: true, taskId, command, workdir: WORKDIR },
    });
    worker.on("message", (msg: { taskId: string; status: string; output: string }) => {
      const t = this.tasks.get(msg.taskId);
      if (!t) return;
      t.status = msg.status as any;
      t.result = msg.output;
      t.finishedAt = Date.now() / 1000;
      t.resultPreview = this._preview(msg.output);
      fs.writeFileSync(outputFile, msg.output, "utf-8");
      this.notificationQueue.push({
        taskId: msg.taskId,
        status: msg.status,
        command: command.slice(0, 80),
        preview: t.resultPreview,
        outputFile: t.outputFile,
      });
    });
    worker.on("error", (e) => {
      const t = this.tasks.get(taskId);
      if (t) { t.status = "error"; t.result = e.message; }
    });

    return `Background task ${taskId} started: ${command.slice(0, 80)} (output_file=${path.relative(WORKDIR, outputFile)})`;
  }

  check(taskId?: string): string {
    if (taskId) {
      const t = this.tasks.get(taskId);
      if (!t) return `Error: Unknown task ${taskId}`;
      return JSON.stringify({ id: t.id, status: t.status, command: t.command, resultPreview: t.resultPreview, outputFile: t.outputFile }, null, 2);
    }
    if (!this.tasks.size) return "No background tasks.";
    return [...this.tasks.entries()].map(([id, t]) =>
      `${id}: [${t.status}] ${t.command.slice(0, 60)} -> ${t.resultPreview || "(running)"}`
    ).join("\n");
  }

  drainNotifications(): Notification[] {
    const notifs = [...this.notificationQueue];
    this.notificationQueue = [];
    return notifs;
  }

  detectStalled(): string[] {
    const now = Date.now() / 1000;
    return [...this.tasks.entries()]
      .filter(([, t]) => t.status === "running" && (now - t.startedAt) > STALL_THRESHOLD_S)
      .map(([id]) => id);
  }
}

const BG = new BackgroundManager();

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
    const c = fs.readFileSync(fp, "utf-8");
    if (!c.includes(oldText)) return `Error: Text not found in ${p}`;
    fs.writeFileSync(fp, c.replace(oldText, newText), "utf-8");
    return `Edited ${p}`;
  } catch (e: any) { return `Error: ${e.message}`; }
}

const TOOL_HANDLERS: Record<string, (kw: Record<string, any>) => string> = {
  bash:             (kw) => runBash(kw.command),
  read_file:        (kw) => runRead(kw.path, kw.limit),
  write_file:       (kw) => runWrite(kw.path, kw.content),
  edit_file:        (kw) => runEdit(kw.path, kw.old_text, kw.new_text),
  background_run:   (kw) => BG.run(kw.command),
  check_background: (kw) => BG.check(kw.task_id),
};

const TOOLS: Anthropic.Tool[] = [
  { name: "bash", description: "Run a shell command (blocking).",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.",
    input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.",
    input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "background_run", description: "Run command in background thread. Returns task_id immediately.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "check_background", description: "Check background task status. Omit task_id to list all.",
    input_schema: { type: "object", properties: { task_id: { type: "string" } } } },
];

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    // Drain background notifications and inject as a synthetic user message
    const notifs = BG.drainNotifications();
    if (notifs.length && messages.length) {
      const notifText = notifs.map((n) =>
        `[bg:${n.taskId}] ${n.status}: ${n.preview} (output_file=${n.outputFile})`
      ).join("\n");
      messages.push({ role: "user", content: `<background-results>\n${notifText}\n</background-results>` });
    }

    const response = await client.messages.create({
      model: MODEL, system: SYSTEM, messages, tools: TOOLS, max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        let output: string;
        try {
          output = handler ? handler(block.input as Record<string, any>) : `Unknown tool: ${block.name}`;
        } catch (e: any) { output = `Error: ${e.message}`; }
        console.log(`> ${block.name}:`);
        console.log(String(output).slice(0, 200));
        results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
      }
    }
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "\x1b[36ms13 >> \x1b[0m" });
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
