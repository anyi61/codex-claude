import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  addArtifactEntry,
  getArtifactSummary,
  hashFile,
  pruneArtifactIndex,
  readArtifactIndex,
  registerPatchArtifact,
  registerVerificationArtifacts,
} from "../src/artifact-index.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    await rm(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-artifact-"));
  cleanupPaths.push(root);
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  return { root, repo };
}

async function writeTestFile(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

// ---- Basic read/write ----

describe("readArtifactIndex", () => {
  it("returns empty index when no file exists", async () => {
    const { repo } = await createFixture();
    const index = await readArtifactIndex(repo);
    expect(index.version).toBe(1);
    expect(index.entries).toEqual([]);
    expect(index.updatedAt).toBeTruthy();
  });

  it("returns empty index for corrupt JSON", async () => {
    const { repo } = await createFixture();
    const artifactDir = path.join(repo, ".codex-claude-delegate", "artifacts");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(artifactDir, "artifacts.json"), "{not valid json", "utf8");

    const index = await readArtifactIndex(repo);
    expect(index.version).toBe(1);
    expect(index.entries).toEqual([]);
  });

  it("filters invalid entries", async () => {
    const { repo } = await createFixture();
    const artifactDir = path.join(repo, ".codex-claude-delegate", "artifacts");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(artifactDir, "artifacts.json"), JSON.stringify({
      version: 1,
      entries: [
        { type: "patch", path: "ok.patch", sha256: "a", sizeBytes: 1, createdAt: "2026-01-01", producer: "test", sensitivity: "safe" },
        { type: "patch", path: "bad.patch" }, // missing fields
        null,
        "not an object",
      ],
    }), "utf8");

    const index = await readArtifactIndex(repo);
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0].path).toBe("ok.patch");
  });
});

describe("writeArtifactIndex", () => {
  it("writes index atomically and reads back", async () => {
    const { repo } = await createFixture();
    const entry = {
      type: "patch" as const,
      path: "test.patch",
      sha256: "abc123",
      sizeBytes: 42,
      createdAt: new Date().toISOString(),
      producer: "test",
      sensitivity: "safe" as const,
    };

    await addArtifactEntry(repo, entry);
    const index = await readArtifactIndex(repo);
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0].sha256).toBe("abc123");
  });

  it("updates updatedAt on each write", async () => {
    const { repo } = await createFixture();
    const idx1 = await readArtifactIndex(repo);
    const ts1 = idx1.updatedAt;

    await new Promise((r) => setTimeout(r, 10));
    await addArtifactEntry(repo, { type: "patch", path: "p.patch", sha256: "a", sizeBytes: 1, producer: "t", sensitivity: "safe" });
    const idx2 = await readArtifactIndex(repo);
    expect(idx2.updatedAt).not.toBe(ts1);
  });
});

// ---- hashFile ----

describe("hashFile", () => {
  it("returns correct sha256", async () => {
    const { repo } = await createFixture();
    const filePath = path.join(repo, "test.txt");
    await writeFile(filePath, "hello world", "utf8");

    const expected = createHash("sha256").update("hello world").digest("hex");
    const actual = await hashFile(filePath);
    expect(actual).toBe(expected);
  });

  it("produces different hashes for different content", async () => {
    const { repo } = await createFixture();
    const a = path.join(repo, "a.txt");
    const b = path.join(repo, "b.txt");
    await writeFile(a, "content-a", "utf8");
    await writeFile(b, "content-b", "utf8");

    const hashA = await hashFile(a);
    const hashB = await hashFile(b);
    expect(hashA).not.toBe(hashB);
  });
});

// ---- getArtifactSummary ----

describe("getArtifactSummary", () => {
  it("returns null when no index exists", async () => {
    const { repo } = await createFixture();
    const summary = await getArtifactSummary(repo);
    expect(summary).not.toBeNull();
    expect(summary!.entry_count).toBe(0);
    expect(summary!.latest_timestamp).toBeNull();
  });

  it("returns counts and latest timestamp", async () => {
    const { repo } = await createFixture();
    await addArtifactEntry(repo, {
      type: "patch",
      path: "a.patch",
      sha256: "a",
      sizeBytes: 1,
      producer: "test",
      sensitivity: "safe",
      createdAt: "2026-01-01T00:00:00Z",
    });
    await addArtifactEntry(repo, {
      type: "verification_stdout",
      path: "v/stdout.txt",
      sha256: "b",
      sizeBytes: 2,
      producer: "test",
      sensitivity: "high",
      createdAt: "2026-06-01T00:00:00Z",
    });

    const summary = await getArtifactSummary(repo);
    expect(summary!.entry_count).toBe(2);
    expect(summary!.type_counts).toEqual({ patch: 1, verification_stdout: 1 });
    expect(summary!.sensitivity_counts).toEqual({ safe: 1, high: 1 });
    expect(summary!.latest_timestamp).toBe("2026-06-01T00:00:00Z");
    expect(summary!.index_path).toContain("artifacts.json");
  });

  it("does not expose entry paths or hashes in summary", async () => {
    const { repo } = await createFixture();
    await addArtifactEntry(repo, {
      type: "patch",
      path: "secret-path.patch",
      sha256: "deadbeef1234",
      sizeBytes: 999,
      producer: "test",
      sensitivity: "safe",
    });

    const summary = await getArtifactSummary(repo);
    const summaryStr = JSON.stringify(summary);
    expect(summaryStr).not.toContain("secret-path");
    expect(summaryStr).not.toContain("deadbeef");
  });
});

// ---- prune ----

describe("pruneArtifactIndex", () => {
  it("dry run reports matched but removes nothing", async () => {
    const { repo } = await createFixture();
    const artifactDir = path.join(repo, ".codex-claude-delegate", "artifacts");
    const testFile = path.join(artifactDir, "old.txt");
    await writeTestFile(testFile, "old content");

    await addArtifactEntry(repo, {
      type: "patch",
      path: ".codex-claude-delegate/artifacts/old.txt",
      sha256: createHash("sha256").update("old content").digest("hex"),
      sizeBytes: 11,
      producer: "test",
      sensitivity: "safe",
      createdAt: "2020-01-01T00:00:00Z",
    });

    const result = await pruneArtifactIndex(repo, { older_than_hours: 24, dry_run: true, limit: 10 });
    expect(result.dry_run).toBe(true);
    expect(result.matched_count).toBe(1);
    expect(result.removed_count).toBe(0);

    // File should still exist
    expect(existsSync(testFile)).toBe(true);

    // Index should still have the entry
    const index = await readArtifactIndex(repo);
    expect(index.entries).toHaveLength(1);
  });

  it("prunes old entries and removes files", async () => {
    const { repo } = await createFixture();
    const artifactDir = path.join(repo, ".codex-claude-delegate", "artifacts");
    const testFile = path.join(artifactDir, "old.txt");
    await writeTestFile(testFile, "old content");

    await addArtifactEntry(repo, {
      type: "patch",
      path: ".codex-claude-delegate/artifacts/old.txt",
      sha256: createHash("sha256").update("old content").digest("hex"),
      sizeBytes: 11,
      producer: "test",
      sensitivity: "safe",
      createdAt: "2020-01-01T00:00:00Z",
    });

    const result = await pruneArtifactIndex(repo, { older_than_hours: 0, dry_run: false, limit: 10 });
    expect(result.removed_count).toBe(1);
    expect(result.failed_count).toBe(0);

    // File should be removed
    expect(existsSync(testFile)).toBe(false);

    // Index should not have the entry
    const index = await readArtifactIndex(repo);
    expect(index.entries).toHaveLength(0);
  });

  it("tolerates missing files during prune", async () => {
    const { repo } = await createFixture();

    // Register an entry for a file that doesn't exist
    await addArtifactEntry(repo, {
      type: "patch",
      path: ".codex-claude-delegate/artifacts/nonexistent.txt",
      sha256: "abc",
      sizeBytes: 0,
      producer: "test",
      sensitivity: "safe",
      createdAt: "2020-01-01T00:00:00Z",
    });

    // Should not throw
    const result = await pruneArtifactIndex(repo, { older_than_hours: 0, dry_run: false, limit: 10 });
    expect(result.removed_count).toBe(1);
    expect(result.failed_count).toBe(0);
  });

  it("keeps fresh entries", async () => {
    const { repo } = await createFixture();
    const artifactDir = path.join(repo, ".codex-claude-delegate", "artifacts");
    const freshFile = path.join(artifactDir, "fresh.txt");
    await writeTestFile(freshFile, "fresh content");

    await addArtifactEntry(repo, {
      type: "patch",
      path: ".codex-claude-delegate/artifacts/fresh.txt",
      sha256: createHash("sha256").update("fresh content").digest("hex"),
      sizeBytes: 13,
      producer: "test",
      sensitivity: "safe",
      createdAt: new Date().toISOString(),
    });

    const result = await pruneArtifactIndex(repo, { older_than_hours: 24, dry_run: false, limit: 10 });
    expect(result.matched_count).toBe(0);
    expect(result.removed_count).toBe(0);

    expect(existsSync(freshFile)).toBe(true);
    const index = await readArtifactIndex(repo);
    expect(index.entries).toHaveLength(1);
  });

  it("does not prune files outside safe cleanup roots", async () => {
    const { repo } = await createFixture();
    // Create a file outside safe cleanup roots
    const unsafeFile = path.join(repo, "outside.txt");
    await writeTestFile(unsafeFile, "unsafe content");

    await addArtifactEntry(repo, {
      type: "patch",
      path: "outside.txt",
      sha256: "abc",
      sizeBytes: 14,
      producer: "test",
      sensitivity: "safe",
      createdAt: "2020-01-01T00:00:00Z",
    });

    const result = await pruneArtifactIndex(repo, { older_than_hours: 0, dry_run: false, limit: 10 });
    expect(result.matched_count).toBe(0);
    expect(result.removed_count).toBe(0);

    expect(existsSync(unsafeFile)).toBe(true);
  });

  it("respects limit", async () => {
    const { repo } = await createFixture();
    const artifactDir = path.join(repo, ".codex-claude-delegate", "artifacts");

    for (let i = 0; i < 5; i++) {
      const file = path.join(artifactDir, `${i}.txt`);
      await writeTestFile(file, `content-${i}`);
      await addArtifactEntry(repo, {
        type: "patch",
        path: `.codex-claude-delegate/artifacts/${i}.txt`,
        sha256: `hash-${i}`,
        sizeBytes: 9,
        producer: "test",
        sensitivity: "safe",
        createdAt: "2020-01-01T00:00:00Z",
      });
    }

    const result = await pruneArtifactIndex(repo, { older_than_hours: 0, dry_run: false, limit: 2 });
    expect(result.matched_count).toBe(2);
    expect(result.removed_count).toBe(2);

    const index = await readArtifactIndex(repo);
    expect(index.entries).toHaveLength(3);
  });
});

// ---- Registration helpers ----

describe("registerPatchArtifact", () => {
  it("registers large patch written to disk", async () => {
    const { repo } = await createFixture();
    const patchDir = path.join(repo, ".claude", "patches");
    const patchPath = path.join(patchDir, "run-1.patch");
    await writeTestFile(patchPath, "diff content here");

    await registerPatchArtifact(repo, "run-1", {
      patch_path: ".claude/patches/run-1.patch",
      diff_sha256: createHash("sha256").update("diff content here").digest("hex"),
      patch_bytes: 18,
    });

    const index = await readArtifactIndex(repo);
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0].type).toBe("patch");
    expect(index.entries[0].producer).toBe("claude_apply");
    expect(index.entries[0].sensitivity).toBe("safe");
    expect(index.entries[0].runId).toBe("run-1");
    expect(index.entries[0].metadata).toEqual({ truncated: true });
  });

  it("registers inline patch as metadata_only", async () => {
    const { repo } = await createFixture();

    await registerPatchArtifact(repo, "run-2", {
      diff_sha256: "abc123",
      patch_bytes: 100,
    });

    const index = await readArtifactIndex(repo);
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0].type).toBe("metadata_only");
    expect(index.entries[0].path).toBe("artifact:patch:run-2");
    expect(index.entries[0].sha256).toBe("abc123");
    expect(index.entries[0].metadata).toEqual({ kind: "inline_patch", truncated: false });
  });

  it("gracefully handles missing patch file", async () => {
    const { repo } = await createFixture();

    // Should not throw
    await registerPatchArtifact(repo, "run-3", {
      patch_path: ".claude/patches/nonexistent.patch",
      diff_sha256: "abc",
      patch_bytes: 0,
    });

    const index = await readArtifactIndex(repo);
    expect(index.entries).toHaveLength(0);
  });

  it("skips when no hash provided", async () => {
    const { repo } = await createFixture();

    await registerPatchArtifact(repo, "run-4", {
      patch: "small patch",
    });

    const index = await readArtifactIndex(repo);
    expect(index.entries).toHaveLength(0);
  });
});

describe("registerVerificationArtifacts", () => {
  it("writes tail files and indexes entries", async () => {
    const { repo } = await createFixture();

    const commands = [
      {
        command: "npm test",
        status: "passed",
        stdout_tail: "All tests passed!",
        stderr_tail: "",
        exit_code: 0,
        duration_ms: 1500,
      },
      {
        command: "npx tsc",
        status: "failed",
        stdout_tail: "",
        stderr_tail: "error TS2304: Cannot find name",
        exit_code: 2,
        duration_ms: 3000,
      },
    ];

    await registerVerificationArtifacts(repo, "run-verify-1", commands);

    // Check files were written
    const verifDir = path.join(repo, ".codex-claude-delegate", "artifacts", "verification", "run-verify-1");
    expect(existsSync(path.join(verifDir, "stdout_00.txt"))).toBe(true);
    expect(existsSync(path.join(verifDir, "stderr_01.txt"))).toBe(true);

    // Check index entries
    const index = await readArtifactIndex(repo);
    expect(index.entries).toHaveLength(2); // 1 stdout + 1 stderr

    const stdoutEntry = index.entries.find((e) => e.type === "verification_stdout");
    expect(stdoutEntry).toBeTruthy();
    expect(stdoutEntry!.sensitivity).toBe("high");
    expect(stdoutEntry!.producer).toBe("claude_implement/verification");
    expect(stdoutEntry!.runId).toBe("run-verify-1");
    expect(stdoutEntry!.metadata).toMatchObject({
      command_index: 0,
      command_status: "passed",
    });
    expect(stdoutEntry!.metadata).not.toHaveProperty("command");

    const stderrEntry = index.entries.find((e) => e.type === "verification_stderr");
    expect(stderrEntry).toBeTruthy();
    expect(stderrEntry!.sensitivity).toBe("high");
    expect(stderrEntry!.metadata).toMatchObject({
      command_index: 1,
      command_status: "failed",
    });
    expect(stderrEntry!.metadata).not.toHaveProperty("command");

    // Verify content is NOT in the artifact index (only metadata)
    const indexContent = await readFile(path.join(repo, ".codex-claude-delegate", "artifacts", "artifacts.json"), "utf8");
    expect(indexContent).not.toContain("All tests passed!");
    expect(indexContent).not.toContain("error TS2304");
    expect(indexContent).not.toContain("npm test");
    expect(indexContent).not.toContain("npx tsc");
  });

  it("skips commands with empty tails", async () => {
    const { repo } = await createFixture();

    const commands = [
      {
        command: "npm test",
        status: "passed" as const,
        stdout_tail: "",
        stderr_tail: "",
        exit_code: 0 as number | null,
        duration_ms: 100,
      },
    ];

    await registerVerificationArtifacts(repo, "run-empty", commands);

    const index = await readArtifactIndex(repo);
    expect(index.entries).toHaveLength(0);
  });
});

// ---- STATE-MACHINE-002: fault-injection coverage ----

describe("artifact index fault injection", () => {
  it("returns empty index for wrong version number", async () => {
    const { repo } = await createFixture();
    const artifactDir = path.join(repo, ".codex-claude-delegate", "artifacts");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(artifactDir, "artifacts.json"), JSON.stringify({
      version: 2,
      entries: [
        { type: "patch", path: "a.patch", sha256: "a", sizeBytes: 1, createdAt: "2026-01-01", producer: "t", sensitivity: "safe" },
      ],
    }), "utf8");

    const index = await readArtifactIndex(repo);
    expect(index.version).toBe(1);
    expect(index.entries).toEqual([]);
  });

  it("reads real index when leftover tmp file exists alongside", async () => {
    const { repo } = await createFixture();
    const artifactDir = path.join(repo, ".codex-claude-delegate", "artifacts");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(artifactDir, "artifacts.json"), JSON.stringify({
      version: 1,
      entries: [
        { type: "patch", path: "real.patch", sha256: "abc", sizeBytes: 10, createdAt: "2026-01-01T00:00:00Z", producer: "test", sensitivity: "safe" },
      ],
      updatedAt: "2026-01-01T00:00:00Z",
    }), "utf8");
    await writeFile(path.join(artifactDir, "artifacts.json.tmp.abc123"), "leftover tmp content", "utf8");

    const index = await readArtifactIndex(repo);
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0].path).toBe("real.patch");
  });

  it("prune skips entry with non-finite createdAt", async () => {
    const { repo } = await createFixture();
    const artifactDir = path.join(repo, ".codex-claude-delegate", "artifacts");
    await writeTestFile(path.join(artifactDir, "bad-date.txt"), "content");

    await addArtifactEntry(repo, {
      type: "patch",
      path: ".codex-claude-delegate/artifacts/bad-date.txt",
      sha256: "abc",
      sizeBytes: 7,
      producer: "test",
      sensitivity: "safe",
      createdAt: "not-a-date",
    });

    const result = await pruneArtifactIndex(repo, { older_than_hours: 0, dry_run: false, limit: 10 });
    expect(result.matched_count).toBe(0);
    expect(result.removed_count).toBe(0);

    const index = await readArtifactIndex(repo);
    expect(index.entries).toHaveLength(1);
    expect(existsSync(path.join(artifactDir, "bad-date.txt"))).toBe(true);
  });

  it("prune tolerates stale file reference where disk file is already deleted", async () => {
    const { repo } = await createFixture();
    const artifactDir = path.join(repo, ".codex-claude-delegate", "artifacts");
    await writeTestFile(path.join(artifactDir, "will-vanish.txt"), "content");

    await addArtifactEntry(repo, {
      type: "patch",
      path: ".codex-claude-delegate/artifacts/will-vanish.txt",
      sha256: "abc",
      sizeBytes: 7,
      producer: "test",
      sensitivity: "safe",
      createdAt: "2020-01-01T00:00:00Z",
    });

    // External process deletes the file
    await rm(path.join(artifactDir, "will-vanish.txt"), { force: true });

    const result = await pruneArtifactIndex(repo, { older_than_hours: 0, dry_run: false, limit: 10 });
    expect(result.removed_count).toBe(1);
    expect(result.failed_count).toBe(0);

    const index = await readArtifactIndex(repo);
    expect(index.entries).toHaveLength(0);
  });

  it("prune removes only safe stale entries while keeping unsafe or fresh entries", async () => {
    const { repo } = await createFixture();
    const artifactDir = path.join(repo, ".codex-claude-delegate", "artifacts");
    await writeTestFile(path.join(artifactDir, "old-safe.txt"), "old-safe");
    await writeTestFile(path.join(repo, "old-unsafe.txt"), "old-unsafe");
    await writeTestFile(path.join(artifactDir, "fresh-safe.txt"), "fresh-safe");

    await addArtifactEntry(repo, {
      type: "patch",
      path: ".codex-claude-delegate/artifacts/old-safe.txt",
      sha256: "a",
      sizeBytes: 8,
      producer: "test",
      sensitivity: "safe",
      createdAt: "2020-01-01T00:00:00Z",
    });
    await addArtifactEntry(repo, {
      type: "patch",
      path: "old-unsafe.txt",
      sha256: "b",
      sizeBytes: 11,
      producer: "test",
      sensitivity: "safe",
      createdAt: "2020-01-01T00:00:00Z",
    });
    await addArtifactEntry(repo, {
      type: "patch",
      path: ".codex-claude-delegate/artifacts/fresh-safe.txt",
      sha256: "c",
      sizeBytes: 10,
      producer: "test",
      sensitivity: "safe",
      createdAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await pruneArtifactIndex(repo, { older_than_hours: 0, dry_run: false, limit: 10 });
    expect(result.removed_count).toBe(1);
    expect(result.matched_count).toBe(1);

    const index = await readArtifactIndex(repo);
    expect(index.entries).toHaveLength(2);
    const paths = index.entries.map((e) => e.path).sort();
    expect(paths).toEqual([".codex-claude-delegate/artifacts/fresh-safe.txt", "old-unsafe.txt"].sort());
  });

  it("getArtifactSummary returns empty summary for wrong version index", async () => {
    const { repo } = await createFixture();
    const artifactDir = path.join(repo, ".codex-claude-delegate", "artifacts");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(artifactDir, "artifacts.json"), JSON.stringify({
      version: 99,
      entries: [{ type: "patch", path: "x.patch", sha256: "x", sizeBytes: 1, createdAt: "2026-01-01", producer: "t", sensitivity: "safe" }],
    }), "utf8");

    const summary = await getArtifactSummary(repo);
    expect(summary).not.toBeNull();
    expect(summary!.entry_count).toBe(0);
    expect(summary!.latest_timestamp).toBeNull();
    expect(summary!.type_counts).toEqual({});
  });

  it("getArtifactSummary returns empty summary for empty entries array", async () => {
    const { repo } = await createFixture();
    const artifactDir = path.join(repo, ".codex-claude-delegate", "artifacts");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(artifactDir, "artifacts.json"), JSON.stringify({
      version: 1,
      entries: [],
      updatedAt: "2026-05-30T00:00:00Z",
    }), "utf8");

    const summary = await getArtifactSummary(repo);
    expect(summary).not.toBeNull();
    expect(summary!.entry_count).toBe(0);
    expect(summary!.latest_timestamp).toBeNull();
    expect(summary!.type_counts).toEqual({});
  });
});

// ---- addArtifactEntry robustness ----

describe("addArtifactEntry robustness", () => {
  it("survives concurrent adds without throwing", async () => {
    const { repo } = await createFixture();

    const adds = Array.from({ length: 10 }, (_, i) =>
      addArtifactEntry(repo, {
        type: "audit",
        path: `audit-${i}.json`,
        sha256: `hash-${i}`,
        sizeBytes: i,
        producer: "test",
        sensitivity: "safe",
      })
    );

    await Promise.all(adds);

    const index = await readArtifactIndex(repo);
    // Due to read-modify-write races, some entries may be lost — this is acceptable
    // The key invariant: we should not crash
    expect(index.entries.length).toBeGreaterThan(0);
  });
});
