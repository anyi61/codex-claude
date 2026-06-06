import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  ClaudeRunsInput,
  ClaudeRunsResult,
  ClaudeRunInspectInput,
  ClaudeRunInspectResult,
  RunGroupSummary,
  RunLogEntrySummary,
  RunLifecycle,
  RunLogStatus,
  ServerVerifiedSummary,
  ToolCallAuditSummary,
} from "./schema.js";

export function getRunLogDir(cwd?: string): string {
  if (process.env.CODEX_CLAUDE_RUN_LOG_DIR) {
    return path.resolve(process.env.CODEX_CLAUDE_RUN_LOG_DIR);
  }
  const base = cwd ?? process.cwd();
  return path.join(base, ".codex-claude-delegate", "runs");
}

export interface ImplementRunLog {
  type?: unknown;
  report?: {
    status?: unknown;
    summary?: unknown;
  };
  error?: unknown;
  execution?: {
    exit_code?: unknown;
    timed_out?: unknown;
    duration_ms?: unknown;
  };
  server_verified?: unknown;
  downstream?: {
    current_lifecycle?: unknown;
  };
  input?: {
    cwd?: unknown;
    files?: unknown;
  };
  observed?: {
    worktree_path?: unknown;
    base_commit?: unknown;
    changed_files?: unknown;
    resource_limits?: {
      changed_files_exceeded?: unknown;
      warnings?: unknown;
    };
    scope?: {
      scope_exceeded?: unknown;
      warnings?: unknown;
    };
  };
}

export interface GenericRunLog {
  started_at?: unknown;
  updated_at?: unknown;
  type?: unknown;
  input?: {
    cwd?: unknown;
    worktree_path?: unknown;
  };
  report?: {
    status?: unknown;
    summary?: unknown;
  };
  execution?: {
    exit_code?: unknown;
    timed_out?: unknown;
  };
  error?: unknown;
  preview?: unknown;
  applied_files?: unknown;
  removed_count?: unknown;
  failed_count?: unknown;
  downstream?: {
    current_lifecycle?: unknown;
    previewed_at?: unknown;
    applied_at?: unknown;
    cleaned_at?: unknown;
    last_apply_run_id?: unknown;
    last_cleanup_run_id?: unknown;
  };
  observed?: {
    worktree_path?: unknown;
    worktree_name?: unknown;
    changed_files?: unknown;
  };
  session?: {
    requested_session_id?: unknown;
    returned_session_id?: unknown;
  };
  retried_after_session_expired?: unknown;
  server_verified?: unknown;
}

export function normalizeRepoPath(cwd: string, file: string): string {
  const repoRelative = path.isAbsolute(file) ? path.relative(cwd, file) : file;
  return repoRelative.replaceAll(path.sep, "/").replace(/^\.\//, "");
}

export function isUnderRequestedFile(file: string, requested: string): boolean {
  return file === requested || file.startsWith(`${requested.replace(/\/$/, "")}/`);
}

export function normalizeRequestedFiles(cwd: string, files?: string[]): string[] {
  if (!files?.length) return [];
  const normalized = new Set<string>();
  for (const file of files) {
    const repoPath = normalizeRepoPath(cwd, file).replace(/\/+$/g, "");
    if (repoPath) normalized.add(repoPath);
  }
  return [...normalized].sort();
}

export async function logRun(runId: string, data: Record<string, unknown>, cwd?: string): Promise<void> {
  const logDir = getRunLogDir(cwd);
  try {
    await mkdir(logDir, { recursive: true });
    const timestamp = new Date().toISOString();
    await writeFile(
      path.join(logDir, `${runId}.json`),
      JSON.stringify({ started_at: timestamp, updated_at: timestamp, ...data }, null, 2)
    );
  } catch {
    // best-effort logging
  }
}

export async function findImplementLogForWorktree(worktreePath: string, cwd?: string): Promise<ImplementRunLog | null> {
  const logDir = getRunLogDir(cwd);
  try {
    const entries = await readdir(logDir);
    const candidates = await Promise.all(
      entries
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          const file = path.join(logDir, name);
          try {
            return { file, mtimeMs: (await stat(file)).mtimeMs };
          } catch {
            return null;
          }
        })
    );

    for (const entry of candidates
      .filter((item): item is { file: string; mtimeMs: number } => item !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)) {
      try {
        const parsed = JSON.parse(await readFile(entry.file, "utf8")) as ImplementRunLog;
        if (parsed.type === "implement" && parsed.observed?.worktree_path === worktreePath) {
          return parsed;
        }
      } catch {
        // Ignore malformed or concurrently written logs.
      }
    }
  } catch {
    // Missing logs should not block legacy/manual apply flows.
  }
  return null;
}

export async function findImplementLogRecordForWorktree(worktreePath: string, cwd?: string): Promise<{ file: string; parsed: ImplementRunLog } | null> {
  const logDir = getRunLogDir(cwd);
  try {
    const entries = await readdir(logDir);
    const candidates = await Promise.all(
      entries
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          const file = path.join(logDir, name);
          try {
            return { file, mtimeMs: (await stat(file)).mtimeMs };
          } catch {
            return null;
          }
        })
    );

    for (const entry of candidates
      .filter((item): item is { file: string; mtimeMs: number } => item !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)) {
      try {
        const parsed = JSON.parse(await readFile(entry.file, "utf8")) as ImplementRunLog;
        if (parsed.type === "implement" && parsed.observed?.worktree_path === worktreePath) {
          return { file: entry.file, parsed };
        }
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function updateImplementLifecycleForWorktree(
  worktreePath: string,
  update: Partial<NonNullable<GenericRunLog["downstream"]>>,
  cwd?: string,
): Promise<void> {
  const record = await findImplementLogRecordForWorktree(worktreePath, cwd);
  if (!record) return;
  const parsed = record.parsed as GenericRunLog;
  const timestamp = new Date().toISOString();
  const next = {
    ...parsed,
    updated_at: timestamp,
    downstream: {
      ...(parsed.downstream ?? {}),
      ...update,
    },
  };
  await writeFile(record.file, JSON.stringify(next, null, 2));
}

export function parseRunStatus(raw: GenericRunLog): RunLogStatus {
  if (typeof raw.error === "string" && raw.error.length > 0) return "failed";
  const exitCode = raw.execution?.exit_code;
  const timedOut = raw.execution?.timed_out === true;
  if (timedOut || (typeof exitCode === "number" && exitCode !== 0)) {
    const changedFiles = Array.isArray(raw.observed?.changed_files) ? raw.observed.changed_files.length : 0;
    return changedFiles > 0 ? "partial" : "failed";
  }
  const status = raw.report?.status;
  if (status === "success" || status === "failed" || status === "partial" || status === "needs_user") {
    return status;
  }
  return "unknown";
}

export function parseRunLifecycle(raw: GenericRunLog): RunLifecycle {
  const downstreamLifecycle = raw.downstream?.current_lifecycle;
  if (
    downstreamLifecycle === "queued" ||
    downstreamLifecycle === "running" ||
    downstreamLifecycle === "success" ||
    downstreamLifecycle === "partial" ||
    downstreamLifecycle === "failed" ||
    downstreamLifecycle === "apply_blocked" ||
    downstreamLifecycle === "applied" ||
    downstreamLifecycle === "cleaned" ||
    downstreamLifecycle === "unknown"
  ) {
    return downstreamLifecycle;
  }
  const type = typeof raw.type === "string" ? raw.type : "unknown";
  const status = parseRunStatus(raw);

  if (type === "apply") {
    if (typeof raw.error === "string" && raw.error.length > 0) return "apply_blocked";
    const appliedCount = Array.isArray(raw.applied_files) ? raw.applied_files.length : 0;
    if (appliedCount > 0) return "applied";
    if (raw.preview === true) return "success";
  }

  if (type === "cleanup") {
    const removedCount = typeof raw.removed_count === "number" ? raw.removed_count : 0;
    const failedCount = typeof raw.failed_count === "number" ? raw.failed_count : 0;
    if (removedCount > 0 && failedCount === 0) return "cleaned";
    if (failedCount > 0) return "partial";
    return "success";
  }

  if (status === "needs_user") {
    return "partial";
  }
  if (status === "success" || status === "partial" || status === "failed") {
    return status;
  }
  return "unknown";
}

export function summarizeServerVerified(raw: unknown): ServerVerifiedSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const status = obj.status;
  if (status !== "passed" && status !== "failed" && status !== "skipped") return undefined;
  if (!Array.isArray(obj.commands)) return undefined;

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const cmd of obj.commands) {
    if (cmd && typeof cmd === "object") {
      const cmdStatus = (cmd as Record<string, unknown>).status;
      if (cmdStatus === "passed") passed++;
      else if (cmdStatus === "failed") failed++;
      else if (cmdStatus === "skipped") skipped++;
    }
  }

  return {
    status,
    command_count: obj.commands.length,
    passed_count: passed,
    failed_count: failed,
    skipped_count: skipped,
  };
}

export function summarizeToolCallAudit(report: unknown): ToolCallAuditSummary | undefined {
  if (!report || typeof report !== "object") return undefined;
  const obj = report as Record<string, unknown>;

  const denials = obj.permission_denials;
  const commandsRun = obj.commands_run;

  const hasDenials = Array.isArray(denials);
  const hasCommands = Array.isArray(commandsRun);

  if (!hasDenials && !hasCommands) return undefined;

  let totalDenied = 0;
  const toolNames = new Set<string>();

  if (hasDenials) {
    totalDenied = denials.length;
    for (const denial of denials) {
      if (denial && typeof denial === "object") {
        const toolName = (denial as Record<string, unknown>).tool_name;
        if (typeof toolName === "string" && toolName.length > 0) {
          toolNames.add(toolName);
        }
      }
    }
  }

  const sortedTools = [...toolNames].sort();
  const truncated = sortedTools.length > 20;
  const uniqueTools = truncated ? sortedTools.slice(0, 20) : sortedTools;

  const result: ToolCallAuditSummary = {
    total_denied: totalDenied,
    unique_denied_tools: uniqueTools,
  };

  if (truncated) {
    result.unique_denied_tools_truncated = true;
  }

  if (hasCommands) {
    result.commands_run_count = commandsRun.length;
  }

  return result;
}

export function summarizeRunLog(runId: string, raw: GenericRunLog, updatedAt?: string): RunLogEntrySummary {
  const worktreePath =
    typeof raw.observed?.worktree_path === "string"
      ? raw.observed.worktree_path
      : typeof raw.input?.worktree_path === "string"
        ? raw.input.worktree_path
        : undefined;
  const verified = summarizeServerVerified(raw.server_verified);
  const audit = summarizeToolCallAudit(raw.report);
  const rawRecord = raw as Record<string, unknown>;
  return {
    run_id: runId,
    type: typeof raw.type === "string" ? raw.type : "unknown",
    status: parseRunStatus(raw),
    lifecycle: parseRunLifecycle(raw),
    cwd: typeof raw.input?.cwd === "string" ? raw.input.cwd : undefined,
    summary: typeof raw.report?.summary === "string" ? raw.report.summary : undefined,
    error: typeof raw.error === "string" ? raw.error : undefined,
    worktree_path: worktreePath,
    worktree_name:
      typeof raw.observed?.worktree_name === "string"
        ? raw.observed.worktree_name
        : worktreePath
          ? path.basename(worktreePath)
          : undefined,
    requested_session_id:
      typeof raw.session?.requested_session_id === "string" || raw.session?.requested_session_id === null
        ? raw.session.requested_session_id
        : undefined,
    returned_session_id:
      typeof raw.session?.returned_session_id === "string" || raw.session?.returned_session_id === null
        ? raw.session.returned_session_id
        : undefined,
    retried_after_session_expired: raw.retried_after_session_expired === true,
    started_at: typeof raw.started_at === "string" ? raw.started_at : updatedAt,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : updatedAt,
    ...(verified ? { server_verified: verified } : {}),
    ...(audit ? { tool_call_audit: audit } : {}),
    ...(typeof rawRecord.goal_item_id === "string" && rawRecord.goal_item_id.length > 0 ? { goal_item_id: rawRecord.goal_item_id } : {}),
    ...(typeof rawRecord.supersedes_run_id === "string" && rawRecord.supersedes_run_id.length > 0 ? { supersedes_run_id: rawRecord.supersedes_run_id } : {}),
  };
}

export function summarizeRecentRuns(entries: RunLogEntrySummary[]): { entries: RunLogEntrySummary[]; lifecycle_counts: Record<string, number> } {
  const lifecycleCounts: Record<string, number> = {};
  for (const entry of entries) {
    lifecycleCounts[entry.lifecycle] = (lifecycleCounts[entry.lifecycle] ?? 0) + 1;
  }
  return { entries, lifecycle_counts: lifecycleCounts };
}

export async function readRunLogFile(runId: string, cwd?: string): Promise<GenericRunLog | null> {
  const logDir = getRunLogDir(cwd);
  const file = path.join(logDir, `${runId}.json`);
  try {
    return JSON.parse(await readFile(file, "utf8")) as GenericRunLog;
  } catch {
    return null;
  }
}

export async function listRunLogs(input: ClaudeRunsInput): Promise<ClaudeRunsResult> {
  const limit = input.limit ?? 20;
  const logDir = getRunLogDir(input.cwd);
  try {
    const entries = await readdir(logDir);
    const candidates = await Promise.all(
      entries
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          const file = path.join(logDir, name);
          try {
            const stats = await stat(file);
            return { file, runId: name.replace(/\.json$/, ""), mtimeMs: stats.mtimeMs, updatedAt: new Date(stats.mtimeMs).toISOString() };
          } catch {
            return null;
          }
        })
    );

    const summaries: RunLogEntrySummary[] = [];
    for (const candidate of candidates
      .filter((item): item is { file: string; runId: string; mtimeMs: number; updatedAt: string } => item !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)) {
      try {
        const raw = JSON.parse(await readFile(candidate.file, "utf8")) as GenericRunLog;
        const summary = summarizeRunLog(candidate.runId, raw, candidate.updatedAt);
        if (summary.cwd && summary.cwd !== input.cwd) continue;
        if (input.type && summary.type !== input.type) continue;
        if (input.status && summary.status !== input.status) continue;
        if (input.worktree_name && summary.worktree_name !== input.worktree_name) continue;
        if (input.goal_item_id && summary.goal_item_id !== input.goal_item_id) continue;
        summaries.push(summary);
        if (summaries.length >= limit) break;
      } catch {
        continue;
      }
    }

    return { entries: summaries, total_entries: summaries.length };
  } catch {
    return { entries: [], total_entries: 0 };
  }
}

export async function getRecentRunsSummary(cwd: string, limit = 5): Promise<{ entries: RunLogEntrySummary[]; lifecycle_counts: Record<string, number> }> {
  const runs = await listRunLogs({ cwd, limit });
  return summarizeRecentRuns(runs.entries);
}

export async function getRunLogById(input: ClaudeRunInspectInput): Promise<ClaudeRunInspectResult | null> {
  const raw = await readRunLogFile(input.run_id, input.cwd);
  if (!raw) return null;

  const summary = summarizeRunLog(input.run_id, raw);
  if (summary.cwd && summary.cwd !== input.cwd) return null;

  return {
    entry: summary,
    raw: raw as Record<string, unknown>,
    related_runs: {
      apply_run_id:
        typeof raw.downstream?.last_apply_run_id === "string" ? raw.downstream.last_apply_run_id : undefined,
      cleanup_run_id:
        typeof raw.downstream?.last_cleanup_run_id === "string" ? raw.downstream.last_cleanup_run_id : undefined,
    },
  };
}

export function buildRunResultPayload(raw: GenericRunLog): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: typeof raw.type === "string" ? raw.type : "unknown",
  };
  if (raw.report && typeof raw.report === "object") payload.report = raw.report;
  if (typeof raw.error === "string" && raw.error.length > 0) payload.error = raw.error;
  if (typeof raw.preview === "boolean") payload.preview = raw.preview;
  if (Array.isArray(raw.applied_files)) payload.applied_files = raw.applied_files;
  if (typeof raw.removed_count === "number") payload.removed_count = raw.removed_count;
  if (typeof raw.failed_count === "number") payload.failed_count = raw.failed_count;
  if (raw.observed && typeof raw.observed === "object") payload.observed = raw.observed;
  if (raw.downstream && typeof raw.downstream === "object") payload.downstream = raw.downstream;
  return payload;
}

export function buildResultSummaryFromRun(entry: RunLogEntrySummary): string {
  if (entry.summary) return entry.summary;
  if (entry.error) return `${entry.type} failed: ${entry.error}`;
  return `${entry.type} ${entry.lifecycle}`;
}

export function buildRunGroupSummary(
  goalItemId: string,
  entries: RunLogEntrySummary[],
  limit = 20,
): RunGroupSummary | undefined {
  const matching = entries.filter((e) => e.goal_item_id === goalItemId);
  if (matching.length === 0) return undefined;

  const sorted = [...matching].sort((a, b) => {
    const aTime = a.updated_at ?? a.started_at ?? "";
    const bTime = b.updated_at ?? b.started_at ?? "";
    return bTime.localeCompare(aTime);
  });

  const latest = sorted[0]!;
  const supersededSet = new Set<string>();
  for (const entry of matching) {
    if (entry.supersedes_run_id) supersededSet.add(entry.supersedes_run_id);
  }

  return {
    goal_item_id: goalItemId,
    run_count: matching.length,
    latest_run_id: latest.run_id,
    latest_status: latest.status,
    latest_lifecycle: latest.lifecycle,
    latest_updated_at: latest.updated_at,
    superseded_run_ids: [...supersededSet].sort(),
    entries: sorted.slice(0, limit),
  };
}
