import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobStore } from "../src/jobs.js";
import {
  markCancelled,
  registerTerminationHandler,
  runJobRunner,
} from "../src/job-runner.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    await rm(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

async function createJobStoreFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-job-runner-"));
  cleanupPaths.push(root);
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  const store = new JobStore(root);
  await store.init();
  return { root, repo, store };
}

describe("job runner helpers", () => {
  it("rejects missing job ids", async () => {
    await expect(runJobRunner("")).rejects.toThrow("jobId is required");
  });

  it("marks exit code when background execution fails", async () => {
    const executeMock = vi.fn(async () => {
      throw new Error("boom");
    });
    const setExitCode = vi.fn();

    await runJobRunner("job-1", {
      executeBackgroundJob: executeMock,
      onSignal: vi.fn(),
      setExitCode,
    });

    expect(executeMock).toHaveBeenCalledWith("job-1");
    expect(setExitCode).toHaveBeenCalledWith(1);
  });

  it("marks jobs cancelled through the exported helper", async () => {
    const { repo, store } = await createJobStoreFixture();

    await store.create({
      job_id: "job-1",
      type: "review",
      status: "running",
      cwd: repo,
      created_at: "2026-05-05T00:00:00.000Z",
      updated_at: "2026-05-05T00:00:00.000Z",
      payload: { cwd: repo, task: "review this" },
    });

    await markCancelled("job-1", () => store);

    const updated = await store.get("job-1");
    expect(updated?.status).toBe("cancelled");
    expect(updated?.summary).toBe("Cancelled by user");
  });

  it("handles SIGTERM by persisting cancelled state and aborting Claude once", async () => {
    const { repo, store } = await createJobStoreFixture();
    await store.create({
      job_id: "job-1",
      type: "implement",
      status: "running",
      cwd: repo,
      created_at: "2026-05-05T00:00:00.000Z",
      updated_at: "2026-05-05T00:00:00.000Z",
      payload: { cwd: repo, task: "ship it" },
    });

    let signalHandler: (() => void) | undefined;
    const onSignal = vi.fn((_signal: NodeJS.Signals, handler: () => void) => {
      signalHandler = handler;
    });
    const abortMock = vi.fn(() => true);
    const exitMock = vi.fn();

    const handleSigterm = registerTerminationHandler("job-1", {
      createStore: () => store,
      onSignal,
      abortActiveClaudeRun: abortMock,
      exit: exitMock,
    });

    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(signalHandler).toBeDefined();

    handleSigterm();
    handleSigterm();
    let updated = await store.get("job-1");
    for (let attempt = 0; attempt < 10 && updated?.status !== "cancelled"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      updated = await store.get("job-1");
    }

    expect(updated?.status).toBe("cancelled");
    expect(abortMock).toHaveBeenCalledTimes(1);
    expect(abortMock).toHaveBeenCalledWith("SIGTERM");
    expect(exitMock).toHaveBeenCalledTimes(1);
    expect(exitMock).toHaveBeenCalledWith(0);
  });
});
