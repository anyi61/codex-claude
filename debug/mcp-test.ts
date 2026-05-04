import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from "node:fs";
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

function getAnswer(payload: Record<string, unknown>): string {
  const data = payload.data as Record<string, unknown> | undefined;
  return String(data?.answer ?? payload.answer ?? "(none)");
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
  process.stderr.write(`Answer: ${getAnswer(q1).slice(0, 200)}\n`);
  const sessionsAfter1 = readSessions();
  process.stderr.write(`Sessions stored: ${sessionsAfter1}\n`);

  // Query #2 (should auto-resume)
  process.stderr.write("\n=== query #2 (should auto-resume) ===\n");
  const q2Resp = await runQuery(child, "What tools does this project expose? List names only.");
  const q2 = JSON.parse(getContent(q2Resp));
  process.stderr.write(`Answer: ${getAnswer(q2).slice(0, 200)}\n`);
  const sessionsAfter2 = readSessions();
  process.stderr.write(`Sessions stored: ${sessionsAfter2} (still 1 if resumed, 2 if new)\n`);

  // Read the most recent run log and verify session.resumed === true
  const runDir = path.join(PROJECT_ROOT, ".codex-claude-delegate", "runs");
  const runFiles = readdirSync(runDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ name: f, mtime: statSync(path.join(runDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (runFiles.length < 2) {
    throw new Error(`Need at least 2 run logs to verify session reuse, found ${runFiles.length}`);
  }

  const lastRun = JSON.parse(readFileSync(path.join(runDir, runFiles[0].name), "utf-8"));
  const session = lastRun.session;
  if (!session || session.resumed !== true) {
    throw new Error(`Session reuse FAILED: resumed=${session?.resumed}, session=${JSON.stringify(session)}`);
  }
  if (!session.requested_session_id || !session.returned_session_id) {
    throw new Error(`Session IDs missing: requested=${session.requested_session_id}, returned=${session.returned_session_id}`);
  }
  if (session.requested_session_id !== session.returned_session_id) {
    throw new Error(`Session IDs mismatch: ${session.requested_session_id} vs ${session.returned_session_id}`);
  }

  process.stderr.write(`✓ Session reuse verified: resumed session ${session.returned_session_id.slice(0, 8)}..., IDs match\n`);

  child.stdin!.end();
  await new Promise((r) => setTimeout(r, 500));
  child.kill();
  process.stderr.write("\n=== Done ===\n");
}

main().catch((e) => { process.stderr.write(`FATAL: ${e}\n`); process.exit(1); });
