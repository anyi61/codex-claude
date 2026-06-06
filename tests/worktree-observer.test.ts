import { describe, expect, it, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  applyDirtyEntries,
  findDirtyFiles,
  getWorktreeStatus,
} from "../src/worktree-observer.js";

const execFileAsync = promisify(execFile);

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

async function git(cwd: string, ...args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function makeGitRepo(name: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `codex-git-${name}-`));
  cleanupPaths.push(root);
  const cwd = path.join(root, "repo");
  await mkdir(cwd, { recursive: true });
  await git(cwd, "init");
  await git(cwd, "config", "user.email", "codex@example.com");
  await git(cwd, "config", "user.name", "Codex Test");
  await writeFile(path.join(cwd, "tracked.txt"), "tracked\n");
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, "src", "app.ts"), "app\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", "initial");
  return { cwd };
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

describe("findDirtyFiles", () => {
  it("returns sorted dirty requested files from git status", async () => {
    const { cwd } = await makeGitRepo("dirty-requested");
    await writeFile(path.join(cwd, "tracked.txt"), "changed\n");
    await writeFile(path.join(cwd, "new.txt"), "new\n");

    const dirty = await findDirtyFiles(cwd, ["new.txt", "tracked.txt", "clean.txt"]);

    expect(dirty).toEqual(["new.txt", "tracked.txt"]);
  });

  it("returns an empty list when requested files are empty", async () => {
    const dirty = await findDirtyFiles("/does/not/matter", []);

    expect(dirty).toEqual([]);
  });

  it("returns an empty list when git status fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-no-git-"));
    cleanupPaths.push(root);

    const dirty = await findDirtyFiles(root, ["tracked.txt"]);

    expect(dirty).toEqual([]);
  });
});

describe("getWorktreeStatus", () => {
  it("returns short status for delegated worktree path", async () => {
    const { cwd } = await makeGitRepo("worktree-status");
    const worktree = path.join(cwd, ".claude", "worktrees", "snapshot");
    await mkdir(path.dirname(worktree), { recursive: true });
    await git(cwd, "worktree", "add", worktree, "HEAD");
    await writeFile(path.join(worktree, "tracked.txt"), "changed in worktree\n");

    const status = await getWorktreeStatus(cwd, "snapshot");

    expect(status).toContain("M tracked.txt");
  });

  it("returns fallback text when worktree status cannot be read", async () => {
    const { cwd } = await makeGitRepo("worktree-missing");

    const status = await getWorktreeStatus(cwd, "missing");

    expect(status).toBe("(unable to get worktree status)");
  });
});
