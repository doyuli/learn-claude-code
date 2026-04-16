#!/usr/bin/env npx ts-node
// Harness: persistent tasks -- goals that outlive any single conversation.
/**
 * s12_task_system.ts - Tasks
 *
 * Tasks persist as JSON files in .tasks/ so they survive context compression.
 * Each task carries a small dependency graph:
 *
 * - blockedBy: what must finish first
 * - blocks: what this task unlocks later
 *
 * Key idea: task state survives compression because it lives on disk, not only
 * inside the conversation.
 * These are durable work-graph tasks, not transient runtime execution slots.
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
const TASKS_DIR = path.join(WORKDIR, ".tasks");

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use task tools to plan and track work.`;

type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";
const STATUS_MARKER: Record<TaskStatus, string> = {
  pending: "[ ]", in_progress: "[>]", completed: "[x]", deleted: "[-]",
};

interface TaskRecord {
  id: number;
  subject: string;
  description: string;
  status: TaskStatus;
  blockedBy: number[];
  blocks: number[];
  owner: string;
}

/**
 * Persistent TaskRecord store.
 *
 * Think "work graph on disk", not "currently running worker".
 */
class TaskManager {
  private dir: string;
  private nextId: number;

  constructor(tasksDir: string) {
    this.dir = tasksDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.nextId = this._maxId() + 1;
  }

  private _maxId(): number {
    const ids = fs.readdirSync(this.dir)
      .filter((f) => /^task_\d+\.json$/.test(f))
      .map((f) => parseInt(f.split("_")[1]));
    return ids.length > 0 ? Math.max(...ids) : 0;
  }

  private _load(taskId: number): TaskRecord {
    const p = path.join(this.dir, `task_${taskId}.json`);
    if (!fs.existsSync(p)) throw new Error(`Task ${taskId} not found`);
    return JSON.parse(fs.readFileSync(p, "utf-8")) as TaskRecord;
  }

  private _save(task: TaskRecord): void {
    fs.writeFileSync(path.join(this.dir, `task_${task.id}.json`), JSON.stringify(task, null, 2), "utf-8");
  }

  create(subject: string, description = ""): string {
    const task: TaskRecord = {
      id: this.nextId++, subject, description,
      status: "pending", blockedBy: [], blocks: [], owner: "",
    };
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  get(taskId: number): string {
    return JSON.stringify(this._load(taskId), null, 2);
  }

  update(taskId: number, status?: TaskStatus, owner?: string, addBlockedBy?: number[], addBlocks?: number[]): string {
    const task = this._load(taskId);
    if (owner !== undefined) task.owner = owner;
    if (status) {
      if (!["pending", "in_progress", "completed", "deleted"].includes(status))
        throw new Error(`Invalid status: ${status}`);
      task.status = status;
      if (status === "completed") this._clearDependency(taskId);
    }
    if (addBlockedBy) task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
    if (addBlocks) {
      task.blocks = [...new Set([...task.blocks, ...addBlocks])];
      for (const blockedId of addBlocks) {
        try {
          const blocked = this._load(blockedId);
          if (!blocked.blockedBy.includes(taskId)) {
            blocked.blockedBy.push(taskId);
            this._save(blocked);
          }
        } catch {}
      }
    }
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  private _clearDependency(completedId: number): void {
    for (const file of fs.readdirSync(this.dir).filter((f) => /^task_\d+\.json$/.test(f))) {
      const task: TaskRecord = JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf-8"));
      if (task.blockedBy.includes(completedId)) {
        task.blockedBy = task.blockedBy.filter((id) => id !== completedId);
        this._save(task);
      }
    }
  }

  listAll(): string {
    const files = fs.readdirSync(this.dir).filter((f) => /^task_\d+\.json$/.test(f)).sort();
    if (!files.length) return "No tasks.";
    const lines = files.map((file) => {
      const t: TaskRecord = JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf-8"));
      const marker = STATUS_MARKER[t.status] ?? "[?]";
      const blocked = t.blockedBy.length ? ` (blocked by: [${t.blockedBy}])` : "";
      const owner = t.owner ? ` owner=${t.owner}` : "";
      return `${marker} #${t.id}: ${t.subject}${owner}${blocked}`;
    });
    return lines.join("\n");
  }
}

const TASKS = new TaskManager(TASKS_DIR);

// -- Base tool implementations --
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
  bash:         (kw) => runBash(kw.command),
  read_file:    (kw) => runRead(kw.path, kw.limit),
  write_file:   (kw) => runWrite(kw.path, kw.content),
  edit_file:    (kw) => runEdit(kw.path, kw.old_text, kw.new_text),
  task_create:  (kw) => TASKS.create(kw.subject, kw.description ?? ""),
  task_update:  (kw) => TASKS.update(kw.task_id, kw.status, kw.owner, kw.addBlockedBy, kw.addBlocks),
  task_list:    (_kw) => TASKS.listAll(),
  task_get:     (kw) => TASKS.get(kw.task_id),
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
  { name: "task_create", description: "Create a new task.",
    input_schema: { type: "object", properties: { subject: { type: "string" }, description: { type: "string" } }, required: ["subject"] } },
  { name: "task_update", description: "Update a task's status, owner, or dependencies.",
    input_schema: { type: "object", properties: {
      task_id: { type: "integer" },
      status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] },
      owner: { type: "string", description: "Set when a teammate claims the task" },
      addBlockedBy: { type: "array", items: { type: "integer" } },
      addBlocks: { type: "array", items: { type: "integer" } },
    }, required: ["task_id"] } },
  { name: "task_list", description: "List all tasks with status summary.",
    input_schema: { type: "object", properties: {} } },
  { name: "task_get", description: "Get full details of a task by ID.",
    input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
];

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
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
        console.log(`> ${block.name}: ${String(output).slice(0, 200)}`);
        results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
      }
    }
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "\x1b[36ms12 >> \x1b[0m" });
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
