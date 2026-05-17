import { mkdtemp, mkdir, rm } from "node:fs/promises";
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

  it("returns not found when canceling a missing job", async () => {
    const { repo } = await createJobFixture();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const module = await import("../src/background-jobs.js");
    const result = await module.cancelBackgroundJob({ cwd: repo, job_id: "missing" });
    expect(result.cancelled).toBe(false);
    expect(result.error).toContain("not found");
    expect(killSpy).not.toHaveBeenCalled();
  });
});
