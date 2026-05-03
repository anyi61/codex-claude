import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = path.join(PROJECT_ROOT, "dist", "server.js");
const SESSION_PATH = path.join(PROJECT_ROOT, ".codex-claude-delegate", "sessions.json");
const TEST_CWD = PROJECT_ROOT;

let nextId = 1;
const pending = new Map<number, (v: Record<string, unknown>) => void>();

function req(child: ReturnType<typeof spawn>, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextId++;
  child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((r) => { pending.set(id, r); });
}

function notify(child: ReturnType<typeof spawn>, method: string, params?: Record<string, unknown>): void {
  child.stdin!.write(JSON.stringify(params ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", method }) + "\n");
}

function getContent(resp: Record<string, unknown>): string {
  return ((resp.result as Record<string, unknown>)?.content as Array<{ text: string }>)?.[0]?.text ?? "{}";
}

function readSessions(): number {
  if (!existsSync(SESSION_PATH)) return 0;
  try {
    return JSON.parse(readFileSync(SESSION_PATH, "utf-8")).sessions?.length ?? 0;
  } catch { return 0; }
}

function runQuery(child: ReturnType<typeof spawn>, task: string): Promise<Record<string, unknown>> {
  return req(child, "tools/call", {
    name: "claude_query",
    arguments: { task, cwd: TEST_CWD, timeout_sec: 60 },
  });
}

async function main() {
  // Clean sessions
  await mkdir(path.join(PROJECT_ROOT, ".codex-claude-delegate"), { recursive: true });
  try { writeFileSync(SESSION_PATH, JSON.stringify({ version: 1, sessions: [] })); } catch {}

  const child = spawn("node", [SERVER_PATH], { stdio: ["pipe", "pipe", "pipe"] });
  const rl = createInterface({ input: child.stdout! });

  child.stderr!.on("data", (d: Buffer) => process.stderr.write(d.toString()));

  rl.on("line", (line: string) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    } catch {}
  });

  child.on("close", (code) => process.stderr.write(`\nServer exited: ${code}\n`));

  // Init
  await req(child, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  notify(child, "notifications/initialized");
  await new Promise((r) => setTimeout(r, 100));

  // Status
  process.stderr.write("\n=== claude_status ===\n");
  const statusResp = await req(child, "tools/call", { name: "claude_status", arguments: { cwd: TEST_CWD } });
  const status = JSON.parse(getContent(statusResp));
  process.stderr.write(`Git repo: ${status.cwd_is_git_repo}, auth: ${status.auth_status}\n`);

  // Query #1
  process.stderr.write("\n=== query #1 ===\n");
  const q1Resp = await runQuery(child, "What is the purpose of this project? Check README.md. One sentence.");
  const q1 = JSON.parse(getContent(q1Resp));
  process.stderr.write(`Answer: ${(q1.answer ?? "(none)").slice(0, 200)}\n`);
  const sessionsAfter1 = readSessions();
  process.stderr.write(`Sessions stored: ${sessionsAfter1}\n`);

  // Query #2 (should auto-resume)
  process.stderr.write("\n=== query #2 (should auto-resume) ===\n");
  const q2Resp = await runQuery(child, "What tools does this project expose? List names only.");
  const q2 = JSON.parse(getContent(q2Resp));
  process.stderr.write(`Answer: ${(q2.answer ?? "(none)").slice(0, 200)}\n`);
  const sessionsAfter2 = readSessions();
  process.stderr.write(`Sessions stored: ${sessionsAfter2} (still 1 if resumed, 2 if new)\n`);

  if (sessionsAfter2 === 1) {
    process.stderr.write("✓ Session reuse working: query #2 used same session as #1\n");
  } else {
    process.stderr.write(`! Sessions: ${sessionsAfter1} → ${sessionsAfter2} (may be first-time setup)\n`);
  }

  child.stdin!.end();
  await new Promise((r) => setTimeout(r, 500));
  child.kill();
  process.stderr.write("\n=== Done ===\n");
}

main().catch((e) => { process.stderr.write(`FATAL: ${e}\n`); process.exit(1); });
