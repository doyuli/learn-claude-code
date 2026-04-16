#!/usr/bin/env npx ts-node
// Harness: all mechanisms combined -- the complete cockpit for the model.
/**
 * s_full.ts - Capstone Teaching Agent
 *
 * Capstone file that combines the core local mechanisms taught across
 * `s01-s18` into one runnable agent.
 *
 * `s19` (MCP / plugin integration) is still taught as a separate chapter,
 * because external tool connectivity is easier to understand after the local
 * core is already stable.
 *
 * Chapter -> Class/Function mapping:
 *   s01 Agent Loop     -> agentLoop()
 *   s02 Tool Dispatch  -> TOOL_HANDLERS, normalizeMessages()
 *   s03 TodoWrite      -> TodoManager
 *   s04 Subagent       -> runSubagent()
 *   s05 Skill Loading  -> SkillLoader
 *   s06 Context Compact-> maybePersistOutput(), microcompact(), autoCompact()
 *   s07 Permissions    -> PermissionManager (inline in agentLoop)
 *   s08 Hooks          -> (omitted — see s08_hook_system.ts)
 *   s09 Memory         -> (omitted — see s09_memory_system.ts)
 *   s10 System Prompt  -> buildSystemPrompt() / SYSTEM
 *   s11 Error Recovery -> recovery logic inside agentLoop()
 *   s12 Task System    -> TaskManager
 *   s13 Background     -> BackgroundManager
 *   s14 Cron Scheduler -> (omitted — see s14_cron_scheduler.ts)
 *   s15 Agent Teams    -> TeammateManager, MessageBus
 *   s16 Team Protocols -> shutdownRequests, planRequests maps
 *   s17 Autonomous     -> idlePoll(), scanUnclaimedTasks()
 *   s18 Worktree       -> (omitted — see s18_worktree_task_isolation.ts)
 *
 * REPL commands: /compact /tasks /team /inbox
 */

import Anthropic from "@anthropic-ai/sdk";
import * as readline from "readline";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import "dotenv/config";

// ──────────────────────────────────────────────
// SECTION: teammate worker (runs in Worker thread)
// ──────────────────────────────────────────────
if (!isMainThread && workerData?.isFullTeammateWorker) {
  const { name, role, prompt, teamName, workdir, model, baseURL } = workerData as any;
  const Anthropic_ = require("@anthropic-ai/sdk").default;
  const fs_ = require("fs") as typeof fs;
  const path_ = require("path") as typeof path;

  const client_ = new Anthropic_({ baseURL, apiKey: process.env.ANTHROPIC_API_KEY });
  const inboxDir = path_.join(workdir, ".team", "inbox");
  const tasksDir = path_.join(workdir, ".tasks");

  const POLL_INTERVAL_MS = 5000;
  const IDLE_TIMEOUT_MS  = 60000;

  function readInboxW(): any[] {
    const p = path_.join(inboxDir, `${name}.jsonl`);
    if (!fs_.existsSync(p)) return [];
    const msgs = fs_.readFileSync(p, "utf-8").trim().split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
    fs_.writeFileSync(p, "", "utf-8");
    return msgs;
  }

  function sendMsgW(to: string, content: string, msgType = "message"): string {
    fs_.mkdirSync(inboxDir, { recursive: true });
    const msg = { type: msgType, from: name, content, timestamp: Date.now() / 1000 };
    fs_.appendFileSync(path_.join(inboxDir, `${to}.jsonl`), JSON.stringify(msg) + "\n", "utf-8");
    return `Sent ${msgType} to ${to}`;
  }

  function claimTaskW(taskId: number): string {
    const taskPath = path_.join(tasksDir, `task_${taskId}.json`);
    if (!fs_.existsSync(taskPath)) return `Error: Task ${taskId} not found`;
    const t = JSON.parse(fs_.readFileSync(taskPath, "utf-8"));
    t.owner = name; t.status = "in_progress"; t.updated_at = Date.now() / 1000;
    fs_.writeFileSync(taskPath, JSON.stringify(t, null, 2), "utf-8");
    return `Claimed task #${taskId} for ${name}`;
  }

  function tryClaimUnclaimedW(): any | null {
    if (!fs_.existsSync(tasksDir)) return null;
    const files = fs_.readdirSync(tasksDir).filter((f: string) => /^task_\d+\.json$/.test(f)).sort();
    for (const file of files) {
      try {
        const t = JSON.parse(fs_.readFileSync(path_.join(tasksDir, file), "utf-8"));
        if (t.status !== "pending" || t.owner || (t.blockedBy ?? []).length) continue;
        t.owner = name; t.status = "in_progress"; t.updated_at = Date.now() / 1000;
        fs_.writeFileSync(path_.join(tasksDir, file), JSON.stringify(t, null, 2), "utf-8");
        return t;
      } catch { continue; }
    }
    return null;
  }

  const sysPr = `You are '${name}', role: ${role}, team: ${teamName}, at ${workdir}. Use idle when done. You may auto-claim tasks.`;
  const tools = [
    { name: "bash",         description: "Run command.",   input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
    { name: "read_file",    description: "Read file.",     input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "write_file",   description: "Write file.",    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
    { name: "edit_file",    description: "Edit file.",     input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
    { name: "send_message", description: "Send message.",  input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" } }, required: ["to", "content"] } },
    { name: "idle",         description: "Signal no more work.", input_schema: { type: "object", properties: {} } },
    { name: "claim_task",   description: "Claim task by ID.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
  ];

  let identityBlock: any = { role: "user", content: `<identity>You are '${name}', role: ${role}, team: ${teamName}.</identity>` };
  let messages: any[] = [{ role: "user", content: prompt }];

  (async () => {
    while (true) {
      // -- WORK PHASE --
      for (let i = 0; i < 50; i++) {
        const inbox = readInboxW();
        for (const msg of inbox) {
          if (msg.type === "shutdown_request") {
            parentPort?.postMessage({ type: "done", name, shutdown: true });
            return;
          }
          messages.push({ role: "user", content: JSON.stringify(msg) });
        }
        let response: any;
        try { response = await client_.messages.create({ model, system: sysPr, messages, tools, max_tokens: 8000 }); }
        catch { parentPort?.postMessage({ type: "done", name }); return; }
        messages.push({ role: "assistant", content: response.content });
        if (response.stop_reason !== "tool_use") break;
        const results: any[] = [];
        let idleRequested = false;
        for (const block of response.content) {
          if (block.type !== "tool_use") continue;
          const inp: any = block.input;
          let output: string;
          if (block.name === "idle") { idleRequested = true; output = "Entering idle phase."; }
          else if (block.name === "claim_task") output = claimTaskW(inp.task_id);
          else if (block.name === "send_message") output = sendMsgW(inp.to, inp.content);
          else if (block.name === "bash") { try { output = execSync(inp.command, { cwd: workdir, encoding: "utf-8" }).trim() || "(no output)"; } catch (e: any) { output = `Error: ${e.message}`; } }
          else if (block.name === "read_file") { try { output = fs_.readFileSync(path_.resolve(workdir, inp.path), "utf-8").slice(0, 50000); } catch (e: any) { output = `Error: ${e.message}`; } }
          else if (block.name === "write_file") { try { const fp = path_.resolve(workdir, inp.path); fs_.mkdirSync(path_.dirname(fp), { recursive: true }); fs_.writeFileSync(fp, inp.content, "utf-8"); output = `Wrote ${inp.content.length} bytes`; } catch (e: any) { output = `Error: ${e.message}`; } }
          else if (block.name === "edit_file") { try { const fp = path_.resolve(workdir, inp.path); const c = fs_.readFileSync(fp, "utf-8"); output = c.includes(inp.old_text) ? (fs_.writeFileSync(fp, c.replace(inp.old_text, inp.new_text), "utf-8"), `Edited ${inp.path}`) : "Error: Text not found"; } catch (e: any) { output = `Error: ${e.message}`; } }
          else { output = `Unknown tool: ${block.name}`; }
          parentPort?.postMessage({ type: "log", name, tool: block.name, output: String(output).slice(0, 120) });
          results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
        }
        messages.push({ role: "user", content: results });
        if (idleRequested) break;
      }

      // -- IDLE PHASE --
      parentPort?.postMessage({ type: "status", name, status: "idle" });
      const idleStart = Date.now();
      let foundWork = false;
      while (Date.now() - idleStart < IDLE_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const inbox = readInboxW();
        if (inbox.length) {
          if (messages.length <= 3) {
            messages.unshift({ role: "assistant", content: `I am ${name}. Continuing.` });
            messages.unshift(identityBlock);
          }
          for (const msg of inbox) {
            if (msg.type === "shutdown_request") { parentPort?.postMessage({ type: "done", name, shutdown: true }); return; }
            messages.push({ role: "user", content: JSON.stringify(msg) });
          }
          foundWork = true; break;
        }
        const task = tryClaimUnclaimedW();
        if (task) {
          if (messages.length <= 3) {
            messages.unshift({ role: "assistant", content: `I am ${name}. Continuing.` });
            messages.unshift(identityBlock);
          }
          messages.push({ role: "user", content: `<auto-claimed>Task #${task.id}: ${task.subject}\n${task.description ?? ""}</auto-claimed>` });
          messages.push({ role: "assistant", content: `Claimed task #${task.id}. Working on it.` });
          foundWork = true; break;
        }
      }
      if (!foundWork) { parentPort?.postMessage({ type: "done", name }); return; }
      parentPort?.postMessage({ type: "status", name, status: "working" });
    }
  })();
}

if (!isMainThread) { /* skip main */ }
else {

// ──────────────────────────────────────────────
// SECTION: constants & globals
// ──────────────────────────────────────────────
if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR       = process.cwd();
const client        = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL         = process.env.MODEL_ID!;

const TEAM_DIR      = path.join(WORKDIR, ".team");
const INBOX_DIR     = path.join(TEAM_DIR, "inbox");
const TASKS_DIR     = path.join(WORKDIR, ".tasks");
const SKILLS_DIR    = path.join(WORKDIR, "skills");
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");

const TOKEN_THRESHOLD = 100000;

// Persisted-output settings (s06)
const TASK_OUTPUT_DIR              = path.join(WORKDIR, ".task_outputs");
const TOOL_RESULTS_DIR             = path.join(TASK_OUTPUT_DIR, "tool-results");
const PERSIST_TRIGGER_DEFAULT      = 50000;
const PERSIST_TRIGGER_BASH         = 30000;
const CONTEXT_TRUNCATE_CHARS       = 50000;
const PERSISTED_PREVIEW_CHARS      = 2000;
const KEEP_RECENT                  = 3;
const PRESERVE_RESULT_TOOLS        = new Set(["read_file"]);

const VALID_MSG_TYPES = new Set(["message", "broadcast", "shutdown_request", "shutdown_response", "plan_approval_response"]);

// ──────────────────────────────────────────────
// SECTION: persisted_output (s06)
// ──────────────────────────────────────────────
function persistToolResult(toolUseId: string, content: string): string {
  fs.mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
  const safeId = (toolUseId || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_");
  const filePath = path.join(TOOL_RESULTS_DIR, `${safeId}.txt`);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, content, "utf-8");
  return path.relative(WORKDIR, filePath);
}

function formatSize(size: number): string {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / (1024 * 1024)).toFixed(1)}MB`;
}

function previewSlice(text: string, limit: number): [string, boolean] {
  if (text.length <= limit) return [text, false];
  const idx = text.slice(0, limit).lastIndexOf("\n");
  const cut = idx > limit * 0.5 ? idx : limit;
  return [text.slice(0, cut), true];
}

function buildPersistedMarker(storedPath: string, content: string): string {
  const [preview, hasMore] = previewSlice(content, PERSISTED_PREVIEW_CHARS);
  let marker =
    `<persisted-output>\n` +
    `Output too large (${formatSize(content.length)}). Full output saved to: ${storedPath}\n\n` +
    `Preview (first ${formatSize(PERSISTED_PREVIEW_CHARS)}):\n` +
    `${preview}`;
  if (hasMore) marker += "\n...";
  marker += "\n</persisted-output>";
  return marker;
}

function maybePersistOutput(toolUseId: string, output: string, triggerChars = PERSIST_TRIGGER_DEFAULT): string {
  if (output.length <= triggerChars) return output;
  const storedPath = persistToolResult(toolUseId, output);
  return buildPersistedMarker(storedPath, output);
}

// ──────────────────────────────────────────────
// SECTION: base_tools (s02)
// ──────────────────────────────────────────────
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR + path.sep) && resolved !== WORKDIR)
    throw new Error(`Path escapes workspace: ${p}`);
  return resolved;
}

function runBash(command: string, toolUseId = ""): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) return "Error: Dangerous command blocked";
  try {
    const r = execSync(command, { cwd: WORKDIR, timeout: 120000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    const out = r.trim();
    if (!out) return "(no output)";
    return maybePersistOutput(toolUseId, out, PERSIST_TRIGGER_BASH).slice(0, CONTEXT_TRUNCATE_CHARS);
  } catch (e: any) {
    if (e.signal === "SIGTERM") return "Error: Timeout (120s)";
    return (((e.stdout || "") + (e.stderr || "")).trim()).slice(0, CONTEXT_TRUNCATE_CHARS) || `Error: ${e.message}`;
  }
}

function runRead(p: string, toolUseId = "", limit?: number): string {
  try {
    const lines = fs.readFileSync(safePath(p), "utf-8").split("\n");
    const result = limit && limit < lines.length ? [...lines.slice(0, limit), `... (${lines.length - limit} more)`] : lines;
    const out = result.join("\n");
    return maybePersistOutput(toolUseId, out).slice(0, CONTEXT_TRUNCATE_CHARS);
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
    const c = fs.readFileSync(fp, "utf-8");
    if (!c.includes(oldText)) return `Error: Text not found in ${p}`;
    fs.writeFileSync(fp, c.replace(oldText, newText), "utf-8");
    return `Edited ${p}`;
  } catch (e: any) { return `Error: ${e.message}`; }
}

// ──────────────────────────────────────────────
// SECTION: todos (s03)
// ──────────────────────────────────────────────
interface TodoItem { content: string; status: "pending" | "in_progress" | "completed"; activeForm: string; }

class TodoManager {
  items: TodoItem[] = [];

  update(items: any[]): string {
    const validated: TodoItem[] = [];
    let inProgressCount = 0;
    for (let i = 0; i < items.length; i++) {
      const content = String(items[i].content ?? "").trim();
      const status = String(items[i].status ?? "pending").toLowerCase() as TodoItem["status"];
      const activeForm = String(items[i].activeForm ?? "").trim();
      if (!content) throw new Error(`Item ${i}: content required`);
      if (!["pending", "in_progress", "completed"].includes(status)) throw new Error(`Item ${i}: invalid status '${status}'`);
      if (!activeForm) throw new Error(`Item ${i}: activeForm required`);
      if (status === "in_progress") inProgressCount++;
      validated.push({ content, status, activeForm });
    }
    if (validated.length > 20) throw new Error("Max 20 todos");
    if (inProgressCount > 1) throw new Error("Only one in_progress allowed");
    this.items = validated;
    return this.render();
  }

  render(): string {
    if (!this.items.length) return "No todos.";
    const lines = this.items.map((item) => {
      const m = { completed: "[x]", in_progress: "[>]", pending: "[ ]" }[item.status] ?? "[?]";
      const suffix = item.status === "in_progress" ? ` <- ${item.activeForm}` : "";
      return `${m} ${item.content}${suffix}`;
    });
    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }

  hasOpenItems(): boolean {
    return this.items.some((item) => item.status !== "completed");
  }
}

// ──────────────────────────────────────────────
// SECTION: subagent (s04)
// ──────────────────────────────────────────────
async function runSubagent(prompt: string, agentType = "Explore"): Promise<string> {
  const subTools: Anthropic.Tool[] = [
    { name: "bash",      description: "Run command.",  input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
    { name: "read_file", description: "Read file.",    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  ];
  if (agentType !== "Explore") {
    subTools.push(
      { name: "write_file", description: "Write file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
      { name: "edit_file",  description: "Edit file.",  input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
    );
  }
  const subHandlers: Record<string, (kw: Record<string, any>) => string> = {
    bash:       (kw) => runBash(kw.command),
    read_file:  (kw) => runRead(kw.path),
    write_file: (kw) => runWrite(kw.path, kw.content),
    edit_file:  (kw) => runEdit(kw.path, kw.old_text, kw.new_text),
  };
  const subMsgs: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  let resp: Anthropic.Message | null = null;
  for (let i = 0; i < 30; i++) {
    resp = await client.messages.create({ model: MODEL, messages: subMsgs, tools: subTools, max_tokens: 8000 });
    subMsgs.push({ role: "assistant", content: resp.content });
    if (resp.stop_reason !== "tool_use") break;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of resp.content) {
      if (b.type === "tool_use") {
        const h = subHandlers[b.name];
        const out = h ? h(b.input as Record<string, any>) : "Unknown tool";
        results.push({ type: "tool_result", tool_use_id: b.id, content: String(out).slice(0, 50000) });
      }
    }
    subMsgs.push({ role: "user", content: results });
  }
  if (resp) {
    return resp.content.filter((b) => b.type === "text").map((b) => (b as any).text).join("") || "(no summary)";
  }
  return "(subagent failed)";
}

// ──────────────────────────────────────────────
// SECTION: skills (s05)
// ──────────────────────────────────────────────
interface Skill { meta: Record<string, string>; body: string; }

class SkillLoader {
  skills: Record<string, Skill> = {};

  constructor(skillsDir: string) {
    if (!fs.existsSync(skillsDir)) return;
    const allFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === "SKILL.md") allFiles.push(full);
      }
    };
    walk(skillsDir);
    allFiles.sort();
    for (const f of allFiles) {
      const text = fs.readFileSync(f, "utf-8");
      const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      let meta: Record<string, string> = {};
      let body = text;
      if (match) {
        for (const line of match[1].trim().split("\n")) {
          const idx = line.indexOf(":");
          if (idx !== -1) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
        body = match[2].trim();
      }
      const name = meta["name"] ?? path.basename(path.dirname(f));
      this.skills[name] = { meta, body };
    }
  }

  descriptions(): string {
    if (!Object.keys(this.skills).length) return "(no skills)";
    return Object.entries(this.skills).map(([n, s]) => `  - ${n}: ${s.meta["description"] ?? "-"}`).join("\n");
  }

  load(name: string): string {
    const s = this.skills[name];
    if (!s) return `Error: Unknown skill '${name}'. Available: ${Object.keys(this.skills).join(", ")}`;
    return `<skill name="${name}">\n${s.body}\n</skill>`;
  }
}

// ──────────────────────────────────────────────
// SECTION: compression (s06)
// ──────────────────────────────────────────────
function estimateTokens(messages: any[]): number {
  return JSON.stringify(messages).length / 4;
}

function microcompact(messages: any[]): void {
  const toolResults: any[] = [];
  for (const msg of messages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === "tool_result") toolResults.push(part);
      }
    }
  }
  if (toolResults.length <= KEEP_RECENT) return;

  const toolNameMap: Record<string, string> = {};
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type === "tool_use") toolNameMap[block.id] = block.name;
      }
    }
  }
  for (const part of toolResults.slice(0, -KEEP_RECENT)) {
    if (typeof part.content !== "string" || part.content.length <= 100) continue;
    const toolName = toolNameMap[part.tool_use_id ?? ""] ?? "unknown";
    if (PRESERVE_RESULT_TOOLS.has(toolName)) continue;
    part.content = `[Previous: used ${toolName}]`;
  }
}

async function autoCompact(messages: any[], focus?: string): Promise<any[]> {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  fs.writeFileSync(transcriptPath, messages.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf-8");

  const convText = JSON.stringify(messages).slice(0, 80000);
  let prompt =
    "Summarize this conversation for continuity. Structure your summary:\n" +
    "1) Task overview: core request, success criteria, constraints\n" +
    "2) Current state: completed work, files touched, artifacts created\n" +
    "3) Key decisions and discoveries: constraints, errors, failed approaches\n" +
    "4) Next steps: remaining actions, blockers, priority order\n" +
    "5) Context to preserve: user preferences, domain details, commitments\n" +
    "Be concise but preserve critical details.\n";
  if (focus) prompt += `\nPay special attention to: ${focus}\n`;

  const resp = await client.messages.create({
    model: MODEL,
    messages: [{ role: "user", content: prompt + "\n" + convText }],
    max_tokens: 4000,
  });
  const summary = (resp.content[0] as any).text as string;
  const continuation =
    "This session is being continued from a previous conversation that ran out " +
    "of context. The summary below covers the earlier portion of the conversation.\n\n" +
    `${summary}\n\n` +
    "Please continue the conversation from where we left it off without asking " +
    "the user any further questions.";
  return [{ role: "user", content: continuation }];
}

// ──────────────────────────────────────────────
// SECTION: TaskManager (s12)
// ──────────────────────────────────────────────
interface Task {
  id: number; subject: string; description: string;
  status: string; owner: string | null; blockedBy: number[]; blocks: number[];
}

class TaskManager {
  constructor() { fs.mkdirSync(TASKS_DIR, { recursive: true }); }

  private nextId(): number {
    const ids = fs.readdirSync(TASKS_DIR)
      .filter((f) => /^task_\d+\.json$/.test(f))
      .map((f) => parseInt(f.split("_")[1]));
    return (ids.length ? Math.max(...ids) : 0) + 1;
  }

  private load(tid: number): Task {
    const p = path.join(TASKS_DIR, `task_${tid}.json`);
    if (!fs.existsSync(p)) throw new Error(`Task ${tid} not found`);
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  }

  private save(task: Task): void {
    fs.writeFileSync(path.join(TASKS_DIR, `task_${task.id}.json`), JSON.stringify(task, null, 2), "utf-8");
  }

  create(subject: string, description = ""): string {
    const task: Task = { id: this.nextId(), subject, description, status: "pending", owner: null, blockedBy: [], blocks: [] };
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  get(tid: number): string { return JSON.stringify(this.load(tid), null, 2); }

  update(tid: number, status?: string, addBlockedBy?: number[], addBlocks?: number[]): string {
    const task = this.load(tid);
    if (status) {
      task.status = status;
      if (status === "completed") {
        for (const f of fs.readdirSync(TASKS_DIR).filter((f) => /^task_\d+\.json$/.test(f))) {
          const t: Task = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf-8"));
          const idx = t.blockedBy.indexOf(tid);
          if (idx !== -1) { t.blockedBy.splice(idx, 1); this.save(t); }
        }
      }
      if (status === "deleted") {
        const p = path.join(TASKS_DIR, `task_${tid}.json`);
        if (fs.existsSync(p)) fs.unlinkSync(p);
        return `Task ${tid} deleted`;
      }
    }
    if (addBlockedBy) task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
    if (addBlocks)    task.blocks    = [...new Set([...task.blocks, ...addBlocks])];
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  listAll(): string {
    const files = fs.readdirSync(TASKS_DIR).filter((f) => /^task_\d+\.json$/.test(f)).sort();
    if (!files.length) return "No tasks.";
    return files.map((f) => {
      const t: Task = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf-8"));
      const m = ({ pending: "[ ]", in_progress: "[>]", completed: "[x]" } as any)[t.status] ?? "[?]";
      const owner = t.owner ? ` @${t.owner}` : "";
      const blocked = t.blockedBy?.length ? ` (blocked by: ${t.blockedBy})` : "";
      return `${m} #${t.id}: ${t.subject}${owner}${blocked}`;
    }).join("\n");
  }

  claim(tid: number, owner: string): string {
    const task = this.load(tid);
    task.owner = owner; task.status = "in_progress";
    this.save(task);
    return `Claimed task #${tid} for ${owner}`;
  }
}

// ──────────────────────────────────────────────
// SECTION: BackgroundManager (s13)
// ──────────────────────────────────────────────
interface BgTask { status: string; command: string; result: string | null; }

class BackgroundManager {
  private tasks: Record<string, BgTask> = {};
  private notifications: Array<Record<string, any>> = [];

  run(command: string, timeout = 120): string {
    const tid = crypto.randomBytes(4).toString("hex");
    this.tasks[tid] = { status: "running", command, result: null };
    this._exec(tid, command, timeout);
    return `Background task ${tid} started: ${command.slice(0, 80)}`;
  }

  private _exec(tid: string, command: string, timeout: number): void {
    // Use a worker thread to avoid blocking — simplified: spawn in setImmediate
    setImmediate(() => {
      try {
        const r = execSync(command, { cwd: WORKDIR, timeout: timeout * 1000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
        const output = (r || "").trim().slice(0, 50000) || "(no output)";
        this.tasks[tid].status = "completed"; this.tasks[tid].result = output;
      } catch (e: any) {
        const output = (((e.stdout || "") + (e.stderr || "")).trim()).slice(0, 50000) || e.message;
        this.tasks[tid].status = "error"; this.tasks[tid].result = output;
      }
      this.notifications.push({ task_id: tid, status: this.tasks[tid].status, result: (this.tasks[tid].result ?? "").slice(0, 500) });
    });
  }

  check(tid?: string): string {
    if (tid) {
      const t = this.tasks[tid];
      return t ? `[${t.status}] ${t.result ?? "(running)"}` : `Unknown: ${tid}`;
    }
    return Object.entries(this.tasks).map(([k, v]) => `${k}: [${v.status}] ${v.command.slice(0, 60)}`).join("\n") || "No bg tasks.";
  }

  drain(): Array<Record<string, any>> {
    const notifs = [...this.notifications];
    this.notifications = [];
    return notifs;
  }
}

// ──────────────────────────────────────────────
// SECTION: MessageBus (s15)
// ──────────────────────────────────────────────
class MessageBus {
  constructor() { fs.mkdirSync(INBOX_DIR, { recursive: true }); }

  send(sender: string, to: string, content: string, msgType = "message", extra: Record<string, any> = {}): string {
    if (!VALID_MSG_TYPES.has(msgType)) return `Error: Invalid type '${msgType}'`;
    const msg = { type: msgType, from: sender, content, timestamp: Date.now() / 1000, ...extra };
    fs.appendFileSync(path.join(INBOX_DIR, `${to}.jsonl`), JSON.stringify(msg) + "\n", "utf-8");
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string): any[] {
    const p = path.join(INBOX_DIR, `${name}.jsonl`);
    if (!fs.existsSync(p)) return [];
    const msgs = fs.readFileSync(p, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    fs.writeFileSync(p, "", "utf-8");
    return msgs;
  }

  broadcast(sender: string, content: string, names: string[]): string {
    let count = 0;
    for (const n of names) { if (n !== sender) { this.send(sender, n, content, "broadcast"); count++; } }
    return `Broadcast to ${count} teammates`;
  }
}

// ──────────────────────────────────────────────
// SECTION: shutdown + plan tracking (s16)
// ──────────────────────────────────────────────
const shutdownRequests: Record<string, { target: string; status: string }> = {};
const planRequests: Record<string, { from: string; status: string }> = {};

// ──────────────────────────────────────────────
// SECTION: TeammateManager (s15/s17)
// ──────────────────────────────────────────────
interface TeamMember { name: string; role: string; status: string; }
interface TeamConfig  { team_name: string; members: TeamMember[]; }

class TeammateManager {
  private configPath = path.join(TEAM_DIR, "config.json");
  private config: TeamConfig;

  constructor(private bus: MessageBus) {
    fs.mkdirSync(TEAM_DIR, { recursive: true });
    this.config = fs.existsSync(this.configPath)
      ? JSON.parse(fs.readFileSync(this.configPath, "utf-8"))
      : { team_name: "default", members: [] };
  }

  private save() { fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), "utf-8"); }
  private find(name: string) { return this.config.members.find((m) => m.name === name); }

  spawn(name: string, role: string, prompt: string): string {
    const existing = this.find(name);
    if (existing) {
      if (!["idle", "shutdown"].includes(existing.status)) return `Error: '${name}' is currently ${existing.status}`;
      existing.status = "working"; existing.role = role;
    } else {
      this.config.members.push({ name, role, status: "working" });
    }
    this.save();
    const worker = new Worker(__filename, {
      workerData: { isFullTeammateWorker: true, name, role, prompt, teamName: this.config.team_name, workdir: WORKDIR, model: MODEL, baseURL: process.env.ANTHROPIC_BASE_URL },
    });
    worker.on("message", (msg: any) => {
      if (msg.type === "log") console.log(`  [${msg.name}] ${msg.tool}: ${msg.output}`);
      else if (msg.type === "status") {
        const m = this.find(msg.name); if (m) { m.status = msg.status; this.save(); }
      }
      else if (msg.type === "done") {
        const m = this.find(msg.name); if (m) { m.status = msg.shutdown ? "shutdown" : "idle"; this.save(); }
      }
    });
    return `Spawned '${name}' (role: ${role})`;
  }

  listAll(): string {
    if (!this.config.members.length) return "No teammates.";
    return [`Team: ${this.config.team_name}`, ...this.config.members.map((m) => `  ${m.name} (${m.role}): ${m.status}`)].join("\n");
  }

  memberNames(): string[] { return this.config.members.map((m) => m.name); }
}

// ──────────────────────────────────────────────
// SECTION: global instances
// ──────────────────────────────────────────────
const TODO     = new TodoManager();
const SKILLS   = new SkillLoader(SKILLS_DIR);
const TASK_MGR = new TaskManager();
const BG       = new BackgroundManager();
const BUS      = new MessageBus();
const TEAM     = new TeammateManager(BUS);

// ──────────────────────────────────────────────
// SECTION: system prompt (s10)
// ──────────────────────────────────────────────
const SYSTEM =
  `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.\n` +
  `Prefer task_create/task_update/task_list for multi-step work. Use TodoWrite for short checklists.\n` +
  `Use task for subagent delegation. Use load_skill for specialized knowledge.\n` +
  `Skills: ${SKILLS.descriptions()}`;

// ──────────────────────────────────────────────
// SECTION: shutdown_protocol (s16)
// ──────────────────────────────────────────────
function handleShutdownRequest(teammate: string): string {
  const reqId = crypto.randomBytes(4).toString("hex");
  shutdownRequests[reqId] = { target: teammate, status: "pending" };
  BUS.send("lead", teammate, "Please shut down.", "shutdown_request", { request_id: reqId });
  return `Shutdown request ${reqId} sent to '${teammate}'`;
}

function handlePlanReview(requestId: string, approve: boolean, feedback = ""): string {
  const req = planRequests[requestId];
  if (!req) return `Error: Unknown plan request_id '${requestId}'`;
  req.status = approve ? "approved" : "rejected";
  BUS.send("lead", req.from, feedback, "plan_approval_response", { request_id: requestId, approve, feedback });
  return `Plan ${req.status} for '${req.from}'`;
}

// ──────────────────────────────────────────────
// SECTION: tool_dispatch (s02)
// ──────────────────────────────────────────────
const TOOL_HANDLERS: Record<string, (kw: Record<string, any>) => string | Promise<string>> = {
  bash:             (kw) => runBash(kw.command, kw.tool_use_id ?? ""),
  read_file:        (kw) => runRead(kw.path, kw.tool_use_id ?? "", kw.limit),
  write_file:       (kw) => runWrite(kw.path, kw.content),
  edit_file:        (kw) => runEdit(kw.path, kw.old_text, kw.new_text),
  TodoWrite:        (kw) => TODO.update(kw.items),
  task:             (kw) => runSubagent(kw.prompt, kw.agent_type ?? "Explore"),
  load_skill:       (kw) => SKILLS.load(kw.name),
  compress:         (_kw) => "Compressing...",
  background_run:   (kw) => BG.run(kw.command, kw.timeout ?? 120),
  check_background: (kw) => BG.check(kw.task_id),
  task_create:      (kw) => TASK_MGR.create(kw.subject, kw.description ?? ""),
  task_get:         (kw) => TASK_MGR.get(kw.task_id),
  task_update:      (kw) => TASK_MGR.update(kw.task_id, kw.status, kw.add_blocked_by, kw.add_blocks),
  task_list:        (_kw) => TASK_MGR.listAll(),
  spawn_teammate:   (kw) => TEAM.spawn(kw.name, kw.role, kw.prompt),
  list_teammates:   (_kw) => TEAM.listAll(),
  send_message:     (kw) => BUS.send("lead", kw.to, kw.content, kw.msg_type ?? "message"),
  read_inbox:       (_kw) => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast:        (kw) => BUS.broadcast("lead", kw.content, TEAM.memberNames()),
  shutdown_request: (kw) => handleShutdownRequest(kw.teammate),
  plan_approval:    (kw) => handlePlanReview(kw.request_id, kw.approve, kw.feedback ?? ""),
  idle:             (_kw) => "Lead does not idle.",
  claim_task:       (kw) => TASK_MGR.claim(kw.task_id, "lead"),
};

const TOOLS: Anthropic.Tool[] = [
  { name: "bash",      description: "Run a shell command.",    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.",     input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file",description: "Write content to file.",  input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "TodoWrite", description: "Update task tracking list.", input_schema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] }, activeForm: { type: "string" } }, required: ["content", "status", "activeForm"] } } }, required: ["items"] } },
  { name: "task",      description: "Spawn a subagent for isolated exploration or work.", input_schema: { type: "object", properties: { prompt: { type: "string" }, agent_type: { type: "string", enum: ["Explore", "general-purpose"] } }, required: ["prompt"] } },
  { name: "load_skill",description: "Load specialized knowledge by name.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "compress",  description: "Manually compress conversation context.", input_schema: { type: "object", properties: { focus: { type: "string" } } } },
  { name: "background_run",   description: "Run command in background thread.", input_schema: { type: "object", properties: { command: { type: "string" }, timeout: { type: "integer" } }, required: ["command"] } },
  { name: "check_background", description: "Check background task status.",     input_schema: { type: "object", properties: { task_id: { type: "string" } } } },
  { name: "task_create", description: "Create a persistent file task.",          input_schema: { type: "object", properties: { subject: { type: "string" }, description: { type: "string" } }, required: ["subject"] } },
  { name: "task_get",    description: "Get task details by ID.",                 input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
  { name: "task_update", description: "Update task status or dependencies.",     input_schema: { type: "object", properties: { task_id: { type: "integer" }, status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] }, add_blocked_by: { type: "array", items: { type: "integer" } }, add_blocks: { type: "array", items: { type: "integer" } } }, required: ["task_id"] } },
  { name: "task_list",   description: "List all tasks.",                         input_schema: { type: "object", properties: {} } },
  { name: "spawn_teammate",  description: "Spawn a persistent autonomous teammate.", input_schema: { type: "object", properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } }, required: ["name", "role", "prompt"] } },
  { name: "list_teammates",  description: "List all teammates.",                     input_schema: { type: "object", properties: {} } },
  { name: "send_message",    description: "Send a message to a teammate.",           input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: [...VALID_MSG_TYPES] } }, required: ["to", "content"] } },
  { name: "read_inbox",      description: "Read and drain the lead's inbox.",        input_schema: { type: "object", properties: {} } },
  { name: "broadcast",       description: "Send message to all teammates.",          input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } },
  { name: "shutdown_request",description: "Request a teammate to shut down.",        input_schema: { type: "object", properties: { teammate: { type: "string" } }, required: ["teammate"] } },
  { name: "plan_approval",   description: "Approve or reject a teammate's plan.",    input_schema: { type: "object", properties: { request_id: { type: "string" }, approve: { type: "boolean" }, feedback: { type: "string" } }, required: ["request_id", "approve"] } },
  { name: "idle",       description: "Enter idle state.",                            input_schema: { type: "object", properties: {} } },
  { name: "claim_task", description: "Claim a task from the board.",                 input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
];

// ──────────────────────────────────────────────
// SECTION: agent_loop (s01 / s06 / s11 / s13)
// ──────────────────────────────────────────────
async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  let roundsWithoutTodo = 0;

  while (true) {
    // s06: compression pipeline
    microcompact(messages);
    if (estimateTokens(messages) > TOKEN_THRESHOLD) {
      console.log("[auto-compact triggered]");
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
    }

    // s13: drain background notifications
    const notifs = BG.drain();
    if (notifs.length) {
      const txt = notifs.map((n) => `[bg:${n.task_id}] ${n.status}: ${n.result}`).join("\n");
      messages.push({ role: "user", content: `<background-results>\n${txt}\n</background-results>` });
      messages.push({ role: "assistant", content: "Noted background results." });
    }

    // s15/s16: check lead inbox
    const inbox = BUS.readInbox("lead");
    if (inbox.length) {
      messages.push({ role: "user", content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>` });
      messages.push({ role: "assistant", content: "Noted inbox messages." });
    }

    // LLM call (s11: catch & surface errors)
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({ model: MODEL, system: SYSTEM, messages, tools: TOOLS, max_tokens: 8000 });
    } catch (e: any) {
      messages.push({ role: "user", content: `[System error: ${e.message}. Please continue.]` });
      continue;
    }

    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;

    // Tool execution
    const results: Anthropic.ToolResultBlockParam[] = [];
    let usedTodo = false;
    let manualCompress = false;
    let compactFocus: string | undefined;

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      if (block.name === "compress") {
        manualCompress = true;
        compactFocus = (block.input as any)?.focus;
      }
      const handler = TOOL_HANDLERS[block.name];
      let output: string;
      try {
        const toolInput: Record<string, any> = { ...(block.input as Record<string, any> ?? {}), tool_use_id: block.id };
        const result = handler ? handler(toolInput) : `Unknown tool: ${block.name}`;
        output = String(await result);
      } catch (e: any) { output = `Error: ${e.message}`; }
      console.log(`> ${block.name}: ${output.slice(0, 200)}`);
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
      if (block.name === "TodoWrite") usedTodo = true;
    }

    // s03: nag reminder when todo workflow is active
    roundsWithoutTodo = usedTodo ? 0 : roundsWithoutTodo + 1;
    if (TODO.hasOpenItems() && roundsWithoutTodo >= 3) {
      results.unshift({ type: "text", text: "<reminder>Update your todos.</reminder>" } as any);
    }

    messages.push({ role: "user", content: results });

    // s06: manual compress
    if (manualCompress) {
      console.log("[manual compact]");
      const compacted = await autoCompact(messages, compactFocus);
      messages.splice(0, messages.length, ...compacted);
    }
  }
}

// ──────────────────────────────────────────────
// SECTION: repl
// ──────────────────────────────────────────────
async function main() {
  const history: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "\x1b[36ms_full >> \x1b[0m" });
  rl.prompt();
  rl.on("line", async (query) => {
    rl.pause();
    if (!query.trim() || ["q", "exit"].includes(query.trim().toLowerCase())) { rl.close(); return; }

    if (query.trim() === "/compact") {
      if (history.length) {
        console.log("[manual compact via /compact]");
        const compacted = await autoCompact(history);
        history.splice(0, history.length, ...compacted);
      }
      rl.resume(); rl.prompt(); return;
    }
    if (query.trim() === "/tasks") { console.log(TASK_MGR.listAll()); rl.resume(); rl.prompt(); return; }
    if (query.trim() === "/team")  { console.log(TEAM.listAll());     rl.resume(); rl.prompt(); return; }
    if (query.trim() === "/inbox") { console.log(JSON.stringify(BUS.readInbox("lead"), null, 2)); rl.resume(); rl.prompt(); return; }

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

} // end isMainThread
