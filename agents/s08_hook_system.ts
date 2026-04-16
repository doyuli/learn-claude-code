#!/usr/bin/env npx ts-node
// Harness: extensibility -- injecting behavior without touching the loop.
/**
 * s08_hook_system.ts - Hook System
 *
 * Hooks are extension points around the main loop.
 * They let readers add behavior without rewriting the loop itself.
 *
 * Teaching version:
 *   - SessionStart
 *   - PreToolUse
 *   - PostToolUse
 *
 * Teaching exit-code contract:
 *   - 0 -> continue
 *   - 1 -> block
 *   - 2 -> inject a message
 *
 * Key insight: "Extend the agent without touching the loop."
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

// The teaching version keeps only the three clearest events. More complete
// systems can grow the event surface later.
const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "SessionStart"] as const;
type HookEvent = typeof HOOK_EVENTS[number];
const HOOK_TIMEOUT = 30; // seconds

// Workspace trust marker. Hooks only run if this file exists (or SDK mode).
const TRUST_MARKER = path.join(WORKDIR, ".claude", ".claude_trusted");

interface HookDef {
  matcher?: string;
  command?: string;
}

interface HookConfig {
  hooks?: { [event: string]: HookDef[] };
}

interface HookResult {
  blocked: boolean;
  messages: string[];
  blockReason?: string;
  permissionOverride?: string;
}

/**
 * Load and execute hooks from .hooks.json configuration.
 *
 * The hook manager does three simple jobs:
 * - load hook definitions
 * - run matching commands for an event
 * - aggregate block / message results for the caller
 */
class HookManager {
  private hooks: { [K in HookEvent]: HookDef[] } = {
    PreToolUse: [], PostToolUse: [], SessionStart: [],
  };
  private sdkMode: boolean;

  constructor(configPath?: string, sdkMode = false) {
    this.sdkMode = sdkMode;
    const cPath = configPath ?? path.join(WORKDIR, ".hooks.json");
    if (fs.existsSync(cPath)) {
      try {
        const config: HookConfig = JSON.parse(fs.readFileSync(cPath, "utf-8"));
        for (const event of HOOK_EVENTS) {
          this.hooks[event] = config.hooks?.[event] ?? [];
        }
        console.log(`[Hooks loaded from ${cPath}]`);
      } catch (e: any) {
        console.log(`[Hook config error: ${e.message}]`);
      }
    }
  }

  private _checkWorkspaceTrust(): boolean {
    if (this.sdkMode) return true;
    return fs.existsSync(TRUST_MARKER);
  }

  runHooks(event: HookEvent, context: Record<string, any> = {}): HookResult {
    const result: HookResult = { blocked: false, messages: [] };
    if (!this._checkWorkspaceTrust()) return result;

    const hooks = this.hooks[event] ?? [];
    for (const hookDef of hooks) {
      const matcher = hookDef.matcher;
      if (matcher && context) {
        const toolName = context.tool_name ?? "";
        if (matcher !== "*" && matcher !== toolName) continue;
      }

      const command = hookDef.command;
      if (!command) continue;

      const env: Record<string, string> = { ...process.env as any };
      if (context) {
        env.HOOK_EVENT = event;
        env.HOOK_TOOL_NAME = context.tool_name ?? "";
        env.HOOK_TOOL_INPUT = JSON.stringify(context.tool_input ?? {}).slice(0, 10000);
        if (context.tool_output !== undefined) env.HOOK_TOOL_OUTPUT = String(context.tool_output).slice(0, 10000);
      }

      try {
        const r = spawnSync(command, { shell: true, cwd: WORKDIR, env, timeout: HOOK_TIMEOUT * 1000, encoding: "utf-8" });

        if (r.status === 0) {
          const stdout = (r.stdout ?? "").trim();
          if (stdout) console.log(`  [hook:${event}] ${stdout.slice(0, 100)}`);
          try {
            const hookOutput = JSON.parse(stdout);
            if (hookOutput.updatedInput && context) context.tool_input = hookOutput.updatedInput;
            if (hookOutput.additionalContext) result.messages.push(hookOutput.additionalContext);
            if (hookOutput.permissionDecision) result.permissionOverride = hookOutput.permissionDecision;
          } catch { /* stdout was not JSON -- normal for simple hooks */ }
        } else if (r.status === 1) {
          result.blocked = true;
          const reason = (r.stderr ?? "").trim() || "Blocked by hook";
          result.blockReason = reason;
          console.log(`  [hook:${event}] BLOCKED: ${reason.slice(0, 200)}`);
        } else if (r.status === 2) {
          const msg = (r.stderr ?? "").trim();
          if (msg) {
            result.messages.push(msg);
            console.log(`  [hook:${event}] INJECT: ${msg.slice(0, 200)}`);
          }
        }

        if (r.error) throw r.error;
      } catch (e: any) {
        if (e.code === "ETIMEDOUT") console.log(`  [hook:${event}] Timeout (${HOOK_TIMEOUT}s)`);
        else console.log(`  [hook:${event}] Error: ${e.message}`);
      }
    }
    return result;
  }
}

// -- Tool implementations (same as s02) --
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
  bash:       (kw) => runBash(kw.command),
  read_file:  (kw) => runRead(kw.path, kw.limit),
  write_file: (kw) => runWrite(kw.path, kw.content),
  edit_file:  (kw) => runEdit(kw.path, kw.old_text, kw.new_text),
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
];

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`;

/**
 * The hook-aware agent loop.
 *
 * The teaching version keeps only the clearest integration points:
 * SessionStart, PreToolUse, execute tool, PostToolUse.
 */
async function agentLoop(messages: Anthropic.MessageParam[], hooks: HookManager): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL, system: SYSTEM, messages, tools: TOOLS, max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const toolInput = { ...(block.input as Record<string, any>) };
      const ctx: { tool_name: string; tool_input: Record<string, any>; tool_output?: string } = { tool_name: block.name, tool_input: toolInput };

      // -- PreToolUse hooks --
      const preResult = hooks.runHooks("PreToolUse", ctx);

      for (const msg of preResult.messages) {
        results.push({ type: "tool_result", tool_use_id: block.id, content: `[Hook message]: ${msg}` });
      }

      if (preResult.blocked) {
        const reason = preResult.blockReason ?? "Blocked by hook";
        const output = `Tool blocked by PreToolUse hook: ${reason}`;
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
        continue;
      }

      // -- Execute tool --
      const handler = TOOL_HANDLERS[block.name];
      let output: string;
      try {
        output = handler ? handler(toolInput) : `Unknown: ${block.name}`;
      } catch (e: any) { output = `Error: ${e.message}`; }
      console.log(`> ${block.name}: ${String(output).slice(0, 200)}`);

      // -- PostToolUse hooks --
      ctx.tool_output = output;
      const postResult = hooks.runHooks("PostToolUse", ctx);
      for (const msg of postResult.messages) output += `\n[Hook note]: ${msg}`;

      results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
    }
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const hooks = new HookManager();
  hooks.runHooks("SessionStart", { tool_name: "", tool_input: {} });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "\x1b[36ms08 >> \x1b[0m" });
  const history: Anthropic.MessageParam[] = [];
  rl.prompt();
  rl.on("line", async (query) => {
    rl.pause();
    if (!query.trim() || ["q", "exit"].includes(query.trim().toLowerCase())) { rl.close(); return; }
    history.push({ role: "user", content: query });
    await agentLoop(history, hooks);
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
