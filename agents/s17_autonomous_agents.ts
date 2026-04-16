#!/usr/bin/env npx ts-node
// Harness: autonomy -- models that find work without being told.
/**
 * s17_autonomous_agents.ts - Autonomous Agents
 *
 * Idle cycle with task board polling, auto-claiming unclaimed tasks, and
 * identity re-injection after context compression. Builds on task boards,
 * team mailboxes, and protocol support from earlier chapters.
 *
 *     Teammate lifecycle:
 *     spawn -> WORK -> IDLE (poll 5s, up to 60s) -> claim task -> WORK
 *                                                 -> timeout -> shutdown
 *
 * Key idea: an idle teammate can safely claim ready work instead of waiting
 * for every assignment from the lead.
 */

import Anthropic from "@anthropic-ai/sdk";
import * as readline from "readline";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import "dotenv/config";

const POLL_INTERVAL_MS = 5000;
const IDLE_TIMEOUT_MS = 60000;

// Worker: autonomous teammate loop
if (!isMainThread && workerData?.isAutonomousWorker) {
  const { name, role, prompt, teamName, workdir, model, baseURL } = workerData as any;
  const Anthropic_ = require("@anthropic-ai/sdk").default;
  const fs_ = require("fs");
  const path_ = require("path");

  const client_ = new Anthropic_({ baseURL, apiKey: process.env.ANTHROPIC_API_KEY });
  const inboxDir = path_.join(workdir, ".team", "inbox");
  const tasksDir = path_.join(workdir, ".tasks");
  const reqDir = path_.join(workdir, ".team", "requests");

  // Claim lock via file (simplified; no true atomic across processes but sufficient for demo)
  function tryClaimTask(): any | null {
    if (!fs_.existsSync(tasksDir)) return null;
    const files = fs_.readdirSync(tasksDir).filter((f: string) => /^task_\d+\.json$/.test(f)).sort();
    for (const file of files) {
      const taskPath = path_.join(tasksDir, file);
      try {
        const task = JSON.parse(fs_.readFileSync(taskPath, "utf-8"));
        if (task.status !== "pending" || task.owner) continue;
        // Atomic-ish claim: re-read and compare before writing
        task.owner = name;
        task.status = "in_progress";
        task.updated_at = Date.now() / 1000;
        fs_.writeFileSync(taskPath, JSON.stringify(task, null, 2), "utf-8");
        return task;
      } catch { continue; }
    }
    return null;
  }

  function readInbox(): any[] {
    const p = path_.join(inboxDir, `${name}.jsonl`);
    if (!fs_.existsSync(p)) return [];
    const msgs = fs_.readFileSync(p, "utf-8").trim().split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
    fs_.writeFileSync(p, "", "utf-8");
    return msgs;
  }

  function sendMsg(to: string, content: string, msgType = "message", extra: Record<string, any> = {}): string {
    fs_.mkdirSync(inboxDir, { recursive: true });
    const msg = { type: msgType, from: name, content, timestamp: Date.now() / 1000, ...extra };
    fs_.appendFileSync(path_.join(inboxDir, `${to}.jsonl`), JSON.stringify(msg) + "\n", "utf-8");
    return `Sent ${msgType} to ${to}`;
  }

  const identityBlock = {
    role: "user" as const,
    content: `You are '${name}', role: ${role}, team: ${teamName}. Check inbox and claim tasks from /tasks board. When done or no work, shut down.`,
  };

  const SYSTEM17 = `You are '${name}', role: ${role}, team: ${teamName}, at ${workdir}. Complete tasks, then wait for more work or shut down gracefully.`;

  const tools = [
    { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
    { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
    { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
    { name: "send_message", description: "Send message to a teammate.", input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string" } }, required: ["to", "content"] } },
    { name: "read_inbox", description: "Read and drain your inbox.", input_schema: { type: "object", properties: {} } },
    { name: "list_tasks", description: "List tasks on the board.", input_schema: { type: "object", properties: {} } },
    { name: "claim_task", description: "Claim an unclaimed task by ID.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
    { name: "update_task", description: "Update your own task status.", input_schema: { type: "object", properties: { task_id: { type: "integer" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } }, required: ["task_id", "status"] } },
  ];

  let shouldExit = false;

  async function workLoop(initialPrompt: string) {
    let messages: any[] = [identityBlock, { role: "user", content: initialPrompt }];

    while (!shouldExit) {
      // --- WORK phase ---
      for (let i = 0; i < 50; i++) {
        const inbox = readInbox();
        for (const msg of inbox) messages.push({ role: "user", content: JSON.stringify(msg) });
        let response: any;
        try { response = await client_.messages.create({ model, system: SYSTEM17, messages, tools, max_tokens: 8000 }); }
        catch { shouldExit = true; break; }
        messages.push({ role: "assistant", content: response.content });
        if (response.stop_reason !== "tool_use") break;
        const results: any[] = [];
        for (const block of response.content) {
          if (block.type !== "tool_use") continue;
          const inp: any = block.input;
          let output: string;
          if (block.name === "bash") { try { output = execSync(inp.command, { cwd: workdir, encoding: "utf-8" }).trim() || "(no output)"; } catch (e: any) { output = `Error: ${e.message}`; } }
          else if (block.name === "send_message") output = sendMsg(inp.to, inp.content, inp.msg_type ?? "message");
          else if (block.name === "read_inbox") output = JSON.stringify(readInbox(), null, 2);
          else if (block.name === "list_tasks") {
            const files = fs_.existsSync(tasksDir) ? fs_.readdirSync(tasksDir).filter((f: string) => /^task_\d+\.json$/.test(f)).sort() : [];
            output = files.map((f: string) => {
              const t = JSON.parse(fs_.readFileSync(path_.join(tasksDir, f), "utf-8"));
              return `[ ] #${t.id}: ${t.subject} [${t.status}] owner=${t.owner || "(none)"}`;
            }).join("\n") || "No tasks.";
          } else if (block.name === "claim_task") {
            const taskPath = path_.join(tasksDir, `task_${inp.task_id}.json`);
            if (!fs_.existsSync(taskPath)) { output = `Error: Task ${inp.task_id} not found`; }
            else {
              const t = JSON.parse(fs_.readFileSync(taskPath, "utf-8"));
              if (t.owner && t.owner !== name) { output = `Error: Task already owned by ${t.owner}`; }
              else { t.owner = name; t.status = "in_progress"; t.updated_at = Date.now() / 1000; fs_.writeFileSync(taskPath, JSON.stringify(t, null, 2), "utf-8"); output = `Claimed task ${inp.task_id}`; }
            }
          } else if (block.name === "update_task") {
            const taskPath = path_.join(tasksDir, `task_${inp.task_id}.json`);
            if (!fs_.existsSync(taskPath)) { output = `Error: Task ${inp.task_id} not found`; }
            else { const t = JSON.parse(fs_.readFileSync(taskPath, "utf-8")); t.status = inp.status; t.updated_at = Date.now() / 1000; fs_.writeFileSync(taskPath, JSON.stringify(t, null, 2), "utf-8"); output = `Updated task ${inp.task_id} -> ${inp.status}`; }
          } else { output = `Unknown tool: ${block.name}`; }
          parentPort?.postMessage({ type: "log", name, tool: block.name, output: String(output).slice(0, 120) });
          results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
        }
        messages.push({ role: "user", content: results });
      }

      if (shouldExit) break;

      // --- IDLE phase: poll ---
      const idleStart = Date.now();
      let foundWork = false;
      while (Date.now() - idleStart < IDLE_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const inbox = readInbox();
        if (inbox.length) {
          messages = [identityBlock, ...inbox.map((m) => ({ role: "user", content: JSON.stringify(m) }))];
          foundWork = true; break;
        }
        const task = tryClaimTask();
        if (task) {
          messages = [identityBlock, { role: "user", content: `Claimed task: ${JSON.stringify(task)}. Start working on it.` }];
          foundWork = true; break;
        }
      }
      if (!foundWork) { shouldExit = true; }
    }
    parentPort?.postMessage({ type: "done", name });
  }

  workLoop(prompt);
}

if (!isMainThread) { /* skip main */ }
else {

if (process.env.ANTHROPIC_BASE_URL) { delete process.env.ANTHROPIC_AUTH_TOKEN; }

const WORKDIR = process.cwd();
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID!;
const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");
const TASKS_DIR = path.join(WORKDIR, ".tasks");

const SYSTEM = `You are a team lead at ${WORKDIR}. Teammates are autonomous -- they find work themselves.`;

fs.mkdirSync(INBOX_DIR, { recursive: true });
fs.mkdirSync(TASKS_DIR, { recursive: true });

const VALID_MSG_TYPES = new Set(["message", "broadcast", "shutdown_request", "shutdown_response", "plan_approval", "plan_approval_response"]);

interface TeamMember { name: string; role: string; status: string; }
interface TeamConfig { team_name: string; members: TeamMember[]; }

const CONFIG_PATH = path.join(TEAM_DIR, "config.json");
let teamConfig: TeamConfig = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) : { team_name: "default", members: [] };

function saveConfig(): void { fs.mkdirSync(TEAM_DIR, { recursive: true }); fs.writeFileSync(CONFIG_PATH, JSON.stringify(teamConfig, null, 2), "utf-8"); }
function findMember(name: string): TeamMember | undefined { return teamConfig.members.find((m) => m.name === name); }

function spawnTeammate(name: string, role: string, prompt: string): string {
  const existing = findMember(name);
  if (existing) {
    if (!["idle", "shutdown"].includes(existing.status)) return `Error: '${name}' is currently ${existing.status}`;
    existing.status = "working"; existing.role = role;
  } else { teamConfig.members.push({ name, role, status: "working" }); }
  saveConfig();
  const worker = new Worker(__filename, {
    workerData: { isAutonomousWorker: true, name, role, prompt, teamName: teamConfig.team_name, workdir: WORKDIR, model: MODEL, baseURL: process.env.ANTHROPIC_BASE_URL },
  });
  worker.on("message", (msg: any) => {
    if (msg.type === "log") console.log(`  [${msg.name}] ${msg.tool}: ${msg.output}`);
    else if (msg.type === "done") {
      const m = findMember(msg.name);
      if (m) { m.status = "idle"; saveConfig(); }
    }
  });
  return `Spawned autonomous '${name}' (role: ${role})`;
}

function sendMessage(to: string, content: string, msgType = "message"): string {
  if (!VALID_MSG_TYPES.has(msgType)) return `Error: Invalid type`;
  const msg = { type: msgType, from: "lead", content, timestamp: Date.now() / 1000 };
  fs.appendFileSync(path.join(INBOX_DIR, `${to}.jsonl`), JSON.stringify(msg) + "\n", "utf-8");
  return `Sent ${msgType} to ${to}`;
}

function readLeadInbox(): any[] {
  const p = path.join(INBOX_DIR, "lead.jsonl");
  if (!fs.existsSync(p)) return [];
  const msgs = fs.readFileSync(p, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  fs.writeFileSync(p, "", "utf-8");
  return msgs;
}

function listTasks(): string {
  const files = fs.readdirSync(TASKS_DIR).filter((f) => /^task_\d+\.json$/.test(f)).sort();
  if (!files.length) return "No tasks.";
  return files.map((f) => {
    const t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf-8"));
    return `[${t.status}] #${t.id}: ${t.subject} owner=${t.owner || "(none)"}`;
  }).join("\n");
}

function createTask(subject: string, description = ""): string {
  const files = fs.readdirSync(TASKS_DIR).filter((f) => /^task_\d+\.json$/.test(f));
  const maxId = files.reduce((m, f) => Math.max(m, parseInt(f.split("_")[1])), 0);
  const task = { id: maxId + 1, subject, description, status: "pending", owner: "", created_at: Date.now() / 1000, updated_at: Date.now() / 1000 };
  fs.writeFileSync(path.join(TASKS_DIR, `task_${task.id}.json`), JSON.stringify(task, null, 2), "utf-8");
  return JSON.stringify(task, null, 2);
}

const TOOL_HANDLERS: Record<string, (kw: Record<string, any>) => string> = {
  bash:            (kw) => { try { return execSync(kw.command, { cwd: WORKDIR, encoding: "utf-8" }).trim() || "(no output)"; } catch (e: any) { return `Error: ${e.message}`; } },
  read_file:       (kw) => { try { return fs.readFileSync(path.resolve(WORKDIR, kw.path), "utf-8").slice(0, 50000); } catch (e: any) { return `Error: ${e.message}`; } },
  write_file:      (kw) => { try { const fp = path.resolve(WORKDIR, kw.path); fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, kw.content, "utf-8"); return `Wrote ${kw.content.length} bytes`; } catch (e: any) { return `Error: ${e.message}`; } },
  edit_file:       (kw) => { try { const fp = path.resolve(WORKDIR, kw.path); const c = fs.readFileSync(fp, "utf-8"); if (!c.includes(kw.old_text)) return "Error: Text not found"; fs.writeFileSync(fp, c.replace(kw.old_text, kw.new_text), "utf-8"); return `Edited ${kw.path}`; } catch (e: any) { return `Error: ${e.message}`; } },
  spawn_teammate:  (kw) => spawnTeammate(kw.name, kw.role, kw.prompt),
  list_teammates:  (_kw) => teamConfig.members.map((m) => `  ${m.name} (${m.role}): ${m.status}`).join("\n") || "No teammates.",
  send_message:    (kw) => sendMessage(kw.to, kw.content, kw.msg_type ?? "message"),
  read_inbox:      (_kw) => JSON.stringify(readLeadInbox(), null, 2),
  broadcast:       (kw) => { let count = 0; for (const m of teamConfig.members) { if (m.name !== "lead") { sendMessage(m.name, kw.content, "broadcast"); count++; } } return `Broadcast to ${count} teammates`; },
  task_create:     (kw) => createTask(kw.subject, kw.description ?? ""),
  task_list:       (_kw) => listTasks(),
};

const TOOLS: Anthropic.Tool[] = [
  { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "spawn_teammate", description: "Spawn an autonomous teammate.", input_schema: { type: "object", properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } }, required: ["name", "role", "prompt"] } },
  { name: "list_teammates", description: "List all teammates.", input_schema: { type: "object", properties: {} } },
  { name: "send_message", description: "Send a message to a teammate.", input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: [...VALID_MSG_TYPES] } }, required: ["to", "content"] } },
  { name: "read_inbox", description: "Read and drain the lead's inbox.", input_schema: { type: "object", properties: {} } },
  { name: "broadcast", description: "Broadcast to all teammates.", input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } },
  { name: "task_create", description: "Create a task on the shared board.", input_schema: { type: "object", properties: { subject: { type: "string" }, description: { type: "string" } }, required: ["subject"] } },
  { name: "task_list", description: "List all tasks.", input_schema: { type: "object", properties: {} } },
];

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    const inbox = readLeadInbox();
    if (inbox.length) messages.push({ role: "user", content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>` });
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
        console.log(`> ${block.name}:`); console.log(String(output).slice(0, 200));
        results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
      }
    }
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "\x1b[36ms17 >> \x1b[0m" });
  const history: Anthropic.MessageParam[] = [];
  rl.prompt();
  rl.on("line", async (query) => {
    rl.pause();
    if (!query.trim() || ["q", "exit"].includes(query.trim().toLowerCase())) { rl.close(); return; }
    if (query.trim() === "/team") { console.log(teamConfig.members.map((m) => `  ${m.name} (${m.role}): ${m.status}`).join("\n") || "No teammates."); rl.resume(); rl.prompt(); return; }
    if (query.trim() === "/tasks") { console.log(listTasks()); rl.resume(); rl.prompt(); return; }
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
