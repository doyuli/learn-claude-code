#!/usr/bin/env npx ts-node
// Harness: team mailboxes -- multiple models, coordinated through files.
/**
 * s15_agent_teams.ts - Agent Teams
 *
 * Persistent named agents with file-based JSONL inboxes. Each teammate runs
 * its own agent loop in a separate thread. Communication happens through
 * append-only inbox files.
 *
 *     Subagent (s04):  spawn -> execute -> return summary -> destroyed
 *     Teammate (s15):  spawn -> work -> idle -> work -> ... -> shutdown
 *
 * Key idea: teammates have names, inboxes, and independent loops.
 */

import Anthropic from "@anthropic-ai/sdk";
import * as readline from "readline";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import "dotenv/config";

// Worker thread: runs the teammate agent loop
if (!isMainThread && workerData?.isTeammateWorker) {
  const { name, role, prompt, workdir, model, baseURL, authToken } = workerData;
  const Anthropic_ = require("@anthropic-ai/sdk").default;
  const fs_ = require("fs");
  const path_ = require("path");

  const client_ = new Anthropic_({ baseURL, apiKey: authToken || process.env.ANTHROPIC_API_KEY });
  const inboxDir = path_.join(workdir, ".team", "inbox");
  const inboxPath = path_.join(inboxDir, `${name}.jsonl`);

  function readInbox(): any[] {
    if (!fs_.existsSync(inboxPath)) return [];
    const lines = fs_.readFileSync(inboxPath, "utf-8").trim().split("\n").filter(Boolean);
    fs_.writeFileSync(inboxPath, "", "utf-8");
    return lines.map((l: string) => JSON.parse(l));
  }

  function sendMsg(to: string, content: string, msgType = "message", extra: Record<string, any> = {}): string {
    const msg = { type: msgType, from: name, content, timestamp: Date.now() / 1000, ...extra };
    const toPath = path_.join(inboxDir, `${to}.jsonl`);
    fs_.appendFileSync(toPath, JSON.stringify(msg) + "\n", "utf-8");
    return `Sent ${msgType} to ${to}`;
  }

  const sysPrompt = `You are '${name}', role: ${role}, at ${workdir}. Use send_message to communicate. Complete your task.`;
  const messages: any[] = [{ role: "user", content: prompt }];
  const tools = [
    { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
    { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
    { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
    { name: "send_message", description: "Send message to a teammate.", input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string" } }, required: ["to", "content"] } },
    { name: "read_inbox", description: "Read and drain your inbox.", input_schema: { type: "object", properties: {} } },
  ];

  (async () => {
    for (let i = 0; i < 50; i++) {
      const inbox = readInbox();
      for (const msg of inbox) messages.push({ role: "user", content: JSON.stringify(msg) });
      let response: any;
      try {
        response = await client_.messages.create({ model, system: sysPrompt, messages, tools, max_tokens: 8000 });
      } catch { break; }
      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason !== "tool_use") break;
      const results: any[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const inp: any = block.input;
        let output: string;
        if (block.name === "bash") {
          try { output = execSync(inp.command, { cwd: workdir, encoding: "utf-8" }).trim() || "(no output)"; }
          catch (e: any) { output = `Error: ${e.message}`; }
        } else if (block.name === "send_message") {
          output = sendMsg(inp.to, inp.content, inp.msg_type ?? "message");
        } else if (block.name === "read_inbox") {
          output = JSON.stringify(readInbox(), null, 2);
        } else {
          output = `Unknown tool: ${block.name}`;
        }
        parentPort?.postMessage({ type: "log", name, tool: block.name, output: String(output).slice(0, 120) });
        results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
      }
      messages.push({ role: "user", content: results });
    }
    parentPort?.postMessage({ type: "done", name });
  })();
}

if (!isMainThread) { /* don't run main if worker */ }
else {

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID!;
const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");

const SYSTEM = `You are a team lead at ${WORKDIR}. Spawn teammates and communicate via inboxes.`;

const VALID_MSG_TYPES = new Set(["message", "broadcast", "shutdown_request", "shutdown_response", "plan_approval", "plan_approval_response"]);

interface TeamMember { name: string; role: string; status: string; }
interface TeamConfig { team_name: string; members: TeamMember[]; }

class MessageBus {
  constructor(private dir: string) { fs.mkdirSync(dir, { recursive: true }); }

  send(sender: string, to: string, content: string, msgType = "message", extra: Record<string, any> = {}): string {
    if (!VALID_MSG_TYPES.has(msgType)) return `Error: Invalid type '${msgType}'`;
    const msg = { type: msgType, from: sender, content, timestamp: Date.now() / 1000, ...extra };
    fs.appendFileSync(path.join(this.dir, `${to}.jsonl`), JSON.stringify(msg) + "\n", "utf-8");
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string): any[] {
    const p = path.join(this.dir, `${name}.jsonl`);
    if (!fs.existsSync(p)) return [];
    const msgs = fs.readFileSync(p, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    fs.writeFileSync(p, "", "utf-8");
    return msgs;
  }

  broadcast(sender: string, content: string, teammates: string[]): string {
    let count = 0;
    for (const name of teammates) {
      if (name !== sender) { this.send(sender, name, content, "broadcast"); count++; }
    }
    return `Broadcast to ${count} teammates`;
  }
}

const BUS = new MessageBus(INBOX_DIR);

class TeammateManager {
  private configPath: string;
  private config: TeamConfig;
  private workers: Map<string, Worker> = new Map();

  constructor(private teamDir: string) {
    fs.mkdirSync(teamDir, { recursive: true });
    this.configPath = path.join(teamDir, "config.json");
    this.config = this._loadConfig();
  }

  private _loadConfig(): TeamConfig {
    if (fs.existsSync(this.configPath)) return JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
    return { team_name: "default", members: [] };
  }

  private _saveConfig(): void {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), "utf-8");
  }

  private _findMember(name: string): TeamMember | undefined {
    return this.config.members.find((m) => m.name === name);
  }

  spawn(name: string, role: string, prompt: string): string {
    const existing = this._findMember(name);
    if (existing) {
      if (!["idle", "shutdown"].includes(existing.status)) return `Error: '${name}' is currently ${existing.status}`;
      existing.status = "working"; existing.role = role;
    } else {
      this.config.members.push({ name, role, status: "working" });
    }
    this._saveConfig();

    const worker = new Worker(__filename, {
      workerData: {
        isTeammateWorker: true, name, role, prompt, workdir: WORKDIR, model: MODEL,
        baseURL: process.env.ANTHROPIC_BASE_URL, authToken: process.env.ANTHROPIC_API_KEY,
      },
    });
    worker.on("message", (msg: { type: string; name: string; tool?: string; output?: string }) => {
      if (msg.type === "log") console.log(`  [${msg.name}] ${msg.tool}: ${msg.output}`);
      else if (msg.type === "done") {
        const m = this._findMember(msg.name);
        if (m) { m.status = "idle"; this._saveConfig(); }
      }
    });
    this.workers.set(name, worker);
    return `Spawned '${name}' (role: ${role})`;
  }

  listAll(): string {
    if (!this.config.members.length) return "No teammates.";
    const lines = [`Team: ${this.config.team_name}`];
    for (const m of this.config.members) lines.push(`  ${m.name} (${m.role}): ${m.status}`);
    return lines.join("\n");
  }

  memberNames(): string[] { return this.config.members.map((m) => m.name); }
}

const TEAM = new TeammateManager(TEAM_DIR);

const TOOL_HANDLERS: Record<string, (kw: Record<string, any>) => string> = {
  bash:           (kw) => { try { return execSync(kw.command, { cwd: WORKDIR, encoding: "utf-8" }).trim() || "(no output)"; } catch (e: any) { return `Error: ${e.message}`; } },
  read_file:      (kw) => { try { return fs.readFileSync(path.resolve(WORKDIR, kw.path), "utf-8").slice(0, 50000); } catch (e: any) { return `Error: ${e.message}`; } },
  write_file:     (kw) => { try { fs.mkdirSync(path.dirname(path.resolve(WORKDIR, kw.path)), { recursive: true }); fs.writeFileSync(path.resolve(WORKDIR, kw.path), kw.content, "utf-8"); return `Wrote ${kw.content.length} bytes`; } catch (e: any) { return `Error: ${e.message}`; } },
  edit_file:      (kw) => { try { const fp = path.resolve(WORKDIR, kw.path); const c = fs.readFileSync(fp, "utf-8"); if (!c.includes(kw.old_text)) return `Error: Text not found`; fs.writeFileSync(fp, c.replace(kw.old_text, kw.new_text), "utf-8"); return `Edited ${kw.path}`; } catch (e: any) { return `Error: ${e.message}`; } },
  spawn_teammate: (kw) => TEAM.spawn(kw.name, kw.role, kw.prompt),
  list_teammates: (_kw) => TEAM.listAll(),
  send_message:   (kw) => BUS.send("lead", kw.to, kw.content, kw.msg_type ?? "message"),
  read_inbox:     (_kw) => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast:      (kw) => BUS.broadcast("lead", kw.content, TEAM.memberNames()),
};

const TOOLS: Anthropic.Tool[] = [
  { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "spawn_teammate", description: "Spawn a persistent teammate that runs in its own thread.", input_schema: { type: "object", properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } }, required: ["name", "role", "prompt"] } },
  { name: "list_teammates", description: "List all teammates with name, role, status.", input_schema: { type: "object", properties: {} } },
  { name: "send_message", description: "Send a message to a teammate's inbox.", input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: [...VALID_MSG_TYPES] } }, required: ["to", "content"] } },
  { name: "read_inbox", description: "Read and drain the lead's inbox.", input_schema: { type: "object", properties: {} } },
  { name: "broadcast", description: "Send a message to all teammates.", input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } },
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
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "\x1b[36ms15 >> \x1b[0m" });
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

} // end isMainThread block
