import {
  writeFile as fsWriteFile,
  lstat as fsLstat,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  realpath as fsRealpath,
  rm as fsRm,
} from "node:fs/promises";
import { existsSync as fsExistsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveRepoLocalPath } from "./guard.js";
import type { ApplyDirtyEntry } from "./schema.js";

// ---- Injectable FS operations for fault injection ----

export interface TransactionFSOps {
  exists(dest: string): boolean;
  lstat(target: string): Promise<{ isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>;
  mkdir(dir: string): Promise<void>;
  readFile(filePath: string): Promise<Buffer>;
  realpath(target: string): Promise<string>;
  writeFile(filePath: string, data: Buffer): Promise<void>;
  rm(target: string): Promise<void>;
}

export const defaultFSOps: TransactionFSOps = {
  exists(dest: string): boolean {
    return fsExistsSync(dest);
  },
  async lstat(target: string): Promise<{ isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }> {
    return fsLstat(target);
  },
  async mkdir(dir: string): Promise<void> {
    await fsMkdir(dir, { recursive: true });
  },
  async readFile(filePath: string): Promise<Buffer> {
    return fsReadFile(filePath);
  },
  async realpath(target: string): Promise<string> {
    return fsRealpath(target);
  },
  async writeFile(filePath: string, data: Buffer): Promise<void> {
    await fsWriteFile(filePath, data);
  },
  async rm(target: string): Promise<void> {
    await fsRm(target, { recursive: true, force: true });
  },
};

// Test-only override point (never used in production)
export let __testFSOps: TransactionFSOps | undefined;
export function __setTestFSOps(ops: TransactionFSOps | undefined): void {
  __testFSOps = ops;
}

function fs(): TransactionFSOps {
  return __testFSOps ?? defaultFSOps;
}

// ---- Types ----

interface BackupRecord {
  file: string;
  backupPath: string;
  existed: boolean;
}

export interface TransactionApplyResult {
  applied_files: string[];
  dirty_recovery_needed?: boolean;
  dirty_files?: ApplyDirtyEntry[];
  rollback_error?: string;
  error?: string;
}

/** A single change with optional old_file for rename/copy. */
export interface ChangeEntry {
  status: string;
  file: string;
  old_file?: string;
}

// ---- Core logic ----

const ALLOWED_STATUSES = new Set(["A", "M", "D", "R", "C"]);
const BACKUP_ROOT = ".codex-claude-delegate";
const BACKUP_SUBDIR = "apply-backups";

export async function applyChangesTransactional(
  cwd: string,
  worktreeRoot: string,
  changes: ChangeEntry[],
): Promise<TransactionApplyResult> {
  const f = fs();
  const backupId = randomUUID();

  // Phase 0: validate all caller-provided paths before any filesystem mutation.
  for (const change of changes) {
    if (!ALLOWED_STATUSES.has(change.status)) {
      return {
        applied_files: [],
        error: `Unsupported change status "${change.status}" for ${change.file}`,
      };
    }

    if ((change.status === "R" || change.status === "C") && !change.old_file) {
      return {
        applied_files: [],
        error: `Change "${change.status} ${change.file}" is missing a source path (old_file)`,
      };
    }

    const targetFileCheck = validateTransactionPath(cwd, change.file, "file", "cwd");
    if (targetFileCheck) return targetFileCheck;

    const sourceFileCheck = validateTransactionPath(worktreeRoot, change.file, "file", "worktreeRoot");
    if (sourceFileCheck) return sourceFileCheck;

    if ((change.status === "R" || change.status === "C") && change.old_file) {
      const oldFileCheck = validateTransactionPath(cwd, change.old_file, "old_file", "cwd");
      if (oldFileCheck) return oldFileCheck;

      const oldFileParentCheck = await validateDestinationParentReal(cwd, change.old_file, f);
      if (oldFileParentCheck) return oldFileParentCheck;
    }

    const destParentCheck = await validateDestinationParentReal(cwd, change.file, f);
    if (destParentCheck) return destParentCheck;

    const destPathCheck = await validateExistingWorkspaceFileForIO(cwd, change.file, "destination", f);
    if (destPathCheck) return destPathCheck;

    if (change.status === "R" && change.old_file) {
      const oldFilePathCheck = await validateExistingWorkspaceFileForIO(cwd, change.old_file, "old_file", f);
      if (oldFilePathCheck) return oldFilePathCheck;
    }

    if (change.status !== "D") {
      const sourceRealCheck = await validateSourcePathReal(worktreeRoot, change.file, f);
      if (sourceRealCheck) return sourceRealCheck;
    }

    const backupEntities = getBackupEntities(change);
    for (const file of backupEntities) {
      const backupParentCheck = await validateInternalBackupPathParent(cwd, backupId, file, f);
      if (backupParentCheck) return backupParentCheck;
    }
  }

  const backupDir = path.join(cwd, BACKUP_ROOT, BACKUP_SUBDIR, backupId);
  const backups: BackupRecord[] = [];
  const appliedFiles: string[] = [];
  // Tracks how many backup records exist after processing each change (used for
  // correct rollback scoping since R can produce 2 backup records per change).
  const backupEndIndices: number[] = [];

  // Phase 1: create backups. Fail closed: if any existing target cannot be
  // backed up, do not mutate the main workspace.
  for (const change of changes) {
    const entitiesToBackup = getBackupEntities(change);

    for (const file of entitiesToBackup) {
      const dest = path.join(cwd, file);
      const bakPath = path.join(backupDir, file);
      const destExists = f.exists(dest);

      if (destExists) {
        await f.mkdir(path.dirname(bakPath));
        try {
          const content = await f.readFile(dest);
          await f.writeFile(bakPath, content);
          backups.push({ file, backupPath: bakPath, existed: true });
        } catch (err) {
          await f.rm(backupDir).catch(() => {});
          const backupError = err instanceof Error ? err.message : String(err);
          return {
            applied_files: [],
            error: `Backup failed for ${file}: ${backupError}`,
          };
        }
      } else {
        backups.push({ file, backupPath: bakPath, existed: false });
      }
    }
    backupEndIndices.push(backups.length);
  }

  // Phase 2: apply changes. Phase 0 minimizes symlink escape risk, but another
  // process can still race filesystem entries between validation and mutation.
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    const dest = path.join(cwd, c.file);

    try {
      if (c.status === "D") {
        if (f.exists(dest)) {
          await f.rm(dest);
        }
      } else {
        // A, M, R, C: write file from worktree
        const src = path.join(worktreeRoot, c.file);
        const content = await f.readFile(src);
        await f.mkdir(path.dirname(dest));
        await f.writeFile(dest, content);

        // R additionally removes old_file from cwd
        if (c.status === "R" && c.old_file) {
          const oldDest = path.join(cwd, c.old_file);
          if (f.exists(oldDest)) {
            await f.rm(oldDest);
          }
        }
        // C: does NOT touch old_file/source
      }
      appliedFiles.push(c.file);
    } catch (err) {
      const applyError = err instanceof Error ? err.message : String(err);

      // Phase 3: rollback using tracked backup count
      const rollbackOk = await rollbackApplied(cwd, backups.slice(0, backupEndIndices[i]), f);

      if (rollbackOk.ok) {
        await f.rm(backupDir).catch(() => {});
        return {
          applied_files: [],
          error: `Apply failed for ${c.file}: ${applyError}`,
        };
      }

      // Rollback failed — keep backups for manual recovery
      return {
        applied_files: [],
        dirty_recovery_needed: true,
        dirty_files: rollbackOk.dirtyFiles,
        rollback_error: rollbackOk.error,
        error: `Apply failed for ${c.file}: ${applyError}. Rollback also failed.`,
      };
    }
  }

  // Success: clean up backups
  await f.rm(backupDir).catch(() => {});
  return { applied_files: appliedFiles };
}

function getBackupEntities(change: ChangeEntry): string[] {
  const entitiesToBackup: string[] = [change.file];
  // R backs up both destination and source (old_file).
  if (change.status === "R" && change.old_file) {
    entitiesToBackup.push(change.old_file);
  }
  // C backs up destination only; old_file is metadata and is not read, backed up, or deleted.
  return entitiesToBackup;
}

async function validateSourcePathReal(
  worktreeRoot: string,
  file: string,
  f: TransactionFSOps,
): Promise<TransactionApplyResult | undefined> {
  const rootReal = await f.realpath(worktreeRoot);
  const source = path.resolve(rootReal, file);

  try {
    const sourceStat = await f.lstat(source);
    if (sourceStat.isSymbolicLink()) {
      return {
        applied_files: [],
        error: `Invalid source path for worktreeRoot ${file}: source path is a symlink`,
      };
    }
    if (!sourceStat.isFile()) {
      return {
        applied_files: [],
        error: `Invalid source path for worktreeRoot ${file}: source path is not a regular file`,
      };
    }
  } catch (err) {
    return {
      applied_files: [],
      error: `Invalid source path for worktreeRoot ${file}: ${errorMessage(err)}`,
    };
  }

  const sourceReal = await f.realpath(source);
  if (sourceReal !== rootReal && !sourceReal.startsWith(rootReal + path.sep)) {
    return {
      applied_files: [],
      error: `Invalid source path for worktreeRoot ${file}: source path escapes worktreeRoot`,
    };
  }

  return undefined;
}

async function validateExistingWorkspaceFileForIO(
  cwd: string,
  file: string,
  label: "destination" | "old_file",
  f: TransactionFSOps,
): Promise<TransactionApplyResult | undefined> {
  const cwdReal = await f.realpath(cwd);
  const dest = path.resolve(cwdReal, file);

  const destStat = await lstatOrNull(dest, f);
  if (!destStat) {
    return undefined;
  }

  if (destStat.isSymbolicLink()) {
    return {
      applied_files: [],
      error: `Invalid ${label} path for cwd ${file}: ${label} path is a symlink`,
    };
  }

  if (!destStat.isFile()) {
    return {
      applied_files: [],
      error: `Invalid ${label} path for cwd ${file}: ${label} path is not a regular file`,
    };
  }

  const destReal = await f.realpath(dest);
  if (!pathIsInside(cwdReal, destReal)) {
    return {
      applied_files: [],
      error: `Invalid ${label} path for cwd ${file}: ${label} path escapes cwd`,
    };
  }

  return undefined;
}

async function validateDestinationParentReal(
  cwd: string,
  file: string,
  f: TransactionFSOps,
): Promise<TransactionApplyResult | undefined> {
  const cwdReal = await f.realpath(cwd);
  let candidate = path.dirname(path.resolve(cwdReal, file));

  while (candidate !== cwdReal && !f.exists(candidate)) {
    const next = path.dirname(candidate);
    if (next === candidate) break;
    candidate = next;
  }

  try {
    const parentReal = await f.realpath(candidate);
    if (!pathIsInside(cwdReal, parentReal)) {
      return {
        applied_files: [],
        error: `Invalid destination path for cwd ${file}: destination parent escapes cwd`,
      };
    }
  } catch (err) {
    return {
      applied_files: [],
      error: `Invalid destination path for cwd ${file}: ${errorMessage(err)}`,
    };
  }

  return undefined;
}

async function validateInternalBackupPathParent(
  cwd: string,
  backupId: string,
  file: string,
  f: TransactionFSOps,
): Promise<TransactionApplyResult | undefined> {
  const cwdReal = await f.realpath(cwd);
  const backupRelParent = path.dirname(path.join(BACKUP_ROOT, BACKUP_SUBDIR, backupId, file));
  const parts = backupRelParent.split(path.sep).filter(Boolean);
  let candidate = cwdReal;

  for (const part of parts) {
    candidate = path.join(candidate, part);
    const candidateStat = await lstatOrNull(candidate, f);
    if (!candidateStat) return undefined;

    if (candidateStat.isSymbolicLink()) {
      return {
        applied_files: [],
        error: `Invalid backup path for cwd ${file}: backup path component is a symlink`,
      };
    }

    if (!candidateStat.isDirectory()) {
      return {
        applied_files: [],
        error: `Invalid backup path for cwd ${file}: backup path component is not a directory`,
      };
    }

    const candidateReal = await f.realpath(candidate);
    if (!pathIsInside(cwdReal, candidateReal)) {
      return {
        applied_files: [],
        error: `Invalid backup path for cwd ${file}: backup path escapes cwd`,
      };
    }
  }

  return undefined;
}

async function lstatOrNull(
  target: string,
  f: TransactionFSOps,
): Promise<{ isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean } | null> {
  try {
    return await f.lstat(target);
  } catch (err) {
    if (isErrno(err, "ENOENT")) {
      return null;
    }
    throw err;
  }
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === code;
}

function pathIsInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function validateTransactionPath(
  cwd: string,
  file: string,
  field: "file" | "old_file",
  scope: "cwd" | "worktreeRoot",
): TransactionApplyResult | undefined {
  if (path.isAbsolute(file)) {
    return {
      applied_files: [],
      error: `Invalid ${field} path for ${scope} (absolute): ${file}`,
    };
  }
  const check = resolveRepoLocalPath(cwd, file);
  if (!check.ok) {
    return {
      applied_files: [],
      error: `Invalid ${field} path for ${scope} ${file}: ${check.error}`,
    };
  }
  return undefined;
}

interface RollbackResult {
  ok: boolean;
  dirtyFiles: ApplyDirtyEntry[];
  error?: string;
}

async function rollbackApplied(
  cwd: string,
  backups: BackupRecord[],
  f: TransactionFSOps,
): Promise<RollbackResult> {
  const dirtyFiles: ApplyDirtyEntry[] = [];
  let firstError: string | undefined;

  // Roll back in reverse order
  for (let i = backups.length - 1; i >= 0; i--) {
    const bk = backups[i];
    const dest = path.join(cwd, bk.file);
    try {
      if (bk.existed) {
        await f.mkdir(path.dirname(dest));
        const content = await f.readFile(bk.backupPath);
        await f.writeFile(dest, content);
      } else {
        if (f.exists(dest)) {
          await f.rm(dest);
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      firstError = firstError ?? errMsg;
      dirtyFiles.push({
        file: bk.file,
        status: bk.existed ? "rollback_restore_failed" : "rollback_remove_failed",
      });
    }
  }

  if (dirtyFiles.length === 0) {
    return { ok: true, dirtyFiles: [] };
  }

  return {
    ok: false,
    dirtyFiles,
    error: firstError ?? "Rollback failed for some files",
  };
}
