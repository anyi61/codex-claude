import { mkdir, readFile, rename, stat, writeFile, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

// ---- Types ----

export type ArtifactType =
  | "patch"
  | "verification_stdout"
  | "verification_stderr"
  | "metadata_only"
  | "export"
  | "audit"
  | "rollback";

export type ArtifactSensitivity = "safe" | "sensitive" | "high";

export interface ArtifactEntry {
  type: ArtifactType;
  path: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
  producer: string;
  sensitivity: ArtifactSensitivity;
  runId?: string;
  metadata?: Record<string, unknown>;
}

export interface ArtifactIndex {
  version: 1;
  entries: ArtifactEntry[];
  updatedAt: string;
}

export interface ArtifactIndexSummary {
  index_path: string;
  entry_count: number;
  type_counts: Record<string, number>;
  sensitivity_counts: Record<string, number>;
  latest_timestamp: string | null;
}

export interface ArtifactPruneOptions {
  older_than_hours: number;
  dry_run: boolean;
  limit: number;
}

export interface ArtifactPruneResult {
  dry_run: boolean;
  matched_count: number;
  removed_count: number;
  failed_count: number;
  entries: Array<{
    entry_path: string;
    disk_path: string;
    removed: boolean;
    error?: string;
  }>;
}

// ---- Paths ----

const ARTIFACT_DIR = ".codex-claude-delegate/artifacts";
const INDEX_FILENAME = "artifacts.json";
const SAFE_CLEANUP_ROOTS = [".codex-claude-delegate/artifacts", ".codex-claude-delegate/apply-backups"];

function getArtifactDir(cwd: string): string {
  return path.join(cwd, ARTIFACT_DIR);
}

function getArtifactIndexPath(cwd: string): string {
  return path.join(cwd, ARTIFACT_DIR, INDEX_FILENAME);
}

// ---- Helpers ----

export async function hashFile(absPath: string): Promise<string> {
  const buf = await readFile(absPath);
  return createHash("sha256").update(buf).digest("hex");
}

async function resolveFileInfo(absPath: string): Promise<{ sha256: string; sizeBytes: number }> {
  const [buf, st] = await Promise.all([readFile(absPath), stat(absPath)]);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  return { sha256, sizeBytes: st.size };
}

function emptyIndex(): ArtifactIndex {
  return {
    version: 1,
    entries: [],
    updatedAt: new Date().toISOString(),
  };
}

function isSafeToCleanup(filePath: string, cwd: string): boolean {
  const absPath = path.resolve(cwd, filePath);
  for (const root of SAFE_CLEANUP_ROOTS) {
    const absRoot = path.resolve(cwd, root);
    if (absPath.startsWith(absRoot + path.sep) || absPath === absRoot) {
      return true;
    }
  }
  return false;
}

// ---- Index read/write ----

export async function readArtifactIndex(cwd: string): Promise<ArtifactIndex> {
  const indexPath = getArtifactIndexPath(cwd);
  try {
    const raw = await readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      parsed.version === 1 &&
      Array.isArray(parsed.entries)
    ) {
      return {
        version: 1,
        entries: parsed.entries.filter(
          (e: unknown) =>
            e !== null &&
            typeof e === "object" &&
            typeof (e as Record<string, unknown>).type === "string" &&
            typeof (e as Record<string, unknown>).path === "string" &&
            typeof (e as Record<string, unknown>).sha256 === "string" &&
            typeof (e as Record<string, unknown>).sizeBytes === "number" &&
            typeof (e as Record<string, unknown>).createdAt === "string" &&
            typeof (e as Record<string, unknown>).producer === "string" &&
            typeof (e as Record<string, unknown>).sensitivity === "string"
        ),
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      };
    }
    return emptyIndex();
  } catch {
    return emptyIndex();
  }
}

export async function writeArtifactIndex(cwd: string, index: ArtifactIndex): Promise<void> {
  const artifactDir = getArtifactDir(cwd);
  await mkdir(artifactDir, { recursive: true });
  const indexPath = getArtifactIndexPath(cwd);
  const tmpPath = indexPath + ".tmp." + Math.random().toString(36).slice(2, 8);
  const content = JSON.stringify({ ...index, updatedAt: new Date().toISOString() }, null, 2);
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, indexPath);
}

// ---- Entry management ----

export async function addArtifactEntry(
  cwd: string,
  entry: Omit<ArtifactEntry, "createdAt"> & { createdAt?: string }
): Promise<void> {
  try {
    const index = await readArtifactIndex(cwd);
    const fullEntry: ArtifactEntry = {
      ...entry,
      createdAt: entry.createdAt ?? new Date().toISOString(),
    };
    index.entries.push(fullEntry);
    await writeArtifactIndex(cwd, index);
  } catch {
    // Silently skip on failure — don't crash parent workflow
  }
}

// ---- Summary ----

export async function getArtifactSummary(cwd: string): Promise<ArtifactIndexSummary | null> {
  try {
    const index = await readArtifactIndex(cwd);
    if (index.entries.length === 0 && index.updatedAt) {
      return {
        index_path: ARTIFACT_DIR + "/" + INDEX_FILENAME,
        entry_count: 0,
        type_counts: {},
        sensitivity_counts: {},
        latest_timestamp: null,
      };
    }
    const typeCounts: Record<string, number> = {};
    const sensitivityCounts: Record<string, number> = {};
    let latestTimestamp: string | null = null;
    for (const entry of index.entries) {
      typeCounts[entry.type] = (typeCounts[entry.type] ?? 0) + 1;
      sensitivityCounts[entry.sensitivity] = (sensitivityCounts[entry.sensitivity] ?? 0) + 1;
      if (!latestTimestamp || entry.createdAt > latestTimestamp) {
        latestTimestamp = entry.createdAt;
      }
    }
    return {
      index_path: ARTIFACT_DIR + "/" + INDEX_FILENAME,
      entry_count: index.entries.length,
      type_counts: typeCounts,
      sensitivity_counts: sensitivityCounts,
      latest_timestamp: latestTimestamp,
    };
  } catch {
    return null;
  }
}

// ---- Prune ----

export async function pruneArtifactIndex(
  cwd: string,
  options: ArtifactPruneOptions
): Promise<ArtifactPruneResult> {
  const index = await readArtifactIndex(cwd);
  const cutoff = Date.now() - options.older_than_hours * 60 * 60 * 1000;

  // Identify stale entries: those older than cutoff AND in safe cleanup roots
  const staleCandidates = index.entries
    .filter((entry) => {
      const createdAt = Date.parse(entry.createdAt);
      return Number.isFinite(createdAt) && createdAt <= cutoff && isSafeToCleanup(entry.path, cwd);
    })
    .slice(0, options.limit);

  const resultEntries: ArtifactPruneResult["entries"] = [];
  let removedCount = 0;
  let failedCount = 0;
  const removedPaths = new Set<string>();

  for (const entry of staleCandidates) {
    const absPath = path.resolve(cwd, entry.path);
    if (options.dry_run) {
      resultEntries.push({ entry_path: entry.path, disk_path: absPath, removed: false });
      continue;
    }
    try {
      // Remove the file if it exists
      try {
        await unlink(absPath);
      } catch {
        // File already gone — tolerate missing files
      }
      removedPaths.add(entry.path);
      removedCount++;
      resultEntries.push({ entry_path: entry.path, disk_path: absPath, removed: true });
    } catch (err) {
      failedCount++;
      resultEntries.push({
        entry_path: entry.path,
        disk_path: absPath,
        removed: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Remove pruned entries from the index
  if (!options.dry_run && removedPaths.size > 0) {
    const remaining = index.entries.filter((e) => !removedPaths.has(e.path));
    await writeArtifactIndex(cwd, { ...index, entries: remaining });
  }

  return {
    dry_run: options.dry_run,
    matched_count: staleCandidates.length,
    removed_count: removedCount,
    failed_count: failedCount,
    entries: resultEntries,
  };
}

// ---- Registration helpers ----

export async function registerPatchArtifact(
  cwd: string,
  runId: string,
  patchResult: {
    patch?: string;
    patch_path?: string;
    diff_sha256?: string;
    patch_bytes?: number;
  }
): Promise<void> {
  // Case 1: Large patch written to disk (e.g. .claude/patches/<runId>.patch)
  if (patchResult.patch_path && patchResult.diff_sha256) {
    const absPath = path.resolve(cwd, patchResult.patch_path);
    try {
      const st = await stat(absPath);
      await addArtifactEntry(cwd, {
        type: "patch",
        path: patchResult.patch_path,
        sha256: patchResult.diff_sha256,
        sizeBytes: st.size,
        producer: "claude_apply",
        sensitivity: "safe",
        runId,
        metadata: {
          truncated: true,
        },
      });
    } catch {
      // File doesn't exist or can't be stat'd — skip
    }
    return;
  }

  // Case 2: Small inline patch — register metadata-only entry (no file)
  if (patchResult.diff_sha256) {
    await addArtifactEntry(cwd, {
      type: "metadata_only",
      path: `artifact:patch:${runId}`,
      sha256: patchResult.diff_sha256,
      sizeBytes: patchResult.patch_bytes ?? 0,
      producer: "claude_apply",
      sensitivity: "safe",
      runId,
      metadata: {
        kind: "inline_patch",
        truncated: false,
      },
    });
  }
}

export async function registerVerificationArtifacts(
  cwd: string,
  runId: string,
  commands: Array<{
    command: string;
    status: string;
    stdout_tail: string;
    stderr_tail: string;
    exit_code: number | null;
    duration_ms: number;
  }>
): Promise<void> {
  const verifDir = path.join(cwd, ARTIFACT_DIR, "verification", runId);
  await mkdir(verifDir, { recursive: true });

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    const idx = String(i).padStart(2, "0");

    // Write stdout tail
    if (cmd.stdout_tail) {
      const stdoutPath = path.join(verifDir, `stdout_${idx}.txt`);
      try {
        await writeFile(stdoutPath, cmd.stdout_tail, "utf8");
        const info = await resolveFileInfo(stdoutPath);
        const relPath = path.relative(cwd, stdoutPath);
        await addArtifactEntry(cwd, {
          type: "verification_stdout",
          path: relPath,
          sha256: info.sha256,
          sizeBytes: info.sizeBytes,
          producer: "claude_implement/verification",
          sensitivity: "high",
          runId,
          metadata: {
            command_index: i,
            command_status: cmd.status,
            exit_code: cmd.exit_code,
            duration_ms: cmd.duration_ms,
          },
        });
      } catch {
        // Write failed — skip index entry gracefully
      }
    }

    // Write stderr tail
    if (cmd.stderr_tail) {
      const stderrPath = path.join(verifDir, `stderr_${idx}.txt`);
      try {
        await writeFile(stderrPath, cmd.stderr_tail, "utf8");
        const info = await resolveFileInfo(stderrPath);
        const relPath = path.relative(cwd, stderrPath);
        await addArtifactEntry(cwd, {
          type: "verification_stderr",
          path: relPath,
          sha256: info.sha256,
          sizeBytes: info.sizeBytes,
          producer: "claude_implement/verification",
          sensitivity: "high",
          runId,
          metadata: {
            command_index: i,
            command_status: cmd.status,
            exit_code: cmd.exit_code,
            duration_ms: cmd.duration_ms,
          },
        });
      } catch {
        // Write failed — skip index entry gracefully
      }
    }
  }
}
