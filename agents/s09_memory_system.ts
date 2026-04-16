#!/usr/bin/env npx ts-node
// Harness: persistence -- remembering across the session boundary.
/**
 * s09_memory_system.ts - Memory System
 *
 * This teaching version focuses on one core idea:
 * some information should survive the current conversation, but not everything
 * belongs in memory.
 *
 * Use memory for:
 *   - user preferences
 *   - repeated user feedback
 *   - project facts that are NOT obvious from the current code
 *   - pointers to external resources
 *
 * Do NOT use memory for:
 *   - code structure that can be re-read from the repo
 *   - temporary task state
 *   - secrets
 *
 * Storage layout:
 *   .memory/
 *     MEMORY.md
 *     prefer_tabs.md
 *     review_style.md
 *
 * Key insight: "Memory only stores cross-session information that is still
 * worth recalling later and is not easy to re-derive from the current repo."
 */

import Anthropic from "@anthropic-ai/sdk";
import * as readline from "readline";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import "dotenv/config";

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID!;

const MEMORY_DIR = path.join(WORKDIR, ".memory");
const MEMORY_INDEX = path.join(MEMORY_DIR, "MEMORY.md");
const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
type MemoryType = typeof MEMORY_TYPES[number];
const MAX_INDEX_LINES = 200;

interface MemoryEntry {
  description: string;
  type: MemoryType;
  content: string;
  file: string;
}

/**
 * Load, build, and save persistent memories across sessions.
 *
 * The teaching version keeps memory explicit:
 * one Markdown file per memory, plus one compact index file.
 */
class MemoryManager {
  memories: Map<string, MemoryEntry> = new Map();

  constructor(private memoryDir: string = MEMORY_DIR) {}

  loadAll(): void {
    this.memories = new Map();
    if (!fs.existsSync(this.memoryDir)) return;

    for (const file of fs.readdirSync(this.memoryDir).sort()) {
      if (!file.endsWith(".md") || file === "MEMORY.md") continue;
      const filePath = path.join(this.memoryDir, file);
      const parsed = this._parseFrontmatter(fs.readFileSync(filePath, "utf-8"));
      if (!parsed) continue;
      const name = parsed.name ?? path.basename(file, ".md");
      this.memories.set(name, {
        description: parsed.description ?? "",
        type: (parsed.type ?? "project") as MemoryType,
        content: parsed.content ?? "",
        file,
      });
    }

    const count = this.memories.size;
    if (count > 0) console.log(`[Memory loaded: ${count} memories from ${this.memoryDir}]`);
  }

  loadMemoryPrompt(): string {
    if (!this.memories.size) return "";
    const sections = ["# Memories (persistent across sessions)", ""];

    for (const memType of MEMORY_TYPES) {
      const typed = [...this.memories.entries()].filter(([, v]) => v.type === memType);
      if (!typed.length) continue;
      sections.push(`## [${memType}]`);
      for (const [name, mem] of typed) {
        sections.push(`### ${name}: ${mem.description}`);
        if (mem.content.trim()) sections.push(mem.content.trim());
        sections.push("");
      }
    }
    return sections.join("\n");
  }

  saveMemory(name: string, description: string, memType: MemoryType, content: string): string {
    if (!MEMORY_TYPES.includes(memType)) return `Error: type must be one of ${MEMORY_TYPES.join(", ")}`;

    const safeName = name.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    if (!safeName) return "Error: invalid memory name";

    fs.mkdirSync(this.memoryDir, { recursive: true });

    const frontmatter = `---\nname: ${name}\ndescription: ${description}\ntype: ${memType}\n---\n${content}\n`;
    const fileName = `${safeName}.md`;
    const filePath = path.join(this.memoryDir, fileName);
    fs.writeFileSync(filePath, frontmatter, "utf-8");

    this.memories.set(name, { description, type: memType, content, file: fileName });
    this._rebuildIndex();

    return `Saved memory '${name}' [${memType}] to ${path.relative(WORKDIR, filePath)}`;
  }

  private _rebuildIndex(): void {
    const lines = ["# Memory Index", ""];
    for (const [name, mem] of this.memories.entries()) {
      lines.push(`- ${name}: ${mem.description} [${mem.type}]`);
      if (lines.length >= MAX_INDEX_LINES) {
        lines.push(`... (truncated at ${MAX_INDEX_LINES} lines)`);
        break;
      }
    }
    fs.mkdirSync(this.memoryDir, { recursive: true });
    fs.writeFileSync(MEMORY_INDEX, lines.join("\n") + "\n", "utf-8");
  }

  private _parseFrontmatter(text: string): Record<string, string> | null {
    const match = text.match(/^---\s*\n(.*?)\n---\s*\n(.*)/s);
    if (!match) return null;
    const result: Record<string, string> = { content: match[2].trim() };
    for (const line of match[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx >= 0) result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return result;
  }
}

/**
 * Auto-consolidation of memories between sessions ("Dream").
 *
 * This is an optional later-stage feature. Its job is to prevent the memory
 * store from growing into a noisy pile by merging, deduplicating, and
 * pruning entries over time.
 */
class DreamConsolidator {
  static COOLDOWN_SECONDS = 86400;       // 24 hours
  static SCAN_THROTTLE_SECONDS = 600;    // 10 minutes
  static MIN_SESSION_COUNT = 5;
  static LOCK_STALE_SECONDS = 3600;

  static PHASES = [
    "Orient: scan MEMORY.md index for structure and categories",
    "Gather: read individual memory files for full content",
    "Consolidate: merge related memories, remove stale entries",
    "Prune: enforce 200-line limit on MEMORY.md index",
  ];

  enabled = true;
  mode = "default";
  lastConsolidationTime = 0;
  lastScanTime = 0;
  sessionCount = 0;

  constructor(private memoryDir: string = MEMORY_DIR) {}

  private get lockFile(): string { return path.join(this.memoryDir, ".dream_lock"); }

  shouldConsolidate(): [boolean, string] {
    const now = Date.now() / 1000;
    if (!this.enabled) return [false, "Gate 1: consolidation is disabled"];
    if (!fs.existsSync(this.memoryDir)) return [false, "Gate 2: memory directory does not exist"];
    const memFiles = fs.readdirSync(this.memoryDir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
    if (!memFiles.length) return [false, "Gate 2: no memory files found"];
    if (this.mode === "plan") return [false, "Gate 3: plan mode does not allow consolidation"];
    const timeSinceLast = now - this.lastConsolidationTime;
    if (timeSinceLast < DreamConsolidator.COOLDOWN_SECONDS)
      return [false, `Gate 4: cooldown active, ${Math.round(DreamConsolidator.COOLDOWN_SECONDS - timeSinceLast)}s remaining`];
    const timeSinceScan = now - this.lastScanTime;
    if (timeSinceScan < DreamConsolidator.SCAN_THROTTLE_SECONDS)
      return [false, `Gate 5: scan throttle active, ${Math.round(DreamConsolidator.SCAN_THROTTLE_SECONDS - timeSinceScan)}s remaining`];
    if (this.sessionCount < DreamConsolidator.MIN_SESSION_COUNT)
      return [false, `Gate 6: only ${this.sessionCount} sessions, need ${DreamConsolidator.MIN_SESSION_COUNT}`];
    if (!this._acquireLock()) return [false, "Gate 7: lock held by another process"];
    return [true, "All 7 gates passed"];
  }

  consolidate(): string[] {
    const [canRun, reason] = this.shouldConsolidate();
    if (!canRun) { console.log(`[Dream] Cannot consolidate: ${reason}`); return []; }
    console.log("[Dream] Starting consolidation...");
    this.lastScanTime = Date.now() / 1000;
    const completed: string[] = [];
    DreamConsolidator.PHASES.forEach((phase, i) => {
      console.log(`[Dream] Phase ${i + 1}/4: ${phase}`);
      completed.push(phase);
    });
    this.lastConsolidationTime = Date.now() / 1000;
    this._releaseLock();
    console.log(`[Dream] Consolidation complete: ${completed.length} phases executed`);
    return completed;
  }

  private _acquireLock(): boolean {
    if (fs.existsSync(this.lockFile)) {
      try {
        const lockData = fs.readFileSync(this.lockFile, "utf-8").trim();
        const [pidStr, tsStr] = lockData.split(":");
        const pid = parseInt(pidStr);
        const lockTime = parseFloat(tsStr);
        if ((Date.now() / 1000 - lockTime) > DreamConsolidator.LOCK_STALE_SECONDS) {
          console.log(`[Dream] Removing stale lock from PID ${pid}`);
          fs.unlinkSync(this.lockFile);
        } else {
          try { process.kill(pid, 0); return false; }
          catch { console.log(`[Dream] Removing lock from dead PID ${pid}`); fs.unlinkSync(this.lockFile); }
        }
      } catch { try { fs.unlinkSync(this.lockFile); } catch {} }
    }
    try {
      fs.mkdirSync(this.memoryDir, { recursive: true });
      fs.writeFileSync(this.lockFile, `${process.pid}:${Date.now() / 1000}`, "utf-8");
      return true;
    } catch { return false; }
  }

  private _releaseLock(): void {
    try {
      if (fs.existsSync(this.lockFile)) {
        const lockData = fs.readFileSync(this.lockFile, "utf-8").trim();
        const [pidStr] = lockData.split(":");
        if (parseInt(pidStr) === process.pid) fs.unlinkSync(this.lockFile);
      }
    } catch {}
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

const memoryMgr = new MemoryManager();

const TOOL_HANDLERS: Record<string, (kw: Record<string, any>) => string> = {
  bash:        (kw) => runBash(kw.command),
  read_file:   (kw) => runRead(kw.path, kw.limit),
  write_file:  (kw) => runWrite(kw.path, kw.content),
  edit_file:   (kw) => runEdit(kw.path, kw.old_text, kw.new_text),
  save_memory: (kw) => memoryMgr.saveMemory(kw.name, kw.description, kw.type as MemoryType, kw.content),
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
  { name: "save_memory", description: "Save a persistent memory that survives across sessions.",
    input_schema: { type: "object", properties: {
      name: { type: "string", description: "Short identifier (e.g. prefer_tabs, db_schema)" },
      description: { type: "string", description: "One-line summary of what this memory captures" },
      type: { type: "string", enum: ["user", "feedback", "project", "reference"],
              description: "user=preferences, feedback=corrections, project=non-obvious project conventions or decision reasons, reference=external resource pointers" },
      content: { type: "string", description: "Full memory content (multi-line OK)" },
    }, required: ["name", "description", "type", "content"] } },
];

const MEMORY_GUIDANCE = `
When to save memories:
- User states a preference ("I like tabs", "always use pytest") -> type: user
- User corrects you ("don't do X", "that was wrong because...") -> type: feedback
- You learn a project fact that is not easy to infer from current code alone
  (for example: a rule exists because of compliance, or a legacy module must
  stay untouched for business reasons) -> type: project
- You learn where an external resource lives (ticket board, dashboard, docs URL)
  -> type: reference

When NOT to save:
- Anything easily derivable from code (function signatures, file structure, directory layout)
- Temporary task state (current branch, open PR numbers, current TODOs)
- Secrets or credentials (API keys, passwords)
`;

function buildSystemPrompt(): string {
  const parts = [`You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`];
  const memorySection = memoryMgr.loadMemoryPrompt();
  if (memorySection) parts.push(memorySection);
  parts.push(MEMORY_GUIDANCE);
  return parts.join("\n\n");
}

/**
 * Agent loop with memory-aware system prompt.
 *
 * The system prompt is rebuilt each call so newly saved memories
 * are visible in the next LLM turn within the same session.
 */
async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    const system = buildSystemPrompt();
    const response = await client.messages.create({
      model: MODEL, system, messages, tools: TOOLS, max_tokens: 8000,
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
  memoryMgr.loadAll();
  const memCount = memoryMgr.memories.size;
  if (memCount) console.log(`[${memCount} memories loaded into context]`);
  else console.log("[No existing memories. The agent can create them with save_memory.]");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "\x1b[36ms09 >> \x1b[0m" });
  const history: Anthropic.MessageParam[] = [];
  rl.prompt();
  rl.on("line", async (query) => {
    rl.pause();
    if (!query.trim() || ["q", "exit"].includes(query.trim().toLowerCase())) { rl.close(); return; }

    if (query.trim() === "/memories") {
      if (memoryMgr.memories.size) {
        for (const [name, mem] of memoryMgr.memories.entries()) {
          console.log(`  [${mem.type}] ${name}: ${mem.description}`);
        }
      } else console.log("  (no memories)");
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
  rl.on("close", () => process.exit(0));
}

main().catch(console.error);
