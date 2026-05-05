import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = path.join(PROJECT_ROOT, "dist", "server.js");

let nextId = 1;
const pending = new Map<number, (value: Record<string, unknown>) => void>();

function req(child: ReturnType<typeof spawn>, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextId++;
  child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve) => pending.set(id, resolve));
}

function notify(child: ReturnType<typeof spawn>, method: string, params?: Record<string, unknown>): void {
  child.stdin!.write(JSON.stringify(params ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", method }) + "\n");
}

function payload(resp: Record<string, unknown>): Record<string, unknown> {
  const text = ((resp.result as Record<string, unknown>)?.content as Array<{ text: string }>)?.[0]?.text;
  if (!text) throw new Error(`missing tool content: ${JSON.stringify(resp)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function waitForStatus(
  child: ReturnType<typeof spawn>,
  cwd: string,
  jobId: string,
  wanted: string,
  timeoutMs = 60_000
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = payload(await req(child, "tools/call", {
      name: "claude_job_result",
      arguments: { cwd, job_id: jobId },
    }));
    const job = result.job as Record<string, unknown> | undefined;
    const status = String(job?.status ?? "");
    if (status === wanted) {
      return result;
    }
    if (wanted === "running" && (status === "failed" || status === "cancelled" || status === "succeeded")) {
      throw new Error(`job reached terminal status before running check: ${JSON.stringify(result)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for job ${jobId} to reach status ${wanted}`);
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(PROJECT_ROOT, ".debug-fixtures", "background-cancel-"));
  const stateDir = path.join(root, ".codex-claude-delegate");
  const logDir = path.join(stateDir, "runs");

  await mkdir(logDir, { recursive: true });

  const child = spawn("node", [SERVER_PATH], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      CODEX_CLAUDE_RUN_LOG_DIR: logDir,
      CODEX_CLAUDE_BACKGROUND_STATE_DIR: stateDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rl = createInterface({ input: child.stdout! });
  child.stderr!.on("data", (data: Buffer) => process.stderr.write(data.toString()));
  rl.on("line", (line: string) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    } catch {
      // ignore
    }
  });

  try {
    await req(child, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "background-cancel", version: "0.1.0" },
    });
    notify(child, "notifications/initialized");

    process.stderr.write("\n=== start running background review ===\n");
    const started = payload(await req(child, "tools/call", {
      name: "claude_review",
      arguments: {
        cwd: PROJECT_ROOT,
        task: "Review README.md in detail and write a thorough risk assessment focused on correctness, gaps, and documentation drift.",
        files: ["README.md"],
        timeout_sec: 120,
        max_turns: 10,
        background: true,
      },
    }));
    const job = started.job as Record<string, unknown> | undefined;
    const jobId = String(job?.job_id ?? "");
    if (!jobId) {
      throw new Error(`missing job id from background review start: ${JSON.stringify(started)}`);
    }
    process.stderr.write(`  queued job ${jobId}\n`);

    const running = await waitForStatus(child, PROJECT_ROOT, jobId, "running");
    const runningJob = running.job as Record<string, unknown> | undefined;
    if (runningJob?.status !== "running") {
      throw new Error(`job never reached running: ${JSON.stringify(running)}`);
    }
    process.stderr.write("  ✓ job reached running state\n");

    process.stderr.write("\n=== cancel running job ===\n");
    const cancelled = payload(await req(child, "tools/call", {
      name: "claude_job_cancel",
      arguments: { cwd: PROJECT_ROOT, job_id: jobId },
    }));
    if (cancelled.cancelled !== true) {
      throw new Error(`claude_job_cancel did not report success: ${JSON.stringify(cancelled)}`);
    }
    process.stderr.write("  ✓ claude_job_cancel returned success\n");

    const final = await waitForStatus(child, PROJECT_ROOT, jobId, "cancelled");
    const finalJob = final.job as Record<string, unknown> | undefined;
    if (finalJob?.status !== "cancelled") {
      throw new Error(`job did not persist cancelled status: ${JSON.stringify(final)}`);
    }
    process.stderr.write("  ✓ running job persisted cancelled status\n");
  } finally {
    child.stdin!.end();
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.kill();
    await rm(root, { recursive: true, force: true });
  }

  process.stderr.write("\n=== BACKGROUND RUNNING CANCEL PASSED ===\n");
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
