#!/usr/bin/env npx ts-node
// Harness: protocols -- structured handshakes between models.
/**
 * s16_team_protocols.ts - Team Protocols
 *
 * Shutdown protocol and plan approval protocol, both using the same
 * request_id correlation pattern. Builds on s15's mailbox-based team messaging.
 *
 * Key idea: one request/response shape can support multiple kinds of team workflow.
 * Protocol requests are structured workflow objects, not normal free-form chat.
 */

import Anthropic from "@anthropic-ai/sdk";
import * as readline from "readline";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import "dotenv/config";

// Worker thread: runs teammate agent loop with protocol tools
if (!isMainThread && workerData?.isTeammateWorker16) {
  const { name, role, prompt, workdir, model, baseURL } = workerData;
  const Anthropic_ = require("@anthropic-ai/sdk").default;
  const fs_ = require("fs");
  const path_ = require("path");

  const client_ = new Anthropic_({ baseURL, apiKey: process.env.ANTHROPIC_API_KEY });
  const inboxDir = path_.join(workdir, ".team", "inbox");
  const reqDir = path_.join(workdir, ".team", "requests");

  function readInbox(): any[] {
    const p = path_.join(inboxDir, `${name}.jsonl`);
    if (!fs_.existsSync(p)) return [];
    const msgs = fs_.readFileSync(p, "utf-8").trim().split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
    fs_.writeFileSync(p, "", "utf-8");
    return msgs;
  }

  function sendMsg(to: string, content: string, msgType = "message", extra: Record<string, any> = {}): string {
    const msg = { type: msgType, from: name, content, timestamp: Date.now() / 1000, ...extra };
    fs_.appendFileSync(path_.join(inboxDir, `${to}.jsonl`), JSON.stringify(msg) + "\n", "utf-8");
    return `Sent ${msgType} to ${to}`;
  }

  const sysPrompt = `You are '${name}', role: ${role}, at ${workdir}. Submit plans via plan_approval before major work. Respond to shutdown_request with shutdown_response.`;
  const messages: any[] = [{ role: "user", content: prompt }];
  let shouldExit = false;

  const tools = [
    { name: "bash", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
    { name: "read_file", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "write_file", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
    { name: "edit_file", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
    { name: "send_message", input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string" } }, required: ["to", "content"] } },
    { name: "read_inbox", input_schema: { type: "object", properties: {} } },
    { name: "shutdown_response", input_schema: { type: "object", properties: { request_id: { type: "string" }, approve: { type: "boolean" }, reason: { type: "string" } }, required: ["request_id", "approve"] } },
    { name: "plan_approval", input_schema: { type: "object", properties: { plan: { type: "string" } }, required: ["plan"] } },
  ].map((t) => ({ ...t, description: t.name }));

  (async () => {
    for (let i = 0; i < 50; i++) {
      const inbox = readInbox();
      for (const msg of inbox) messages.push({ role: "user", content: JSON.stringify(msg) });
      if (shouldExit) break;
      let response: any;
      try { response = await client_.messages.create({ model, system: sysPrompt, messages, tools, max_tokens: 8000 }); }
      catch { break; }
      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason !== "tool_use") break;
      const results: any[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const inp: any = block.input;
        let output: string;
        if (block.name === "send_message") output = sendMsg(inp.to, inp.content, inp.msg_type ?? "message");
        else if (block.name === "read_inbox") output = JSON.stringify(readInbox(), null, 2);
        else if (block.name === "shutdown_response") {
          const reqPath = path_.join(reqDir, `${inp.request_id}.json`);
          if (fs_.existsSync(reqPath)) {
            const req = JSON.parse(fs_.readFileSync(reqPath, "utf-8"));
            req.status = inp.approve ? "approved" : "rejected";
            req.resolved_by = name;
            req.resolved_at = Date.now() / 1000;
            req.response = { approve: inp.approve, reason: inp.reason ?? "" };
            fs_.writeFileSync(reqPath, JSON.stringify(req, null, 2), "utf-8");
          }
          sendMsg("lead", inp.reason ?? "", "shutdown_response", { request_id: inp.request_id, approve: inp.approve });
          if (inp.approve) shouldExit = true;
          output = `Shutdown ${inp.approve ? "approved" : "rejected"}`;
        } else if (block.name === "plan_approval") {
          const reqId = Math.random().toString(36).slice(2, 10);
          const reqPath = path_.join(reqDir, `${reqId}.json`);
          fs_.mkdirSync(reqDir, { recursive: true });
          fs_.writeFileSync(reqPath, JSON.stringify({ request_id: reqId, kind: "plan_approval", from: name, to: "lead", status: "pending", plan: inp.plan, created_at: Date.now() / 1000, updated_at: Date.now() / 1000 }, null, 2), "utf-8");
          sendMsg("lead", inp.plan, "plan_approval", { request_id: reqId, plan: inp.plan });
          output = `Plan submitted (request_id=${reqId}). Waiting for lead approval.`;
        } else {
          try { output = execSync(inp.command ?? "", { cwd: workdir, encoding: "utf-8" }).trim() || "(no output)"; }
          catch (e: any) { output = `Error: ${e.message}`; }
        }
        parentPort?.postMessage({ type: "log", name, tool: block.name, output: String(output).slice(0, 120) });
        results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
      }
      messages.push({ role: "user", content: results });
    }
    parentPort?.postMessage({ type: "done", name, shutdown: shouldExit });
  })();
}

if (!isMainThread) { /* skip main */ }
else {

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID!;
const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");
const REQUESTS_DIR = path.join(TEAM_DIR, "requests");

const SYSTEM = `You are a team lead at ${WORKDIR}. Manage teammates with shutdown and plan approval protocols.`;
const VALID_MSG_TYPES = new Set(["message", "broadcast", "shutdown_request", "shutdown_response", "plan_approval", "plan_approval_response"]);

fs.mkdirSync(INBOX_DIR, { recursive: true });
fs.mkdirSync(REQUESTS_DIR, { recursive: true });

class MessageBus {
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

  broadcast(sender: string, content: string, teammates: string[]): string {
    let count = 0;
    for (const name of teammates) { if (name !== sender) { this.send(sender, name, content, "broadcast"); count++; } }
    return `Broadcast to ${count} teammates`;
  }
}

const BUS = new MessageBus();

interface TeamMember { name: string; role: string; status: string; }
interface TeamConfig { team_name: string; members: TeamMember[]; }

class TeammateManager {
  private configPath = path.join(TEAM_DIR, "config.json");
  private config: TeamConfig;
  private workers: Map<string, Worker> = new Map();

  constructor() {
    fs.mkdirSync(TEAM_DIR, { recursive: true });
    this.config = fs.existsSync(this.configPath) ? JSON.parse(fs.readFileSync(this.configPath, "utf-8")) : { team_name: "default", members: [] };
  }

  private _save(): void { fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), "utf-8"); }
  private _find(name: string): TeamMember | undefined { return this.config.members.find((m) => m.name === name); }
  memberNames(): string[] { return this.config.members.map((m) => m.name); }

  spawn(name: string, role: string, prompt: string): string {
    const existing = this._find(name);
    if (existing) {
      if (!["idle", "shutdown"].includes(existing.status)) return `Error: '${name}' is currently ${existing.status}`;
      existing.status = "working"; existing.role = role;
    } else {
      this.config.members.push({ name, role, status: "working" });
    }
    this._save();
    const worker = new Worker(__filename, {
      workerData: { isTeammateWorker16: true, name, role, prompt, workdir: WORKDIR, model: MODEL, baseURL: process.env.ANTHROPIC_BASE_URL },
    });
    worker.on("message", (msg: any) => {
      if (msg.type === "log") console.log(`  [${msg.name}] ${msg.tool}: ${msg.output}`);
      else if (msg.type === "done") {
        const m = this._find(msg.name);
        if (m) { m.status = msg.shutdown ? "shutdown" : "idle"; this._save(); }
      }
    });
    this.workers.set(name, worker);
    return `Spawned '${name}' (role: ${role})`;
  }

  listAll(): string {
    if (!this.config.members.length) return "No teammates.";
    return [`Team: ${this.config.team_name}`, ...this.config.members.map((m) => `  ${m.name} (${m.role}): ${m.status}`)].join("\n");
  }
}

const TEAM = new TeammateManager();

function handleShutdownRequest(teammate: string): string {
  const reqId = Math.random().toString(36).slice(2, 10);
  const reqPath = path.join(REQUESTS_DIR, `${reqId}.json`);
  fs.writeFileSync(reqPath, JSON.stringify({ request_id: reqId, kind: "shutdown", from: "lead", to: teammate, status: "pending", created_at: Date.now() / 1000, updated_at: Date.now() / 1000 }, null, 2), "utf-8");
  BUS.send("lead", teammate, "Please shut down gracefully.", "shutdown_request", { request_id: reqId });
  return `Shutdown request ${reqId} sent to '${teammate}' (status: pending)`;
}

function handlePlanReview(requestId: string, approve: boolean, feedback = ""): string {
  const reqPath = path.join(REQUESTS_DIR, `${requestId}.json`);
  if (!fs.existsSync(reqPath)) return `Error: Unknown plan request_id '${requestId}'`;
  const req = JSON.parse(fs.readFileSync(reqPath, "utf-8"));
  req.status = approve ? "approved" : "rejected";
  req.reviewed_by = "lead"; req.resolved_at = Date.now() / 1000; req.feedback = feedback;
  fs.writeFileSync(reqPath, JSON.stringify(req, null, 2), "utf-8");
  BUS.send("lead", req.from, feedback, "plan_approval_response", { request_id: requestId, approve, feedback });
  return `Plan ${approve ? "approved" : "rejected"} for '${req.from}'`;
}

const TOOL_HANDLERS: Record<string, (kw: Record<string, any>) => string> = {
  bash:              (kw) => { try { return execSync(kw.command, { cwd: WORKDIR, encoding: "utf-8" }).trim() || "(no output)"; } catch (e: any) { return `Error: ${e.message}`; } },
  read_file:         (kw) => { try { return fs.readFileSync(path.resolve(WORKDIR, kw.path), "utf-8").slice(0, 50000); } catch (e: any) { return `Error: ${e.message}`; } },
  write_file:        (kw) => { try { const fp = path.resolve(WORKDIR, kw.path); fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, kw.content, "utf-8"); return `Wrote ${kw.content.length} bytes`; } catch (e: any) { return `Error: ${e.message}`; } },
  edit_file:         (kw) => { try { const fp = path.resolve(WORKDIR, kw.path); const c = fs.readFileSync(fp, "utf-8"); if (!c.includes(kw.old_text)) return "Error: Text not found"; fs.writeFileSync(fp, c.replace(kw.old_text, kw.new_text), "utf-8"); return `Edited ${kw.path}`; } catch (e: any) { return `Error: ${e.message}`; } },
  spawn_teammate:    (kw) => TEAM.spawn(kw.name, kw.role, kw.prompt),
  list_teammates:    (_kw) => TEAM.listAll(),
  send_message:      (kw) => BUS.send("lead", kw.to, kw.content, kw.msg_type ?? "message"),
  read_inbox:        (_kw) => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast:         (kw) => BUS.broadcast("lead", kw.content, TEAM.memberNames()),
  shutdown_request:  (kw) => handleShutdownRequest(kw.teammate),
  shutdown_response: (kw) => { const p = path.join(REQUESTS_DIR, `${kw.request_id}.json`); return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : `{"error": "not found"}`; },
  plan_approval:     (kw) => handlePlanReview(kw.request_id, kw.approve, kw.feedback ?? ""),
};

const TOOLS: Anthropic.Tool[] = [
  { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "spawn_teammate", description: "Spawn a persistent teammate.", input_schema: { type: "object", properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } }, required: ["name", "role", "prompt"] } },
  { name: "list_teammates", description: "List all teammates.", input_schema: { type: "object", properties: {} } },
  { name: "send_message", description: "Send a message to a teammate.", input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: [...VALID_MSG_TYPES] } }, required: ["to", "content"] } },
  { name: "read_inbox", description: "Read and drain the lead's inbox.", input_schema: { type: "object", properties: {} } },
  { name: "broadcast", description: "Send a message to all teammates.", input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } },
  { name: "shutdown_request", description: "Request a teammate to shut down gracefully.", input_schema: { type: "object", properties: { teammate: { type: "string" } }, required: ["teammate"] } },
  { name: "shutdown_response", description: "Check the status of a shutdown request by request_id.", input_schema: { type: "object", properties: { request_id: { type: "string" } }, required: ["request_id"] } },
  { name: "plan_approval", description: "Approve or reject a teammate's plan.", input_schema: { type: "object", properties: { request_id: { type: "string" }, approve: { type: "boolean" }, feedback: { type: "string" } }, required: ["request_id", "approve"] } },
];

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    const inbox = BUS.readInbox("lead");
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
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "\x1b[36ms16 >> \x1b[0m" });
  const history: Anthropic.MessageParam[] = [];
  rl.prompt();
  rl.on("line", async (query) => {
    rl.pause();
    if (!query.trim() || ["q", "exit"].includes(query.trim().toLowerCase())) { rl.close(); return; }
    if (query.trim() === "/team") { console.log(TEAM.listAll()); rl.resume(); rl.prompt(); return; }
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
