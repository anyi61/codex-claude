import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = path.join(PROJECT_ROOT, "dist", "server.js");

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
  await writeFile(path.join(repo, "README.md"), "# Background Fixture\n");
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
  const root = await mkdtemp(path.join(fixturesRoot, "background-jobs-"));
  const stateDir = path.join(root, ".codex-claude-delegate");
  const logDir = path.join(stateDir, "runs");
  const jobsDir = path.join(stateDir, "jobs");
  const fixtureRepo = await createFixtureRepo(root);

  await mkdir(logDir, { recursive: true });
  await mkdir(jobsDir, { recursive: true });

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
      clientInfo: { name: "background-jobs", version: "0.1.0" },
    });
    notify(child, "notifications/initialized");

    process.stderr.write("\n=== background query ===\n");
    const queryStart = payload(await req(child, "tools/call", {
      name: "claude_query",
      arguments: {
        cwd: PROJECT_ROOT,
        task: "In one sentence, explain what this project does.",
        timeout_sec: 120,
        background: true,
      },
    }));
    const queryJob = queryStart.job as Record<string, unknown> | undefined;
    const queryJobId = String(queryJob?.job_id ?? "");
    if (!queryJobId || queryJob?.status !== "queued") {
      throw new Error(`background query did not return a queued job: ${JSON.stringify(queryStart)}`);
    }
    const queryResult = await waitForJob(child, PROJECT_ROOT, queryJobId);
    const finishedQueryJob = queryResult.job as Record<string, unknown> | undefined;
    if (finishedQueryJob?.status !== "succeeded") {
      throw new Error(`background query did not succeed: ${JSON.stringify(queryResult)}`);
    }
    const queryPayload = queryResult.result as Record<string, unknown> | undefined;
    const queryData = queryPayload?.data as Record<string, unknown> | undefined;
    if (typeof queryData?.answer !== "string" || queryData.answer.length === 0) {
      throw new Error(`background query missing answer payload: ${JSON.stringify(queryResult)}`);
    }
    process.stderr.write("  ✓ background query completed and persisted result\n");

    process.stderr.write("\n=== background review ===\n");
    const reviewStart = payload(await req(child, "tools/call", {
      name: "claude_review",
      arguments: {
        cwd: PROJECT_ROOT,
        task: "Review README.md and summarize any correctness or documentation risks in this project.",
        files: ["README.md"],
        timeout_sec: 120,
        background: true,
      },
    }));
    const reviewJob = reviewStart.job as Record<string, unknown> | undefined;
    const reviewJobId = String(reviewJob?.job_id ?? "");
    if (!reviewJobId || reviewJob?.status !== "queued") {
      throw new Error(`background review did not return a queued job: ${JSON.stringify(reviewStart)}`);
    }
    process.stderr.write(`  queued review job ${reviewJobId}\n`);

    const reviewJobs = payload(await req(child, "tools/call", {
      name: "claude_jobs",
      arguments: { cwd: PROJECT_ROOT, type: "review", limit: 10 },
    }));
    const reviewEntries = (reviewJobs.entries as Array<Record<string, unknown>> | undefined) ?? [];
    if (!reviewEntries.some((entry) => entry.job_id === reviewJobId)) {
      throw new Error(`claude_jobs did not include the queued review job: ${JSON.stringify(reviewJobs)}`);
    }
    process.stderr.write("  ✓ claude_jobs listed the review job\n");

    const reviewResult = await waitForJob(child, PROJECT_ROOT, reviewJobId);
    const finishedReviewJob = reviewResult.job as Record<string, unknown> | undefined;
    const reviewStatus = String(finishedReviewJob?.status ?? "");
    if (reviewStatus !== "succeeded") {
      throw new Error(`background review did not succeed: ${JSON.stringify(reviewResult)}`);
    }
    if (!reviewResult.result || typeof reviewResult.result !== "object") {
      throw new Error(`background review missing persisted result payload: ${JSON.stringify(reviewResult)}`);
    }
    process.stderr.write("  ✓ background review completed and persisted result\n");

    process.stderr.write("\n=== background implement ===\n");
    const implementStart = payload(await req(child, "tools/call", {
      name: "claude_implement",
      arguments: {
        cwd: fixtureRepo,
        task: "Append exactly one line 'Implemented in background mode.' to README.md and do not modify other files.",
        files: ["README.md"],
        max_changed_files: 1,
        timeout_sec: 180,
        background: true,
      },
    }));
    const implementJob = implementStart.job as Record<string, unknown> | undefined;
    const implementJobId = String(implementJob?.job_id ?? "");
    if (!implementJobId || implementJob?.status !== "queued") {
      throw new Error(`background implement did not return a queued job: ${JSON.stringify(implementStart)}`);
    }
    process.stderr.write(`  queued implement job ${implementJobId}\n`);

    const implementResult = await waitForJob(child, fixtureRepo, implementJobId);
    const finishedImplementJob = implementResult.job as Record<string, unknown> | undefined;
    if (finishedImplementJob?.status !== "succeeded") {
      throw new Error(`background implement did not succeed: ${JSON.stringify(implementResult)}`);
    }
    const implementPayload = implementResult.result as Record<string, unknown> | undefined;
    const observed = implementPayload?.server_observed as Record<string, unknown> | undefined;
    const worktreePath = String(observed?.worktree_path ?? "");
    if (!worktreePath.includes("codex-delegated-")) {
      throw new Error(`background implement result missing worktree path: ${JSON.stringify(implementResult)}`);
    }
    process.stderr.write(`  ✓ background implement completed (${worktreePath})\n`);

    process.stderr.write("\n=== background apply ===\n");
    const applyWorktreePath = ".claude/worktrees/codex-delegated-apply";
    sh(fixtureRepo, "git", "worktree", "add", "--detach", applyWorktreePath, "HEAD");
    await writeFile(
      path.join(fixtureRepo, applyWorktreePath, "README.md"),
      "# Background Fixture\n\nImplemented in background mode.\n"
    );
    await writeFile(path.join(logDir, "manual-apply-implement.json"), JSON.stringify({
      type: "implement",
      input: { cwd: fixtureRepo, task: "manual apply fixture", files: ["README.md"] },
      observed: {
        worktree_path: applyWorktreePath,
        worktree_name: "codex-delegated-apply",
        base_commit: sh(fixtureRepo, "git", "rev-parse", "HEAD"),
        changed_files: ["README.md"],
      },
      report: { status: "success", summary: "Manual apply fixture" },
    }, null, 2));
    const applyStart = payload(await req(child, "tools/call", {
      name: "claude_apply",
      arguments: { cwd: fixtureRepo, worktree_path: applyWorktreePath, cleanup: true, background: true },
    }));
    const applyJob = applyStart.job as Record<string, unknown> | undefined;
    const applyJobId = String(applyJob?.job_id ?? "");
    if (!applyJobId || applyJob?.status !== "queued") {
      throw new Error(`background apply did not return a queued job: ${JSON.stringify(applyStart)}`);
    }
    const applyResult = await waitForJob(child, fixtureRepo, applyJobId);
    const finishedApplyJob = applyResult.job as Record<string, unknown> | undefined;
    if (finishedApplyJob?.status !== "succeeded") {
      throw new Error(`background apply did not succeed: ${JSON.stringify(applyResult)}`);
    }
    const applied = applyResult.result as Record<string, unknown> | undefined;
    const appliedFiles = (applied?.applied_files as string[] | undefined) ?? [];
    if (!appliedFiles.includes("README.md")) {
      throw new Error(`claude_apply did not apply README.md from background implement: ${JSON.stringify(applyResult)}`);
    }
    const content = await readFile(path.join(fixtureRepo, "README.md"), "utf8");
    if (!content.includes("Implemented in background mode.")) {
      throw new Error(`background apply content not present after apply: ${content}`);
    }
    process.stderr.write("  ✓ background apply succeeded and landed implement result\n");

    process.stderr.write("\n=== background cleanup worktrees ===\n");
    const cleanupWorktree = ".claude/worktrees/codex-delegated-cleanup";
    sh(fixtureRepo, "git", "worktree", "add", "--detach", cleanupWorktree, "HEAD");
    const cleanupStart = payload(await req(child, "tools/call", {
      name: "claude_cleanup",
      arguments: { cwd: fixtureRepo, older_than_hours: 0, dry_run: false, background: true },
    }));
    const cleanupJob = cleanupStart.job as Record<string, unknown> | undefined;
    const cleanupJobId = String(cleanupJob?.job_id ?? "");
    if (!cleanupJobId || cleanupJob?.status !== "queued") {
      throw new Error(`background cleanup did not return a queued job: ${JSON.stringify(cleanupStart)}`);
    }
    const cleanupResult = await waitForJob(child, fixtureRepo, cleanupJobId);
    const finishedCleanupJob = cleanupResult.job as Record<string, unknown> | undefined;
    if (finishedCleanupJob?.status !== "succeeded") {
      throw new Error(`background cleanup did not succeed: ${JSON.stringify(cleanupResult)}`);
    }
    const cleanupPayload = cleanupResult.result as Record<string, unknown> | undefined;
    const removedCount = Number(cleanupPayload?.removed_count ?? 0);
    if (removedCount < 1) {
      throw new Error(`background cleanup did not remove any worktree: ${JSON.stringify(cleanupResult)}`);
    }
    process.stderr.write("  ✓ background cleanup removed delegated worktree\n");

    process.stderr.write("\n=== cleanup terminal background jobs ===\n");
    const oldCreated = "2026-05-01T00:00:00.000Z";
    await writeFile(path.join(jobsDir, "job-old-success.json"), JSON.stringify({
      job_id: "job-old-success",
      type: "query",
      status: "succeeded",
      cwd: PROJECT_ROOT,
      created_at: oldCreated,
      updated_at: oldCreated,
      payload: { cwd: PROJECT_ROOT, task: "old query fixture" },
      result: { data: { answer: "done" } },
    }, null, 2));
    await writeFile(path.join(jobsDir, "job-old-failed.json"), JSON.stringify({
      job_id: "job-old-failed",
      type: "review",
      status: "failed",
      cwd: PROJECT_ROOT,
      created_at: oldCreated,
      updated_at: oldCreated,
      payload: { cwd: PROJECT_ROOT, task: "old review fixture" },
      error: "fixture failure",
    }, null, 2));
    const cleanupJobsPreview = payload(await req(child, "tools/call", {
      name: "claude_job_cleanup",
      arguments: { cwd: PROJECT_ROOT, older_than_hours: 0, dry_run: true, limit: 10 },
    }));
    const previewMatched = Number(cleanupJobsPreview.matched_count ?? 0);
    if (previewMatched < 2) {
      throw new Error(`claude_job_cleanup dry-run did not match terminal jobs: ${JSON.stringify(cleanupJobsPreview)}`);
    }
    const cleanupJobsApplied = payload(await req(child, "tools/call", {
      name: "claude_job_cleanup",
      arguments: { cwd: PROJECT_ROOT, older_than_hours: 0, dry_run: false, limit: 10 },
    }));
    const removedJobs = Number(cleanupJobsApplied.removed_count ?? 0);
    if (removedJobs < 2) {
      throw new Error(`claude_job_cleanup did not remove terminal jobs: ${JSON.stringify(cleanupJobsApplied)}`);
    }
    process.stderr.write("  ✓ claude_job_cleanup removed old terminal jobs\n");

    process.stderr.write("\n=== cancel queued job ===\n");
    const queuedJobId = "job-manual-cancel";
    const now = new Date().toISOString();
    await writeFile(path.join(jobsDir, `${queuedJobId}.json`), JSON.stringify({
      job_id: queuedJobId,
      type: "review",
      status: "queued",
      cwd: PROJECT_ROOT,
      created_at: now,
      updated_at: now,
      payload: { cwd: PROJECT_ROOT, task: "manual cancel fixture" },
    }, null, 2));

    const cancel = payload(await req(child, "tools/call", {
      name: "claude_job_cancel",
      arguments: { cwd: PROJECT_ROOT, job_id: queuedJobId },
    }));
    if (cancel.cancelled !== true) {
      throw new Error(`claude_job_cancel did not cancel queued job: ${JSON.stringify(cancel)}`);
    }
    const cancelled = payload(await req(child, "tools/call", {
      name: "claude_job_result",
      arguments: { cwd: PROJECT_ROOT, job_id: queuedJobId },
    }));
    const cancelledJob = cancelled.job as Record<string, unknown> | undefined;
    if (cancelledJob?.status !== "cancelled") {
      throw new Error(`cancelled job did not persist cancelled status: ${JSON.stringify(cancelled)}`);
    }
    process.stderr.write("  ✓ claude_job_cancel updated queued job state\n");
  } finally {
    child.stdin!.end();
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.kill();
    await rm(root, { recursive: true, force: true });
  }

  process.stderr.write("\n=== BACKGROUND JOBS PASSED ===\n");
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
