#!/usr/bin/env npx ts-node
// Harness: directory isolation -- parallel execution lanes that never collide.
/**
 * s18_worktree_task_isolation.ts - Worktree + Task Isolation
 *
 * Directory-level isolation for parallel task execution.
 * Tasks are the control plane and worktrees are the execution plane.
 *
 * Key insight: "Isolate by directory, coordinate by task ID."
 */

import Anthropic from "@anthropic-ai/sdk";
import * as readline from "readline";
import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import "dotenv/config";

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID!;

function detectRepoRoot(cwd: string): string {
  try {
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8", timeout: 10000 });
    if (r.status === 0) return r.stdout.trim();
  } catch {}
  return cwd;
}

const REPO_ROOT = detectRepoRoot(WORKDIR);
const TASKS_DIR = path.join(REPO_ROOT, ".tasks");
const WORKTREES_DIR = path.join(REPO_ROOT, ".worktrees");
const EVENTS_LOG = path.join(WORKTREES_DIR, "events.jsonl");
const WORKTREE_INDEX = path.join(WORKTREES_DIR, "index.json");

const SYSTEM =
  `You are a coding agent at ${WORKDIR}. ` +
  "Use task + worktree tools for multi-task work. " +
  "For parallel or risky changes: create tasks, allocate worktree lanes, " +
  "run commands in those lanes, then choose keep/remove for closeout.";

// -- EventBus --
function emitEvent(event: string, data: Record<string, any> = {}): void {
  fs.mkdirSync(path.dirname(EVENTS_LOG), { recursive: true });
  if (!fs.existsSync(EVENTS_LOG)) fs.writeFileSync(EVENTS_LOG, "", "utf-8");
  fs.appendFileSync(EVENTS_LOG, JSON.stringify({ event, ts: Date.now() / 1000, ...data }) + "\n", "utf-8");
}

function listRecentEvents(limit = 20): string {
  if (!fs.existsSync(EVENTS_LOG)) return "[]";
  const lines = fs.readFileSync(EVENTS_LOG, "utf-8").trim().split("\n").filter(Boolean);
  const recent = lines.slice(-Math.max(1, Math.min(limit, 200)));
  return JSON.stringify(recent.map((l) => { try { return JSON.parse(l); } catch { return { event: "parse_error", raw: l }; } }), null, 2);
}

// -- TaskManager --
fs.mkdirSync(TASKS_DIR, { recursive: true });

function taskMaxId(): number {
  return fs.readdirSync(TASKS_DIR)
    .filter((f) => /^task_\d+\.json$/.test(f))
    .reduce((m, f) => Math.max(m, parseInt(f.split("_")[1])), 0);
}

function loadTask(taskId: number): Record<string, any> {
  const p = path.join(TASKS_DIR, `task_${taskId}.json`);
  if (!fs.existsSync(p)) throw new Error(`Task ${taskId} not found`);
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function saveTask(task: Record<string, any>): void {
  fs.writeFileSync(path.join(TASKS_DIR, `task_${task.id}.json`), JSON.stringify(task, null, 2), "utf-8");
}

let nextTaskId = taskMaxId() + 1;

function createTask(subject: string, description = ""): string {
  const task = { id: nextTaskId++, subject, description, status: "pending", owner: "", worktree: "", worktree_state: "unbound", last_worktree: "", closeout: null, blockedBy: [], created_at: Date.now() / 1000, updated_at: Date.now() / 1000 };
  saveTask(task); return JSON.stringify(task, null, 2);
}

function getTask(taskId: number): string { return JSON.stringify(loadTask(taskId), null, 2); }

function updateTask(taskId: number, status?: string, owner?: string): string {
  const task = loadTask(taskId);
  if (status) { if (!["pending", "in_progress", "completed", "deleted"].includes(status)) throw new Error(`Invalid status: ${status}`); task.status = status; }
  if (owner !== undefined) task.owner = owner;
  task.updated_at = Date.now() / 1000;
  saveTask(task); return JSON.stringify(task, null, 2);
}

function bindWorktree(taskId: number, worktree: string, owner = ""): string {
  const task = loadTask(taskId);
  task.worktree = worktree; task.last_worktree = worktree; task.worktree_state = "active";
  if (owner) task.owner = owner;
  if (task.status === "pending") task.status = "in_progress";
  task.updated_at = Date.now() / 1000;
  saveTask(task); return JSON.stringify(task, null, 2);
}

function recordTaskCloseout(taskId: number, action: string, reason = "", keepBinding = false): string {
  const task = loadTask(taskId);
  task.closeout = { action, reason, at: Date.now() / 1000 };
  task.worktree_state = action;
  if (!keepBinding) task.worktree = "";
  task.updated_at = Date.now() / 1000;
  saveTask(task); return JSON.stringify(task, null, 2);
}

function listTasks(): string {
  const files = fs.readdirSync(TASKS_DIR).filter((f) => /^task_\d+\.json$/.test(f)).sort();
  if (!files.length) return "No tasks.";
  return files.map((f) => {
    const t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf-8"));
    const marker = ({ pending: "[ ]", in_progress: "[>]", completed: "[x]", deleted: "[-]" } as any)[t.status] ?? "[?]";
    const owner = t.owner ? ` owner=${t.owner}` : "";
    const wt = t.worktree ? ` wt=${t.worktree}` : "";
    return `${marker} #${t.id}: ${t.subject}${owner}${wt}`;
  }).join("\n");
}

// -- WorktreeManager --
function loadIndex(): Record<string, any> {
  if (!fs.existsSync(WORKTREE_INDEX)) return { worktrees: [] };
  return JSON.parse(fs.readFileSync(WORKTREE_INDEX, "utf-8"));
}

function saveIndex(data: Record<string, any>): void {
  fs.mkdirSync(path.dirname(WORKTREE_INDEX), { recursive: true });
  fs.writeFileSync(WORKTREE_INDEX, JSON.stringify(data, null, 2), "utf-8");
}

function findWt(name: string): Record<string, any> | undefined {
  return loadIndex().worktrees.find((w: any) => w.name === name);
}

function updateWtEntry(name: string, changes: Record<string, any>): Record<string, any> {
  const idx = loadIndex();
  const entry = idx.worktrees.find((w: any) => w.name === name);
  if (!entry) throw new Error(`Worktree '${name}' not found in index`);
  Object.assign(entry, changes);
  saveIndex(idx);
  return entry;
}

function isGitAvailable(): boolean {
  try { return spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: REPO_ROOT, timeout: 5000 }).status === 0; }
  catch { return false; }
}

function runGit(args: string[]): string {
  const r = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8", timeout: 120000 });
  if (r.status !== 0) throw new Error(((r.stdout ?? "") + (r.stderr ?? "")).trim() || `git ${args.join(" ")} failed`);
  return ((r.stdout ?? "") + (r.stderr ?? "")).trim() || "(no output)";
}

function validateWtName(name: string): void {
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(name)) throw new Error("Invalid worktree name. Use 1-40 chars: letters, digits, ., _, -");
}

const gitAvailable = isGitAvailable();

function createWorktree(name: string, taskId?: number, baseRef = "HEAD"): string {
  validateWtName(name);
  if (findWt(name)) throw new Error(`Worktree '${name}' already exists`);
  if (taskId !== undefined && !fs.existsSync(path.join(TASKS_DIR, `task_${taskId}.json`))) throw new Error(`Task ${taskId} not found`);
  const wtPath = path.join(WORKTREES_DIR, name);
  const branch = `wt/${name}`;
  emitEvent("worktree.create.before", { task_id: taskId, worktree: name });
  try {
    if (!gitAvailable) throw new Error("Not in a git repository.");
    runGit(["worktree", "add", "-b", branch, wtPath, baseRef]);
    const entry = { name, path: wtPath, branch, task_id: taskId, status: "active", created_at: Date.now() / 1000 };
    const idx = loadIndex(); idx.worktrees.push(entry); saveIndex(idx);
    if (taskId !== undefined) bindWorktree(taskId, name);
    emitEvent("worktree.create.after", { task_id: taskId, worktree: name });
    return JSON.stringify(entry, null, 2);
  } catch (e: any) {
    emitEvent("worktree.create.failed", { task_id: taskId, worktree: name, error: e.message });
    throw e;
  }
}

function listWorktrees(): string {
  const wts: any[] = loadIndex().worktrees;
  if (!wts.length) return "No worktrees in index.";
  return wts.map((wt) => {
    const suffix = wt.task_id != null ? ` task=${wt.task_id}` : "";
    return `[${wt.status ?? "?"}] ${wt.name} -> ${wt.path} (${wt.branch ?? "-"})${suffix}`;
  }).join("\n");
}

function worktreeStatus(name: string): string {
  const wt = findWt(name);
  if (!wt) return `Error: Unknown worktree '${name}'`;
  if (!fs.existsSync(wt.path)) return `Error: Worktree path missing: ${wt.path}`;
  const r = spawnSync("git", ["status", "--short", "--branch"], { cwd: wt.path, encoding: "utf-8", timeout: 30000 });
  return ((r.stdout ?? "") + (r.stderr ?? "")).trim() || "Clean worktree";
}

function worktreeEnter(name: string): string {
  const wt = findWt(name);
  if (!wt) return `Error: Unknown worktree '${name}'`;
  if (!fs.existsSync(wt.path)) return `Error: Worktree path missing: ${wt.path}`;
  const updated = updateWtEntry(name, { last_entered_at: Date.now() / 1000 });
  emitEvent("worktree.enter", { task_id: wt.task_id, worktree: name, path: wt.path });
  return JSON.stringify(updated, null, 2);
}

function worktreeRun(name: string, command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) return "Error: Dangerous command blocked";
  const wt = findWt(name);
  if (!wt) return `Error: Unknown worktree '${name}'`;
  if (!fs.existsSync(wt.path)) return `Error: Worktree path missing: ${wt.path}`;
  try {
    updateWtEntry(name, { last_entered_at: Date.now() / 1000, last_command_at: Date.now() / 1000, last_command_preview: command.slice(0, 120) });
    emitEvent("worktree.run.before", { task_id: wt.task_id, worktree: name, command: command.slice(0, 120) });
    const out = execSync(command, { cwd: wt.path, timeout: 300000, encoding: "utf-8", stdio: ["pipe","pipe","pipe"] });
    emitEvent("worktree.run.after", { task_id: wt.task_id, worktree: name });
    return out.trim().slice(0, 50000) || "(no output)";
  } catch (e: any) {
    if (e.signal === "SIGTERM") { emitEvent("worktree.run.timeout", { task_id: wt.task_id, worktree: name }); return "Error: Timeout (300s)"; }
    return (((e.stdout || "") + (e.stderr || "")).trim()).slice(0, 50000) || `Error: ${e.message}`;
  }
}

function worktreeCloseout(name: string, action: "keep" | "remove", reason = "", force = false, completeTask = false): string {
  if (action === "keep") {
    const wt = findWt(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    if (wt.task_id != null) { recordTaskCloseout(wt.task_id, "kept", reason, true); if (completeTask) updateTask(wt.task_id, "completed"); }
    updateWtEntry(name, { status: "kept", kept_at: Date.now() / 1000, closeout: { action: "keep", reason, at: Date.now() / 1000 } });
    emitEvent("worktree.closeout.keep", { task_id: wt.task_id, worktree: name, reason });
    return JSON.stringify(findWt(name), null, 2);
  }
  if (action === "remove") {
    const wt = findWt(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    const taskId = wt.task_id;
    emitEvent("worktree.remove.before", { task_id: taskId, worktree: name });
    try {
      if (!gitAvailable) throw new Error("Not in a git repository.");
      const args = ["worktree", "remove"];
      if (force) args.push("--force");
      args.push(wt.path);
      runGit(args);
      if (completeTask && taskId != null) { updateTask(taskId, "completed"); emitEvent("task.completed", { task_id: taskId, worktree: name }); }
      if (taskId != null) recordTaskCloseout(taskId, "removed", reason);
      updateWtEntry(name, { status: "removed", removed_at: Date.now() / 1000, closeout: { action: "remove", reason, at: Date.now() / 1000 } });
      emitEvent("worktree.remove.after", { task_id: taskId, worktree: name });
      return `Removed worktree '${name}'`;
    } catch (e: any) {
      emitEvent("worktree.remove.failed", { task_id: taskId, worktree: name, error: e.message });
      return `Error: ${e.message}`;
    }
  }
  return "Error: action must be 'keep' or 'remove'";
}

// -- Utility tools --
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR + path.sep) && resolved !== WORKDIR) throw new Error(`Path escapes workspace: ${p}`);
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
  try { const fp = safePath(p); fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, content, "utf-8"); return `Wrote ${content.length} bytes`; }
  catch (e: any) { return `Error: ${e.message}`; }
}

function runEdit(p: string, oldText: string, newText: string): string {
  try { const fp = safePath(p); const c = fs.readFileSync(fp, "utf-8"); if (!c.includes(oldText)) return `Error: Text not found in ${p}`; fs.writeFileSync(fp, c.replace(oldText, newText), "utf-8"); return `Edited ${p}`; }
  catch (e: any) { return `Error: ${e.message}`; }
}

const TOOL_HANDLERS: Record<string, (kw: Record<string, any>) => string> = {
  bash:               (kw) => runBash(kw.command),
  read_file:          (kw) => runRead(kw.path, kw.limit),
  write_file:         (kw) => runWrite(kw.path, kw.content),
  edit_file:          (kw) => runEdit(kw.path, kw.old_text, kw.new_text),
  task_create:        (kw) => createTask(kw.subject, kw.description ?? ""),
  task_list:          (_kw) => listTasks(),
  task_get:           (kw) => getTask(kw.task_id),
  task_update:        (kw) => updateTask(kw.task_id, kw.status, kw.owner),
  task_bind_worktree: (kw) => bindWorktree(kw.task_id, kw.worktree, kw.owner ?? ""),
  worktree_create:    (kw) => createWorktree(kw.name, kw.task_id, kw.base_ref ?? "HEAD"),
  worktree_list:      (_kw) => listWorktrees(),
  worktree_enter:     (kw) => worktreeEnter(kw.name),
  worktree_status:    (kw) => worktreeStatus(kw.name),
  worktree_run:       (kw) => worktreeRun(kw.name, kw.command),
  worktree_closeout:  (kw) => worktreeCloseout(kw.name, kw.action, kw.reason ?? "", kw.force ?? false, kw.complete_task ?? false),
  worktree_remove:    (kw) => worktreeCloseout(kw.name, "remove", kw.reason ?? "", kw.force ?? false, kw.complete_task ?? false),
  worktree_keep:      (kw) => worktreeCloseout(kw.name, "keep"),
  worktree_events:    (kw) => listRecentEvents(kw.limit ?? 20),
};

const TOOLS: Anthropic.Tool[] = [
  { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "task_create", description: "Create a new task.", input_schema: { type: "object", properties: { subject: { type: "string" }, description: { type: "string" } }, required: ["subject"] } },
  { name: "task_list", description: "List all tasks.", input_schema: { type: "object", properties: {} } },
  { name: "task_get", description: "Get task details.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
  { name: "task_update", description: "Update task status or owner.", input_schema: { type: "object", properties: { task_id: { type: "integer" }, status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] }, owner: { type: "string" } }, required: ["task_id"] } },
  { name: "task_bind_worktree", description: "Bind a task to a worktree name.", input_schema: { type: "object", properties: { task_id: { type: "integer" }, worktree: { type: "string" }, owner: { type: "string" } }, required: ["task_id", "worktree"] } },
  { name: "worktree_create", description: "Create a git worktree.", input_schema: { type: "object", properties: { name: { type: "string" }, task_id: { type: "integer" }, base_ref: { type: "string" } }, required: ["name"] } },
  { name: "worktree_list", description: "List worktrees.", input_schema: { type: "object", properties: {} } },
  { name: "worktree_enter", description: "Enter a worktree lane.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "worktree_status", description: "Show git status for a worktree.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "worktree_run", description: "Run a command in a worktree.", input_schema: { type: "object", properties: { name: { type: "string" }, command: { type: "string" } }, required: ["name", "command"] } },
  { name: "worktree_closeout", description: "Close out a lane: keep or remove.", input_schema: { type: "object", properties: { name: { type: "string" }, action: { type: "string", enum: ["keep", "remove"] }, reason: { type: "string" }, force: { type: "boolean" }, complete_task: { type: "boolean" } }, required: ["name", "action"] } },
  { name: "worktree_remove", description: "Remove a worktree.", input_schema: { type: "object", properties: { name: { type: "string" }, force: { type: "boolean" }, complete_task: { type: "boolean" }, reason: { type: "string" } }, required: ["name"] } },
  { name: "worktree_keep", description: "Mark a worktree as kept.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "worktree_events", description: "List recent lifecycle events.", input_schema: { type: "object", properties: { limit: { type: "integer" } } } },
];

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({ model: MODEL, system: SYSTEM, messages, tools: TOOLS, max_tokens: 8000 });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        let output: string;
        try { output = handler ? handler(block.input as Record<string, any>) : `Unknown tool: ${block.name}`; }
        catch (e: any) { output = `Error: ${e.message}`; }
        console.log(`> ${block.name}: ${String(output).slice(0, 200)}`);
        results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
      }
    }
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  console.log(`Repo root for s18: ${REPO_ROOT}`);
  if (!gitAvailable) console.log("Note: Not in a git repo. worktree_* tools will return errors.");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "\x1b[36ms18 >> \x1b[0m" });
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
