import { writeFile as fsWriteFile, mkdir as fsMkdir, readFile as fsReadFile, rm as fsRm } from "node:fs/promises";
import { existsSync as fsExistsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
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

// ---- Core logic ----

export async function applyChangesTransactional(
  cwd: string,
  worktreeRoot: string,
  changes: Array<{ status: string; file: string }>,
): Promise<TransactionApplyResult> {
  const f = fs();
  const backupDir = path.join(cwd, ".codex-claude-delegate", "apply-backups", randomUUID());
  const backups: BackupRecord[] = [];
  const appliedFiles: string[] = [];

  // Phase 1: create backups. Fail closed: if any existing target cannot be
  // backed up, do not mutate the main workspace.
  for (const change of changes) {
    const dest = path.join(cwd, change.file);
    const bakPath = path.join(backupDir, change.file);
    const destExists = f.exists(dest);

    if (destExists) {
      await f.mkdir(path.dirname(bakPath));
      try {
        const content = await f.readFile(dest);
        await f.writeFile(bakPath, content);
        backups.push({ file: change.file, backupPath: bakPath, existed: true });
      } catch (err) {
        await f.rm(backupDir).catch(() => {});
        const backupError = err instanceof Error ? err.message : String(err);
        return {
          applied_files: [],
          error: `Backup failed for ${change.file}: ${backupError}`,
        };
      }
    } else {
      backups.push({ file: change.file, backupPath: bakPath, existed: false });
    }
  }

  // Phase 2: apply changes
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    const dest = path.join(cwd, c.file);
    try {
      if (c.status === "D") {
        if (f.exists(dest)) {
          await f.rm(dest);
        }
      } else {
        const src = path.join(worktreeRoot, c.file);
        const content = await f.readFile(src);
        await f.mkdir(path.dirname(dest));
        await f.writeFile(dest, content);
      }
      appliedFiles.push(c.file);
    } catch (err) {
      const applyError = err instanceof Error ? err.message : String(err);

      // Phase 3: rollback
      const rollbackOk = await rollbackApplied(cwd, backups.slice(0, i + 1), f);

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
