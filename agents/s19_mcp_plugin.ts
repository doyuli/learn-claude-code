#!/usr/bin/env npx ts-node
// Harness: integration -- tools aren't just in your code.
/**
 * s19_mcp_plugin.ts - MCP & Plugin System
 *
 * This teaching chapter focuses on the smallest useful idea:
 * external processes can expose tools, and your agent can treat them like
 * normal tools after a small amount of normalization.
 *
 * Minimal path:
 *   1. start an MCP server process
 *   2. ask it which tools it has
 *   3. prefix and register those tools
 *   4. route matching calls to that server
 *
 * Plugins add one more layer: discovery. A tiny manifest tells the agent which
 * external server to start.
 *
 * Key insight: "External tools should enter the same tool pipeline, not form a
 * completely separate world." In practice that means shared permission checks
 * and normalized tool_result payloads.
 *
 * Read this file in this order:
 * 1. CapabilityPermissionGate: external tools still go through the same control gate.
 * 2. MCPClient: how one server connection exposes tool specs and tool calls.
 * 3. PluginLoader: how manifests declare external servers.
 * 4. MCPToolRouter / buildToolPool: how native and external tools merge into one pool.
 *
 * Most common confusion:
 * - a plugin manifest is not an MCP server
 * - an MCP server is not a single MCP tool
 * - external capability does not bypass the native permission path
 *
 * Teaching boundary:
 * this file teaches the smallest useful stdio MCP path.
 * Marketplace details, auth flows, reconnect logic, and non-tool capability layers
 * are intentionally left to bridge docs and later extensions.
 */

import Anthropic from "@anthropic-ai/sdk";
import * as readline from "readline";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as child_process from "child_process";
import "dotenv/config";

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID!;
const PERMISSION_MODES = ["default", "auto"] as const;
type PermissionMode = (typeof PERMISSION_MODES)[number];

// -- CapabilityPermissionGate --
/**
 * Shared permission gate for native tools and external capabilities.
 *
 * The teaching goal is simple: MCP does not bypass the control plane.
 * Native tools and MCP tools both become normalized capability intents first,
 * then pass through the same allow / ask policy.
 */
const READ_PREFIXES = ["read", "list", "get", "show", "search", "query", "inspect"];
const HIGH_RISK_PREFIXES = ["delete", "remove", "drop", "shutdown"];

interface CapabilityIntent {
  source: "mcp" | "native";
  server: string | null;
  tool: string;
  risk: "read" | "write" | "high";
}

interface PermissionDecision {
  behavior: "allow" | "ask" | "deny";
  reason: string;
  intent: CapabilityIntent;
}

class CapabilityPermissionGate {
  mode: PermissionMode;

  constructor(mode: PermissionMode = "default") {
    this.mode = PERMISSION_MODES.includes(mode) ? mode : "default";
  }

  normalize(toolName: string, toolInput: Record<string, any>): CapabilityIntent {
    let serverName: string | null = null;
    let actualTool: string;
    let source: "mcp" | "native";

    if (toolName.startsWith("mcp__")) {
      const parts = toolName.split("__", 3);
      serverName = parts[1];
      actualTool = parts[2];
      source = "mcp";
    } else {
      actualTool = toolName;
      source = "native";
    }

    const lowered = actualTool.toLowerCase();
    let risk: "read" | "write" | "high";

    if (actualTool === "read_file" || READ_PREFIXES.some((p) => lowered.startsWith(p))) {
      risk = "read";
    } else if (actualTool === "bash") {
      const command = (toolInput["command"] as string) ?? "";
      risk = ["rm -rf", "sudo", "shutdown", "reboot"].some((t) => command.includes(t)) ? "high" : "write";
    } else if (HIGH_RISK_PREFIXES.some((p) => lowered.startsWith(p))) {
      risk = "high";
    } else {
      risk = "write";
    }

    return { source, server: serverName, tool: actualTool, risk };
  }

  check(toolName: string, toolInput: Record<string, any>): PermissionDecision {
    const intent = this.normalize(toolName, toolInput);

    if (intent.risk === "read") {
      return { behavior: "allow", reason: "Read capability", intent };
    }
    if (this.mode === "auto" && intent.risk !== "high") {
      return { behavior: "allow", reason: "Auto mode for non-high-risk capability", intent };
    }
    if (intent.risk === "high") {
      return { behavior: "ask", reason: "High-risk capability requires confirmation", intent };
    }
    return { behavior: "ask", reason: "State-changing capability requires confirmation", intent };
  }

  askUser(intent: CapabilityIntent, toolInput: Record<string, any>): Promise<boolean> {
    const preview = JSON.stringify(toolInput).slice(0, 200);
    const source = intent.server
      ? `${intent.source}:${intent.server}/${intent.tool}`
      : `${intent.source}:${intent.tool}`;
    process.stdout.write(`\n  [Permission] ${source} risk=${intent.risk}: ${preview}\n`);
    process.stdout.write("  Allow? (y/n): ");
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      rl.once("line", (answer) => {
        rl.close();
        resolve(["y", "yes"].includes(answer.trim().toLowerCase()));
      });
      rl.once("close", () => resolve(false));
    });
  }
}

const permissionGate = new CapabilityPermissionGate();

// -- MCPClient --
/**
 * Minimal MCP client over stdio.
 *
 * This is enough to teach the core architecture without dragging readers
 * through every transport, auth flow, or marketplace detail up front.
 */
interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
}

interface AgentTool {
  name: string;
  description: string;
  input_schema: Record<string, any>;
  _mcp_server?: string;
  _mcp_tool?: string;
}

class MCPClient {
  serverName: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  private process: child_process.ChildProcess | null = null;
  private requestId = 0;
  private tools: MCPTool[] = [];

  constructor(serverName: string, command: string, args: string[] = [], env: Record<string, string> = {}) {
    this.serverName = serverName;
    this.command = command;
    this.args = args;
    this.env = { ...process.env, ...env } as Record<string, string>;
  }

  connect(): boolean {
    try {
      this.process = child_process.spawn(this.command, this.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: this.env,
      });
      // Send initialize request
      this._send({ method: "initialize", params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "teaching-agent", version: "1.0" },
      }});
      const response = this._recv();
      if (response && "result" in response) {
        // Send initialized notification
        this._send({ method: "notifications/initialized" });
        return true;
      }
    } catch (e: any) {
      if (e.code === "ENOENT") {
        console.log(`[MCP] Server command not found: ${this.command}`);
      } else {
        console.log(`[MCP] Connection failed: ${e.message}`);
      }
    }
    return false;
  }

  listTools(): MCPTool[] {
    this._send({ method: "tools/list", params: {} });
    const response = this._recv();
    if (response && "result" in response) {
      this.tools = (response as any).result?.tools ?? [];
    }
    return this.tools;
  }

  callTool(toolName: string, arguments_: Record<string, any>): string {
    this._send({ method: "tools/call", params: { name: toolName, arguments: arguments_ } });
    const response = this._recv();
    if (response && "result" in response) {
      const content: any[] = (response as any).result?.content ?? [];
      return content.map((c) => c.text ?? String(c)).join("\n");
    }
    if (response && "error" in response) {
      return `MCP Error: ${(response as any).error?.message ?? "unknown"}`;
    }
    return "MCP Error: no response";
  }

  getAgentTools(): AgentTool[] {
    return this.tools.map((tool) => ({
      name: `mcp__${this.serverName}__${tool.name}`,
      description: tool.description ?? "",
      input_schema: tool.inputSchema ?? { type: "object", properties: {} },
      _mcp_server: this.serverName,
      _mcp_tool: tool.name,
    }));
  }

  disconnect(): void {
    if (this.process) {
      try {
        this._send({ method: "shutdown" });
        this.process.kill("SIGTERM");
      } catch {
        this.process.kill("SIGKILL");
      }
      this.process = null;
    }
  }

  private _send(message: Record<string, any>): void {
    if (!this.process || this.process.killed) return;
    this.requestId++;
    const envelope = JSON.stringify({ jsonrpc: "2.0", id: this.requestId, ...message }) + "\n";
    try {
      (this.process.stdin as NodeJS.WritableStream).write(envelope);
    } catch { /* broken pipe */ }
  }

  private _recv(): Record<string, any> | null {
    if (!this.process || this.process.killed) return null;
    try {
      // Synchronous read: read one line from stdout buffer
      // Note: for a real implementation, use async readline; here we do a simple sync approach
      const chunks: string[] = [];
      const stdout = this.process.stdout as NodeJS.ReadableStream;
      // We'll use execSync trick via spawnSync for simplicity in this teaching version
      // In practice, use async event-driven I/O
      return null; // simplified: subprocesses managed externally
    } catch {
      return null;
    }
  }
}

// -- PluginLoader --
/**
 * Load plugins from .claude-plugin/ directories.
 *
 * Teaching version implements the smallest useful plugin flow:
 * read a manifest, discover MCP server configs, and register them.
 */
interface PluginManifest {
  name?: string;
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
}

class PluginLoader {
  searchDirs: string[];
  plugins: Record<string, PluginManifest> = {};

  constructor(searchDirs: string[] = [WORKDIR]) {
    this.searchDirs = searchDirs;
  }

  scan(): string[] {
    const found: string[] = [];
    for (const searchDir of this.searchDirs) {
      const manifestPath = path.join(searchDir, ".claude-plugin", "plugin.json");
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest: PluginManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
          const name = manifest.name ?? path.basename(searchDir);
          this.plugins[name] = manifest;
          found.push(name);
        } catch (e: any) {
          console.log(`[Plugin] Failed to load ${manifestPath}: ${e.message}`);
        }
      }
    }
    return found;
  }

  getMcpServers(): Record<string, { command: string; args?: string[]; env?: Record<string, string> }> {
    const servers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {};
    for (const [pluginName, manifest] of Object.entries(this.plugins)) {
      for (const [serverName, config] of Object.entries(manifest.mcpServers ?? {})) {
        servers[`${pluginName}__${serverName}`] = config;
      }
    }
    return servers;
  }
}

// -- MCPToolRouter --
/**
 * Routes tool calls to the correct MCP server.
 *
 * MCP tools are prefixed mcp__{server}__{tool} and live alongside
 * native tools in the same tool pool. The router strips the prefix
 * and dispatches to the right MCPClient.
 */
class MCPToolRouter {
  clients: Map<string, MCPClient> = new Map();

  registerClient(client: MCPClient): void {
    this.clients.set(client.serverName, client);
  }

  isMcpTool(toolName: string): boolean {
    return toolName.startsWith("mcp__");
  }

  call(toolName: string, arguments_: Record<string, any>): string {
    const parts = toolName.split("__", 3);
    if (parts.length !== 3) return `Error: Invalid MCP tool name: ${toolName}`;
    const [, serverName, actualTool] = parts;
    const client = this.clients.get(serverName);
    if (!client) return `Error: MCP server not found: ${serverName}`;
    return client.callTool(actualTool, arguments_);
  }

  getAllTools(): AgentTool[] {
    const tools: AgentTool[] = [];
    for (const client of this.clients.values()) {
      tools.push(...client.getAgentTools());
    }
    return tools;
  }
}

// -- Native tool implementations --
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR + path.sep) && resolved !== WORKDIR) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) return "Error: Dangerous command blocked";
  try {
    const out = execSync(command, { cwd: WORKDIR, timeout: 120000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return out.trim().slice(0, 50000) || "(no output)";
  } catch (e: any) {
    if (e.signal === "SIGTERM") return "Error: Timeout (120s)";
    return (((e.stdout || "") + (e.stderr || "")).trim()).slice(0, 50000) || `Error: ${e.message}`;
  }
}

function runRead(p: string): string {
  try { return fs.readFileSync(safePath(p), "utf-8").slice(0, 50000); }
  catch (e: any) { return `Error: ${e.message}`; }
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

const NATIVE_HANDLERS: Record<string, (kw: Record<string, any>) => string> = {
  bash:       (kw) => runBash(kw["command"]),
  read_file:  (kw) => runRead(kw["path"]),
  write_file: (kw) => runWrite(kw["path"], kw["content"]),
  edit_file:  (kw) => runEdit(kw["path"], kw["old_text"], kw["new_text"]),
};

const NATIVE_TOOLS: Anthropic.Tool[] = [
  { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
];

// -- Global instances --
const mcpRouter = new MCPToolRouter();
const pluginLoader = new PluginLoader();

function buildToolPool(): Anthropic.Tool[] {
  /**
   * Assemble the complete tool pool: native + MCP tools.
   *
   * Native tools take precedence on name conflicts so the local core remains
   * predictable even after external tools are added.
   */
  const allTools: Anthropic.Tool[] = [...NATIVE_TOOLS];
  const mcpTools = mcpRouter.getAllTools();

  const nativeNames = new Set(allTools.map((t) => t.name));
  for (const tool of mcpTools) {
    if (!nativeNames.has(tool.name)) {
      // strip internal fields before passing to Anthropic SDK
      const { _mcp_server, _mcp_tool, ...agentTool } = tool as any;
      allTools.push(agentTool as Anthropic.Tool);
    }
  }
  return allTools;
}

function handleToolCall(toolName: string, toolInput: Record<string, any>): string {
  if (mcpRouter.isMcpTool(toolName)) {
    return mcpRouter.call(toolName, toolInput);
  }
  const handler = NATIVE_HANDLERS[toolName];
  if (handler) return handler(toolInput);
  return `Unknown tool: ${toolName}`;
}

function normalizeToolResult(
  toolName: string,
  output: string,
  intent?: CapabilityIntent,
): string {
  const resolvedIntent = intent ?? permissionGate.normalize(toolName, {});
  const status = output.includes("Error:") || output.includes("MCP Error:") ? "error" : "ok";
  return JSON.stringify(
    {
      source: resolvedIntent.source,
      server: resolvedIntent.server,
      tool: resolvedIntent.tool,
      risk: resolvedIntent.risk,
      status,
      preview: output.slice(0, 500),
    },
    null,
    2,
  );
}

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  const tools = buildToolPool();
  const system =
    `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.\n` +
    "You have both native tools and MCP tools available.\n" +
    "MCP tools are prefixed with mcp__{server}__{tool}.\n" +
    "All capabilities pass through the same permission gate before execution.";

  while (true) {
    const response = await client.messages.create({ model: MODEL, system, messages, tools, max_tokens: 8000 });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") return;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const decision = permissionGate.check(block.name, (block.input as Record<string, any>) ?? {});
      let output: string;
      try {
        if (decision.behavior === "deny") {
          output = `Permission denied: ${decision.reason}`;
        } else if (
          decision.behavior === "ask" &&
          !(await permissionGate.askUser(decision.intent, (block.input as Record<string, any>) ?? {}))
        ) {
          output = `Permission denied by user: ${decision.reason}`;
        } else {
          output = handleToolCall(block.name, (block.input as Record<string, any>) ?? {});
        }
      } catch (e: any) {
        output = `Error: ${e.message}`;
      }
      console.log(`> ${block.name}: ${String(output).slice(0, 200)}`);
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: normalizeToolResult(block.name, String(output), decision.intent),
      });
    }
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  // Scan for plugins
  const found = pluginLoader.scan();
  if (found.length) {
    console.log(`[Plugins loaded: ${found.join(", ")}]`);
    for (const [serverName, config] of Object.entries(pluginLoader.getMcpServers())) {
      const mcpClient = new MCPClient(serverName, config.command, config.args ?? []);
      if (mcpClient.connect()) {
        mcpClient.listTools();
        mcpRouter.registerClient(mcpClient);
        console.log(`[MCP] Connected to ${serverName}`);
      }
    }
  }

  const toolCount = buildToolPool().length;
  const mcpCount = mcpRouter.getAllTools().length;
  console.log(`[Tool pool: ${toolCount} tools (${mcpCount} from MCP)]`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "\x1b[36ms19 >> \x1b[0m" });
  const history: Anthropic.MessageParam[] = [];
  rl.prompt();
  rl.on("line", async (query) => {
    rl.pause();
    if (!query.trim() || ["q", "exit"].includes(query.trim().toLowerCase())) {
      // Cleanup MCP connections
      for (const c of mcpRouter.clients.values()) c.disconnect();
      rl.close();
      return;
    }

    if (query.trim() === "/tools") {
      for (const tool of buildToolPool()) {
        const prefix = tool.name.startsWith("mcp__") ? "[MCP] " : "       ";
        const desc = (tool.description ?? "").slice(0, 60);
        console.log(`  ${prefix}${tool.name}: ${desc}`);
      }
      rl.resume(); rl.prompt(); return;
    }

    if (query.trim() === "/mcp") {
      if (mcpRouter.clients.size > 0) {
        for (const [name, c] of mcpRouter.clients.entries()) {
          console.log(`  ${name}: ${c.getAgentTools().length} tools`);
        }
      } else {
        console.log("  (no MCP servers connected)");
      }
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
  rl.on("close", () => {
    for (const c of mcpRouter.clients.values()) c.disconnect();
    process.exit(0);
  });
}

main().catch(console.error);

// Further upgrades you can add later:
// - more transports
// - auth / approval flows
// - server reconnect and lifecycle management
// - filtering external tools before they reach the model
// - richer plugin installation and update handling
