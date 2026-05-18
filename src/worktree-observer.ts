import { cp, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execCapture } from "./guard.js";
import { normalizeRepoPath } from "./run-logs.js";

export async function ensureImplementWorkspaceScaffold(worktreePath: string): Promise<void> {
  await Promise.all([
    mkdir(path.join(worktreePath, "src"), { recursive: true }),
    mkdir(path.join(worktreePath, "tests"), { recursive: true }),
    mkdir(path.join(worktreePath, ".github", "workflows"), { recursive: true }),
  ]);
}

export async function findDirtyFiles(cwd: string, requestedFiles: string[]): Promise<string[]> {
  if (requestedFiles.length === 0) return [];
  const output = await execCapture("git", ["status", "--porcelain=v1", "-z", "--", ...requestedFiles], { cwd }).catch(() => "");
  const dirty = new Set<string>();
  for (const entry of parseStatusPorcelainZ(output)) {
    if (entry.file) dirty.add(entry.file);
  }
  return [...dirty].sort();
}

export function isIgnoredMainWorkspaceDirtyFile(file: string): boolean {
  return file === ".claude" ||
    file.startsWith(".claude/") ||
    file === ".codex-claude-delegate" ||
    file.startsWith(".codex-claude-delegate/");
}

export async function findDirtyMainWorkspaceFiles(cwd: string): Promise<string[]> {
  const output = await execCapture("git", ["status", "--porcelain=v1", "-z"], { cwd }).catch(() => "");
  const dirty = new Set<string>();
  for (const entry of parseStatusPorcelainZ(output)) {
    const file = normalizeRepoPath(cwd, entry.file);
    if (!file || isIgnoredMainWorkspaceDirtyFile(file)) continue;
    dirty.add(file);
  }
  return [...dirty].sort();
}

export async function listDirtyMainWorkspaceEntries(cwd: string): Promise<Array<{ status: string; file: string }>> {
  const output = await execCapture("git", ["status", "--porcelain=v1", "-z"], { cwd }).catch(() => "");
  return parseStatusPorcelainZ(output)
    .map((entry) => ({ ...entry, file: normalizeRepoPath(cwd, entry.file) }))
    .filter((entry) => entry.file && !isIgnoredMainWorkspaceDirtyFile(entry.file))
    .sort((a, b) => a.file.localeCompare(b.file));
}

export async function findDirtyImplementFiles(cwd: string, requestedFiles: string[]): Promise<string[]> {
  return requestedFiles.length > 0
    ? findDirtyFiles(cwd, requestedFiles)
    : findDirtyMainWorkspaceFiles(cwd);
}

export function formatDirtyImplementMessage(dirtyFiles: string[], requestedFiles: string[]): string {
  return requestedFiles.length > 0
    ? `Requested files contain uncommitted changes in main workspace: ${dirtyFiles.join(", ")}. Choose dirty_policy="snapshot" to include current uncommitted changes, dirty_policy="committed" to use HEAD only, or commit/stash/clean them before retrying.`
    : `Main workspace contains uncommitted changes: ${dirtyFiles.join(", ")}. Choose dirty_policy="snapshot" to include current uncommitted changes, dirty_policy="committed" to use HEAD only, or commit/stash/clean them before retrying.`;
}

export async function applyDirtySnapshotToWorktree(cwd: string, worktreePath: string): Promise<string[]> {
  const entries = await listDirtyMainWorkspaceEntries(cwd);
  const copied: string[] = [];
  for (const entry of entries) {
    const source = path.join(cwd, entry.file);
    const destination = path.join(worktreePath, entry.file);
    if (entry.status === "D") {
      await rm(destination, { recursive: true, force: true });
      copied.push(entry.file);
      continue;
    }
    if (!existsSync(source)) continue;
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, force: true });
    copied.push(entry.file);
  }
  return copied;
}

// ---- Git status/diff parsing helpers ----

export function parseStatusPorcelainZ(output: string): Array<{ status: string; file: string }> {
  const entries = output.split("\0");
  const parsed: Array<{ status: string; file: string }> = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const match = entry.match(/^(.{2}) (.+)$/s) ?? entry.match(/^([ MADRCU?!]) (.+)$/s);
    if (!match) continue;
    const xy = match[1].length === 1 ? `${match[1]} ` : match[1];
    const firstPath = match[2];
    if (!firstPath) continue;

    let status = "?";
    if (xy === "??") {
      status = "A";
    } else if (xy.includes("R") || xy.includes("C")) {
      status = "unsupported";
      const nextPath = entries[i + 1];
      const file = nextPath || firstPath;
      if (nextPath) i++;
      parsed.push({ status, file });
      continue;
    } else if (xy.includes("D")) {
      status = "D";
    } else if (xy.includes("A")) {
      status = "A";
    } else if (xy.includes("M")) {
      status = "M";
    } else {
      status = xy.trim() || "?";
    }

    parsed.push({ status, file: firstPath });
  }

  return parsed;
}

export function parseNameStatusPorcelainZ(output: string): Array<{ status: string; file: string }> {
  const entries = output.split("\0");
  const parsed: Array<{ status: string; file: string }> = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    let rawStatus = "";
    let firstPath = "";
    let consumedExtraPath = false;

    const tabIndex = entry.indexOf("\t");
    if (tabIndex > 0) {
      rawStatus = entry.slice(0, tabIndex);
      firstPath = entry.slice(tabIndex + 1);
    } else if (/^[A-Z?][0-9]*$/.test(entry)) {
      rawStatus = entry;
      firstPath = entries[i + 1] ?? "";
      consumedExtraPath = true;
    } else {
      continue;
    }
    if (!firstPath) continue;

    const statusCode = rawStatus[0] ?? "?";
    if (statusCode === "R" || statusCode === "C") {
      const nextPath = entries[i + (consumedExtraPath ? 2 : 1)];
      const file = nextPath || firstPath;
      i += consumedExtraPath ? 1 : 0;
      if (nextPath) i++;
      parsed.push({ status: "unsupported", file });
      continue;
    }

    if (statusCode === "A" || statusCode === "M" || statusCode === "D") {
      if (consumedExtraPath) i++;
      parsed.push({ status: statusCode, file: firstPath });
      continue;
    }

    if (consumedExtraPath) i++;
    parsed.push({ status: statusCode, file: firstPath });
  }

  return parsed;
}

export async function getWorktreeStatus(cwd: string, worktree: string): Promise<string> {
  const worktreePath = path.join(cwd, ".claude", "worktrees", worktree);
  try {
    return await execCapture("git", ["status", "--short"], { cwd: worktreePath });
  } catch {
    return "(unable to get worktree status)";
  }
}
