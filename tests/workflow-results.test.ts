import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobStore } from "../src/jobs.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
  delete process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR;
  vi.resetModules();
  while (cleanupPaths.length > 0) {
    await rm(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

describe("workflow results", () => {
  it("workspace status reports active implement jobs and background process count", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-status-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    await mkdir(repo, { recursive: true });
    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;

    const store = new JobStore(stateDir);
    await store.init();
    await store.create({
      job_id: "job-running-implement",
      type: "implement",
      status: "running",
      cwd: repo,
      created_at: "2026-05-20T00:00:00.000Z",
      updated_at: "2026-05-20T00:01:00.000Z",
      pid: 4242,
      payload: { cwd: repo, task: "implement" },
    });
    await store.create({
      job_id: "job-queued-query",
      type: "query",
      status: "queued",
      cwd: repo,
      created_at: "2026-05-20T00:00:00.000Z",
      updated_at: "2026-05-20T00:01:00.000Z",
      payload: { cwd: repo, task: "explain" },
    });

    const { getWorkspaceStatus } = await import("../src/workflow-results.js");
    const result = await getWorkspaceStatus({ cwd: repo });

    expect(result.counts.active_implement_jobs).toBe(1);
    expect(result.counts.active_claude_processes).toBe(1);
    expect(result.active_processes).toEqual([
      { job_id: "job-running-implement", type: "implement", pid: 4242 },
    ]);
  });
});
