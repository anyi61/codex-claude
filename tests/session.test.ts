import { writeFileSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeRepoKey,
  RECENT_WINDOW_MINUTES,
  SessionStore,
} from "../src/session.js";
import type { Session, SessionType } from "../src/session.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    await rm(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

// ---- Helpers ----

function writeSessionsFile(baseDir: string, sessions: Session[]): void {
  const filePath = path.join(baseDir, "sessions.json");
  writeFileSync(
    filePath,
    JSON.stringify({ version: 1, sessions }, null, 2),
    "utf-8",
  );
}

function makeSession(
  overrides: Partial<Session> & {
    session_id: string;
    type: SessionType;
    repo_key: string;
    repo_path: string;
  },
): Session {
  const now = new Date().toISOString();
  return {
    session_id: overrides.session_id,
    type: overrides.type,
    repo_key: overrides.repo_key,
    repo_path: overrides.repo_path,
    created_at: now,
    last_used: now,
    use_count: 1,
    summary: "",
    expired: false,
    ...overrides,
  };
}

// ===================================================================
// computeRepoKey
// ===================================================================

describe("computeRepoKey", () => {
  let dirA: string;
  let dirB: string;

  beforeEach(async () => {
    dirA = await mkdtemp(path.join(os.tmpdir(), "codex-repokey-a-"));
    cleanupPaths.push(dirA);
    dirB = await mkdtemp(path.join(os.tmpdir(), "codex-repokey-b-"));
    cleanupPaths.push(dirB);
  });

  it("returns a 64-character hex string", async () => {
    const key = await computeRepoKey(dirA);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns the same key for the same directory (stable)", async () => {
    const k1 = await computeRepoKey(dirA);
    const k2 = await computeRepoKey(dirA);
    expect(k1).toBe(k2);
  });

  it("returns different keys for different directories", async () => {
    const k1 = await computeRepoKey(dirA);
    const k2 = await computeRepoKey(dirB);
    expect(k1).not.toBe(k2);
  });

  it("resolves symlinks so symlinked dirs produce the same key", async () => {
    const linkPath = path.join(os.tmpdir(), `codex-sym-${Date.now()}`);
    await symlink(dirA, linkPath);
    cleanupPaths.push(linkPath);

    const keyOriginal = await computeRepoKey(dirA);
    const keyViaLink = await computeRepoKey(linkPath);
    expect(keyOriginal).toBe(keyViaLink);
  });
});

// ===================================================================
// RECENT_WINDOW_MINUTES
// ===================================================================

describe("RECENT_WINDOW_MINUTES", () => {
  it("equals 20", () => {
    expect(RECENT_WINDOW_MINUTES).toBe(20);
  });
});

// ===================================================================
// SessionStore
// ===================================================================

describe("SessionStore", () => {
  let root: string;
  let store: SessionStore;

  beforeEach(async () => {
    vi.useFakeTimers();
    root = await mkdtemp(path.join(os.tmpdir(), "codex-session-store-"));
    cleanupPaths.push(root);
    store = new SessionStore(root);

    // Pin fake time to a known baseline for deterministic timestamps.
    vi.setSystemTime(new Date("2026-05-18T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- init ----

  describe("init", () => {
    it("creates the directory and an empty sessions.json", async () => {
      await store.init();
      const sessions = store.getAll();
      expect(sessions).toEqual([]);

      // Verify the file was created.
      const { readFileSync } = await import("node:fs");
      const raw = readFileSync(path.join(root, "sessions.json"), "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed).toEqual({ version: 1, sessions: [] });
    });

    it("is idempotent — calling init twice does not break", async () => {
      await store.init();
      await store.init();
      const sessions = store.getAll();
      expect(sessions).toEqual([]);
    });
  });

  // ---- getRecent ----

  describe("getRecent", () => {
    it("returns the most recent matching session within the default window", () => {
      writeSessionsFile(root, [
        makeSession({
          session_id: "s1",
          type: "review",
          repo_key: "key1",
          repo_path: "/a",
          last_used: "2026-05-18T11:50:00.000Z",
        }),
        makeSession({
          session_id: "s2",
          type: "review",
          repo_key: "key1",
          repo_path: "/a",
          last_used: "2026-05-18T11:55:00.000Z",
        }),
        makeSession({
          session_id: "s3",
          type: "review",
          repo_key: "key1",
          repo_path: "/a",
          last_used: "2026-05-18T11:45:00.000Z",
        }),
      ]);

      const result = store.getRecent("key1", "review");
      expect(result).toBeTruthy();
      expect(result!.session_id).toBe("s2");
    });

    it("returns null when no sessions exist", () => {
      const result = store.getRecent("key1", "review");
      expect(result).toBeNull();
    });

    it("filters by repo_key and type", () => {
      writeSessionsFile(root, [
        makeSession({
          session_id: "s-match",
          type: "review",
          repo_key: "key1",
          repo_path: "/a",
          last_used: "2026-05-18T11:55:00.000Z",
        }),
        makeSession({
          session_id: "s-wrong-type",
          type: "implement",
          repo_key: "key1",
          repo_path: "/a",
          last_used: "2026-05-18T11:59:00.000Z",
        }),
        makeSession({
          session_id: "s-wrong-repo",
          type: "review",
          repo_key: "key2",
          repo_path: "/b",
          last_used: "2026-05-18T11:59:00.000Z",
        }),
      ]);

      const result = store.getRecent("key1", "review");
      expect(result).toBeTruthy();
      expect(result!.session_id).toBe("s-match");
    });

    it("ignores expired sessions", () => {
      writeSessionsFile(root, [
        makeSession({
          session_id: "s-expired",
          type: "review",
          repo_key: "key1",
          repo_path: "/a",
          last_used: "2026-05-18T11:59:00.000Z",
          expired: true,
        }),
        makeSession({
          session_id: "s-active",
          type: "review",
          repo_key: "key1",
          repo_path: "/a",
          last_used: "2026-05-18T11:55:00.000Z",
          expired: false,
        }),
      ]);

      const result = store.getRecent("key1", "review");
      expect(result).toBeTruthy();
      expect(result!.session_id).toBe("s-active");
    });

    it("respects the withinMinutes parameter", () => {
      writeSessionsFile(root, [
        makeSession({
          session_id: "s-old",
          type: "review",
          repo_key: "key1",
          repo_path: "/a",
          last_used: "2026-05-18T11:50:00.000Z",
        }),
      ]);

      // Default window is 20 min: cutoff = 11:40, s-old at 11:50 fits.
      const withDefault = store.getRecent("key1", "review");
      expect(withDefault).toBeTruthy();

      // withinMinutes=5: cutoff = 11:55, s-old at 11:50 is too old.
      const withTightWindow = store.getRecent("key1", "review", 5);
      expect(withTightWindow).toBeNull();
    });

    it("sorts by last_used descending and returns the most recent", () => {
      writeSessionsFile(root, [
        makeSession({
          session_id: "s-older",
          type: "review",
          repo_key: "key1",
          repo_path: "/a",
          last_used: "2026-05-18T11:40:00.000Z",
        }),
        makeSession({
          session_id: "s-newer",
          type: "review",
          repo_key: "key1",
          repo_path: "/a",
          last_used: "2026-05-18T11:55:00.000Z",
        }),
      ]);

      const result = store.getRecent("key1", "review");
      expect(result).toBeTruthy();
      expect(result!.session_id).toBe("s-newer");
    });
  });

  // ---- getById ----

  describe("getById", () => {
    it("returns the session with the matching id", () => {
      writeSessionsFile(root, [
        makeSession({
          session_id: "abc",
          type: "review",
          repo_key: "key1",
          repo_path: "/a",
        }),
        makeSession({
          session_id: "xyz",
          type: "implement",
          repo_key: "key2",
          repo_path: "/b",
        }),
      ]);

      const result = store.getById("xyz");
      expect(result).toBeTruthy();
      expect(result!.session_id).toBe("xyz");
      expect(result!.type).toBe("implement");
    });

    it("returns null when no session has the given id", () => {
      writeSessionsFile(root, [
        makeSession({
          session_id: "abc",
          type: "review",
          repo_key: "key1",
          repo_path: "/a",
        }),
      ]);

      const result = store.getById("nonexistent");
      expect(result).toBeNull();
    });
  });

  // ---- listByRepo ----

  describe("listByRepo", () => {
    it("returns sessions filtered by repo_key", () => {
      writeSessionsFile(root, [
        makeSession({
          session_id: "s1",
          type: "review",
          repo_key: "key1",
          repo_path: "/a",
        }),
        makeSession({
          session_id: "s2",
          type: "implement",
          repo_key: "key1",
          repo_path: "/a",
        }),
        makeSession({
          session_id: "s3",
          type: "review",
          repo_key: "key2",
          repo_path: "/b",
        }),
      ]);

      const results = store.listByRepo("key1");
      expect(results).toHaveLength(2);
      expect(results.map((s) => s.session_id).sort()).toEqual(["s1", "s2"]);
    });

    it("sorts results by last_used descending", () => {
      writeSessionsFile(root, [
        makeSession({
          session_id: "s1",
          type: "review",
          repo_key: "key1",
          repo_path: "/a",
          last_used: "2026-05-18T11:50:00.000Z",
        }),
        makeSession({
          session_id: "s2",
          type: "review",
          repo_key: "key1",
          repo_path: "/a",
          last_used: "2026-05-18T11:55:00.000Z",
        }),
        makeSession({
          session_id: "s3",
          type: "review",
          repo_key: "key1",
          repo_path: "/a",
          last_used: "2026-05-18T11:45:00.000Z",
        }),
      ]);

      const results = store.listByRepo("key1");
      expect(results.map((s) => s.session_id)).toEqual(["s2", "s1", "s3"]);
    });

    it("respects the limit parameter", () => {
      writeSessionsFile(root, [
        makeSession({
          session_id: "s1",
          type: "review",
          repo_key: "key1",
          repo_path: "/a",
          last_used: "2026-05-18T11:50:00.000Z",
        }),
        makeSession({
          session_id: "s2",
          type: "review",
          repo_key: "key1",
          repo_path: "/a",
          last_used: "2026-05-18T11:55:00.000Z",
        }),
        makeSession({
          session_id: "s3",
          type: "review",
          repo_key: "key1",
          repo_path: "/a",
          last_used: "2026-05-18T11:45:00.000Z",
        }),
      ]);

      const results = store.listByRepo("key1", 2);
      expect(results).toHaveLength(2);
      expect(results.map((s) => s.session_id)).toEqual(["s2", "s1"]);
    });

    it("returns an empty array when no sessions match the repo_key", () => {
      writeSessionsFile(root, [
        makeSession({
          session_id: "s1",
          type: "review",
          repo_key: "key1",
          repo_path: "/a",
        }),
      ]);

      const results = store.listByRepo("nonexistent-key");
      expect(results).toEqual([]);
    });
  });

  // ---- upsert ----

  describe("upsert", () => {
    it("creates a new session with correct fields on first upsert", () => {
      store.upsert("s1", "review", "key1", "/a", "test summary");

      const session = store.getById("s1");
      expect(session).toBeTruthy();
      expect(session!.session_id).toBe("s1");
      expect(session!.type).toBe("review");
      expect(session!.repo_key).toBe("key1");
      expect(session!.repo_path).toBe("/a");
      expect(session!.created_at).toBe("2026-05-18T12:00:00.000Z");
      expect(session!.last_used).toBe("2026-05-18T12:00:00.000Z");
      expect(session!.use_count).toBe(1);
      expect(session!.summary).toBe("test summary");
      expect(session!.expired).toBe(false);
    });

    it("updates an existing session: preserves created_at, increments use_count, updates last_used", () => {
      // First upsert at T=12:00.
      store.upsert("s1", "review", "key1", "/a");

      // Advance time by 1 hour.
      vi.setSystemTime(new Date("2026-05-18T13:00:00Z"));

      // Second upsert same id.
      store.upsert("s1", "review", "key1", "/a", "updated");

      const session = store.getById("s1");
      expect(session).toBeTruthy();
      expect(session!.created_at).toBe("2026-05-18T12:00:00.000Z"); // preserved
      expect(session!.last_used).toBe("2026-05-18T13:00:00.000Z"); // updated
      expect(session!.use_count).toBe(2); // incremented
      expect(session!.summary).toBe("updated");

      // Only one entry should exist.
      const all = store.getAll();
      expect(all).toHaveLength(1);
    });

    it("creates a fresh entry when the session_id is not found (new, not update)", () => {
      writeSessionsFile(root, [
        makeSession({
          session_id: "existing",
          type: "review",
          repo_key: "key1",
          repo_path: "/a",
        }),
      ]);

      store.upsert("new-one", "implement", "key2", "/b");

      const created = store.getById("new-one");
      expect(created).toBeTruthy();
      expect(created!.session_id).toBe("new-one");

      // The pre-existing session should be untouched.
      const existing = store.getById("existing");
      expect(existing).toBeTruthy();

      expect(store.getAll()).toHaveLength(2);
    });
  });

  // ---- markExpired ----

  describe("markExpired", () => {
    it("sets expired=true on a matching session", () => {
      writeSessionsFile(root, [
        makeSession({
          session_id: "s1",
          type: "review",
          repo_key: "key1",
          repo_path: "/a",
        }),
      ]);

      store.markExpired("s1");

      const session = store.getById("s1");
      expect(session).toBeTruthy();
      expect(session!.expired).toBe(true);
    });

    it("is a no-op when the session_id is not found", () => {
      writeSessionsFile(root, [
        makeSession({
          session_id: "s1",
          type: "review",
          repo_key: "key1",
          repo_path: "/a",
        }),
      ]);

      // Should not throw.
      store.markExpired("nonexistent");

      const all = store.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].expired).toBe(false);
    });
  });

  // ---- prune ----

  describe("prune", () => {
    it("removes sessions expired more than 24 hours ago", () => {
      writeSessionsFile(root, [
        makeSession({
          session_id: "old-expired",
          type: "review",
          repo_key: "key1",
          repo_path: "/a",
          last_used: "2026-05-16T12:00:00.000Z", // 48h ago
          expired: true,
        }),
      ]);

      store.prune();

      expect(store.getAll()).toHaveLength(0);
    });

    it("keeps non-expired sessions regardless of age", () => {
      writeSessionsFile(root, [
        makeSession({
          session_id: "old-active",
          type: "review",
          repo_key: "key1",
          repo_path: "/a",
          last_used: "2026-05-16T12:00:00.000Z", // 48h ago
          expired: false,
        }),
      ]);

      store.prune();

      const all = store.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].session_id).toBe("old-active");
    });

    it("keeps sessions that expired less than 24 hours ago", () => {
      writeSessionsFile(root, [
        makeSession({
          session_id: "recent-expired",
          type: "review",
          repo_key: "key1",
          repo_path: "/a",
          last_used: "2026-05-17T22:00:00.000Z", // 14h ago
          expired: true,
        }),
        makeSession({
          session_id: "old-expired",
          type: "review",
          repo_key: "key1",
          repo_path: "/a",
          last_used: "2026-05-16T12:00:00.000Z", // 48h ago
          expired: true,
        }),
      ]);

      store.prune();

      const all = store.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].session_id).toBe("recent-expired");
    });
  });

  // ---- getAll ----

  describe("getAll", () => {
    it("returns all sessions in the store", () => {
      writeSessionsFile(root, [
        makeSession({
          session_id: "s1",
          type: "review",
          repo_key: "key1",
          repo_path: "/a",
        }),
        makeSession({
          session_id: "s2",
          type: "implement",
          repo_key: "key2",
          repo_path: "/b",
          expired: true,
        }),
      ]);

      const all = store.getAll();
      expect(all).toHaveLength(2);
      const ids = all.map((s) => s.session_id).sort();
      expect(ids).toEqual(["s1", "s2"]);
    });
  });

  // ---- Corrupted / missing state file ----

  describe("corrupted state handling", () => {
    it("read() returns an empty store on invalid JSON", () => {
      const filePath = path.join(root, "sessions.json");
      writeFileSync(filePath, "not valid {{{ json", "utf-8");

      const sessions = store.getAll();
      expect(sessions).toEqual([]);
    });

    it("read() returns an empty store when the file is missing", () => {
      // No init call, no sessions.json written yet.
      const sessions = store.getAll();
      expect(sessions).toEqual([]);
    });

    it("upsert works after a corrupted read — writes a fresh store", () => {
      const filePath = path.join(root, "sessions.json");
      writeFileSync(filePath, "garbage {{{", "utf-8");

      // This should succeed despite the corrupted file: read() returns empty,
      // upsert adds the session, and atomicWrite creates a valid file.
      store.upsert("s1", "review", "key1", "/a");

      const session = store.getById("s1");
      expect(session).toBeTruthy();
      expect(session!.session_id).toBe("s1");
      expect(session!.repo_key).toBe("key1");
    });
  });
});
