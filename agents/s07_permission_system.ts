#!/usr/bin/env npx ts-node
// Harness: safety -- the pipeline between intent and execution.
/**
 * s07_permission_system.ts - Permission System
 *
 * Every tool call passes through a permission pipeline before execution.
 *
 * Teaching pipeline:
 *   1. deny rules
 *   2. mode check
 *   3. allow rules
 *   4. ask user
 *
 * This version intentionally teaches three modes first:
 *   - default
 *   - plan
 *   - auto
 *
 * Key insight: "Safety is a pipeline, not a boolean."
 */

import Anthropic from "@anthropic-ai/sdk";
import * as readline from "readline";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { minimatch } from "minimatch";
import "dotenv/config";

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID!;

// -- Permission modes --
const MODES = ["default", "plan", "auto"] as const;
type Mode = typeof MODES[number];

const READ_ONLY_TOOLS = new Set(["read_file", "bash_readonly"]);
const WRITE_TOOLS = new Set(["write_file", "edit_file", "bash"]);

// -- Bash security validation --
/**
 * Validate bash commands for obviously dangerous patterns.
 *
 * The teaching version deliberately keeps this small and easy to read.
 * First catch a few high-risk patterns, then let the permission pipeline
 * decide whether to deny or ask the user.
 */
class BashSecurityValidator {
  private static VALIDATORS: Array<[string, RegExp]> = [
    ["shell_metachar", /[;&|`$]/],
    ["sudo", /\bsudo\b/],
    ["rm_rf", /\brm\s+(-[a-zA-Z]*)?r/],
    ["cmd_substitution", /\$\(/],
    ["ifs_injection", /\bIFS\s*=/],
  ];

  validate(command: string): Array<[string, string]> {
    const failures: Array<[string, string]> = [];
    for (const [name, pattern] of BashSecurityValidator.VALIDATORS) {
      if (pattern.test(command)) failures.push([name, pattern.source]);
    }
    return failures;
  }

  isSafe(command: string): boolean {
    return this.validate(command).length === 0;
  }

  describeFailures(command: string): string {
    const failures = this.validate(command);
    if (!failures.length) return "No issues detected";
    return "Security flags: " + failures.map(([n, p]) => `${n} (pattern: ${p})`).join(", ");
  }
}

// -- Workspace trust --
function isWorkspaceTrusted(workspace?: string): boolean {
  const ws = workspace ?? WORKDIR;
  const trustMarker = path.join(ws, ".claude", ".claude_trusted");
  return fs.existsSync(trustMarker);
}

const bashValidator = new BashSecurityValidator();

// -- Permission rules --
interface PermissionRule {
  tool?: string;
  path?: string;
  content?: string;
  behavior: "allow" | "deny" | "ask";
}

const DEFAULT_RULES: PermissionRule[] = [
  { tool: "bash", content: "rm -rf /", behavior: "deny" },
  { tool: "bash", content: "sudo *", behavior: "deny" },
  { tool: "read_file", path: "*", behavior: "allow" },
];

interface PermissionDecision {
  behavior: "allow" | "deny" | "ask";
  reason: string;
}

class PermissionManager {
  mode: Mode;
  rules: PermissionRule[];
  consecutiveDenials = 0;
  maxConsecutiveDenials = 3;

  constructor(mode: Mode = "default", rules?: PermissionRule[]) {
    if (!MODES.includes(mode)) throw new Error(`Unknown mode: ${mode}. Choose from ${MODES}`);
    this.mode = mode;
    this.rules = rules ?? [...DEFAULT_RULES];
  }

  check(toolName: string, toolInput: Record<string, any>): PermissionDecision {
    // Step 0: Bash security validation
    if (toolName === "bash") {
      const command = toolInput.command ?? "";
      const failures = bashValidator.validate(command);
      if (failures.length) {
        const severe = new Set(["sudo", "rm_rf"]);
        const severeHits = failures.filter(([n]) => severe.has(n));
        const desc = bashValidator.describeFailures(command);
        if (severeHits.length) return { behavior: "deny", reason: `Bash validator: ${desc}` };
        return { behavior: "ask", reason: `Bash validator flagged: ${desc}` };
      }
    }

    // Step 1: Deny rules
    for (const rule of this.rules) {
      if (rule.behavior !== "deny") continue;
      if (this._matches(rule, toolName, toolInput)) return { behavior: "deny", reason: `Blocked by deny rule: ${JSON.stringify(rule)}` };
    }

    // Step 2: Mode-based decisions
    if (this.mode === "plan") {
      if (WRITE_TOOLS.has(toolName)) return { behavior: "deny", reason: "Plan mode: write operations are blocked" };
      return { behavior: "allow", reason: "Plan mode: read-only allowed" };
    }

    if (this.mode === "auto") {
      if (READ_ONLY_TOOLS.has(toolName) || toolName === "read_file")
        return { behavior: "allow", reason: "Auto mode: read-only tool auto-approved" };
    }

    // Step 3: Allow rules
    for (const rule of this.rules) {
      if (rule.behavior !== "allow") continue;
      if (this._matches(rule, toolName, toolInput)) {
        this.consecutiveDenials = 0;
        return { behavior: "allow", reason: `Matched allow rule: ${JSON.stringify(rule)}` };
      }
    }

    // Step 4: Ask user
    return { behavior: "ask", reason: `No rule matched for ${toolName}, asking user` };
  }

  askUser(toolName: string, toolInput: Record<string, any>, rl: readline.Interface): Promise<boolean> {
    return new Promise((resolve) => {
      const preview = JSON.stringify(toolInput).slice(0, 200);
      process.stdout.write(`\n  [Permission] ${toolName}: ${preview}\n  Allow? (y/n/always): `);
      rl.once("line", (answer) => {
        const a = answer.trim().toLowerCase();
        if (a === "always") {
          this.rules.push({ tool: toolName, path: "*", behavior: "allow" });
          this.consecutiveDenials = 0;
          resolve(true);
        } else if (a === "y" || a === "yes") {
          this.consecutiveDenials = 0;
          resolve(true);
        } else {
          this.consecutiveDenials++;
          if (this.consecutiveDenials >= this.maxConsecutiveDenials) {
            console.log(`  [${this.consecutiveDenials} consecutive denials -- consider switching to plan mode]`);
          }
          resolve(false);
        }
      });
    });
  }

  private _matches(rule: PermissionRule, toolName: string, toolInput: Record<string, any>): boolean {
    if (rule.tool && rule.tool !== "*" && rule.tool !== toolName) return false;
    if (rule.path && rule.path !== "*") {
      const p = toolInput.path ?? "";
      if (!minimatch(p, rule.path)) return false;
    }
    if (rule.content) {
      const command = toolInput.command ?? "";
      if (!minimatch(command, rule.content)) return false;
    }
    return true;
  }
}

// -- Tool implementations --
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR + path.sep) && resolved !== WORKDIR)
    throw new Error(`Path escapes workspace: ${p}`);
  return resolved;
}

function runBash(command: string): string {
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

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.
The user controls permissions. Some tool calls may be denied.`;

async function agentLoop(messages: Anthropic.MessageParam[], perms: PermissionManager, rl: readline.Interface): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL, system: SYSTEM, messages, tools: TOOLS, max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const inp = block.input as Record<string, any>;
      const decision = perms.check(block.name, inp);

      let output: string;
      if (decision.behavior === "deny") {
        output = `Permission denied: ${decision.reason}`;
        console.log(`  [DENIED] ${block.name}: ${decision.reason}`);
      } else if (decision.behavior === "ask") {
        const approved = await perms.askUser(block.name, inp, rl);
        if (approved) {
          const handler = TOOL_HANDLERS[block.name];
          output = handler ? handler(inp) : `Unknown: ${block.name}`;
          console.log(`> ${block.name}: ${String(output).slice(0, 200)}`);
        } else {
          output = `Permission denied by user for ${block.name}`;
          console.log(`  [USER DENIED] ${block.name}`);
        }
      } else {
        const handler = TOOL_HANDLERS[block.name];
        output = handler ? handler(inp) : `Unknown: ${block.name}`;
        console.log(`> ${block.name}: ${String(output).slice(0, 200)}`);
      }

      results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
    }
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log("Permission modes: default, plan, auto");
  const modeInput = await new Promise<string>((r) => rl.question("Mode (default): ", r));
  const mode = (MODES.includes(modeInput.trim().toLowerCase() as Mode) ? modeInput.trim().toLowerCase() : "default") as Mode;
  const perms = new PermissionManager(mode);
  console.log(`[Permission mode: ${mode}]`);

  const history: Anthropic.MessageParam[] = [];
  rl.setPrompt("\x1b[36ms07 >> \x1b[0m");
  rl.prompt();
  rl.on("line", async (query) => {
    rl.pause();
    if (!query.trim() || ["q", "exit"].includes(query.trim().toLowerCase())) { rl.close(); return; }

    if (query.startsWith("/mode")) {
      const parts = query.split(/\s+/);
      if (parts.length === 2 && MODES.includes(parts[1] as Mode)) {
        perms.mode = parts[1] as Mode;
        console.log(`[Switched to ${parts[1]} mode]`);
      } else {
        console.log(`Usage: /mode <${MODES.join("|")}>`);
      }
      rl.resume(); rl.prompt(); return;
    }

    if (query.trim() === "/rules") {
      perms.rules.forEach((r, i) => console.log(`  ${i}: ${JSON.stringify(r)}`));
      rl.resume(); rl.prompt(); return;
    }

    history.push({ role: "user", content: query });
    await agentLoop(history, perms, rl);
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
