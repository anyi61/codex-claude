import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JobStore } from "../src/jobs.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    await rm(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

async function createStoreFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-job-store-"));
  cleanupPaths.push(root);
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  const store = new JobStore(root);
  await store.init();
  return { root, repo, store };
}

describe("JobStore", () => {
  it("finds an existing running job with the same fingerprint", async () => {
    const { repo, store } = await createStoreFixture();
    await store.create({
      job_id: "job-1",
      type: "implement",
      status: "running",
      cwd: repo,
      created_at: "2026-05-06T00:00:00.000Z",
      updated_at: "2026-05-06T00:00:10.000Z",
      fingerprint: "fp-a",
      payload: { cwd: repo, task: "ship it" },
    });

    const existing = await store.findActiveByFingerprint({
      cwd: repo,
      type: "implement",
      fingerprint: "fp-a",
    });

    expect(existing?.job_id).toBe("job-1");
  });

  it("does not match jobs with a different fingerprint", async () => {
    const { repo, store } = await createStoreFixture();
    await store.create({
      job_id: "job-1",
      type: "query",
      status: "running",
      cwd: repo,
      created_at: "2026-05-06T00:00:00.000Z",
      updated_at: "2026-05-06T00:00:10.000Z",
      fingerprint: "fp-a",
      payload: { cwd: repo, task: "question A" },
    });

    const existing = await store.findActiveByFingerprint({
      cwd: repo,
      type: "query",
      fingerprint: "fp-b",
    });

    expect(existing).toBeNull();
  });

  it("does not match terminal jobs even when fingerprint is identical", async () => {
    const { repo, store } = await createStoreFixture();
    await store.create({
      job_id: "job-1",
      type: "implement",
      status: "succeeded",
      cwd: repo,
      created_at: "2026-05-06T00:00:00.000Z",
      updated_at: "2026-05-06T00:00:10.000Z",
      fingerprint: "fp-a",
      payload: { cwd: repo, task: "ship it" },
    });

    const existing = await store.findActiveByFingerprint({
      cwd: repo,
      type: "implement",
      fingerprint: "fp-a",
    });

    expect(existing).toBeNull();
  });

  it("updates heartbeat_at for active jobs", async () => {
    const { repo, store } = await createStoreFixture();
    await store.create({
      job_id: "job-1",
      type: "review",
      status: "running",
      cwd: repo,
      created_at: "2026-05-06T00:00:00.000Z",
      updated_at: "2026-05-06T00:00:00.000Z",
      payload: { cwd: repo, task: "review it" },
    });

    await store.touchHeartbeat("job-1", "2026-05-06T00:00:30.000Z");
    const updated = await store.get("job-1");

    expect(updated?.heartbeat_at).toBe("2026-05-06T00:00:30.000Z");
    expect(updated?.updated_at).toBe("2026-05-06T00:00:30.000Z");
  });

  it("cleanup does not delete running jobs", async () => {
    const { repo, store } = await createStoreFixture();
    await store.create({
      job_id: "job-running",
      type: "implement",
      status: "running",
      cwd: repo,
      created_at: "2026-05-06T00:00:00.000Z",
      updated_at: "2026-05-06T00:00:00.000Z",
      payload: { cwd: repo, task: "ship it" },
    });

    const result = await store.cleanup({
      cwd: repo,
      older_than_hours: 0,
      dry_run: false,
      limit: 20,
    });

    expect(result.matched_count).toBe(0);
    expect(result.removed_count).toBe(0);
    expect(await store.get("job-running")).not.toBeNull();
  });
});
