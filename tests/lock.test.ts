import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFileLock, getLockPath, LockBusyError } from "../src/lock.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  while (cleanupPaths.length > 0) {
    await rm(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-lock-"));
  cleanupPaths.push(root);
  return root;
}

describe("filesystem locks", () => {
  it("refuses a second holder for the same workspace resource", async () => {
    const root = await createFixture();
    const first = await acquireFileLock({ cwd: root, resource: "worktree:one", staleMs: 60_000 });

    await expect(
      acquireFileLock({ cwd: root, resource: "worktree:one", staleMs: 60_000 })
    ).rejects.toBeInstanceOf(LockBusyError);

    await first.release();
  });

  it("replaces stale lock directories", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-13T00:00:00.000Z"));
    const root = await createFixture();
    const lockPath = getLockPath(root, "worktree:stale");
    await mkdir(lockPath, { recursive: true });
    await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: 999999,
      acquired_at: "2026-05-12T23:00:00.000Z",
    }));

    const lock = await acquireFileLock({ cwd: root, resource: "worktree:stale", staleMs: 1000 });

    expect(lock.path).toBe(lockPath);
    await lock.release();
  });
});
