import { describe, expect, it, afterEach } from "vitest";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  applyChangesTransactional,
  defaultFSOps,
  __setTestFSOps,
  type TransactionFSOps,
} from "../src/transaction.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  __setTestFSOps(undefined);
  while (cleanupPaths.length > 0) {
    await rm(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

function hasBackupFiles(backupParent: string): boolean {
  if (!existsSync(backupParent)) return false;
  try {
    const entries = readdirSync(backupParent, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) return true;
    }
    return false;
  } catch {
    return false;
  }
}

const fakeFileStat = {
  isDirectory: () => false,
  isFile: () => true,
  isSymbolicLink: () => false,
};

const fakeSymlinkStat = {
  isDirectory: () => false,
  isFile: () => false,
  isSymbolicLink: () => true,
};

const fakeDirectoryStat = {
  isDirectory: () => true,
  isFile: () => false,
  isSymbolicLink: () => false,
};

async function makeFixture(name: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `codex-tx-${name}-`));
  cleanupPaths.push(root);
  const cwd = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  await mkdir(cwd, { recursive: true });
  await mkdir(worktree, { recursive: true });

  await writeFile(path.join(cwd, "existing.txt"), "old content\n");
  await writeFile(path.join(cwd, "modify.txt"), "original\n");

  await writeFile(path.join(worktree, "add.txt"), "new file\n");
  await writeFile(path.join(worktree, "modify.txt"), "modified\n");
  // delete.txt exists in cwd but not in worktree (simulating deletion)
  await writeFile(path.join(cwd, "delete.txt"), "will be deleted\n");

  return { root, cwd, worktree };
}

describe("applyChangesTransactional", () => {
  it("applies A/M/D changes successfully", async () => {
    const { cwd, worktree } = await makeFixture("success");
    const changes = [
      { status: "A", file: "add.txt" },
      { status: "M", file: "modify.txt" },
      { status: "D", file: "delete.txt" },
    ];

    const result = await applyChangesTransactional(cwd, worktree, changes);

    expect(result.error).toBeUndefined();
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(result.applied_files.sort()).toEqual(["add.txt", "delete.txt", "modify.txt"]);

    // Verify add
    expect(await readFile(path.join(cwd, "add.txt"), "utf8")).toBe("new file\n");
    // Verify modify
    expect(await readFile(path.join(cwd, "modify.txt"), "utf8")).toBe("modified\n");
    // Verify delete
    expect(existsSync(path.join(cwd, "delete.txt"))).toBe(false);
    // Verify existing untouched
    expect(await readFile(path.join(cwd, "existing.txt"), "utf8")).toBe("old content\n");

    // Verify no backup files left behind
    const backupParent = path.join(cwd, ".codex-claude-delegate", "apply-backups");
    expect(hasBackupFiles(backupParent)).toBe(false);
  });

  it("creates parent directories for new files", async () => {
    const { cwd, worktree } = await makeFixture("mkdir");
    await mkdir(path.join(worktree, "deep", "nested"), { recursive: true });
    await writeFile(path.join(worktree, "deep", "nested", "file.ts"), "deep content\n");

    const changes = [{ status: "A", file: "deep/nested/file.ts" }];
    const result = await applyChangesTransactional(cwd, worktree, changes);

    expect(result.error).toBeUndefined();
    expect(result.applied_files).toEqual(["deep/nested/file.ts"]);
    expect(await readFile(path.join(cwd, "deep", "nested", "file.ts"), "utf8")).toBe("deep content\n");
  });

  it("applies deletion when file exists in cwd", async () => {
    const { cwd, worktree } = await makeFixture("delete");
    const changes = [{ status: "D", file: "delete.txt" }];

    const result = await applyChangesTransactional(cwd, worktree, changes);

    expect(result.error).toBeUndefined();
    expect(result.applied_files).toEqual(["delete.txt"]);
    expect(existsSync(path.join(cwd, "delete.txt"))).toBe(false);
  });

  it("skips deletion when file does not exist (already deleted)", async () => {
    const { cwd, worktree } = await makeFixture("delete-missing");
    const changes = [{ status: "D", file: "nonexistent.txt" }];

    const result = await applyChangesTransactional(cwd, worktree, changes);

    expect(result.error).toBeUndefined();
    expect(result.applied_files).toEqual(["nonexistent.txt"]);
  });

  it("applies R (rename): writes destination and removes old_file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-tx-rename-"));
    cleanupPaths.push(root);
    const cwd = path.join(root, "repo");
    const worktree = path.join(root, "worktree");
    await mkdir(cwd, { recursive: true });
    await mkdir(worktree, { recursive: true });

    await writeFile(path.join(cwd, "old.txt"), "original content\n");
    await writeFile(path.join(cwd, "existing.txt"), "untouched\n");

    // In worktree, old.txt was removed and new.txt was created (rename)
    await writeFile(path.join(worktree, "new.txt"), "renamed content\n");

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "R", file: "new.txt", old_file: "old.txt" },
    ]);

    expect(result.error).toBeUndefined();
    expect(result.applied_files).toEqual(["new.txt"]);

    // Destination should contain the new content
    expect(await readFile(path.join(cwd, "new.txt"), "utf8")).toBe("renamed content\n");
    // Old file should be removed
    expect(existsSync(path.join(cwd, "old.txt"))).toBe(false);
    // Untouched file preserved
    expect(await readFile(path.join(cwd, "existing.txt"), "utf8")).toBe("untouched\n");

    // No backup dir left behind
    const backupParent = path.join(cwd, ".codex-claude-delegate", "apply-backups");
    expect(hasBackupFiles(backupParent)).toBe(false);
  });

  it("applies R (rename) when destination pre-exists: backs up both and removes old_file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-tx-rename-exists-"));
    cleanupPaths.push(root);
    const cwd = path.join(root, "repo");
    const worktree = path.join(root, "worktree");
    await mkdir(cwd, { recursive: true });
    await mkdir(worktree, { recursive: true });

    // Both old and new files exist in cwd
    await writeFile(path.join(cwd, "old.txt"), "old content\n");
    await writeFile(path.join(cwd, "new.txt"), "preexisting content\n");
    await writeFile(path.join(worktree, "new.txt"), "renamed content\n");

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "R", file: "new.txt", old_file: "old.txt" },
    ]);

    expect(result.error).toBeUndefined();
    expect(result.applied_files).toEqual(["new.txt"]);

    // Destination updated
    expect(await readFile(path.join(cwd, "new.txt"), "utf8")).toBe("renamed content\n");
    // Old file removed
    expect(existsSync(path.join(cwd, "old.txt"))).toBe(false);

    // No backup dir left behind
    const backupParent = path.join(cwd, ".codex-claude-delegate", "apply-backups");
    expect(hasBackupFiles(backupParent)).toBe(false);
  });

  it("applies C (copy): writes destination without touching old_file/source", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-tx-copy-"));
    cleanupPaths.push(root);
    const cwd = path.join(root, "repo");
    const worktree = path.join(root, "worktree");
    await mkdir(cwd, { recursive: true });
    await mkdir(worktree, { recursive: true });

    // old.txt exists in both cwd and worktree (unchanged)
    await writeFile(path.join(cwd, "old.txt"), "original\n");
    await writeFile(path.join(cwd, "existing.txt"), "untouched\n");
    await writeFile(path.join(worktree, "old.txt"), "original\n");
    // new.txt is the copy destination
    await writeFile(path.join(worktree, "new.txt"), "copied content\n");

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "C", file: "new.txt", old_file: "old.txt" },
    ]);

    expect(result.error).toBeUndefined();
    expect(result.applied_files).toEqual(["new.txt"]);

    // Destination written
    expect(await readFile(path.join(cwd, "new.txt"), "utf8")).toBe("copied content\n");
    // Source (old_file) must NOT have been touched
    expect(await readFile(path.join(cwd, "old.txt"), "utf8")).toBe("original\n");
    // Untouched file preserved
    expect(await readFile(path.join(cwd, "existing.txt"), "utf8")).toBe("untouched\n");

    // No backup dir
    const backupParent = path.join(cwd, ".codex-claude-delegate", "apply-backups");
    expect(hasBackupFiles(backupParent)).toBe(false);
  });

  it("applies C (copy) when destination pre-exists: backs up destination only, not source", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-tx-copy-exists-"));
    cleanupPaths.push(root);
    const cwd = path.join(root, "repo");
    const worktree = path.join(root, "worktree");
    await mkdir(cwd, { recursive: true });
    await mkdir(worktree, { recursive: true });

    // Destination pre-exists in cwd
    await writeFile(path.join(cwd, "old.txt"), "original\n");
    await writeFile(path.join(cwd, "new.txt"), "preexisting content\n");
    await writeFile(path.join(worktree, "old.txt"), "original\n");
    await writeFile(path.join(worktree, "new.txt"), "copied content\n");

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "C", file: "new.txt", old_file: "old.txt" },
    ]);

    expect(result.error).toBeUndefined();
    expect(result.applied_files).toEqual(["new.txt"]);

    // Destination updated
    expect(await readFile(path.join(cwd, "new.txt"), "utf8")).toBe("copied content\n");
    // Source must NOT have been touched
    expect(await readFile(path.join(cwd, "old.txt"), "utf8")).toBe("original\n");

    // No backup dir
    const backupParent = path.join(cwd, ".codex-claude-delegate", "apply-backups");
    expect(hasBackupFiles(backupParent)).toBe(false);
  });

  it("rejects unknown change status with fail-closed error", async () => {
    const { cwd, worktree } = await makeFixture("unknown-status");
    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "X", file: "unknown.txt" },
    ]);

    expect(result.error).toContain("Unsupported change status");
    expect(result.error).toContain("X");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });

  it("rejects R/C change missing old_file with fail-closed error", async () => {
    const { cwd, worktree } = await makeFixture("rc-no-old");
    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "R", file: "new.txt" },
    ]);

    expect(result.error).toContain("missing a source path");
    expect(result.error).toContain("R");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });

  it("rejects all changes in Phase 0 when any entry has an unsupported status", async () => {
    const { cwd, worktree } = await makeFixture("rb-unknown");
    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "M", file: "modify.txt" },
      { status: "X", file: "unknown.txt" },
    ]);

    expect(result.error).toContain("Unsupported change status");
    expect(result.error).toContain("X");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
    expect(await readFile(path.join(cwd, "modify.txt"), "utf8")).toBe("original\n");
  });
});

describe("applyChangesTransactional rollback", () => {
  it("aborts without applying changes when backup read fails", async () => {
    const { cwd, worktree } = await makeFixture("backup-read-fails");

    const failingOps: TransactionFSOps = {
      ...defaultFSOps,
      async readFile(filePath: string): Promise<Buffer> {
        if (filePath.endsWith("modify.txt") && !filePath.includes("worktree")) {
          throw new Error("EIO: backup read failed");
        }
        return defaultFSOps.readFile(filePath);
      },
    };
    __setTestFSOps(failingOps);

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "A", file: "add.txt" },
      { status: "M", file: "modify.txt" },
    ]);

    expect(result.error).toContain("Backup failed for modify.txt");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(existsSync(path.join(cwd, "add.txt"))).toBe(false);
    expect(await readFile(path.join(cwd, "modify.txt"), "utf8")).toBe("original\n");
    const backupParent = path.join(cwd, ".codex-claude-delegate", "apply-backups");
    expect(hasBackupFiles(backupParent)).toBe(false);
  });

  it("formats non-Error backup failures without crashing", async () => {
    const { cwd, worktree } = await makeFixture("backup-string-fails");

    const failingOps: TransactionFSOps = {
      ...defaultFSOps,
      async readFile(filePath: string): Promise<Buffer> {
        if (filePath.endsWith("modify.txt") && !filePath.includes("worktree")) {
          throw "string backup failure";
        }
        return defaultFSOps.readFile(filePath);
      },
    };
    __setTestFSOps(failingOps);

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "M", file: "modify.txt" },
    ]);

    expect(result.error).toContain("Backup failed for modify.txt");
    expect(result.error).toContain("string backup failure");
    expect(result.applied_files).toEqual([]);
  });

  it("aborts without applying changes when backup write fails", async () => {
    const { cwd, worktree } = await makeFixture("backup-write-fails");

    const failingOps: TransactionFSOps = {
      ...defaultFSOps,
      async writeFile(filePath: string, data: Buffer, options?: { flag?: string }): Promise<void> {
        if (filePath.includes(".codex-claude-delegate/apply-backups")) {
          throw new Error("ENOSPC: backup write failed");
        }
        return defaultFSOps.writeFile(filePath, data, options);
      },
    };
    __setTestFSOps(failingOps);

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "A", file: "add.txt" },
      { status: "M", file: "modify.txt" },
    ]);

    expect(result.error).toContain("Backup failed for modify.txt");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(existsSync(path.join(cwd, "add.txt"))).toBe(false);
    expect(await readFile(path.join(cwd, "modify.txt"), "utf8")).toBe("original\n");
  });

  it("restores the current modified file when its write partially succeeds then fails", async () => {
    const { cwd, worktree } = await makeFixture("current-partial-write");
    let failedOnce = false;

    const failingOps: TransactionFSOps = {
      ...defaultFSOps,
      async writeFile(filePath: string, data: Buffer, options?: { flag?: string }): Promise<void> {
        if (!failedOnce && filePath.endsWith("modify.txt") && !filePath.includes(".codex-claude-delegate")) {
          failedOnce = true;
          await defaultFSOps.writeFile(filePath, Buffer.from("partial corrupt\n"), options);
          throw new Error("EIO: partial write failed");
        }
        return defaultFSOps.writeFile(filePath, data, options);
      },
    };
    __setTestFSOps(failingOps);

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "M", file: "modify.txt" },
    ]);

    expect(result.error).toContain("partial write failed");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(await readFile(path.join(cwd, "modify.txt"), "utf8")).toBe("original\n");
  });

  it("formats non-Error apply failures without crashing", async () => {
    const { cwd, worktree } = await makeFixture("apply-string-fails");

    const failingOps: TransactionFSOps = {
      ...defaultFSOps,
      async writeFile(filePath: string, data: Buffer, options?: { flag?: string }): Promise<void> {
        if (filePath.endsWith("modify.txt") && !filePath.includes(".codex-claude-delegate") && !filePath.includes("worktree")) {
          throw "string apply failure";
        }
        return defaultFSOps.writeFile(filePath, data, options);
      },
    };
    __setTestFSOps(failingOps);

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "M", file: "modify.txt" },
    ]);

    expect(result.error).toContain("Apply failed");
    expect(result.error).toContain("string apply failure");
    expect(result.applied_files).toEqual([]);
    expect(await readFile(path.join(cwd, "modify.txt"), "utf8")).toBe("original\n");
  });

  it("removes the current added file when its write partially creates then fails", async () => {
    const { cwd, worktree } = await makeFixture("current-partial-add");
    let failedOnce = false;

    const failingOps: TransactionFSOps = {
      ...defaultFSOps,
      async writeFile(filePath: string, data: Buffer, options?: { flag?: string }): Promise<void> {
        if (!failedOnce && filePath.endsWith("add.txt") && !filePath.includes(".codex-claude-delegate")) {
          failedOnce = true;
          await defaultFSOps.writeFile(filePath, Buffer.from("partial new\n"), options);
          throw new Error("EIO: partial add failed");
        }
        return defaultFSOps.writeFile(filePath, data, options);
      },
    };
    __setTestFSOps(failingOps);

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "A", file: "add.txt" },
    ]);

    expect(result.error).toContain("partial add failed");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(existsSync(path.join(cwd, "add.txt"))).toBe(false);
  });

  it("rolls back first file when second write fails", async () => {
    const { cwd, worktree } = await makeFixture("rb-write");

    // Inject FS ops that fail only on the first apply write to modify.txt.
    // Rollback must be allowed to write the original content back.
    let failedApplyWrite = false;
    const failingOps: TransactionFSOps = {
      ...defaultFSOps,
      async writeFile(filePath: string, data: Buffer, options?: { flag?: string }): Promise<void> {
        if (!failedApplyWrite && !filePath.includes(".codex-claude-delegate") && filePath.includes("modify.txt")) {
          failedApplyWrite = true;
          throw new Error("ENOSPC: no space left on device");
        }
        return defaultFSOps.writeFile(filePath, data, options);
      },
    };
    __setTestFSOps(failingOps);

    const changes = [
      { status: "A", file: "add.txt" },
      { status: "M", file: "modify.txt" },
      { status: "D", file: "delete.txt" },
    ];

    const result = await applyChangesTransactional(cwd, worktree, changes);

    // Rollback should have succeeded — first file restored
    expect(result.error).toContain("Apply failed");
    expect(result.error).toContain("ENOSPC");
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(result.applied_files).toEqual([]);

    // First file should be rolled back
    expect(existsSync(path.join(cwd, "add.txt"))).toBe(false);
    // modify.txt should be unchanged
    expect(await readFile(path.join(cwd, "modify.txt"), "utf8")).toBe("original\n");
    // delete.txt should still exist
    expect(existsSync(path.join(cwd, "delete.txt"))).toBe(true);
    // existing.txt untouched
    expect(await readFile(path.join(cwd, "existing.txt"), "utf8")).toBe("old content\n");

    // Backup files should be cleaned up after successful rollback
    const backupParent = path.join(cwd, ".codex-claude-delegate", "apply-backups");
    expect(hasBackupFiles(backupParent)).toBe(false);
  });

  it("rolls back prior writes when delete fails", async () => {
    const { cwd, worktree } = await makeFixture("rb-delete");

    const failingOps: TransactionFSOps = {
      ...defaultFSOps,
      async rm(target: string): Promise<void> {
        if (target.includes("delete.txt")) {
          throw new Error("EACCES: permission denied");
        }
        return defaultFSOps.rm(target);
      },
    };
    __setTestFSOps(failingOps);

    const changes = [
      { status: "A", file: "add.txt" },
      { status: "M", file: "modify.txt" },
      { status: "D", file: "delete.txt" },
    ];

    const result = await applyChangesTransactional(cwd, worktree, changes);

    expect(result.error).toContain("Apply failed");
    expect(result.error).toContain("EACCES");
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(result.applied_files).toEqual([]);

    // add.txt should be rolled back
    expect(existsSync(path.join(cwd, "add.txt"))).toBe(false);
    // modify.txt should be restored
    expect(await readFile(path.join(cwd, "modify.txt"), "utf8")).toBe("original\n");

    // Backup files cleaned up after successful rollback
    const backupParent = path.join(cwd, ".codex-claude-delegate", "apply-backups");
    expect(hasBackupFiles(backupParent)).toBe(false);
  });

  it("rolls back prior writes when second write fails", async () => {
    const { cwd, worktree } = await makeFixture("rb-dirty");

    const failingOps: TransactionFSOps = {
      ...defaultFSOps,
      async writeFile(filePath: string, data: Buffer, options?: { flag?: string }): Promise<void> {
        // Fail only when writing add.txt in cwd (the second apply write).
        // Rollback writes must succeed.
        if (!filePath.includes(".codex-claude-delegate") && filePath.endsWith("add.txt")) {
          throw new Error("ENOSPC: no space left on device");
        }
        return defaultFSOps.writeFile(filePath, data, options);
      },
    };
    __setTestFSOps(failingOps);

    const changes = [
      { status: "M", file: "modify.txt" },
      { status: "A", file: "add.txt" },
    ];

    const result = await applyChangesTransactional(cwd, worktree, changes);

    // Rollback should have succeeded — first file restored, add.txt removed
    expect(result.error).toContain("Apply failed");
    expect(result.error).toContain("ENOSPC");
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(result.applied_files).toEqual([]);

    // modify.txt should be restored
    expect(await readFile(path.join(cwd, "modify.txt"), "utf8")).toBe("original\n");
    // add.txt should not exist (it was never successfully written and didn't exist before)
    expect(existsSync(path.join(cwd, "add.txt"))).toBe(false);

    // Backup files cleaned up after successful rollback
    const backupParent = path.join(cwd, ".codex-claude-delegate", "apply-backups");
    expect(hasBackupFiles(backupParent)).toBe(false);
  });

  it("sets dirty_recovery_needed when rollback remove fails", async () => {
    const { cwd, worktree } = await makeFixture("rb-dirty-rm");

    let applyWriteCount = 0;
    const failingOps: TransactionFSOps = {
      ...defaultFSOps,
      async writeFile(filePath: string, data: Buffer, options?: { flag?: string }): Promise<void> {
        if (!filePath.includes(".codex-claude-delegate")) {
          applyWriteCount++;
          if (applyWriteCount === 2) {
            throw new Error("ENOSPC: no space");
          }
        }
        return defaultFSOps.writeFile(filePath, data, options);
      },
      async rm(target: string): Promise<void> {
        // Fail when removing the newly added file (add.txt) during rollback
        if (target.endsWith("add.txt") || target.endsWith("add.txt/")) {
          throw new Error("EACCES: permission denied during rollback");
        }
        return defaultFSOps.rm(target);
      },
    };
    __setTestFSOps(failingOps);

    // First file is a new add (no backup), second fails on write
    const changes = [
      { status: "A", file: "add.txt" },
      { status: "M", file: "modify.txt" },
    ];

    const result = await applyChangesTransactional(cwd, worktree, changes);

    expect(result.dirty_recovery_needed).toBe(true);
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_files!.some((d) => d.status === "rollback_remove_failed")).toBe(true);
  });

  it("sets dirty_recovery_needed with rollback_restore_failed when rollback cannot restore a previously existing file", async () => {
    const { cwd, worktree } = await makeFixture("rb-dirty-restore");

    // apply write succeeds for first file, fails for second.
    // During rollback, restore of the first file's backup fails.
    let applySucceeded = false;
    const failingOps: TransactionFSOps = {
      ...defaultFSOps,
      async writeFile(filePath: string, data: Buffer, options?: { flag?: string }): Promise<void> {
        // First: normal write for modify.txt
        if (!applySucceeded && !filePath.includes(".codex-claude-delegate")) {
          applySucceeded = true;
          return defaultFSOps.writeFile(filePath, data, options);
        }
        // Second: fail when writing add.txt
        if (applySucceeded && filePath.endsWith("add.txt") && !filePath.includes(".codex-claude-delegate")) {
          throw new Error("ENOSPC: no space");
        }
        // During rollback, fail when trying to restore modify.txt from backup
        if (filePath.endsWith("modify.txt") && !filePath.includes("worktree") && !filePath.includes(".codex-claude-delegate") && applySucceeded) {
          throw new Error("EIO: restore failed");
        }
        return defaultFSOps.writeFile(filePath, data, options);
      },
    };
    __setTestFSOps(failingOps);

    const changes = [
      { status: "M", file: "modify.txt" },
      { status: "A", file: "add.txt" },
    ];

    const result = await applyChangesTransactional(cwd, worktree, changes);

    expect(result.dirty_recovery_needed).toBe(true);
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_files!.some((d) => d.status === "rollback_restore_failed")).toBe(true);
    expect(result.rollback_error).toBeTruthy();
  });
});

describe("applyChangesTransactional path boundary validation", () => {
  it("formats non-Error source validation failures without crashing", async () => {
    const { cwd, worktree } = await makeFixture("source-string-fails");

    const failingOps: TransactionFSOps = {
      ...defaultFSOps,
      async lstat(target: string) {
        if (target.includes(`${path.sep}worktree${path.sep}`) && target.endsWith("add.txt")) {
          throw "string lstat failure";
        }
        return defaultFSOps.lstat(target);
      },
    };
    __setTestFSOps(failingOps);

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "A", file: "add.txt" },
    ]);

    expect(result.error).toContain("Invalid source path");
    expect(result.error).toContain("string lstat failure");
    expect(result.applied_files).toEqual([]);
  });

  it("apply rejects file path escaping cwd", async () => {
    const { cwd, worktree } = await makeFixture("escape-file");
    const existingContent = await readFile(path.join(cwd, "existing.txt"), "utf8");
    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "A", file: "../escape.txt" },
    ]);

    expect(result.error).toContain("escapes cwd");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(await readFile(path.join(cwd, "existing.txt"), "utf8")).toBe(existingContent);
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });

  it("apply rejects absolute file path", async () => {
    const { cwd, worktree } = await makeFixture("abs-file");
    const absoluteInsideCwd = path.join(cwd, "add.txt");
    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "A", file: absoluteInsideCwd },
    ]);

    expect(result.error).toContain("absolute");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });

  it("apply rejects rename old_file escaping cwd", async () => {
    const { cwd, worktree } = await makeFixture("escape-old-file");
    await writeFile(path.join(worktree, "new.txt"), "content\n");
    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "R", file: "new.txt", old_file: "../../escape.txt" },
    ]);

    expect(result.error).toContain("escapes cwd");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });

  it("apply rejects file path escaping delegated worktree before creating backups", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-tx-escape-worktree-"));
    cleanupPaths.push(root);
    const cwd = root;
    const worktree = path.join(root, "worktree");
    await mkdir(worktree, { recursive: true });
    await writeFile(path.join(cwd, "existing.txt"), "old content\n");
    const file = `../${path.basename(root)}/existing.txt`;

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "M", file },
    ]);

    expect(result.error).toContain("worktreeRoot");
    expect(result.error).toContain("escapes cwd");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });

  it("apply accepts valid repo-relative path", async () => {
    const { cwd, worktree } = await makeFixture("valid-path");
    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "A", file: "add.txt" },
    ]);

    expect(result.error).toBeUndefined();
    expect(result.applied_files).toEqual(["add.txt"]);
    expect(await readFile(path.join(cwd, "add.txt"), "utf8")).toBe("new file\n");
  });

  it("apply rejects absolute old_file for copy entries before mutation", async () => {
    const { cwd, worktree } = await makeFixture("abs-old-file");
    await writeFile(path.join(worktree, "new.txt"), "content\n");
    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "C", file: "new.txt", old_file: path.join(cwd, "existing.txt") },
    ]);

    expect(result.error).toContain("absolute");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });

  it("apply rejects source symlink before reading outside the delegated worktree", async () => {
    const { root, cwd, worktree } = await makeFixture("source-symlink");
    const secret = path.join(root, "secret.txt");
    await writeFile(secret, "do not copy\n");
    await symlink(secret, path.join(worktree, "leak.txt"));

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "A", file: "leak.txt" },
    ]);

    expect(result.error).toContain("source path is a symlink");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(existsSync(path.join(cwd, "leak.txt"))).toBe(false);
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });

  it("apply rejects source symlink even when it points inside the delegated worktree", async () => {
    const { cwd, worktree } = await makeFixture("source-symlink-inside");
    await writeFile(path.join(worktree, "target.txt"), "copy target\n");
    await symlink(path.join(worktree, "target.txt"), path.join(worktree, "link.txt"));

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "A", file: "link.txt" },
    ]);

    expect(result.error).toContain("source path is a symlink");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(existsSync(path.join(cwd, "link.txt"))).toBe(false);
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });

  it("apply rejects destination parent symlink before writing outside cwd", async () => {
    const { root, cwd, worktree } = await makeFixture("dest-parent-symlink");
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(cwd, "out"));
    await mkdir(path.join(worktree, "out"));
    await writeFile(path.join(worktree, "out", "file.txt"), "new file\n");

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "A", file: "out/file.txt" },
    ]);

    expect(result.error).toContain("destination parent escapes cwd");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(existsSync(path.join(outside, "file.txt"))).toBe(false);
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });

  it("apply rejects existing destination symlink before creating backups", async () => {
    const { root, cwd, worktree } = await makeFixture("dest-final-symlink");
    const outside = path.join(root, "outside-secret.txt");
    await writeFile(outside, "outside secret\n");
    await rm(path.join(cwd, "modify.txt"));
    await symlink(outside, path.join(cwd, "modify.txt"));
    await writeFile(path.join(worktree, "modify.txt"), "replacement\n");

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "M", file: "modify.txt" },
    ]);

    expect(result.error).toContain("destination path is a symlink");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(await readFile(outside, "utf8")).toBe("outside secret\n");
    expect(existsSync(path.join(cwd, "modify.txt"))).toBe(true);
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });

  it("apply rejects existing destination symlink to inside cwd before creating backups", async () => {
    const { cwd, worktree } = await makeFixture("dest-final-symlink-inside");
    await writeFile(path.join(cwd, "actual.txt"), "actual\n");
    await rm(path.join(cwd, "modify.txt"));
    await symlink(path.join(cwd, "actual.txt"), path.join(cwd, "modify.txt"));
    await writeFile(path.join(worktree, "modify.txt"), "replacement\n");

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "M", file: "modify.txt" },
    ]);

    expect(result.error).toContain("destination path is a symlink");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(await readFile(path.join(cwd, "actual.txt"), "utf8")).toBe("actual\n");
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });

  it("apply rejects dangling destination symlink before creating backups", async () => {
    const { root, cwd, worktree } = await makeFixture("dest-dangling-symlink");
    const missingOutside = path.join(root, "missing-outside.txt");
    await rm(path.join(cwd, "modify.txt"));
    await symlink(missingOutside, path.join(cwd, "modify.txt"));
    await writeFile(path.join(worktree, "modify.txt"), "replacement\n");

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "M", file: "modify.txt" },
    ]);

    expect(result.error).toContain("destination path is a symlink");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(existsSync(missingOutside)).toBe(false);
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });

  it("apply rejects existing destination directory before creating backups", async () => {
    const { cwd, worktree } = await makeFixture("dest-directory");
    await rm(path.join(cwd, "modify.txt"));
    await mkdir(path.join(cwd, "modify.txt"));
    await writeFile(path.join(worktree, "modify.txt"), "replacement\n");

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "M", file: "modify.txt" },
    ]);

    expect(result.error).toContain("destination path is not a regular file");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(existsSync(path.join(cwd, "modify.txt"))).toBe(true);
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });

  it("apply rejects source path escaping through an intermediate worktree symlink", async () => {
    const { root, cwd, worktree } = await makeFixture("source-intermediate-symlink");
    const outside = path.join(root, "outside-source");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "do not copy\n");
    await symlink(outside, path.join(worktree, "linked-dir"));

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "A", file: "linked-dir/secret.txt" },
    ]);

    expect(result.error).toContain("source path escapes worktreeRoot");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(existsSync(path.join(cwd, "linked-dir", "secret.txt"))).toBe(false);
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });

  it("apply rejects non-regular source paths before creating backups", async () => {
    const { cwd, worktree } = await makeFixture("source-directory");
    await mkdir(path.join(worktree, "source-dir"));

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "A", file: "source-dir" },
    ]);

    expect(result.error).toContain("source path is not a regular file");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(existsSync(path.join(cwd, "source-dir"))).toBe(false);
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });

  it("apply rejects delete target symlink before deleting outside cwd", async () => {
    const { root, cwd, worktree } = await makeFixture("delete-target-symlink");
    const outside = path.join(root, "outside-delete.txt");
    await writeFile(outside, "outside content\n");
    await symlink(outside, path.join(cwd, "delete-link.txt"));

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "D", file: "delete-link.txt" },
    ]);

    expect(result.error).toContain("destination path is a symlink");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(await readFile(outside, "utf8")).toBe("outside content\n");
    expect(existsSync(path.join(cwd, "delete-link.txt"))).toBe(true);
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });

  it("apply rejects delete target dangling symlink before creating backups", async () => {
    const { root, cwd, worktree } = await makeFixture("delete-dangling-symlink");
    const missingOutside = path.join(root, "missing-delete.txt");
    await symlink(missingOutside, path.join(cwd, "delete-dangling.txt"));

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "D", file: "delete-dangling.txt" },
    ]);

    expect(result.error).toContain("destination path is a symlink");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(existsSync(missingOutside)).toBe(false);
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });

  it("apply rejects rename old_file parent symlink before deleting outside cwd", async () => {
    const { root, cwd, worktree } = await makeFixture("old-file-parent-symlink");
    const outside = path.join(root, "outside-old");
    await mkdir(outside);
    await writeFile(path.join(outside, "old.txt"), "outside old\n");
    await symlink(outside, path.join(cwd, "old-dir"));
    await writeFile(path.join(worktree, "new.txt"), "renamed\n");

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "R", file: "new.txt", old_file: "old-dir/old.txt" },
    ]);

    expect(result.error).toContain("old_file parent escapes cwd");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(await readFile(path.join(outside, "old.txt"), "utf8")).toBe("outside old\n");
    expect(existsSync(path.join(cwd, "new.txt"))).toBe(false);
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });

  it("apply rejects destination parent that is not a directory before creating backups", async () => {
    const { cwd, worktree } = await makeFixture("dest-parent-file");
    await writeFile(path.join(cwd, "file-parent"), "not a directory\n");
    await mkdir(path.join(worktree, "file-parent"));
    await writeFile(path.join(worktree, "file-parent", "child.txt"), "new content\n");

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "A", file: "file-parent/child.txt" },
    ]);

    expect(result.error).toContain("destination parent is not a directory");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(await readFile(path.join(cwd, "file-parent"), "utf8")).toBe("not a directory\n");
    expect(existsSync(path.join(cwd, "file-parent", "child.txt"))).toBe(false);
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });

  it("apply rejects rename old_file parent that is not a directory before creating backups", async () => {
    const { cwd, worktree } = await makeFixture("old-file-parent-file");
    await writeFile(path.join(cwd, "old-parent"), "not a directory\n");
    await writeFile(path.join(worktree, "new.txt"), "renamed\n");

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "R", file: "new.txt", old_file: "old-parent/old.txt" },
    ]);

    expect(result.error).toContain("old_file parent is not a directory");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(await readFile(path.join(cwd, "old-parent"), "utf8")).toBe("not a directory\n");
    expect(existsSync(path.join(cwd, "new.txt"))).toBe(false);
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });

  it("apply rejects rename old_file symlink before creating backups", async () => {
    const { root, cwd, worktree } = await makeFixture("old-file-symlink");
    const outside = path.join(root, "outside-old.txt");
    await writeFile(outside, "outside old\n");
    await symlink(outside, path.join(cwd, "old.txt"));
    await writeFile(path.join(worktree, "new.txt"), "renamed\n");

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "R", file: "new.txt", old_file: "old.txt" },
    ]);

    expect(result.error).toContain("old_file path is a symlink");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(await readFile(outside, "utf8")).toBe("outside old\n");
    expect(existsSync(path.join(cwd, "new.txt"))).toBe(false);
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });

  it("apply rejects rename old_file directory before creating backups", async () => {
    const { cwd, worktree } = await makeFixture("old-file-directory");
    await mkdir(path.join(cwd, "old-dir-file"));
    await writeFile(path.join(worktree, "new.txt"), "renamed\n");

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "R", file: "new.txt", old_file: "old-dir-file" },
    ]);

    expect(result.error).toContain("old_file path is not a regular file");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(existsSync(path.join(cwd, "new.txt"))).toBe(false);
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });

  it("apply rejects symlinked backup root before creating backups", async () => {
    const { root, cwd, worktree } = await makeFixture("backup-root-symlink");
    const outside = path.join(root, "outside-backups");
    await mkdir(outside);
    await symlink(outside, path.join(cwd, ".codex-claude-delegate"));
    await writeFile(path.join(worktree, "modify.txt"), "replacement\n");

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "M", file: "modify.txt" },
    ]);

    expect(result.error).toContain("backup path component is a symlink");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(await readFile(path.join(cwd, "modify.txt"), "utf8")).toBe("original\n");
    expect(existsSync(path.join(outside, "apply-backups"))).toBe(false);
  });

  it("apply rejects symlinked backup apply-backups parent before creating backups", async () => {
    const { root, cwd, worktree } = await makeFixture("backup-parent-symlink");
    const stateDir = path.join(cwd, ".codex-claude-delegate");
    const outside = path.join(root, "outside-apply-backups");
    await mkdir(stateDir);
    await mkdir(outside);
    await symlink(outside, path.join(stateDir, "apply-backups"));
    await writeFile(path.join(worktree, "modify.txt"), "replacement\n");

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "M", file: "modify.txt" },
    ]);

    expect(result.error).toContain("backup path component is a symlink");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(await readFile(path.join(cwd, "modify.txt"), "utf8")).toBe("original\n");
    expect(readdirSync(outside)).toEqual([]);
  });

  it("apply rejects non-directory backup root before creating backups", async () => {
    const { cwd, worktree } = await makeFixture("backup-root-file");
    await writeFile(path.join(cwd, ".codex-claude-delegate"), "not a directory\n");
    await writeFile(path.join(worktree, "modify.txt"), "replacement\n");

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "M", file: "modify.txt" },
    ]);

    expect(result.error).toContain("backup path component is not a directory");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(await readFile(path.join(cwd, "modify.txt"), "utf8")).toBe("original\n");
    expect(await readFile(path.join(cwd, ".codex-claude-delegate"), "utf8")).toBe("not a directory\n");
  });

  it("apply rejects pre-existing backup final path before creating backups", async () => {
    const { cwd, worktree } = await makeFixture("backup-final-file");
    await writeFile(path.join(worktree, "modify.txt"), "replacement\n");
    await mkdir(path.join(cwd, ".codex-claude-delegate", "apply-backups"), { recursive: true });
    const ops: TransactionFSOps = {
      ...defaultFSOps,
      async lstat(target: string) {
        if (target.includes(`${path.sep}.codex-claude-delegate${path.sep}apply-backups${path.sep}`)
          && target.endsWith(`${path.sep}modify.txt`)) {
          return fakeFileStat;
        }
        return defaultFSOps.lstat(target);
      },
    };
    __setTestFSOps(ops);

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "M", file: "modify.txt" },
    ]);

    expect(result.error).toContain("backup path already exists");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(await readFile(path.join(cwd, "modify.txt"), "utf8")).toBe("original\n");
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });

  it("apply rejects pre-existing backup final symlink before creating backups", async () => {
    const { cwd, worktree } = await makeFixture("backup-final-symlink");
    await writeFile(path.join(worktree, "modify.txt"), "replacement\n");
    await mkdir(path.join(cwd, ".codex-claude-delegate", "apply-backups"), { recursive: true });
    const ops: TransactionFSOps = {
      ...defaultFSOps,
      async lstat(target: string) {
        if (target.includes(`${path.sep}.codex-claude-delegate${path.sep}apply-backups${path.sep}`)
          && target.endsWith(`${path.sep}modify.txt`)) {
          return fakeSymlinkStat;
        }
        return defaultFSOps.lstat(target);
      },
    };
    __setTestFSOps(ops);

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "M", file: "modify.txt" },
    ]);

    expect(result.error).toContain("backup path already exists");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(await readFile(path.join(cwd, "modify.txt"), "utf8")).toBe("original\n");
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });

  it("apply rejects pre-existing backup final directory before creating backups", async () => {
    const { cwd, worktree } = await makeFixture("backup-final-directory");
    await writeFile(path.join(worktree, "modify.txt"), "replacement\n");
    await mkdir(path.join(cwd, ".codex-claude-delegate", "apply-backups"), { recursive: true });
    const ops: TransactionFSOps = {
      ...defaultFSOps,
      async lstat(target: string) {
        if (target.includes(`${path.sep}.codex-claude-delegate${path.sep}apply-backups${path.sep}`)
          && target.endsWith(`${path.sep}modify.txt`)) {
          return fakeDirectoryStat;
        }
        return defaultFSOps.lstat(target);
      },
    };
    __setTestFSOps(ops);

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "M", file: "modify.txt" },
    ]);

    expect(result.error).toContain("backup path already exists");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    expect(await readFile(path.join(cwd, "modify.txt"), "utf8")).toBe("original\n");
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });

  it("apply writes backups with exclusive create", async () => {
    const { cwd, worktree } = await makeFixture("backup-exclusive-write");
    await writeFile(path.join(worktree, "modify.txt"), "replacement\n");
    const backupWriteFlags: Array<string | undefined> = [];
    const ops: TransactionFSOps = {
      ...defaultFSOps,
      async writeFile(filePath, data, options) {
        if (filePath.includes(`${path.sep}.codex-claude-delegate${path.sep}apply-backups${path.sep}`)) {
          backupWriteFlags.push(options?.flag);
        }
        await defaultFSOps.writeFile(filePath, data, options);
      },
    };
    __setTestFSOps(ops);

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "M", file: "modify.txt" },
    ]);

    expect(result.error).toBeUndefined();
    expect(result.applied_files).toEqual(["modify.txt"]);
    expect(backupWriteFlags).toEqual(["wx"]);
    expect(await readFile(path.join(cwd, "modify.txt"), "utf8")).toBe("replacement\n");
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });

  it("apply still modifies an existing regular destination after preflight hardening", async () => {
    const { cwd, worktree } = await makeFixture("regular-destination");
    await writeFile(path.join(worktree, "modify.txt"), "replacement\n");

    const result = await applyChangesTransactional(cwd, worktree, [
      { status: "M", file: "modify.txt" },
    ]);

    expect(result.error).toBeUndefined();
    expect(result.applied_files).toEqual(["modify.txt"]);
    expect(await readFile(path.join(cwd, "modify.txt"), "utf8")).toBe("replacement\n");
    expect(hasBackupFiles(path.join(cwd, ".codex-claude-delegate", "apply-backups"))).toBe(false);
  });
});

// Helper for temp dir (async version of mkdtemp)
async function mkdtemp(prefix: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(prefix);
}
