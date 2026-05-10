import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobStore } from "../src/jobs.js";

const cleanupPaths: string[] = [];
const originalEnv = { ...process.env };

afterEach(async () => {
  vi.useRealTimers();
  process.env = { ...originalEnv };
  vi.resetModules();
  while (cleanupPaths.length > 0) {
    await rm(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

async function createWaitFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-job-wait-"));
  cleanupPaths.push(root);
  const repo = path.join(root, "repo");
  const stateDir = path.join(root, ".codex-claude-delegate");
  await mkdir(repo, { recursive: true });
  process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;
  process.env.CODEX_CLAUDE_RUN_LOG_DIR = path.join(stateDir, "runs");
  vi.resetModules();
  const cliModule = await import("../src/claude-cli.js");
  cliModule.__test.inlineWaitPollIntervalMs = 5;
  cliModule.__test.inlineWaitTimeoutMs = 50;
  const { waitForBackgroundJob } = cliModule;
  const store = new JobStore(stateDir);
  await store.init();
  return { repo, store, waitForBackgroundJob };
}

describe("claude_job_wait inline wait behavior", () => {
  it("returns completed for a terminal job immediately", async () => {
    const { repo, store, waitForBackgroundJob } = await createWaitFixture();
    await store.create({
      job_id: "job-done",
      type: "review",
      status: "succeeded",
      cwd: repo,
      created_at: "2026-05-06T00:00:00.000Z",
      updated_at: "2026-05-06T00:00:30.000Z",
      result: { findings: "ok" },
      payload: { cwd: repo, task: "review" },
    });

    const result = await waitForBackgroundJob({ cwd: repo, job_id: "job-done" });

    expect(result.waiting).toBe(false);
    expect(result.status).toBe("succeeded");
    expect(result.do_not_start_duplicate_job).toBe(false);
    expect(result.result).toEqual({ findings: "ok" });
  });

  it("classifies old heartbeat as stale and recommends inspect or cancel", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-06T00:06:00.000Z"));
    const { repo, store, waitForBackgroundJob } = await createWaitFixture();
    await store.create({
      job_id: "job-stale",
      type: "implement",
      status: "running",
      cwd: repo,
      created_at: "2026-05-06T00:00:00.000Z",
      updated_at: "2026-05-06T00:00:30.000Z",
      heartbeat_at: "2026-05-06T00:00:30.000Z",
      payload: { cwd: repo, task: "ship it" },
    });

    // Stale is detected on first check before any setTimeout
    const resultPromise = waitForBackgroundJob({ cwd: repo, job_id: "job-stale" });
    vi.advanceTimersByTime(10);
    const result = await resultPromise;

    expect(result.waiting).toBe(true);
    expect(result.stale_state).toBe("stale");
    expect(result.next_actions.map((action) => action.tool)).toEqual([
      "claude_job_cancel",
      "claude_workspace_status",
      "claude_job_result",
    ]);
    vi.useRealTimers();
  });

  it("returns running status and claude_task next action for fresh running job after timeout", async () => {
    const { repo, store, waitForBackgroundJob } = await createWaitFixture();
    await store.create({
      job_id: "job-fresh",
      type: "implement",
      status: "running",
      cwd: repo,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      payload: { cwd: repo, task: "ship it" },
    });

    // With 5ms poll and 50ms timeout, this should complete in < 100ms real time
    const result = await waitForBackgroundJob({ cwd: repo, job_id: "job-fresh" });

    expect(result.waiting).toBe(true);
    expect(result.status).toBe("running");
    expect(result.do_not_start_duplicate_job).toBe(true);
    expect(result.next_actions[0]).toMatchObject({
      tool: "claude_task",
    });
  }, 10000);

  it("returns job-not-found error for wrong cwd", async () => {
    const { repo, store, waitForBackgroundJob } = await createWaitFixture();
    await store.create({
      job_id: "job-other",
      type: "review",
      status: "running",
      cwd: "/other-repo",
      created_at: "2026-05-06T00:00:00.000Z",
      updated_at: "2026-05-06T00:00:10.000Z",
      heartbeat_at: "2026-05-06T00:00:10.000Z",
      payload: { cwd: "/other-repo", task: "review" },
    });

    await expect(
      waitForBackgroundJob({ cwd: repo, job_id: "job-other" })
    ).rejects.toThrow("Job not found");
  });
});
