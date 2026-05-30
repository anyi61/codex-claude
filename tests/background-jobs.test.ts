import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobStore } from "../src/jobs.js";

const cleanupPaths: string[] = [];

type DetachedChild = EventEmitter & { pid: number; unref: ReturnType<typeof vi.fn> };

function createDetachedSpawnResult(pid = 4321): DetachedChild {
  const child = new EventEmitter() as DetachedChild;
  child.pid = pid;
  child.unref = vi.fn();
  return child;
}

async function createJobFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-bg-jobs-"));
  cleanupPaths.push(root);
  const repo = path.join(root, "repo-a");
  const stateDir = path.join(root, ".codex-claude-delegate");
  await mkdir(repo, { recursive: true });
  process.env.CODEX_CLAUDE_RUN_LOG_DIR = path.join(stateDir, "runs");
  vi.resetModules();
  const store = new JobStore(stateDir);
  await store.init();
  return { repo, stateDir, store };
}

afterEach(async () => {
  delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
  delete process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR;
  vi.doUnmock("node:child_process");
  vi.restoreAllMocks();
  vi.resetModules();
  while (cleanupPaths.length > 0) {
    await rm(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

describe("background jobs module", () => {
  it("resolves background state dir from explicit env before run log env", async () => {
    const module = await import("../src/background-jobs.js");
    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = "/tmp/bg-explicit";
    process.env.CODEX_CLAUDE_RUN_LOG_DIR = "/tmp/logs/runs";
    expect(module.getBackgroundStateDir()).toBe(path.resolve("/tmp/bg-explicit"));
    delete process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR;
    expect(module.getBackgroundStateDir()).toBe(path.resolve("/tmp/logs"));
  });

  it("enqueues a detached background job and records launch metadata", async () => {
    const { repo, stateDir } = await createJobFixture();
    const spawnMock = vi.fn(() => createDetachedSpawnResult(5001));
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: spawnMock };
    });
    const module = await import("../src/background-jobs.js");
    const result = await module.enqueueBackgroundJob({ cwd: repo, type: "review", payload: { cwd: repo, task: "review this" } });
    expect(result.job.status).toBe("queued");
    expect(result.job.pid).toBe(5001);
    const store = new JobStore(stateDir);
    await store.init();
    expect((await store.get(result.job.job_id))?.pid).toBe(5001);
  });

  it("marks a background job failed when the detached runner exits during launch", async () => {
    const { repo } = await createJobFixture();
    const spawned = createDetachedSpawnResult(8765);
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        spawn: vi.fn(() => {
          setImmediate(() => spawned.emit("exit", 1, null));
          return spawned;
        }),
      };
    });
    const module = await import("../src/background-jobs.js");
    const result = await module.enqueueBackgroundJob({ cwd: repo, type: "review", payload: { cwd: repo, task: "review this" } });
    expect(result.job.status).toBe("failed");
    expect(result.job.error).toContain("exited during startup");
  });

  it("returns a waiting status while a background job stays running", async () => {
    const { repo, store } = await createJobFixture();
    const now = new Date().toISOString();
    await store.create({
      job_id: "job-running",
      type: "implement",
      status: "running",
      cwd: repo,
      created_at: now,
      updated_at: now,
      heartbeat_at: now,
      payload: { cwd: repo, task: "ship it" },
    });
    const module = await import("../src/background-jobs.js");
    module.__test.inlineWaitPollIntervalMs = 5;
    module.__test.inlineWaitTimeoutMs = 50;
    const result = await module.waitForBackgroundJob({ cwd: repo, job_id: "job-running" });
    expect(result.waiting).toBe(true);
    expect(result.timed_out).toBe(false);
  });

  it("returns a waiting status while a background job stays queued", async () => {
    const { repo, store } = await createJobFixture();
    const now = new Date().toISOString();
    await store.create({
      job_id: "job-queued",
      type: "review",
      status: "queued",
      cwd: repo,
      created_at: now,
      updated_at: now,
      heartbeat_at: now,
      payload: { cwd: repo, task: "review it" },
    });
    const module = await import("../src/background-jobs.js");
    module.__test.inlineWaitPollIntervalMs = 5;
    module.__test.inlineWaitTimeoutMs = 50;
    const result = await module.waitForBackgroundJob({ cwd: repo, job_id: "job-queued" });
    expect(result.waiting).toBe(true);
    expect(result.timed_out).toBe(false);
  });

  it("waits for a background job that is already terminal", async () => {
    const { repo, store } = await createJobFixture();
    await store.create({
      job_id: "job-done",
      type: "implement",
      status: "succeeded",
      result_status: "partial",
      cwd: repo,
      created_at: "2026-05-05T00:00:00.000Z",
      updated_at: "2026-05-05T00:00:01.000Z",
      payload: { cwd: repo, task: "review this" },
      summary: "Implement partial: Hit max turns after editing README.",
      result: { status: "partial" },
    });
    const module = await import("../src/background-jobs.js");
    const result = await module.waitForBackgroundJob({ cwd: repo, job_id: "job-done" });
    expect(result.waiting).toBe(false);
    expect(result.timed_out).toBe(false);
    expect(result.job.result_status).toBe("partial");
    expect(result.next_actions).toEqual([]);
  });

  it("waits for a crashed background job as terminal", async () => {
    const { repo, store } = await createJobFixture();
    await store.create({
      job_id: "job-crashed",
      type: "implement",
      status: "crashed",
      cwd: repo,
      created_at: "2026-05-05T00:00:00.000Z",
      updated_at: "2026-05-05T00:10:00.000Z",
      payload: { cwd: repo, task: "review this" },
      error: "Background job process is no longer alive and was recovered as crashed on server restart.",
    });
    const module = await import("../src/background-jobs.js");
    const result = await module.waitForBackgroundJob({ cwd: repo, job_id: "job-crashed" });
    expect(result.waiting).toBe(false);
    expect(result.timed_out).toBe(false);
    expect(result.status).toBe("crashed");
  });

  it("lists, reads, and cancels background jobs", async () => {
    const { repo, store } = await createJobFixture();
    await store.create({
      job_id: "job-1",
      type: "review",
      status: "queued",
      cwd: repo,
      created_at: "2026-05-05T00:00:00.000Z",
      updated_at: "2026-05-05T00:00:00.000Z",
      payload: { cwd: repo, task: "review this" },
    });
    await store.create({
      job_id: "job-running",
      type: "implement",
      status: "running",
      cwd: repo,
      created_at: "2026-05-05T00:01:00.000Z",
      updated_at: "2026-05-05T00:01:00.000Z",
      pid: 7777,
      payload: { cwd: repo, task: "ship it" },
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const module = await import("../src/background-jobs.js");
    expect((await module.listBackgroundJobs({ cwd: repo, limit: 10 })).entries).toHaveLength(2);
    expect((await module.getBackgroundJobResult({ cwd: repo, job_id: "job-1" }))?.job.job_id).toBe("job-1");
    expect((await module.cancelBackgroundJob({ cwd: repo, job_id: "job-running" })).cancelled).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(7777, "SIGTERM");
  });

  it("returns existing active duplicate job without spawning", async () => {
    const { repo } = await createJobFixture();
    const spawnMock = vi.fn(() => createDetachedSpawnResult(6001));
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: spawnMock };
    });
    const module = await import("../src/background-jobs.js");
    const first = await module.enqueueBackgroundJob({ cwd: repo, type: "query", payload: { cwd: repo, task: "x" }, dedupe: true });
    const second = await module.enqueueBackgroundJob({ cwd: repo, type: "query", payload: { cwd: repo, task: "x" }, dedupe: true });
    expect(second.job.job_id).toBe(first.job.job_id);
    expect(second.do_not_start_duplicate_job).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("dry-runs and removes old terminal background jobs without touching running jobs", async () => {
    const { repo, store } = await createJobFixture();
    await store.create({
      job_id: "job-old-success",
      type: "review",
      status: "succeeded",
      cwd: repo,
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:00:00.000Z",
      payload: { cwd: repo, task: "review this" },
    });
    await store.create({
      job_id: "job-old-cancelled",
      type: "implement",
      status: "cancelled",
      cwd: repo,
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:10:00.000Z",
      payload: { cwd: repo, task: "ship it" },
    });
    await store.create({
      job_id: "job-running",
      type: "implement",
      status: "running",
      cwd: repo,
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:20:00.000Z",
      payload: { cwd: repo, task: "still running" },
    });
    const module = await import("../src/background-jobs.js");
    const dryRun = await module.cleanupBackgroundJobs({ cwd: repo, older_than_hours: 0, dry_run: true, limit: 10 });
    expect(dryRun.matched_count).toBe(2);
    const removed = await module.cleanupBackgroundJobs({ cwd: repo, older_than_hours: 0, dry_run: false, limit: 1 });
    expect(removed.removed_count).toBe(1);
    expect((await store.get("job-running"))?.job_id).toBe("job-running");
  });

  it("finds active implement job by worktree_name and returns null when not found", async () => {
    const { repo, store } = await createJobFixture();
    const now = new Date().toISOString();
    await store.create({
      job_id: "job-wt-active",
      type: "implement",
      status: "running",
      cwd: repo,
      worktree_name: "codex-delegated-testwt00",
      created_at: now,
      updated_at: now,
      payload: { cwd: repo, task: "implement feature" },
    });
    const module = await import("../src/background-jobs.js");
    const match = await module.findActiveImplementByWorktree({ cwd: repo, worktree_name: "codex-delegated-testwt00" });
    expect(match?.job_id).toBe("job-wt-active");

    const miss = await module.findActiveImplementByWorktree({ cwd: repo, worktree_name: "codex-delegated-nonexist" });
    expect(miss).toBeNull();
  });

  it("returns not found when canceling a missing job", async () => {
    const { repo } = await createJobFixture();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const module = await import("../src/background-jobs.js");
    const result = await module.cancelBackgroundJob({ cwd: repo, job_id: "missing" });
    expect(result.cancelled).toBe(false);
    expect(result.error).toContain("not found");
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("recoverCrashedJobs marks running job with dead pid as crashed", async () => {
    const { repo, store } = await createJobFixture();
    const staleTime = new Date(Date.now() - 60_000).toISOString();
    await store.create({
      job_id: "job-dead-pid",
      type: "implement",
      status: "running",
      cwd: repo,
      pid: 999999,
      created_at: staleTime,
      updated_at: staleTime,
      heartbeat_at: staleTime,
      run_id: "run-123",
      worktree_name: "codex-delegated-testwt",
      payload: { cwd: repo, task: "ship it" },
      result: { status: "partial" },
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });
    const module = await import("../src/background-jobs.js");
    const count = await module.recoverCrashedJobs();
    expect(count).toBe(1);
    const updated = await store.get("job-dead-pid");
    expect(updated?.status).toBe("crashed");
    expect(updated?.run_id).toBe("run-123");
    expect(updated?.worktree_name).toBe("codex-delegated-testwt");
    expect(updated?.payload).toEqual({ cwd: repo, task: "ship it" });
    expect(updated?.result).toEqual({ status: "partial" });
    killSpy.mockRestore();
  });

  it("recoverCrashedJobs marks queued job with old stale heartbeat as crashed", async () => {
    const { repo, store } = await createJobFixture();
    const staleTime = new Date(Date.now() - 600_000).toISOString();
    await store.create({
      job_id: "job-stale-queued",
      type: "query",
      status: "queued",
      cwd: repo,
      created_at: staleTime,
      updated_at: staleTime,
      heartbeat_at: staleTime,
      payload: { cwd: repo, task: "explain" },
    });
    const module = await import("../src/background-jobs.js");
    const count = await module.recoverCrashedJobs();
    expect(count).toBe(1);
    const updated = await store.get("job-stale-queued");
    expect(updated?.status).toBe("crashed");
  });

  it("recoverCrashedJobs does not mark queued job without pid created < 30s ago", async () => {
    const { repo, store } = await createJobFixture();
    const recentTime = new Date(Date.now() - 10_000).toISOString();
    await store.create({
      job_id: "job-recent-queued",
      type: "query",
      status: "queued",
      cwd: repo,
      created_at: recentTime,
      updated_at: recentTime,
      payload: { cwd: repo, task: "explain" },
    });
    const module = await import("../src/background-jobs.js");
    const count = await module.recoverCrashedJobs();
    expect(count).toBe(0);
    const updated = await store.get("job-recent-queued");
    expect(updated?.status).toBe("queued");
  });

  it("recoverCrashedJobs does not mark running job with alive pid", async () => {
    const { repo, store } = await createJobFixture();
    const staleTime = new Date(Date.now() - 600_000).toISOString();
    await store.create({
      job_id: "job-alive-pid",
      type: "implement",
      status: "running",
      cwd: repo,
      pid: process.pid,
      created_at: staleTime,
      updated_at: staleTime,
      heartbeat_at: staleTime,
      payload: { cwd: repo, task: "ship it" },
    });
    const module = await import("../src/background-jobs.js");
    const count = await module.recoverCrashedJobs();
    expect(count).toBe(0);
    const updated = await store.get("job-alive-pid");
    expect(updated?.status).toBe("running");
  });

  it("recoverCrashedJobs does not mark already-terminal jobs", async () => {
    const { repo, store } = await createJobFixture();
    const staleTime = new Date(Date.now() - 600_000).toISOString();
    await store.create({
      job_id: "job-already-done",
      type: "review",
      status: "succeeded",
      cwd: repo,
      created_at: staleTime,
      updated_at: staleTime,
      payload: { cwd: repo, task: "review" },
    });
    await store.create({
      job_id: "job-already-failed",
      type: "review",
      status: "failed",
      cwd: repo,
      created_at: staleTime,
      updated_at: staleTime,
      payload: { cwd: repo, task: "review" },
    });
    await store.create({
      job_id: "job-already-crashed",
      type: "review",
      status: "crashed",
      cwd: repo,
      created_at: staleTime,
      updated_at: staleTime,
      payload: { cwd: repo, task: "review" },
    });
    const module = await import("../src/background-jobs.js");
    const count = await module.recoverCrashedJobs();
    expect(count).toBe(0);
  });

  it("recoverCrashedJobs returns 0 when no active jobs exist", async () => {
    const { repo } = await createJobFixture();
    const module = await import("../src/background-jobs.js");
    const count = await module.recoverCrashedJobs();
    expect(count).toBe(0);
  });

  it("returns busy when a concurrent implement job already exists in the same repo", async () => {
    const { repo } = await createJobFixture();
    const spawnMock = vi.fn(() => createDetachedSpawnResult(7001));
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: spawnMock };
    });
    const module = await import("../src/background-jobs.js");
    const first = await module.enqueueBackgroundJob({ cwd: repo, type: "implement", payload: { cwd: repo, task: "implement feature A" }, dedupe: true });
    expect(first.job.status).toBe("queued");
    const second = await module.enqueueBackgroundJob({ cwd: repo, type: "implement", payload: { cwd: repo, task: "implement feature B" }, dedupe: true });
    expect(second.concurrency).toEqual({
      busy: true,
      max_concurrent_implements: 1,
      active_implements: 1,
    });
    expect(second.job.job_id).toBe(first.job.job_id);
    expect(second.do_not_start_duplicate_job).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("does not block concurrent read or review jobs when an implement job is running", async () => {
    const { repo } = await createJobFixture();
    const spawnMock = vi.fn(() => createDetachedSpawnResult(7100));
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: spawnMock };
    });
    const module = await import("../src/background-jobs.js");
    await module.enqueueBackgroundJob({ cwd: repo, type: "implement", payload: { cwd: repo, task: "implement X" }, dedupe: true });
    const review = await module.enqueueBackgroundJob({ cwd: repo, type: "review", payload: { cwd: repo, task: "review X" } });
    expect(review.concurrency).toBeUndefined();
    expect(review.job.status).toBe("queued");
    const query = await module.enqueueBackgroundJob({ cwd: repo, type: "query", payload: { cwd: repo, task: "explain X" } });
    expect(query.concurrency).toBeUndefined();
    expect(query.job.status).toBe("queued");
  });

  it("fingerprint dedupe takes precedence over busy concurrency check for implement", async () => {
    const { repo } = await createJobFixture();
    const spawnMock = vi.fn(() => createDetachedSpawnResult(7200));
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: spawnMock };
    });
    const module = await import("../src/background-jobs.js");
    const payload = { cwd: repo, task: "implement same task" };
    const first = await module.enqueueBackgroundJob({ cwd: repo, type: "implement", payload, dedupe: true });
    const second = await module.enqueueBackgroundJob({ cwd: repo, type: "implement", payload, dedupe: true });
    expect(second.job.job_id).toBe(first.job.job_id);
    expect(second.deduped).toBe(true);
    expect(second.concurrency).toBeUndefined();
  });

  it("fingerprint includes normalized verification_commands", async () => {
    const { repo } = await createJobFixture();
    const spawnMock = vi.fn(() => createDetachedSpawnResult(7201));
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: spawnMock };
    });
    const module = await import("../src/background-jobs.js");

    const first = await module.enqueueBackgroundJob({
      cwd: repo,
      type: "implement",
      payload: { cwd: repo, task: "implement verified task", verification_commands: [" npm test ", "npm run typecheck"] },
      dedupe: true,
    });
    const second = await module.enqueueBackgroundJob({
      cwd: repo,
      type: "implement",
      payload: { cwd: repo, task: "implement verified task", verification_commands: ["npm run typecheck", "npm test"] },
      dedupe: true,
    });

    expect(second.job.job_id).toBe(first.job.job_id);
    expect(second.deduped).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("does not let terminal implement jobs consume implement concurrency", async () => {
    const { repo, store } = await createJobFixture();
    await store.create({
      job_id: `job-done-${randomUUID()}`,
      type: "implement",
      status: "succeeded",
      cwd: repo,
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:01:00.000Z",
      payload: { cwd: repo, task: "old task" },
    });
    const spawnMock = vi.fn(() => createDetachedSpawnResult(7300));
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: spawnMock };
    });
    const module = await import("../src/background-jobs.js");

    const result = await module.enqueueBackgroundJob({ cwd: repo, type: "implement", payload: { cwd: repo, task: "new task" }, dedupe: true });

    expect(result.job.job_id).not.toContain("job-done-");
    expect(result.concurrency).toBeUndefined();
    expect(result.job.status).toBe("queued");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("allows implement jobs in different repos while one repo is busy", async () => {
    const { repo: repoA } = await createJobFixture();
    const { repo: repoB } = await createJobFixture();
    const spawnMock = vi.fn(() => createDetachedSpawnResult(7400));
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: spawnMock };
    });
    const module = await import("../src/background-jobs.js");
    const first = await module.enqueueBackgroundJob({ cwd: repoA, type: "implement", payload: { cwd: repoA, task: "repo A" }, dedupe: true });
    const second = await module.enqueueBackgroundJob({ cwd: repoB, type: "implement", payload: { cwd: repoB, task: "repo B" }, dedupe: true });

    expect(first.job.cwd).toBe(repoA);
    expect(second.job.cwd).toBe(repoB);
    expect(second.concurrency).toBeUndefined();
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("JobStore.findActiveImplementInRepo returns null when no active implement exists", async () => {
    const { repo, store } = await createJobFixture();
    await store.create({
      job_id: `job-${randomUUID()}`,
      type: "review",
      status: "running",
      cwd: repo,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      payload: { cwd: repo, task: "review" },
    });
    expect(await store.findActiveImplementInRepo({ cwd: repo })).toBeNull();
  });

  it("JobStore.findActiveImplementInRepo returns running implement and ignores succeeded", async () => {
    const { repo, store } = await createJobFixture();
    await store.create({
      job_id: `job-done-${randomUUID()}`,
      type: "implement",
      status: "succeeded",
      cwd: repo,
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:01:00.000Z",
      payload: { cwd: repo, task: "old task" },
    });
    const activeId = `job-active-${randomUUID()}`;
    await store.create({
      job_id: activeId,
      type: "implement",
      status: "running",
      cwd: repo,
      created_at: "2026-05-05T00:00:00.000Z",
      updated_at: "2026-05-05T00:01:00.000Z",
      payload: { cwd: repo, task: "current task" },
    });
    expect((await store.findActiveImplementInRepo({ cwd: repo }))?.job_id).toBe(activeId);
  });

  // ---- FUNC-010: context_roots fingerprint tests ----

  it("fingerprint differs when context_roots are present", async () => {
    const module = await import("../src/background-jobs.js");
    const base = module.createTaskFingerprint({
      cwd: "/repo",
      type: "query",
      payload: { cwd: "/repo", task: "explain", mode: "read" },
    });
    const withRoots = module.createTaskFingerprint({
      cwd: "/repo",
      type: "query",
      payload: { cwd: "/repo", task: "explain", mode: "read", context_roots: [{ alias: "lib", cwd: "/other" }] },
    });
    expect(base).not.toBe(withRoots);
  });

  it("fingerprint is stable across context_roots order", async () => {
    const module = await import("../src/background-jobs.js");
    const order1 = module.createTaskFingerprint({
      cwd: "/repo",
      type: "query",
      payload: {
        cwd: "/repo",
        task: "explain",
        context_roots: [
          { alias: "a", cwd: "/a" },
          { alias: "b", cwd: "/b" },
        ],
      },
    });
    const order2 = module.createTaskFingerprint({
      cwd: "/repo",
      type: "query",
      payload: {
        cwd: "/repo",
        task: "explain",
        context_roots: [
          { alias: "b", cwd: "/b" },
          { alias: "a", cwd: "/a" },
        ],
      },
    });
    expect(order1).toBe(order2);
  });

  // ---- STATE-MACHINE-001: fault-injection coverage ----

  it("dedupe does not reuse a crashed job with the same fingerprint", async () => {
    const { repo, store } = await createJobFixture();
    const spawnMock = vi.fn(() => createDetachedSpawnResult(8001));
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: spawnMock };
    });
    await store.create({
      job_id: "job-crashed-old",
      type: "query",
      status: "crashed",
      cwd: repo,
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:10:00.000Z",
      fingerprint: "fp-dedupe-crash",
      payload: { cwd: repo, task: "crashed query" },
    });
    const module = await import("../src/background-jobs.js");
    const result = await module.enqueueBackgroundJob({ cwd: repo, type: "query", payload: { cwd: repo, task: "crashed query" }, dedupe: true });
    expect(result.job.job_id).not.toBe("job-crashed-old");
    expect(result.job.status).toBe("queued");
    expect(result.deduped).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("dedupe does not reuse a cancelled job with the same fingerprint", async () => {
    const { repo, store } = await createJobFixture();
    const spawnMock = vi.fn(() => createDetachedSpawnResult(8002));
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: spawnMock };
    });
    await store.create({
      job_id: "job-cancelled-old",
      type: "query",
      status: "cancelled",
      cwd: repo,
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:10:00.000Z",
      fingerprint: "fp-dedupe-cancel",
      payload: { cwd: repo, task: "cancelled query" },
    });
    const module = await import("../src/background-jobs.js");
    const result = await module.enqueueBackgroundJob({ cwd: repo, type: "query", payload: { cwd: repo, task: "cancelled query" }, dedupe: true });
    expect(result.job.job_id).not.toBe("job-cancelled-old");
    expect(result.job.status).toBe("queued");
    expect(result.deduped).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("dedupe does not reuse a failed job with the same fingerprint", async () => {
    const { repo, store } = await createJobFixture();
    const spawnMock = vi.fn(() => createDetachedSpawnResult(8003));
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: spawnMock };
    });
    await store.create({
      job_id: "job-failed-old",
      type: "query",
      status: "failed",
      cwd: repo,
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:10:00.000Z",
      fingerprint: "fp-dedupe-fail",
      payload: { cwd: repo, task: "failed query" },
    });
    const module = await import("../src/background-jobs.js");
    const result = await module.enqueueBackgroundJob({ cwd: repo, type: "query", payload: { cwd: repo, task: "failed query" }, dedupe: true });
    expect(result.job.job_id).not.toBe("job-failed-old");
    expect(result.job.status).toBe("queued");
    expect(result.deduped).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("enqueue marks job failed when spawn throws synchronously", async () => {
    const { repo } = await createJobFixture();
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        spawn: vi.fn(() => {
          throw new Error("spawn EACCES");
        }),
      };
    });
    const module = await import("../src/background-jobs.js");
    const result = await module.enqueueBackgroundJob({ cwd: repo, type: "review", payload: { cwd: repo, task: "review this" } });
    expect(result.job.status).toBe("failed");
    expect(result.job.error).toContain("spawn EACCES");
  });

  it("wait detects transition to crashed during mid-wait polling", async () => {
    const { repo, store } = await createJobFixture();
    const now = new Date().toISOString();
    await store.create({
      job_id: "job-crash-mid-wait",
      type: "implement",
      status: "running",
      cwd: repo,
      created_at: now,
      updated_at: now,
      heartbeat_at: now,
      payload: { cwd: repo, task: "ship it" },
    });
    const module = await import("../src/background-jobs.js");
    module.__test.inlineWaitPollIntervalMs = 5;
    module.__test.inlineWaitTimeoutMs = 500;

    // Simulate crash between polls by updating status after a short delay
    setTimeout(async () => {
      await store.update("job-crash-mid-wait", { status: "crashed", updated_at: new Date().toISOString(), error: "process died" });
    }, 15);

    const result = await module.waitForBackgroundJob({ cwd: repo, job_id: "job-crash-mid-wait" });
    expect(result.waiting).toBe(false);
    expect(result.status).toBe("crashed");
  });

  it("wait detects transition to terminal state during wait", async () => {
    const { repo, store } = await createJobFixture();
    const now = new Date().toISOString();
    await store.create({
      job_id: "job-success-mid-wait",
      type: "query",
      status: "running",
      cwd: repo,
      created_at: now,
      updated_at: now,
      heartbeat_at: now,
      payload: { cwd: repo, task: "explain" },
    });
    const module = await import("../src/background-jobs.js");
    module.__test.inlineWaitPollIntervalMs = 5;
    module.__test.inlineWaitTimeoutMs = 500;

    setTimeout(async () => {
      await store.update("job-success-mid-wait", { status: "succeeded", updated_at: new Date().toISOString(), result: { status: "success" } });
    }, 15);

    const result = await module.waitForBackgroundJob({ cwd: repo, job_id: "job-success-mid-wait" });
    expect(result.waiting).toBe(false);
    expect(result.status).toBe("succeeded");
  });

  it("recovery skips queued job without pid when age is within grace window", async () => {
    const { repo, store } = await createJobFixture();
    const withinGrace = new Date(Date.now() - 60_000).toISOString(); // 60s, within 300s grace
    await store.create({
      job_id: "job-grace-queued",
      type: "query",
      status: "queued",
      cwd: repo,
      created_at: withinGrace,
      updated_at: withinGrace,
      payload: { cwd: repo, task: "explain" },
    });
    const module = await import("../src/background-jobs.js");
    const count = await module.recoverCrashedJobs();
    expect(count).toBe(0);
    const updated = await store.get("job-grace-queued");
    expect(updated?.status).toBe("queued");
  });

  it("recovery crashes queued job without pid when age exceeds grace window", async () => {
    const { repo, store } = await createJobFixture();
    const beyondGrace = new Date(Date.now() - 600_000).toISOString(); // 10 min, beyond 300s grace
    await store.create({
      job_id: "job-stale-no-pid",
      type: "query",
      status: "queued",
      cwd: repo,
      created_at: beyondGrace,
      updated_at: beyondGrace,
      payload: { cwd: repo, task: "explain" },
    });
    const module = await import("../src/background-jobs.js");
    const count = await module.recoverCrashedJobs();
    expect(count).toBe(1);
    const updated = await store.get("job-stale-no-pid");
    expect(updated?.status).toBe("crashed");
  });

  it("recovery marks queued job with dead pid as crashed after min age", async () => {
    const { repo, store } = await createJobFixture();
    const staleTime = new Date(Date.now() - 60_000).toISOString(); // 60s > 30s min age
    await store.create({
      job_id: "job-dead-pid-queued",
      type: "query",
      status: "queued",
      cwd: repo,
      pid: 999998,
      created_at: staleTime,
      updated_at: staleTime,
      heartbeat_at: staleTime,
      payload: { cwd: repo, task: "explain" },
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });
    const module = await import("../src/background-jobs.js");
    const count = await module.recoverCrashedJobs();
    expect(count).toBe(1);
    const updated = await store.get("job-dead-pid-queued");
    expect(updated?.status).toBe("crashed");
    killSpy.mockRestore();
  });

  it("recovery marks running job with dead pid as crashed after min age", async () => {
    const { repo, store } = await createJobFixture();
    const staleTime = new Date(Date.now() - 60_000).toISOString();
    await store.create({
      job_id: "job-dead-pid-running",
      type: "implement",
      status: "running",
      cwd: repo,
      pid: 999997,
      created_at: staleTime,
      updated_at: staleTime,
      heartbeat_at: staleTime,
      payload: { cwd: repo, task: "ship it" },
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });
    const module = await import("../src/background-jobs.js");
    const count = await module.recoverCrashedJobs();
    expect(count).toBe(1);
    const updated = await store.get("job-dead-pid-running");
    expect(updated?.status).toBe("crashed");
    killSpy.mockRestore();
  });

  it("recovered crashed jobs are not reused by later dedupe", async () => {
    const { repo, stateDir, store } = await createJobFixture();
    const staleTime = new Date(Date.now() - 600_000).toISOString();
    await store.create({
      job_id: "job-recovered",
      type: "query",
      status: "queued",
      cwd: repo,
      created_at: staleTime,
      updated_at: staleTime,
      fingerprint: "fp-recovered",
      payload: { cwd: repo, task: "explain" },
    });
    const module = await import("../src/background-jobs.js");
    // First, recovery marks the old job as crashed
    const recoveryCount = await module.recoverCrashedJobs();
    expect(recoveryCount).toBe(1);
    const recovered = await store.get("job-recovered");
    expect(recovered?.status).toBe("crashed");

    // Enqueue with same fingerprint should NOT reuse the crashed job
    const spawnMock = vi.fn(() => createDetachedSpawnResult(8004));
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: spawnMock };
    });
    vi.resetModules();
    const enqueueModule = await import("../src/background-jobs.js");
    const result = await enqueueModule.enqueueBackgroundJob({ cwd: repo, type: "query", payload: { cwd: repo, task: "explain" }, dedupe: true });
    expect(result.job.job_id).not.toBe("job-recovered");
    expect(result.deduped).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const verifyStore = new JobStore(stateDir);
    await verifyStore.init();
    const stillCrashed = await verifyStore.get("job-recovered");
    expect(stillCrashed?.status).toBe("crashed");
    const newJob = await verifyStore.get(result.job.job_id);
    expect(newJob).not.toBeNull();
  });

  it("recovery skips running job younger than min age even with dead pid", async () => {
    const { repo, store } = await createJobFixture();
    const tooYoung = new Date(Date.now() - 10_000).toISOString(); // 10s < 30s min age
    await store.create({
      job_id: "job-young-dead",
      type: "implement",
      status: "running",
      cwd: repo,
      pid: 999996,
      created_at: tooYoung,
      updated_at: tooYoung,
      payload: { cwd: repo, task: "ship it" },
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });
    const module = await import("../src/background-jobs.js");
    const count = await module.recoverCrashedJobs();
    expect(count).toBe(0);
    const updated = await store.get("job-young-dead");
    expect(updated?.status).toBe("running");
    killSpy.mockRestore();
  });
});
