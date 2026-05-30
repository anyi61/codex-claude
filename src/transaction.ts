import { writeFile as fsWriteFile, mkdir as fsMkdir, readFile as fsReadFile, rm as fsRm } from "node:fs/promises";
import { existsSync as fsExistsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveRepoLocalPath } from "./guard.js";
import type { ApplyDirtyEntry } from "./schema.js";

// ---- Injectable FS operations for fault injection ----

export interface TransactionFSOps {
  exists(dest: string): boolean;
  mkdir(dir: string): Promise<void>;
  readFile(filePath: string): Promise<Buffer>;
  writeFile(filePath: string, data: Buffer): Promise<void>;
  rm(target: string): Promise<void>;
}

export const defaultFSOps: TransactionFSOps = {
  exists(dest: string): boolean {
    return fsExistsSync(dest);
  },
  async mkdir(dir: string): Promise<void> {
    await fsMkdir(dir, { recursive: true });
  },
  async readFile(filePath: string): Promise<Buffer> {
    return fsReadFile(filePath);
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

export async function applyChangesTransactional(
  cwd: string,
  worktreeRoot: string,
  changes: ChangeEntry[],
): Promise<TransactionApplyResult> {
  const f = fs();

  // Phase 0: validate all caller-provided paths before any filesystem mutation.
  for (const change of changes) {
    const targetFileCheck = validateTransactionPath(cwd, change.file, "file", "cwd");
    if (targetFileCheck) return targetFileCheck;

    const sourceFileCheck = validateTransactionPath(worktreeRoot, change.file, "file", "worktreeRoot");
    if (sourceFileCheck) return sourceFileCheck;

    if ((change.status === "R" || change.status === "C") && change.old_file) {
      const oldFileCheck = validateTransactionPath(cwd, change.old_file, "old_file", "cwd");
      if (oldFileCheck) return oldFileCheck;
    }
  }

  const backupDir = path.join(cwd, ".codex-claude-delegate", "apply-backups", randomUUID());
  const backups: BackupRecord[] = [];
  const appliedFiles: string[] = [];
  // Tracks how many backup records exist after processing each change (used for
  // correct rollback scoping since R can produce 2 backup records per change).
  const backupEndIndices: number[] = [];

  // Phase 1: create backups. Fail closed: if any existing target cannot be
  // backed up, do not mutate the main workspace.
  for (const change of changes) {
    const entitiesToBackup: string[] = [change.file];
    // R backs up both destination and source (old_file)
    if (change.status === "R" && change.old_file) {
      entitiesToBackup.push(change.old_file);
    }
    // C backs up destination only (old_file/source must NOT be backed up or mutated)

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

  // Phase 2: apply changes
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    const dest = path.join(cwd, c.file);

    // Unknown status — fail closed
    if (!["A", "M", "D", "R", "C"].includes(c.status)) {
      const rollbackOk = await rollbackApplied(cwd, backups.slice(0, backupEndIndices[i]), f);
      await f.rm(backupDir).catch(() => {});
      if (rollbackOk.ok) {
        return {
          applied_files: [],
          error: `Unsupported change status "${c.status}" for ${c.file}`,
        };
      }
      return {
        applied_files: [],
        dirty_recovery_needed: true,
        dirty_files: rollbackOk.dirtyFiles,
        rollback_error: rollbackOk.error,
        error: `Unsupported change status "${c.status}" for ${c.file}. Rollback also failed.`,
      };
    }

    // R/C without old_file must be rejected
    if ((c.status === "R" || c.status === "C") && !c.old_file) {
      const rollbackOk = await rollbackApplied(cwd, backups.slice(0, backupEndIndices[i]), f);
      await f.rm(backupDir).catch(() => {});
      if (rollbackOk.ok) {
        return {
          applied_files: [],
          error: `Change "${c.status} ${c.file}" is missing a source path (old_file)`,
        };
      }
      return {
        applied_files: [],
        dirty_recovery_needed: true,
        dirty_files: rollbackOk.dirtyFiles,
        rollback_error: rollbackOk.error,
        error: `Change "${c.status} ${c.file}" is missing a source path (old_file). Rollback also failed.`,
      };
    }

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
