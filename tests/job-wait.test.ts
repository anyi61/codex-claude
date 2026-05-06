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
  const { waitForBackgroundJob } = await import("../src/claude-cli.js");
  const store = new JobStore(stateDir);
  await store.init();
  return { repo, store, waitForBackgroundJob };
}

describe("claude_job_wait stale classification", () => {
  it("returns do_not_start_duplicate_job for a fresh running job", async () => {
    vi.setSystemTime(new Date("2026-05-06T00:00:20.000Z"));
    const { repo, store, waitForBackgroundJob } = await createWaitFixture();
    await store.create({
      job_id: "job-fresh",
      type: "implement",
      status: "running",
      cwd: repo,
      created_at: "2026-05-06T00:00:00.000Z",
      updated_at: "2026-05-06T00:00:10.000Z",
      heartbeat_at: "2026-05-06T00:00:10.000Z",
      payload: { cwd: repo, task: "ship it" },
    });

    const result = await waitForBackgroundJob({ cwd: repo, job_id: "job-fresh" });

    expect(result.waiting).toBe(true);
    expect(result.do_not_start_duplicate_job).toBe(true);
    expect(result.stale_state).toBe("fresh");
    expect(result.recommended_delay_ms).toBe(10000);
    expect(result.next_actions[0]).toMatchObject({
      tool: "claude_job_wait",
      args: { cwd: repo, job_id: "job-fresh" },
    });
  });

  it("classifies delayed heartbeat as stale_candidate and recommends one more wait", async () => {
    vi.setSystemTime(new Date("2026-05-06T00:03:20.000Z"));
    const { repo, store, waitForBackgroundJob } = await createWaitFixture();
    await store.create({
      job_id: "job-delayed",
      type: "query",
      status: "running",
      cwd: repo,
      created_at: "2026-05-06T00:00:00.000Z",
      updated_at: "2026-05-06T00:01:00.000Z",
      heartbeat_at: "2026-05-06T00:01:00.000Z",
      payload: { cwd: repo, task: "explain" },
    });

    const result = await waitForBackgroundJob({ cwd: repo, job_id: "job-delayed" });

    expect(result.stale_state).toBe("stale_candidate");
    expect(result.do_not_start_duplicate_job).toBe(true);
    expect(result.recommended_delay_ms).toBe(30000);
    expect(result.next_actions[0]?.tool).toBe("claude_job_wait");
  });

  it("classifies old heartbeat as stale and recommends inspect or cancel", async () => {
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

    const result = await waitForBackgroundJob({ cwd: repo, job_id: "job-stale" });

    expect(result.stale_state).toBe("stale");
    expect(result.recommended_delay_ms).toBeUndefined();
    expect(result.next_actions.map((action) => action.tool)).toEqual([
      "claude_job_cancel",
      "claude_workspace_status",
      "claude_job_result",
    ]);
  });

  it.each([
    ["2026-05-06T00:00:00.000Z", "2026-05-06T00:00:20.000Z", 10000],
    ["2026-05-06T00:00:00.000Z", "2026-05-06T00:01:00.000Z", 20000],
    ["2026-05-06T00:00:00.000Z", "2026-05-06T00:05:00.000Z", 45000],
    ["2026-05-06T00:00:00.000Z", "2026-05-06T00:20:00.000Z", 60000],
    ["2026-05-06T00:00:00.000Z", "2026-05-06T00:40:00.000Z", 90000],
  ])("uses dynamic recommended delay for age %s to %s", async (createdAt, now, expectedDelay) => {
    vi.setSystemTime(new Date(now));
    const { repo, store, waitForBackgroundJob } = await createWaitFixture();
    await store.create({
      job_id: `job-${expectedDelay}`,
      type: "review",
      status: "running",
      cwd: repo,
      created_at: createdAt,
      updated_at: now,
      heartbeat_at: now,
      payload: { cwd: repo, task: "review" },
    });

    const result = await waitForBackgroundJob({ cwd: repo, job_id: `job-${expectedDelay}` });

    expect(result.stale_state).toBe("fresh");
    expect(result.recommended_delay_ms).toBe(expectedDelay);
  });

  it("returns terminal job with waiting false and no dedupe flag", async () => {
    vi.setSystemTime(new Date("2026-05-06T00:01:00.000Z"));
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
    expect(result.do_not_start_duplicate_job).toBe(false);
    expect(result.stale_state).toBe("fresh");
    expect(result.result).toEqual({ findings: "ok" });
  });
});
