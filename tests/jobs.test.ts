import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JobStore } from "../src/jobs.js";
import { createTaskFingerprint } from "../src/claude-cli.js";

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

  it("preserves concurrent update patches for the same job", async () => {
    const { repo, store } = await createStoreFixture();
    await store.create({
      job_id: "job-concurrent",
      type: "review",
      status: "running",
      cwd: repo,
      created_at: "2026-05-06T00:00:00.000Z",
      updated_at: "2026-05-06T00:00:00.000Z",
      payload: { cwd: repo, task: "review it" },
    });

    await Promise.all([
      store.touchHeartbeat("job-concurrent", "2026-05-06T00:00:30.000Z"),
      store.touchWait("job-concurrent", "2026-05-06T00:00:31.000Z", 10_000),
    ]);

    const updated = await store.get("job-concurrent");
    expect(updated?.heartbeat_at).toBe("2026-05-06T00:00:30.000Z");
    expect(updated?.last_wait_at).toBe("2026-05-06T00:00:31.000Z");
    expect(updated?.last_wait_recommended_delay_ms).toBe(10_000);
  });


  it("finds active implement job by worktree_name", async () => {
    const { repo, store } = await createStoreFixture();
    await store.create({
      job_id: "job-running-wt",
      type: "implement",
      status: "running",
      cwd: repo,
      worktree_name: "codex-delegated-abc12345",
      created_at: "2026-05-06T00:00:00.000Z",
      updated_at: "2026-05-06T00:00:10.000Z",
      payload: { cwd: repo, task: "ship it" },
    });

    const match = await store.findActiveImplementByWorktree({
      cwd: repo,
      worktree_name: "codex-delegated-abc12345",
    });

    expect(match?.job_id).toBe("job-running-wt");
  });

  it("does not match terminal implement jobs by worktree_name", async () => {
    const { repo, store } = await createStoreFixture();
    await store.create({
      job_id: "job-succeeded-wt",
      type: "implement",
      status: "succeeded",
      cwd: repo,
      worktree_name: "codex-delegated-xyz98765",
      created_at: "2026-05-06T00:00:00.000Z",
      updated_at: "2026-05-06T00:00:10.000Z",
      payload: { cwd: repo, task: "ship it" },
    });

    const match = await store.findActiveImplementByWorktree({
      cwd: repo,
      worktree_name: "codex-delegated-xyz98765",
    });

    expect(match).toBeNull();
  });

  it("does not match different worktree names in active implement lookup", async () => {
    const { repo, store } = await createStoreFixture();
    await store.create({
      job_id: "job-running-wt2",
      type: "implement",
      status: "running",
      cwd: repo,
      worktree_name: "codex-delegated-aaa11111",
      created_at: "2026-05-06T00:00:00.000Z",
      updated_at: "2026-05-06T00:00:10.000Z",
      payload: { cwd: repo, task: "ship it" },
    });

    const match = await store.findActiveImplementByWorktree({
      cwd: repo,
      worktree_name: "codex-delegated-bbb22222",
    });

    expect(match).toBeNull();
  });

  it("crashed jobs are not matched by findActiveByFingerprint", async () => {
    const { repo, store } = await createStoreFixture();
    await store.create({
      job_id: "job-crashed",
      type: "implement",
      status: "crashed",
      cwd: repo,
      created_at: "2026-05-06T00:00:00.000Z",
      updated_at: "2026-05-06T00:10:00.000Z",
      fingerprint: "fp-crashed",
      payload: { cwd: repo, task: "ship it" },
    });

    const existing = await store.findActiveByFingerprint({
      cwd: repo,
      type: "implement",
      fingerprint: "fp-crashed",
    });

    expect(existing).toBeNull();
  });

  it("crashed jobs are not matched by findActiveImplementByWorktree", async () => {
    const { repo, store } = await createStoreFixture();
    await store.create({
      job_id: "job-crashed-wt",
      type: "implement",
      status: "crashed",
      cwd: repo,
      worktree_name: "codex-delegated-crashed00",
      created_at: "2026-05-06T00:00:00.000Z",
      updated_at: "2026-05-06T00:10:00.000Z",
      payload: { cwd: repo, task: "ship it" },
    });

    const match = await store.findActiveImplementByWorktree({
      cwd: repo,
      worktree_name: "codex-delegated-crashed00",
    });

    expect(match).toBeNull();
  });

  it("cleanup includes crashed jobs in terminal status filter", async () => {
    const { repo, store } = await createStoreFixture();
    await store.create({
      job_id: "job-crashed-old",
      type: "implement",
      status: "crashed",
      cwd: repo,
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:00:00.000Z",
      payload: { cwd: repo, task: "ship it" },
    });

    const result = await store.cleanup({
      cwd: repo,
      older_than_hours: 0,
      dry_run: true,
      limit: 20,
    });

    expect(result.matched_count).toBe(1);
    expect(result.entries[0]?.status).toBe("crashed");
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

  // ---- STATE-MACHINE-001: fault-injection coverage ----

  it("cleanup preserves queued and running active jobs while removing terminal jobs", async () => {
    const { repo, store } = await createStoreFixture();
    // Active jobs should survive
    await store.create({
      job_id: "job-active-queued",
      type: "query",
      status: "queued",
      cwd: repo,
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:00:00.000Z",
      payload: { cwd: repo, task: "queued query" },
    });
    await store.create({
      job_id: "job-active-running",
      type: "implement",
      status: "running",
      cwd: repo,
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:00:00.000Z",
      payload: { cwd: repo, task: "running task" },
    });
    // Terminal jobs should be removed
    await store.create({
      job_id: "job-terminal-success",
      type: "review",
      status: "succeeded",
      cwd: repo,
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:00:00.000Z",
      payload: { cwd: repo, task: "review done" },
    });
    await store.create({
      job_id: "job-terminal-failed",
      type: "query",
      status: "failed",
      cwd: repo,
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:00:00.000Z",
      payload: { cwd: repo, task: "query failed" },
    });

    const result = await store.cleanup({
      cwd: repo,
      older_than_hours: 0,
      dry_run: false,
      limit: 20,
    });

    expect(result.matched_count).toBe(2);
    expect(result.removed_count).toBe(2);
    // Active jobs still exist
    expect(await store.get("job-active-queued")).not.toBeNull();
    expect(await store.get("job-active-running")).not.toBeNull();
    // Terminal jobs removed
    expect(await store.get("job-terminal-success")).toBeNull();
    expect(await store.get("job-terminal-failed")).toBeNull();
  });

  it("update returns null for non-existent job", async () => {
    const { store } = await createStoreFixture();
    const result = await store.update("non-existent-job-id", {
      status: "failed",
      updated_at: new Date().toISOString(),
    });
    expect(result).toBeNull();
  });
});

describe("createTaskFingerprint", () => {
  it("creates the same fingerprint for the same normalized task", () => {
    const left = createTaskFingerprint({
      cwd: "/repo",
      type: "implement",
      payload: {
        cwd: "/repo",
        task: "  Add feature  ",
        files: ["b.ts", "a.ts"],
        dirty_policy: "snapshot",
        max_cost_usd: 1,
        max_changed_files: 10,
      },
    });
    const right = createTaskFingerprint({
      cwd: "/repo",
      type: "implement",
      payload: {
        cwd: "/repo",
        task: "Add feature",
        files: ["a.ts", "b.ts"],
        dirty_policy: "snapshot",
        max_changed_files: 10,
        max_cost_usd: 1,
      },
    });

    expect(left).toBe(right);
  });

  it("creates different fingerprints for different tasks", () => {
    const left = createTaskFingerprint({
      cwd: "/repo",
      type: "query",
      payload: { cwd: "/repo", task: "Explain A" },
    });
    const right = createTaskFingerprint({
      cwd: "/repo",
      type: "query",
      payload: { cwd: "/repo", task: "Explain B" },
    });

    expect(left).not.toBe(right);
  });
});
