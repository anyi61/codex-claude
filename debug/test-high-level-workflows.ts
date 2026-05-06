import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = path.join(PROJECT_ROOT, "dist", "server.js");
const HOOK_MANIFEST_PATH = path.join(PROJECT_ROOT, "plugins", "codex-claude-delegate", "hooks", "hooks.json");

let nextId = 1;
const pending = new Map<number, (value: Record<string, unknown>) => void>();

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(args[0], args.slice(1), { cwd, encoding: "utf8" }).trim();
}

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

async function createFixtureRepo(root: string): Promise<string> {
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  sh(root, "git", "init", repo);
  sh(repo, "git", "config", "user.name", "Test User");
  sh(repo, "git", "config", "user.email", "test@example.com");
  await writeFile(path.join(repo, "README.md"), "# High-Level Workflow Fixture\n");
  sh(repo, "git", "add", ".");
  sh(repo, "git", "commit", "-m", "init");
  return repo;
}

async function waitForJob(
  child: ReturnType<typeof spawn>,
  cwd: string,
  jobId: string,
  timeoutMs = 180_000
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = payload(await req(child, "tools/call", {
      name: "claude_job_result",
      arguments: { cwd, job_id: jobId },
    }));
    const job = result.job as Record<string, unknown> | undefined;
    const status = String(job?.status ?? "");
    if (status === "succeeded" || status === "failed" || status === "cancelled") {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for background job ${jobId}`);
}

async function main(): Promise<void> {
  const fixturesRoot = path.join(PROJECT_ROOT, ".debug-fixtures");
  await mkdir(fixturesRoot, { recursive: true });
  const root = await mkdtemp(path.join(fixturesRoot, "high-level-workflows-"));
  const stateDir = path.join(root, ".codex-claude-delegate");
  const logDir = path.join(stateDir, "runs");
  const fixtureRepo = await createFixtureRepo(root);
  const originalHookManifest = await readFile(HOOK_MANIFEST_PATH, "utf8").catch(() => null);

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
      // ignore non-JSON noise
    }
  });

  try {
    await req(child, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "high-level-workflows", version: "0.1.0" },
    });
    notify(child, "notifications/initialized");

    process.stderr.write("\n=== claude_setup / review gate ===\n");
    const setupBefore = payload(await req(child, "tools/call", {
      name: "claude_setup",
      arguments: { cwd: fixtureRepo },
    }));
    if (setupBefore.workspace_root !== fixtureRepo) {
      throw new Error(`claude_setup returned the wrong workspace root: ${JSON.stringify(setupBefore)}`);
    }
    const gateBefore = setupBefore.review_gate as Record<string, unknown> | undefined;
    if (!gateBefore || gateBefore.enabled !== false) {
      throw new Error(`claude_setup did not expose a disabled initial gate state: ${JSON.stringify(setupBefore)}`);
    }

    const gateEnabled = payload(await req(child, "tools/call", {
      name: "claude_review_gate",
      arguments: { cwd: fixtureRepo, action: "enable" },
    }));
    if (gateEnabled.enabled !== true || gateEnabled.action !== "enable") {
      throw new Error(`claude_review_gate enable failed: ${JSON.stringify(gateEnabled)}`);
    }

    const gateStatus = payload(await req(child, "tools/call", {
      name: "claude_review_gate",
      arguments: { cwd: fixtureRepo, action: "status" },
    }));
    if (gateStatus.enabled !== true || gateStatus.changed !== false) {
      throw new Error(`claude_review_gate status did not reflect enabled state: ${JSON.stringify(gateStatus)}`);
    }

    const gateDisabled = payload(await req(child, "tools/call", {
      name: "claude_review_gate",
      arguments: { cwd: fixtureRepo, action: "disable" },
    }));
    if (gateDisabled.enabled !== false || gateDisabled.action !== "disable") {
      throw new Error(`claude_review_gate disable failed: ${JSON.stringify(gateDisabled)}`);
    }
    process.stderr.write("  ✓ setup and review gate enable/status/disable passed\n");

    process.stderr.write("\n=== claude_task mode=read background ===\n");
    const taskRead = payload(await req(child, "tools/call", {
      name: "claude_task",
      arguments: {
        cwd: PROJECT_ROOT,
        task: "Explain how the background job model works in this repo.",
        mode: "read",
        background: true,
      },
    }));
    const taskReadJob = taskRead.job as Record<string, unknown> | undefined;
    if (taskRead.delegated_mode !== "read" || String(taskReadJob?.type ?? "") !== "query") {
      throw new Error(`claude_task read background routed incorrectly: ${JSON.stringify(taskRead)}`);
    }
    if (!Array.isArray(taskRead.next_actions)) {
      throw new Error(`claude_task read background returned malformed next_actions: ${JSON.stringify(taskRead)}`);
    }
    process.stderr.write("  ✓ claude_task read background routed to query\n");

    process.stderr.write("\n=== claude_task mode=auto ===\n");
    const taskAuto = payload(await req(child, "tools/call", {
      name: "claude_task",
      arguments: {
        cwd: fixtureRepo,
        task: "Review this patch for regressions before landing it.",
        mode: "auto",
        diff: "diff --git a/README.md b/README.md",
        files: ["README.md"],
        background: true,
      },
    }));
    const taskAutoJob = taskAuto.job as Record<string, unknown> | undefined;
    if (taskAuto.delegated_mode !== "review" || String(taskAutoJob?.type ?? "") !== "review") {
      throw new Error(`claude_task auto did not route to review: ${JSON.stringify(taskAuto)}`);
    }
    if (!Array.isArray(taskAuto.next_actions) || !(taskAuto.next_actions as Array<Record<string, unknown>>).some((action) => action.tool === "claude_review")) {
      throw new Error(`claude_task auto missing review next action: ${JSON.stringify(taskAuto)}`);
    }
    process.stderr.write("  ✓ claude_task auto routed to review\n");

    process.stderr.write("\n=== claude_task mode=write background for claude_result ===\n");
    const implementStart = payload(await req(child, "tools/call", {
      name: "claude_task",
      arguments: {
        cwd: fixtureRepo,
        task: "Append exactly one line 'High-level workflow test.' to README.md and do not modify other files.",
        mode: "write",
        background: true,
        files: ["README.md"],
        timeout_sec: 180,
      },
    }));
    const implementJob = implementStart.job as Record<string, unknown> | undefined;
    const implementJobId = String(implementJob?.job_id ?? "");
    if (implementStart.delegated_mode !== "write" || String(implementJob?.type ?? "") !== "implement") {
      throw new Error(`claude_task write did not route to implement: ${JSON.stringify(implementStart)}`);
    }
    if (!implementJobId || implementJob?.status !== "queued") {
      throw new Error(`claude_task write background did not return a queued job: ${JSON.stringify(implementStart)}`);
    }

    const workspaceDuringJob = payload(await req(child, "tools/call", {
      name: "claude_workspace_status",
      arguments: { cwd: fixtureRepo, limit: 10, include_terminal: true },
    }));
    const duringCounts = workspaceDuringJob.counts as Record<string, unknown> | undefined;
    const activeJobCount = Number(duringCounts?.queued_jobs ?? 0) + Number(duringCounts?.running_jobs ?? 0);
    if (activeJobCount < 1) {
      throw new Error(`claude_workspace_status did not surface queued/running job counts: ${JSON.stringify(workspaceDuringJob)}`);
    }
    process.stderr.write("  ✓ claude_task write queued an implement job and workspace status surfaced active counts\n");

    const implementResult = await waitForJob(child, fixtureRepo, implementJobId);
    const finishedImplementJob = implementResult.job as Record<string, unknown> | undefined;
    if (finishedImplementJob?.status !== "succeeded") {
      throw new Error(`background implement did not succeed: ${JSON.stringify(implementResult)}`);
    }
    process.stderr.write(`  ✓ implement job ${implementJobId} finished\n`);

    process.stderr.write("\n=== claude_result by explicit job id ===\n");
    const resultByJob = payload(await req(child, "tools/call", {
      name: "claude_result",
      arguments: { cwd: fixtureRepo, job_id: implementJobId },
    }));
    if (resultByJob.source_type !== "job") {
      throw new Error(`claude_result did not resolve a job source: ${JSON.stringify(resultByJob)}`);
    }
    const resultJob = resultByJob.job as Record<string, unknown> | undefined;
    const resultRun = resultByJob.run as Record<string, unknown> | undefined;
    if (String(resultJob?.job_id ?? "") !== implementJobId) {
      throw new Error(`claude_result returned the wrong job: ${JSON.stringify(resultByJob)}`);
    }
    const nextActions = (resultByJob.next_actions as Array<Record<string, unknown>> | undefined) ?? [];
    const applyAction = nextActions.find((action) => action.tool === "claude_apply");
    const worktreePath = String(resultRun?.worktree_path ?? "");
    if (!applyAction || !worktreePath) {
      throw new Error(`claude_result missing coherent apply action/worktree path: ${JSON.stringify(resultByJob)}`);
    }
    if (String((applyAction.args as Record<string, unknown> | undefined)?.worktree_path ?? "") !== worktreePath) {
      throw new Error(`claude_result apply action does not match run worktree: ${JSON.stringify(resultByJob)}`);
    }
    const session = resultByJob.session as Record<string, unknown> | undefined;
    if (session && typeof session.session_id !== "string") {
      throw new Error(`claude_result returned malformed session payload: ${JSON.stringify(resultByJob)}`);
    }
    process.stderr.write("  ✓ claude_result returned summary, next actions, and coherent worktree metadata\n");

    process.stderr.write("\n=== claude_result by latest-implement preference ===\n");
    const resultByPrefer = payload(await req(child, "tools/call", {
      name: "claude_result",
      arguments: { cwd: fixtureRepo, prefer: "latest-implement" },
    }));
    if (String((resultByPrefer.job as Record<string, unknown> | undefined)?.job_id ?? "") !== implementJobId) {
      throw new Error(`claude_result latest-implement did not resolve the expected job: ${JSON.stringify(resultByPrefer)}`);
    }
    process.stderr.write("  ✓ latest-implement preference resolved the same artifact\n");

    process.stderr.write("\n=== claude_workspace_status ===\n");
    const workspaceStatus = payload(await req(child, "tools/call", {
      name: "claude_workspace_status",
      arguments: { cwd: fixtureRepo, limit: 10, include_terminal: true },
    }));
    const counts = workspaceStatus.counts as Record<string, unknown> | undefined;
    const recentTerminalJobs = (workspaceStatus.recent_terminal_jobs as Array<Record<string, unknown>> | undefined) ?? [];
    const recentRuns = (workspaceStatus.recent_runs as Array<Record<string, unknown>> | undefined) ?? [];
    const delegatedWorktrees = (workspaceStatus.delegated_worktrees as Array<Record<string, unknown>> | undefined) ?? [];
    if (workspaceStatus.workspace_root !== fixtureRepo) {
      throw new Error(`claude_workspace_status returned the wrong workspace root: ${JSON.stringify(workspaceStatus)}`);
    }
    if (Number(counts?.terminal_jobs ?? 0) < 1) {
      throw new Error(`claude_workspace_status did not surface terminal jobs: ${JSON.stringify(workspaceStatus)}`);
    }
    if (!recentTerminalJobs.some((job) => job.job_id === implementJobId)) {
      throw new Error(`claude_workspace_status did not include the implement job: ${JSON.stringify(workspaceStatus)}`);
    }
    if (!recentRuns.some((run) => run.type === "implement")) {
      throw new Error(`claude_workspace_status did not include recent implement runs: ${JSON.stringify(workspaceStatus)}`);
    }
    if (!delegatedWorktrees.some((worktree) => String(worktree.worktree_name ?? "").startsWith("codex-delegated-"))) {
      throw new Error(`claude_workspace_status did not surface delegated worktrees: ${JSON.stringify(workspaceStatus)}`);
    }
    process.stderr.write("  ✓ workspace status aggregated jobs, runs, and delegated worktrees\n");

    process.stderr.write("\n=== HIGH-LEVEL WORKFLOWS PASSED ===\n");
  } finally {
    child.kill("SIGTERM");
    rl.close();
    if (originalHookManifest !== null) {
      await writeFile(HOOK_MANIFEST_PATH, originalHookManifest, "utf8");
    }
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`\nFAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
