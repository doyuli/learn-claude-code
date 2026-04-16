#!/usr/bin/env npx ts-node
// Harness: time -- the agent schedules its own future work.
/**
 * s14_cron_scheduler.ts - Cron / Scheduled Tasks
 *
 * The agent can schedule prompts for future execution using standard cron
 * expressions. When a schedule matches the current time, it pushes a
 * notification back into the main conversation loop.
 *
 *     Cron expression: 5 fields
 *     +-------+-------+-------+-------+-------+
 *     | min   | hour  | dom   | month | dow   |
 *     | 0-59  | 0-23  | 1-31  | 1-12  | 0-6   |
 *     +-------+-------+-------+-------+-------+
 *
 * Key idea: scheduling remembers future work, then hands it back to the
 * same main loop when the time arrives.
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

const SCHEDULED_TASKS_FILE = path.join(WORKDIR, ".claude", "scheduled_tasks.json");
const CRON_LOCK_FILE = path.join(WORKDIR, ".claude", "cron.lock");
const AUTO_EXPIRY_DAYS = 7;
const JITTER_MINUTES = [0, 30];
const JITTER_OFFSET_MAX = 4;

class CronLock {
  constructor(private lockPath: string = CRON_LOCK_FILE) {}

  acquire(): boolean {
    if (fs.existsSync(this.lockPath)) {
      try {
        const storedPid = parseInt(fs.readFileSync(this.lockPath, "utf-8").trim());
        try { process.kill(storedPid, 0); return false; }
        catch { /* stale lock */ }
      } catch {}
    }
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    fs.writeFileSync(this.lockPath, String(process.pid), "utf-8");
    return true;
  }

  release(): void {
    try {
      if (fs.existsSync(this.lockPath)) {
        const storedPid = parseInt(fs.readFileSync(this.lockPath, "utf-8").trim());
        if (storedPid === process.pid) fs.unlinkSync(this.lockPath);
      }
    } catch {}
  }
}

function fieldMatches(field: string, value: number, lo: number): boolean {
  if (field === "*") return true;
  for (const part of field.split(",")) {
    let step = 1;
    let main = part;
    if (main.includes("/")) { const s = main.split("/"); main = s[0]; step = parseInt(s[1]); }
    if (main === "*") { if ((value - lo) % step === 0) return true; }
    else if (main.includes("-")) {
      const [s, e] = main.split("-").map(Number);
      if (s <= value && value <= e && (value - s) % step === 0) return true;
    } else {
      if (parseInt(main) === value) return true;
    }
  }
  return false;
}

function cronMatches(expr: string, dt: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const cronDow = dt.getDay(); // 0=Sunday
  const checks = [
    [dt.getMinutes(), 0], [dt.getHours(), 0], [dt.getDate(), 1],
    [dt.getMonth() + 1, 1], [cronDow, 0],
  ];
  return fields.every((f, i) => fieldMatches(f, checks[i][0], checks[i][1]));
}

interface CronTask {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  createdAt: number;
  jitterOffset?: number;
  lastFired?: number;
}

class CronScheduler {
  private tasks: CronTask[] = [];
  private queue: string[] = [];
  private stopEvent = false;
  private thread?: NodeJS.Timeout;
  private lastCheckMinute = -1;

  start(): void {
    this._loadDurable();
    this.thread = setInterval(() => this._checkLoop(), 1000);
    const count = this.tasks.length;
    if (count) console.log(`[Cron] Loaded ${count} scheduled tasks`);
  }

  stop(): void {
    this.stopEvent = true;
    if (this.thread) clearInterval(this.thread);
  }

  create(cronExpr: string, prompt: string, recurring = true, durable = false): string {
    const taskId = Math.random().toString(36).slice(2, 10);
    const task: CronTask = {
      id: taskId, cron: cronExpr, prompt, recurring, durable,
      createdAt: Date.now() / 1000,
    };
    if (recurring) task.jitterOffset = this._computeJitter(cronExpr);
    this.tasks.push(task);
    if (durable) this._saveDurable();
    const mode = recurring ? "recurring" : "one-shot";
    const store = durable ? "durable" : "session-only";
    return `Created task ${taskId} (${mode}, ${store}): cron=${cronExpr}`;
  }

  delete(taskId: string): string {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== taskId);
    if (this.tasks.length < before) { this._saveDurable(); return `Deleted task ${taskId}`; }
    return `Task ${taskId} not found`;
  }

  listTasks(): string {
    if (!this.tasks.length) return "No scheduled tasks.";
    return this.tasks.map((t) => {
      const mode = t.recurring ? "recurring" : "one-shot";
      const store = t.durable ? "durable" : "session";
      const ageHours = ((Date.now() / 1000 - t.createdAt) / 3600).toFixed(1);
      return `  ${t.id}  ${t.cron}  [${mode}/${store}] (${ageHours}h old): ${t.prompt.slice(0, 60)}`;
    }).join("\n");
  }

  drainNotifications(): string[] {
    const notifs = [...this.queue];
    this.queue = [];
    return notifs;
  }

  private _computeJitter(cronExpr: string): number {
    const fields = cronExpr.trim().split(/\s+/);
    if (!fields.length) return 0;
    const minuteVal = parseInt(fields[0]);
    if (JITTER_MINUTES.includes(minuteVal)) {
      return (cronExpr.split("").reduce((s, c) => s + c.charCodeAt(0), 0) % JITTER_OFFSET_MAX) + 1;
    }
    return 0;
  }

  private _checkLoop(): void {
    if (this.stopEvent) return;
    const now = new Date();
    const currentMinute = now.getHours() * 60 + now.getMinutes();
    if (currentMinute !== this.lastCheckMinute) {
      this.lastCheckMinute = currentMinute;
      this._checkTasks(now);
    }
  }

  private _checkTasks(now: Date): void {
    const toRemove = new Set<string>();
    for (const task of this.tasks) {
      const ageDays = (Date.now() / 1000 - task.createdAt) / 86400;
      if (task.recurring && ageDays > AUTO_EXPIRY_DAYS) { toRemove.add(task.id); continue; }

      let checkTime = now;
      const jitter = task.jitterOffset ?? 0;
      if (jitter) {
        const d = new Date(now.getTime() - jitter * 60000);
        checkTime = d;
      }

      if (cronMatches(task.cron, checkTime)) {
        this.queue.push(`[Scheduled task ${task.id}]: ${task.prompt}`);
        task.lastFired = Date.now() / 1000;
        console.log(`[Cron] Fired: ${task.id}`);
        if (!task.recurring) toRemove.add(task.id);
      }
    }

    if (toRemove.size) {
      this.tasks = this.tasks.filter((t) => !toRemove.has(t.id));
      this._saveDurable();
    }
  }

  private _loadDurable(): void {
    if (!fs.existsSync(SCHEDULED_TASKS_FILE)) return;
    try {
      const data: CronTask[] = JSON.parse(fs.readFileSync(SCHEDULED_TASKS_FILE, "utf-8"));
      this.tasks = data.filter((t) => t.durable);
    } catch (e: any) { console.log(`[Cron] Error loading tasks: ${e.message}`); }
  }

  private _saveDurable(): void {
    const durable = this.tasks.filter((t) => t.durable);
    fs.mkdirSync(path.dirname(SCHEDULED_TASKS_FILE), { recursive: true });
    fs.writeFileSync(SCHEDULED_TASKS_FILE, JSON.stringify(durable, null, 2) + "\n", "utf-8");
  }
}

const scheduler = new CronScheduler();

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
  bash:        (kw) => runBash(kw.command),
  read_file:   (kw) => runRead(kw.path, kw.limit),
  write_file:  (kw) => runWrite(kw.path, kw.content),
  edit_file:   (kw) => runEdit(kw.path, kw.old_text, kw.new_text),
  cron_create: (kw) => scheduler.create(kw.cron, kw.prompt, kw.recurring ?? true, kw.durable ?? false),
  cron_delete: (kw) => scheduler.delete(kw.id),
  cron_list:   (_kw) => scheduler.listTasks(),
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
  { name: "cron_create", description: "Schedule a recurring or one-shot task with a cron expression.",
    input_schema: { type: "object", properties: {
      cron: { type: "string", description: "5-field cron expression: 'min hour dom month dow'" },
      prompt: { type: "string", description: "The prompt to inject when the task fires" },
      recurring: { type: "boolean", description: "true=repeat, false=fire once then delete. Default true." },
      durable: { type: "boolean", description: "true=persist to disk, false=session-only. Default false." },
    }, required: ["cron", "prompt"] } },
  { name: "cron_delete", description: "Delete a scheduled task by ID.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "cron_list", description: "List all scheduled tasks.",
    input_schema: { type: "object", properties: {} } },
];

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.\n\nYou can schedule future work with cron_create. Tasks fire automatically and their prompts are injected into the conversation.`;

/**
 * Cron-aware agent loop.
 *
 * Before each LLM call, drain the notification queue and inject any
 * fired task prompts as user messages. This is how the agent "wakes up"
 * to handle scheduled work.
 */
async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    const notifications = scheduler.drainNotifications();
    for (const note of notifications) {
      console.log(`[Cron notification] ${note.slice(0, 100)}`);
      messages.push({ role: "user", content: note });
    }

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
        output = handler ? handler(block.input as Record<string, any>) : `Unknown: ${block.name}`;
      } catch (e: any) { output = `Error: ${e.message}`; }
      console.log(`> ${block.name}: ${String(output).slice(0, 200)}`);
      results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
    }
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  scheduler.start();
  console.log("[Cron scheduler running. Background checks every second.]");
  console.log("[Commands: /cron to list tasks, /test to fire a test notification]");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "\x1b[36ms14 >> \x1b[0m" });
  const history: Anthropic.MessageParam[] = [];
  rl.prompt();
  rl.on("line", async (query) => {
    rl.pause();
    if (!query.trim() || ["q", "exit"].includes(query.trim().toLowerCase())) {
      scheduler.stop(); rl.close(); return;
    }

    if (query.trim() === "/cron") {
      console.log(scheduler.listTasks());
      rl.resume(); rl.prompt(); return;
    }

    if (query.trim() === "/test") {
      (scheduler as any).queue.push("[Scheduled task test-0000]: This is a test notification.");
      console.log("[Test notification enqueued. It will be injected on your next message.]");
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
  rl.on("close", () => { scheduler.stop(); process.exit(0); });
}

main().catch(console.error);
