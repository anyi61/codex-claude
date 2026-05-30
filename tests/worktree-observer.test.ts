import { describe, expect, it, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyDirtyEntries } from "../src/worktree-observer.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    await rm(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

async function makeFixture(name: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `codex-dirty-${name}-`));
  cleanupPaths.push(root);
  const cwd = path.join(root, "repo");
  const worktree = path.join(cwd, ".claude", "worktrees", "snapshot");
  await mkdir(cwd, { recursive: true });
  await mkdir(worktree, { recursive: true });
  return { cwd, worktree };
}

describe("applyDirtyEntries", () => {
  it("dirty snapshot rejects source path escaping cwd", async () => {
    const { cwd, worktree } = await makeFixture("source-escape");

    await expect(applyDirtyEntries(cwd, worktree, [
      { status: "M", file: "../outside.txt" },
    ])).rejects.toThrow(/source path escapes cwd/);
  });

  it("dirty snapshot rejects destination path escaping worktree", async () => {
    const { cwd, worktree } = await makeFixture("destination-escape");
    await writeFile(path.join(cwd, "outside.txt"), "outside\n");
    const file = `../${path.basename(cwd)}/outside.txt`;

    await expect(applyDirtyEntries(cwd, worktree, [
      { status: "M", file },
    ])).rejects.toThrow(/destination path escapes worktree/);
    expect(await readFile(path.join(cwd, "outside.txt"), "utf8")).toBe("outside\n");
  });

  it("dirty snapshot does not mutate fs for rejected path", async () => {
    const { cwd, worktree } = await makeFixture("no-mutation");
    await mkdir(path.join(worktree, "src"), { recursive: true });
    await writeFile(path.join(worktree, "src", "keep.txt"), "keep\n");

    await expect(applyDirtyEntries(cwd, worktree, [
      { status: "D", file: "../src/keep.txt" },
    ])).rejects.toThrow(/source path escapes cwd/);

    expect(await readFile(path.join(worktree, "src", "keep.txt"), "utf8")).toBe("keep\n");
  });

  it("dirty snapshot copies valid repo-local entries", async () => {
    const { cwd, worktree } = await makeFixture("valid-copy");
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src", "app.ts"), "app\n");
    await writeFile(path.join(cwd, "README.md"), "readme\n");

    const copied = await applyDirtyEntries(cwd, worktree, [
      { status: "M", file: "src/app.ts" },
      { status: "A", file: "README.md" },
    ]);

    expect(copied.sort()).toEqual(["README.md", "src/app.ts"]);
    expect(await readFile(path.join(worktree, "src", "app.ts"), "utf8")).toBe("app\n");
    expect(await readFile(path.join(worktree, "README.md"), "utf8")).toBe("readme\n");
  });

  it("dirty snapshot rejects absolute entry file", async () => {
    const { cwd, worktree } = await makeFixture("absolute");

    await expect(applyDirtyEntries(cwd, worktree, [
      { status: "M", file: path.join(cwd, "README.md") },
    ])).rejects.toThrow(/repo-relative/);
  });

  it("dirty snapshot preserves deletion semantics for valid repo-local entries", async () => {
    const { cwd, worktree } = await makeFixture("delete");
    await mkdir(path.join(worktree, "src"), { recursive: true });
    await writeFile(path.join(worktree, "src", "old.ts"), "old\n");

    const copied = await applyDirtyEntries(cwd, worktree, [
      { status: "D", file: "src/old.ts" },
    ]);

    expect(copied).toEqual(["src/old.ts"]);
    expect(existsSync(path.join(worktree, "src", "old.ts"))).toBe(false);
  });

  it("dirty snapshot skips missing source files", async () => {
    const { cwd, worktree } = await makeFixture("missing");

    const copied = await applyDirtyEntries(cwd, worktree, [
      { status: "M", file: "missing.txt" },
    ]);

    expect(copied).toEqual([]);
  });
});
