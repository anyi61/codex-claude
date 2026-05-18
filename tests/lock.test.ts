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

  it("concurrent acquisition stress test: exactly one caller wins", async () => {
    const root = await createFixture();

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        acquireFileLock({ cwd: root, resource: "worktree:concurrent", staleMs: 60_000 })
          .then((lock) => ({ status: "acquired" as const, lock }))
          .catch((err) => ({ status: "error" as const, err }))
      )
    );

    const acquired = results.filter((r): r is { status: "acquired"; lock: { path: string; release: () => Promise<void> } } => r.status === "acquired");
    const errors = results.filter((r): r is { status: "error"; err: unknown } => r.status === "error");

    expect(acquired.length).toBe(1);
    expect(errors.length).toBe(9);
    for (const e of errors) {
      expect(e.err).toBeInstanceOf(LockBusyError);
    }

    // After release, a new caller can acquire.
    await acquired[0].lock.release();
    const newLock = await acquireFileLock({ cwd: root, resource: "worktree:concurrent", staleMs: 60_000 });
    expect(newLock.path).toBe(acquired[0].lock.path);
    await newLock.release();
  });

  it("stale lock recovery under concurrency: exactly one caller claims the stale lock", async () => {
    const root = await createFixture();
    const lockPath = getLockPath(root, "worktree:stale-concurrent");

    // Create a fake stale lock with an old timestamp and a dead PID.
    await mkdir(lockPath, { recursive: true });
    await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: 999999,
      acquired_at: "2000-01-01T00:00:00.000Z",
    }));

    // Ensure process.kill reports the PID as dead no matter what.
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });

    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          acquireFileLock({ cwd: root, resource: "worktree:stale-concurrent", staleMs: 60_000 })
            .then((lock) => ({ status: "acquired" as const, lock }))
            .catch((err) => ({ status: "error" as const, err }))
        )
      );

      const acquired = results.filter((r): r is { status: "acquired"; lock: { path: string; release: () => Promise<void> } } => r.status === "acquired");
      const errors = results.filter((r): r is { status: "error"; err: unknown } => r.status === "error");

      expect(acquired.length).toBe(1);
      expect(errors.length).toBe(4);
      for (const e of errors) {
        expect(e.err).toBeInstanceOf(LockBusyError);
      }

      await acquired[0].lock.release();
    } finally {
      killSpy.mockRestore();
    }
  });
});
