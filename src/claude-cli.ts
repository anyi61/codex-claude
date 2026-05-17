import { cp, rm, writeFile, mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execCapture, resolveRepoLocalPath } from "./guard.js";
import type { BackgroundJobRecord } from "./jobs.js";
import { acquireFileLock, LockBusyError } from "./lock.js";
import { SessionStore, computeRepoKey, RECENT_WINDOW_MINUTES, type Session } from "./session.js";
import type {
  ApplyPlannedChange,
  BackgroundJobEnqueueResult,
  BackgroundJobSummary,
  BackgroundJobType,
  ClaudeApplyInput,
  ClaudeApplyResult,
  ClaudeCleanupInput,
  ClaudeCleanupResult,
  ClaudeImplementInput,
  ClaudeJobCancelInput,
  ClaudeJobCleanupInput,
  ClaudeJobCleanupResult,
  ClaudeJobResultInput,
  ClaudeResultInput,
  ClaudeResultResult,
  ClaudeJobWaitInput,
  ClaudeJobWaitResult,
  ClaudeJobsInput,
  ClaudeJobsResult,
  ClaudeQueryInput,
  ClaudeReviewInput,
  ClaudeResult,
  ClaudeRunInspectInput,
  ClaudeRunInspectResult,
  ClaudeRunsInput,
  ClaudeRunsResult,
  ClaudeStatusResult,
  ClaudeSetupInput,
  ClaudeSetupResult,
  ClaudeTaskInput,
  ClaudeTaskMode,
  ClaudeTaskResult,
  ClaudeWorkspaceStatusInput,
  ClaudeWorkspaceStatusResult,
  CleanupEntry,
  DelegatedWorktreeSummary,
  ExecutionMetadata,
  RunLogEntrySummary,
  RunLifecycle,
  RunLogStatus,
  ReviewGateState,
  ServerObserved,
  SessionLog,
  ToolEnvelope,
  WorkflowNextAction,
  WorkflowSessionSummary,
  WorkspaceAttentionItem,
  ClaudeReviewGateInput,
  ClaudeReviewGateResult,
  SecurityProfile,
} from "./schema.js";
import {
  QUERY_SCHEMA,
  REVIEW_SCHEMA,
  IMPLEMENT_SCHEMA,
  claudeApplyInputSchema,
  claudeCleanupInputSchema,
  claudeImplementInputSchema,
  claudeQueryInputSchema,
  claudeReviewInputSchema,
  buildImplementPrompt,
  buildQueryPrompt,
  buildReviewPrompt,
} from "./schema.js";
import {
  CLAUDE_BIN,
  buildClaudeArgs,
  getEnvironmentDiagnostics,
  implementEnvelopeStatus,
  makeEnvelope,
  spawnClaude,
  successExecution,
} from "./claude-process.js";
export {
  abortActiveClaudeRun,
  buildClaudeArgs,
  buildSafeEnv,
  truncateTail,
} from "./claude-process.js";
export type { ClaudeRunOptions, ClaudeSpawnResult } from "./claude-process.js";
import type { ClaudeRunOptions } from "./claude-process.js";
import {
  __test as backgroundJobsTestState,
  buildWaitMetadata as buildBackgroundWaitMetadata,
  cancelBackgroundJob as cancelBackgroundJobCore,
  cleanupBackgroundJobs as cleanupBackgroundJobsCore,
  createTaskFingerprint as createTaskFingerprintCore,
  enqueueBackgroundJob as enqueueBackgroundJobCore,
  extractBackgroundResultStatus as extractBackgroundResultStatusCore,
  getBackgroundJobResult as getBackgroundJobResultCore,
  getBackgroundStateDir as getBackgroundStateDirCore,
  getBackgroundWorktreeName as getBackgroundWorktreeNameCore,
  getJobStore as getJobStoreCore,
  listBackgroundJobs as listBackgroundJobsCore,
  startBackgroundApply as startBackgroundApplyCore,
  startBackgroundCleanup as startBackgroundCleanupCore,
  startBackgroundImplement as startBackgroundImplementCore,
  startBackgroundQuery as startBackgroundQueryCore,
  startBackgroundReview as startBackgroundReviewCore,
  startJobHeartbeat as startJobHeartbeatCore,
  summarizeBackgroundResult as summarizeBackgroundResultCore,
  toJobSummary as toJobSummaryCore,
  waitForBackgroundJob as waitForBackgroundJobCore,
  waitForJobCompletionInline as waitForJobCompletionInlineCore,
} from "./background-jobs.js";

function getRunLogDir(cwd?: string): string {
  if (process.env.CODEX_CLAUDE_RUN_LOG_DIR) {
    return path.resolve(process.env.CODEX_CLAUDE_RUN_LOG_DIR);
  }
  const base = cwd ?? process.cwd();
  return path.join(base, ".codex-claude-delegate", "runs");
}
const REVIEW_GATE_RELATIVE_PATH = path.join(".codex-claude-delegate", "review-gate.json");
const REVIEW_GATE_HOOK_COMMAND = "node '${CLAUDE_PLUGIN_ROOT}/hooks/review-gate-stop.mjs'";

// Test-only overrides for inline wait timing (never read from env in production)
export const __test = backgroundJobsTestState;

// ---- Session store (cwd-scoped, lazy init) ----

const stores = new Map<string, SessionStore>();
async function getStore(cwd: string): Promise<SessionStore> {
  let sessionStore = stores.get(cwd);
  if (!sessionStore) {
    const sessionDir = path.join(cwd, ".codex-claude-delegate");
    sessionStore = new SessionStore(sessionDir);
    await sessionStore.init();
    stores.set(cwd, sessionStore);
  }
  return sessionStore;
}

const getBackgroundStateDir = getBackgroundStateDirCore;
const getJobStore = getJobStoreCore;
const toJobSummary = toJobSummaryCore;
const extractBackgroundResultStatus = extractBackgroundResultStatusCore;
const waitForJobCompletionInline = waitForJobCompletionInlineCore;
const startJobHeartbeat = startJobHeartbeatCore;
const summarizeBackgroundResult = summarizeBackgroundResultCore;
const getBackgroundWorktreeName = getBackgroundWorktreeNameCore;

function getRepoRootFromModule(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function resolvePluginRootFromModule(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const envPluginRoot = process.env.CLAUDE_PLUGIN_ROOT ? path.resolve(process.env.CLAUDE_PLUGIN_ROOT) : null;

  const candidates = [
    envPluginRoot,
    path.resolve(moduleDir, ".."),
    path.join(getRepoRootFromModule(), "plugins", "codex-claude-delegate"),
  ].filter((candidate): candidate is string => typeof candidate === "string");

  for (const candidate of candidates) {
    const hooksDir = path.join(candidate, "hooks");
    if (existsSync(path.join(hooksDir, "hooks.json")) || existsSync(path.join(hooksDir, "review-gate-stop.mjs"))) {
      return candidate;
    }
  }

  // Fallback to the repository layout used during source development.
  return path.join(getRepoRootFromModule(), "plugins", "codex-claude-delegate");
}

function getHookManifestPath(): string {
  return path.join(resolvePluginRootFromModule(), "hooks", "hooks.json");
}

function getHookScriptPath(): string {
  return path.join(resolvePluginRootFromModule(), "hooks", "review-gate-stop.mjs");
}

function getReviewGateStatePath(cwd: string): string {
  return path.join(cwd, REVIEW_GATE_RELATIVE_PATH);
}

async function readReviewGateState(cwd: string): Promise<ReviewGateState | null> {
  const filePath = getReviewGateStatePath(cwd);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as ReviewGateState;
  } catch {
    return null;
  }
}

async function writeReviewGateState(cwd: string, enabled: boolean): Promise<ReviewGateState> {
  const pathCheck = resolveRepoLocalPath(cwd, REVIEW_GATE_RELATIVE_PATH);
  if (!pathCheck.ok) {
    throw new Error(pathCheck.error);
  }
  await mkdir(path.dirname(pathCheck.resolved), { recursive: true });
  const next: ReviewGateState = {
    workspace_root: cwd,
    config_path: pathCheck.resolved,
    hook_manifest_path: getHookManifestPath(),
    hook_script_path: getHookScriptPath(),
    hook_installed: existsSync(getHookManifestPath()) && existsSync(getHookScriptPath()),
    enabled,
    mode: "soft-stop",
    pending_review: false,
    updated_at: new Date().toISOString(),
  };
  await writeFile(pathCheck.resolved, JSON.stringify(next, null, 2), "utf8");
  return next;
}

async function markReviewGatePending(cwd: string, pending: boolean, activity: "write" | "review"): Promise<void> {
  const current = await readReviewGateState(cwd);
  if (!current?.enabled) return;
  const pathCheck = resolveRepoLocalPath(cwd, REVIEW_GATE_RELATIVE_PATH);
  if (!pathCheck.ok) {
    throw new Error(pathCheck.error);
  }
  const now = new Date().toISOString();
  const next: ReviewGateState = {
    ...current,
    config_path: pathCheck.resolved,
    hook_manifest_path: getHookManifestPath(),
    hook_script_path: getHookScriptPath(),
    hook_installed: existsSync(getHookManifestPath()) && existsSync(getHookScriptPath()),
    pending_review: pending,
    updated_at: now,
    last_write_at: activity === "write" ? now : current.last_write_at,
    last_review_at: activity === "review" ? now : current.last_review_at,
  };
  await mkdir(path.dirname(pathCheck.resolved), { recursive: true });
  await writeFile(pathCheck.resolved, JSON.stringify(next, null, 2), "utf8");
}

async function ensureReviewGateHookManifest(): Promise<void> {
  const manifestPath = getHookManifestPath();
  await mkdir(path.dirname(manifestPath), { recursive: true });
  const existingRaw = existsSync(manifestPath) ? await readFile(manifestPath, "utf8").catch(() => "") : "";
  let parsed: { hooks?: Record<string, unknown> } = {};
  if (existingRaw.trim()) {
    try {
      parsed = JSON.parse(existingRaw) as { hooks?: Record<string, unknown> };
    } catch {
      parsed = {};
    }
  }
  const hooksRoot = parsed.hooks && typeof parsed.hooks === "object"
    ? parsed.hooks as Record<string, unknown>
    : {};
  const stopEntries = Array.isArray(hooksRoot.Stop) ? [...hooksRoot.Stop as Array<Record<string, unknown>>] : [];
  const alreadyInstalled = stopEntries.some((entry) => {
    const hookEntries = Array.isArray(entry.hooks) ? entry.hooks as Array<Record<string, unknown>> : [];
    return hookEntries.some((hook) => hook.type === "command" && hook.command === REVIEW_GATE_HOOK_COMMAND);
  });
  if (!alreadyInstalled) {
    stopEntries.push({
      matcher: ".*",
      hooks: [
        {
          type: "command",
          command: REVIEW_GATE_HOOK_COMMAND,
          async: false,
        },
      ],
    });
  }
  hooksRoot.Stop = stopEntries;
  await writeFile(manifestPath, JSON.stringify({ hooks: hooksRoot }, null, 2), "utf8");
}

function getReviewGateNextSteps(enabled: boolean, hookInstallable: boolean, pendingReview = false): string[] {
  if (!hookInstallable) {
    return ["Review gate hook assets are missing. Restore the plugin hook files before enabling the gate."];
  }
  if (enabled) {
    return [
      "Review gate is enabled for this workspace.",
      pendingReview
        ? "A review is pending for the latest write-oriented workflow in this workspace."
        : "No pending review is currently tracked for this workspace.",
      "Verify the plugin loads hooks/hooks.json and that the stop hook script is reachable.",
      "Before finishing a coding session, expect a stop-time reminder to run claude_review or claude_task with mode=review.",
    ];
  }
  return [
    "Review gate is disabled for this workspace.",
    "Call claude_review_gate with action=enable to persist the local gate state and install/update the stop-hook manifest.",
  ];
}

function buildReviewGateState(cwd: string, state: Partial<ReviewGateState> | null, hookInstalled: boolean): ReviewGateState {
  return {
    workspace_root: cwd,
    config_path: getReviewGateStatePath(cwd),
    hook_manifest_path: getHookManifestPath(),
    hook_script_path: getHookScriptPath(),
    hook_installed: hookInstalled,
    enabled: state?.enabled === true,
    mode: "soft-stop",
    pending_review: state?.pending_review === true,
    updated_at: state?.updated_at,
    last_write_at: state?.last_write_at,
    last_review_at: state?.last_review_at,
  };
}

function toWorkflowSessionSummaryFromStore(session: Session): WorkflowSessionSummary {
  return {
    session_id: session.session_id,
    type: session.type,
    repo_path: session.repo_path,
    last_used: session.last_used,
    use_count: session.use_count,
    summary: session.summary,
    source: "store",
  };
}

export function createTaskFingerprint(input: {
  cwd: string;
  type: BackgroundJobType;
  payload: Record<string, unknown>;
}): string {
  return createTaskFingerprintCore(input);
}

function buildWaitMetadata(input: {
  mode?: "block" | "background";
  timeoutSec?: number;
  completedInline?: boolean;
  waiting?: boolean;
  timedOut?: boolean;
  doNotStartDuplicateJob?: boolean;
}) {
  return buildBackgroundWaitMetadata(input);
}

// ---- Logging (stderr only, never stdout) ----

function log(msg: string): void {
  process.stderr.write(`[claude-delegate] ${msg}\n`);
}

async function logRun(runId: string, data: Record<string, unknown>, cwd?: string): Promise<void> {
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

interface ImplementRunLog {
  type?: unknown;
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

interface GenericRunLog {
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
}

function normalizeRepoPath(cwd: string, file: string): string {
  const repoRelative = path.isAbsolute(file) ? path.relative(cwd, file) : file;
  return repoRelative.replaceAll(path.sep, "/").replace(/^\.\//, "");
}

function isUnderRequestedFile(file: string, requested: string): boolean {
  return file === requested || file.startsWith(`${requested.replace(/\/$/, "")}/`);
}

function normalizeRequestedFiles(cwd: string, files?: string[]): string[] {
  if (!files?.length) return [];
  const normalized = new Set<string>();
  for (const file of files) {
    const repoPath = normalizeRepoPath(cwd, file).replace(/\/+$/g, "");
    if (repoPath) normalized.add(repoPath);
  }
  return [...normalized].sort();
}

async function findImplementJobForWorktree(worktreePath: string, cwd: string): Promise<BackgroundJobRecord | null> {
  const wtName = path.basename(worktreePath);
  const jobStore = await getJobStore();
  const jobs = await jobStore.list({
    cwd,
    limit: 100,
    type: "implement",
  });
  const terminalStatuses = new Set(["succeeded", "failed", "cancelled"]);
  return jobs.find((job) => job.worktree_name === wtName && terminalStatuses.has(job.status)) ?? null;
}

async function findImplementLogForWorktree(worktreePath: string, cwd?: string): Promise<ImplementRunLog | null> {
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

async function findImplementLogRecordForWorktree(worktreePath: string, cwd?: string): Promise<{ file: string; parsed: ImplementRunLog } | null> {
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

async function updateImplementLifecycleForWorktree(
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

function parseRunStatus(raw: GenericRunLog): RunLogStatus {
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

function parseRunLifecycle(raw: GenericRunLog): RunLifecycle {
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

function summarizeRunLog(runId: string, raw: GenericRunLog, updatedAt?: string): RunLogEntrySummary {
  const worktreePath =
    typeof raw.observed?.worktree_path === "string"
      ? raw.observed.worktree_path
      : typeof raw.input?.worktree_path === "string"
        ? raw.input.worktree_path
        : undefined;
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
  };
}

function summarizeRecentRuns(entries: RunLogEntrySummary[]): { entries: RunLogEntrySummary[]; lifecycle_counts: Record<string, number> } {
  const lifecycleCounts: Record<string, number> = {};
  for (const entry of entries) {
    lifecycleCounts[entry.lifecycle] = (lifecycleCounts[entry.lifecycle] ?? 0) + 1;
  }
  return { entries, lifecycle_counts: lifecycleCounts };
}

async function readRunLogFile(runId: string, cwd?: string): Promise<GenericRunLog | null> {
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

function buildRunResultPayload(raw: GenericRunLog): Record<string, unknown> {
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

function buildResultSummaryFromRun(entry: RunLogEntrySummary): string {
  if (entry.summary) return entry.summary;
  if (entry.error) return `${entry.type} failed: ${entry.error}`;
  return `${entry.type} ${entry.lifecycle}`;
}

async function resolveWorkflowSessionSummary(input: {
  cwd: string;
  run?: RunLogEntrySummary;
}): Promise<WorkflowSessionSummary | undefined> {
  const store = await getStore(input.cwd);
  const run = input.run;

  if (run?.returned_session_id) {
    const stored = store.getById(run.returned_session_id);
    if (stored) {
      return {
        ...toWorkflowSessionSummaryFromStore(stored),
        requested_session_id: run.requested_session_id,
        returned_session_id: run.returned_session_id,
        resumed: !!run.requested_session_id,
        source: "run",
      };
    }
  }

  return undefined;
}

function buildNextActions(input: {
  cwd: string;
  job?: BackgroundJobSummary;
  run?: RunLogEntrySummary;
  related_runs?: ClaudeRunInspectResult["related_runs"];
  session?: WorkflowSessionSummary;
  change_count?: number;
}): WorkflowNextAction[] {
  const actions: WorkflowNextAction[] = [];
  const run = input.run;
  const job = input.job;
  const type = run?.type ?? job?.type;
  const worktreePath = run?.worktree_path;
  const hasChanges = input.change_count !== undefined
    ? input.change_count > 0
    : !!worktreePath;
  const isNonSuccess = run?.status === "partial" || run?.status === "failed" || run?.status === "needs_user";

  if (job && (job.status === "queued" || job.status === "running")) {
    return [
      {
        tool: "claude_task",
        reason: "This job is still active. Continue waiting for this job_id instead of starting a duplicate task.",
        args: { cwd: input.cwd, job_id: job.job_id, wait_strategy: "block", wait_timeout_sec: 540 },
      },
    ];
  }

  if (type === "implement") {
    if (hasChanges && worktreePath) {
      actions.push({
        tool: "claude_apply",
        reason: "Preview the delegated worktree diff before modifying the main workspace. After preview, ask the user for explicit approval before any non-preview apply.",
        args: { cwd: input.cwd, worktree_path: worktreePath, preview: true },
      });
    }
    if (input.session?.session_id && isNonSuccess) {
      actions.push({
        tool: "claude_task",
        reason: "This implementation has a resumable Claude session. Review the existing changes, then ask the user whether to preview, resume, or discard.",
        args: { cwd: input.cwd, mode: "write", task: "Continue the previous implementation task and finish incomplete work.", resume_latest: true },
      });
    }
  }

  if (type === "review") {
    actions.push({
      tool: "claude_review",
      reason: "Run another review pass or adjust review instructions if follow-up validation is needed.",
      args: { cwd: input.cwd },
    });
  }

  if (run?.lifecycle === "apply_blocked") {
    actions.push({
      tool: "claude_run_inspect",
      reason: "The apply step was blocked and usually needs a closer look at the underlying run details.",
      args: { cwd: input.cwd, run_id: run.run_id },
    });
  }

  if (run?.status === "needs_user") {
    actions.push({
      tool: "claude_run_inspect",
      reason: "Claude stopped for user input; inspect the run before deciding whether to resume, apply, or discard it.",
      args: { cwd: input.cwd, run_id: run.run_id },
    });
    if (worktreePath) {
      actions.push({
        tool: "claude_cleanup",
        reason: "If the needs_user worktree is not useful, clean delegated worktrees after inspection.",
        args: { cwd: input.cwd, dry_run: true },
      });
    }
    if (!input.session?.session_id) {
      actions.push({
        tool: "claude_implement",
        reason: "If the Claude session cannot be resumed, start a fresh implementation with the same task.",
        args: { cwd: input.cwd },
      });
    }
  }

  if (input.related_runs?.cleanup_run_id) {
    actions.push({
      tool: "claude_run_inspect",
      reason: "A related cleanup run exists for this workflow.",
      args: { cwd: input.cwd, run_id: input.related_runs.cleanup_run_id },
    });
  }

  return actions;
}

function compareRecency(a?: string, b?: string): number {
  const aTime = a ? Date.parse(a) : 0;
  const bTime = b ? Date.parse(b) : 0;
  return aTime - bTime;
}

async function listDelegatedWorktrees(cwd: string): Promise<DelegatedWorktreeSummary[]> {
  const worktreeDir = path.join(cwd, ".claude", "worktrees");
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  try {
    const entries = await readdir(worktreeDir, { withFileTypes: true });
    const summarized = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("codex-delegated-"))
      .map(async (entry) => {
        const worktreePath = path.join(worktreeDir, entry.name);
        try {
          const details = await stat(worktreePath);
          return {
            worktree_name: entry.name,
            worktree_path: worktreePath,
            updated_at: new Date(details.mtimeMs).toISOString(),
            stale: details.mtimeMs < cutoff,
          } satisfies DelegatedWorktreeSummary;
        } catch {
          return {
            worktree_name: entry.name,
            worktree_path: worktreePath,
            stale: false,
          } satisfies DelegatedWorktreeSummary;
        }
      }));
    return summarized.sort((a, b) => compareRecency(b.updated_at, a.updated_at));
  } catch {
    return [];
  }
}

export async function getClaudeResult(input: ClaudeResultInput): Promise<ClaudeResultResult> {
  const prefer = input.prefer ?? "latest-job";
  let resolvedJob: BackgroundJobSummary | undefined;
  let resolvedRun: ClaudeRunInspectResult | null = null;
  let resultPayload: Record<string, unknown> | undefined;

  if (input.job_id) {
    const jobResult = await getBackgroundJobResult({ cwd: input.cwd, job_id: input.job_id });
    if (!jobResult) {
      throw new Error(`Job not found: ${input.job_id}`);
    }
    resolvedJob = jobResult.job;
    resultPayload = jobResult.result;
    if (jobResult.job.run_id) {
      resolvedRun = await getRunLogById({ cwd: input.cwd, run_id: jobResult.job.run_id });
    }
  } else if (input.run_id) {
    resolvedRun = await getRunLogById({ cwd: input.cwd, run_id: input.run_id });
    if (!resolvedRun) {
      throw new Error(`Run not found: ${input.run_id}`);
    }
    resultPayload = buildRunResultPayload((await readRunLogFile(input.run_id, input.cwd)) ?? {} as GenericRunLog);
  } else {
    const runTypeFilter = prefer === "latest-implement" ? "implement" : prefer === "latest-review" ? "review" : undefined;
    const jobTypeFilter = runTypeFilter;

    const terminalJobLists = await Promise.all([
      listBackgroundJobs({ cwd: input.cwd, limit: 20, status: "succeeded", type: jobTypeFilter }),
      listBackgroundJobs({ cwd: input.cwd, limit: 20, status: "failed", type: jobTypeFilter }),
      listBackgroundJobs({ cwd: input.cwd, limit: 20, status: "cancelled", type: jobTypeFilter }),
    ]);
    const latestJob = terminalJobLists
      .flatMap((result) => result.entries)
      .sort((a, b) => compareRecency(b.updated_at, a.updated_at))[0];

    const latestRun = (await listRunLogs({ cwd: input.cwd, limit: 20, type: runTypeFilter })).entries
      .find((entry) => entry.status !== "unknown" || entry.lifecycle !== "unknown");

    if (prefer === "latest-run" || (!latestJob && latestRun)) {
      if (latestRun) {
        resolvedRun = await getRunLogById({ cwd: input.cwd, run_id: latestRun.run_id });
        resultPayload = buildRunResultPayload((await readRunLogFile(latestRun.run_id, input.cwd)) ?? {} as GenericRunLog);
      }
    } else if (prefer === "latest-job" || !latestRun) {
      if (latestJob) {
        const jobResult = await getBackgroundJobResult({ cwd: input.cwd, job_id: latestJob.job_id });
        resolvedJob = latestJob;
        resultPayload = jobResult?.result;
        if (latestJob.run_id) {
          resolvedRun = await getRunLogById({ cwd: input.cwd, run_id: latestJob.run_id });
        }
      }
    } else if (latestJob && latestRun) {
      if (compareRecency(latestJob.updated_at, latestRun.updated_at) >= 0) {
        const jobResult = await getBackgroundJobResult({ cwd: input.cwd, job_id: latestJob.job_id });
        resolvedJob = latestJob;
        resultPayload = jobResult?.result;
        if (latestJob.run_id) {
          resolvedRun = await getRunLogById({ cwd: input.cwd, run_id: latestJob.run_id });
        }
      } else {
        resolvedRun = await getRunLogById({ cwd: input.cwd, run_id: latestRun.run_id });
        resultPayload = buildRunResultPayload((await readRunLogFile(latestRun.run_id, input.cwd)) ?? {} as GenericRunLog);
      }
    }
  }

  if (!resolvedJob && !resolvedRun) {
    throw new Error("No matching finished job or run found for this workspace.");
  }

  const runEntry = resolvedRun?.entry;
  const rawObserved = resolvedRun?.raw?.observed as Record<string, unknown> | undefined;
  const changeCount = Array.isArray(rawObserved?.changed_files) ? rawObserved.changed_files.length : undefined;
  const session = await resolveWorkflowSessionSummary({ cwd: input.cwd, run: runEntry });
  const summary = resolvedJob?.summary ?? (runEntry ? buildResultSummaryFromRun(runEntry) : "Background job resolved");
  const jobIsActive = resolvedJob?.status === "queued" || resolvedJob?.status === "running";

  return {
    source_type: resolvedJob ? "job" : "run",
    summary,
    job: resolvedJob,
    run: runEntry,
    session,
    result: resultPayload,
    related_runs: resolvedRun?.related_runs,
    do_not_start_duplicate_job: jobIsActive ? true : undefined,
    next_actions: buildNextActions({
      cwd: input.cwd,
      job: resolvedJob,
      run: runEntry,
      related_runs: resolvedRun?.related_runs,
      session,
      change_count: changeCount,
    }),
  };
}

export async function getWorkspaceStatus(input: ClaudeWorkspaceStatusInput): Promise<ClaudeWorkspaceStatusResult> {
  const limit = input.limit ?? 10;
  const [runningJobs, queuedJobs, succeededJobs, failedJobs, cancelledJobs, recentRuns, worktrees] = await Promise.all([
    listBackgroundJobs({ cwd: input.cwd, limit, status: "running" }),
    listBackgroundJobs({ cwd: input.cwd, limit, status: "queued" }),
    input.include_terminal ? listBackgroundJobs({ cwd: input.cwd, limit, status: "succeeded" }) : Promise.resolve({ entries: [] }),
    input.include_terminal ? listBackgroundJobs({ cwd: input.cwd, limit, status: "failed" }) : Promise.resolve({ entries: [] }),
    input.include_terminal ? listBackgroundJobs({ cwd: input.cwd, limit, status: "cancelled" }) : Promise.resolve({ entries: [] }),
    listRunLogs({ cwd: input.cwd, limit }),
    listDelegatedWorktrees(input.cwd),
  ]);

  const terminalJobs = [...succeededJobs.entries, ...failedJobs.entries, ...cancelledJobs.entries]
    .sort((a, b) => compareRecency(b.updated_at, a.updated_at))
    .slice(0, limit);
  const referencedWorktreeNames = new Set<string>();
  for (const run of recentRuns.entries) {
    if (run.worktree_name) referencedWorktreeNames.add(run.worktree_name);
  }
  for (const job of [...runningJobs.entries, ...queuedJobs.entries, ...terminalJobs]) {
    if (job.worktree_name) referencedWorktreeNames.add(job.worktree_name);
  }
  const summarizedWorktrees = worktrees.map((worktree) => ({
    ...worktree,
    orphaned: !referencedWorktreeNames.has(worktree.worktree_name),
  }));

  const store = await getStore(input.cwd);
  const repoKey = await computeRepoKey(input.cwd);
  const latestSessions = store.listByRepo(repoKey, limit)
    .filter((session) => !session.expired)
    .map(toWorkflowSessionSummaryFromStore);

  const attentionItems: WorkspaceAttentionItem[] = [];
  const queuedCutoff = Date.now() - 10 * 60 * 1000;
  for (const job of queuedJobs.entries) {
    const createdAt = Date.parse(job.created_at);
    if (Number.isFinite(createdAt) && createdAt <= queuedCutoff) {
      attentionItems.push({
        kind: "queued_job",
        severity: "warning",
        message: `Queued job ${job.job_id} has been waiting for more than 10 minutes.`,
      });
    }
  }

  for (const run of recentRuns.entries) {
    if (run.lifecycle === "apply_blocked") {
      attentionItems.push({
        kind: "apply_blocked",
        severity: "warning",
        message: `Run ${run.run_id} is apply_blocked and may need manual inspection before changes can land.`,
      });
    }
  }

  for (const worktree of summarizedWorktrees) {
    if (worktree.stale) {
      attentionItems.push({
        kind: "stale_worktree",
        severity: "info",
        message: `Delegated worktree ${worktree.worktree_name} looks stale and may be ready for cleanup.`,
      });
    }
    if (worktree.orphaned) {
      attentionItems.push({
        kind: "orphan_worktree",
        severity: "info",
        message: `Delegated worktree ${worktree.worktree_name} is not referenced by recent runs or jobs.`,
      });
    }
  }

  const activeJobs = [...runningJobs.entries, ...queuedJobs.entries]
    .sort((a, b) => compareRecency(b.updated_at, a.updated_at));
  const workspaceNextActions = activeJobs.slice(0, limit).map((job) => ({
    tool: "claude_task",
    reason: "Workspace has an active delegated job. Continue waiting for this job_id instead of starting a duplicate task.",
    args: { cwd: input.cwd, job_id: job.job_id, wait_strategy: "block", wait_timeout_sec: 540 },
  }));

  return {
    workspace_root: input.cwd,
    running_jobs: runningJobs.entries,
    queued_jobs: queuedJobs.entries,
    recent_terminal_jobs: terminalJobs,
    recent_runs: recentRuns.entries,
    latest_sessions: latestSessions,
    delegated_worktrees: summarizedWorktrees,
    counts: {
      running_jobs: runningJobs.entries.length,
      queued_jobs: queuedJobs.entries.length,
      terminal_jobs: terminalJobs.length,
      recent_runs: recentRuns.entries.length,
      delegated_worktrees: summarizedWorktrees.length,
      stale_worktrees: summarizedWorktrees.filter((worktree) => worktree.stale).length,
      orphan_worktrees: summarizedWorktrees.filter((worktree) => worktree.orphaned).length,
      apply_blocked_runs: recentRuns.entries.filter((run) => run.lifecycle === "apply_blocked").length,
    },
    do_not_start_duplicate_job: activeJobs.length > 0 ? true : undefined,
    next_actions: workspaceNextActions.length > 0 ? workspaceNextActions : undefined,
    attention_items: attentionItems,
  };
}

export async function runClaudeSetup(input: ClaudeSetupInput): Promise<ClaudeSetupResult> {
  const hookManifestPath = getHookManifestPath();
  const hookScriptPath = getHookScriptPath();
  const hookInstalled = existsSync(hookManifestPath) && existsSync(hookScriptPath);
  const gateState = await readReviewGateState(input.cwd);
  const status = await checkClaudeStatus(input.cwd);
  const reviewGate = buildReviewGateState(input.cwd, gateState, hookInstalled);
  const authStatus =
    status.auth_status === "authenticated"
      ? "ok"
      : status.auth_status === "not authenticated" || status.auth_status === "unauthenticated or unknown"
        ? "missing"
        : "unknown";

  return {
    workspace_root: input.cwd,
    review_gate: reviewGate,
    claude_available: status.claude_available,
    claude_version: status.claude_version,
    auth_status: authStatus,
    git_available: status.git_available,
    worktree_capable: status.worktree_capable,
    cwd_valid: status.cwd_valid,
    cwd_is_git_repo: status.cwd_is_git_repo,
    errors: status.errors,
    next_steps: [
      ...(status.claude_available && status.git_available && status.cwd_valid
        ? []
        : ["Run claude_status and fix Claude CLI, git, or workspace readiness issues before using the review gate."]),
      ...getReviewGateNextSteps(reviewGate.enabled, hookInstalled, reviewGate.pending_review),
    ],
  };
}

export async function manageClaudeReviewGate(input: ClaudeReviewGateInput): Promise<ClaudeReviewGateResult> {
  const hookManifestPath = getHookManifestPath();
  const hookScriptPath = getHookScriptPath();
  const hookInstallable = existsSync(hookScriptPath);
  const current = await readReviewGateState(input.cwd);
  const action = input.action ?? "status";
  const hookInstalled = existsSync(hookManifestPath) && hookInstallable;

  if (action === "status") {
    const reviewGate = buildReviewGateState(input.cwd, current, hookInstalled);
    return {
      ...reviewGate,
      action,
      changed: false,
      summary: reviewGate.enabled
        ? (reviewGate.pending_review ? "Review gate is enabled and a review is pending." : "Review gate is enabled for this workspace.")
        : "Review gate is disabled for this workspace.",
      next_steps: getReviewGateNextSteps(reviewGate.enabled, hookInstalled, reviewGate.pending_review),
    };
  }

  if (!hookInstallable) {
    throw new Error(`Review gate hook script is missing: ${hookScriptPath}`);
  }

  if (action === "enable") {
    await ensureReviewGateHookManifest();
  }
  const nextState = await writeReviewGateState(input.cwd, action === "enable");
  const reviewGate = buildReviewGateState(input.cwd, nextState, existsSync(hookManifestPath) && hookInstallable);

  return {
    ...reviewGate,
    action,
    changed: current?.enabled !== nextState.enabled || !current,
    summary: nextState.enabled
      ? "Review gate enabled for this workspace and stop-hook manifest is ready."
      : "Review gate disabled for this workspace. Hook asset is left installed but locally inactive.",
    next_steps: getReviewGateNextSteps(nextState.enabled, existsSync(hookManifestPath) && hookInstallable, reviewGate.pending_review),
  };
}

function inferClaudeTaskMode(input: ClaudeTaskInput): Exclude<ClaudeTaskMode, "auto"> {
  if (input.mode && input.mode !== "auto") {
    return input.mode;
  }

  if (!input.task) return "read";
  const text = input.task.toLowerCase();
  if (typeof input.diff === "string" && input.diff.trim().length > 0) {
    return "review";
  }

  const writeHints = /\b(fix|change|implement|write|edit|modify|update|refactor|patch|add|create)\b/;
  const reviewHints = /\b(review|audit|inspect|check|find bugs|look for issues|critique)\b/;
  const readHints = /\b(explain|analyze|analyse|why|how|what|summarize|describe|read-only|understand)\b/;

  if ((input.constraints?.length ?? 0) > 0) {
    return "write";
  }
  if (writeHints.test(text)) {
    return "write";
  }
  if (reviewHints.test(text)) {
    return "review";
  }
  if (readHints.test(text)) {
    return "read";
  }
  if ((input.files?.length ?? 0) > 0) {
    return "review";
  }
  return "read";
}

function summarizeTaskDispatch(mode: Exclude<ClaudeTaskMode, "auto">, isBackground: boolean): string {
  if (isBackground) {
    return `Delegated ${mode} task as a background job.`;
  }
  return `Delegated ${mode} task with inline wait for result.`;
}

const CLAUDE_TASK_FILES_DEPRECATED_WARNING =
  "claude_task.files is deprecated and treated as instruction_files, not apply scope. Use advanced claude_implement allowed_files/scope options for strict file modification limits.";

function resolveTaskInstructionFiles(input: ClaudeTaskInput): { instructionFiles?: string[]; warnings: string[] } {
  const merged = [...(input.instruction_files ?? []), ...(input.files ?? [])]
    .map((file) => file.trim())
    .filter((file) => file.length > 0);
  const instructionFiles = [...new Set(merged)].sort((a, b) => a.localeCompare(b));
  return {
    instructionFiles: instructionFiles.length > 0 ? instructionFiles : undefined,
    warnings: input.files?.length ? [CLAUDE_TASK_FILES_DEPRECATED_WARNING] : [],
  };
}

function deriveClaudeTaskTopStatus(job: BackgroundJobSummary, result?: Record<string, unknown>): string {
  if (job.status === "cancelled") return "cancelled";

  // Check explicit result_status first
  if (job.result_status === "failed") return "failed";
  if (job.result_status === "partial") return "partial";
  if (job.result_status === "needs_user") return "needs_user";

  // Fallback: scan result for embedded failure signals (legacy jobs without result_status)
  if (result) {
    const extracted = extractBackgroundResultStatus(result);
    if (extracted === "failed") return "failed";
    if (extracted === "partial") return "partial";
    if (extracted === "needs_user") return "needs_user";
  }

  // Process-level failure
  if (job.status === "failed") return "failed";

  return "success";
}

async function buildClaudeTaskInlineResult(input: {
  cwd: string;
  job: BackgroundJobSummary;
  jobRecord: BackgroundJobRecord;
  delegatedMode: Exclude<ClaudeTaskMode, "auto">;
  completedInline: boolean;
  waiting?: boolean;
  staled?: boolean;
}): Promise<ClaudeTaskResult> {
  const { cwd, job, jobRecord, delegatedMode, completedInline, waiting, staled } = input;

  // For completed inline results: reuse getClaudeResult for standardized aggregation
  if (completedInline && !staled) {
    const claudeResult = await getClaudeResult({ cwd, job_id: job.job_id }).catch(() => null);
    if (claudeResult) {
      return {
        delegated_mode: delegatedMode,
        status: deriveClaudeTaskTopStatus(job, jobRecord.result),
        summary: claudeResult.summary,
        job: claudeResult.job,
        result: claudeResult.result,
        result_status: claudeResult.job?.result_status,
        session: claudeResult.session,
        server_observed: claudeResult.result?.server_observed ?? undefined,
        related_runs: claudeResult.related_runs,
        completed_inline: true,
        do_not_start_duplicate_job: false,
        wait: buildWaitMetadata({
          completedInline: true,
          waiting: false,
          doNotStartDuplicateJob: false,
        }),
        warnings: [],
        next_actions: claudeResult.next_actions,
      };
    }
  }

  // Fallback: hand-rolled aggregation (used when getClaudeResult throws or for stale paths)
  const result = jobRecord.result;
  const resultStatus = extractBackgroundResultStatus(result);

  let topStatus: string;
  if (staled) {
    topStatus = "needs_attention";
  } else {
    topStatus = deriveClaudeTaskTopStatus(job, result);
  }

  const runEntry = job.run_id
    ? (await getRunLogById({ cwd, run_id: job.run_id }).catch(() => null))?.entry
    : undefined;
  const rawRun = job.run_id ? await readRunLogFile(job.run_id, cwd).catch(() => null) : null;
  const session = runEntry
    ? await resolveWorkflowSessionSummary({ cwd, run: runEntry }).catch(() => undefined)
    : undefined;
  const relatedRuns = result?.related_runs as { apply_run_id?: string; cleanup_run_id?: string } | undefined;
  const rawObserved = rawRun?.observed as Record<string, unknown> | undefined;
  const changeCount = Array.isArray(rawObserved?.changed_files) ? rawObserved.changed_files.length : undefined;

  return {
    delegated_mode: delegatedMode,
    status: topStatus,
    summary: job.summary ?? `${delegatedMode} job ${job.status}`,
    job,
    result: result ?? undefined,
    result_status: resultStatus,
    session,
    server_observed: result?.server_observed ?? undefined,
    related_runs: relatedRuns,
    completed_inline: completedInline || undefined,
    waiting: waiting || undefined,
    do_not_start_duplicate_job: staled || waiting ? true : false,
    wait: buildWaitMetadata({
      completedInline,
      waiting: waiting || staled,
      doNotStartDuplicateJob: staled || waiting ? true : false,
    }),
    warnings: [],
    next_actions: buildNextActions({ cwd, job, run: runEntry, session, related_runs: relatedRuns, change_count: changeCount }),
  };
}

export async function runClaudeTask(input: ClaudeTaskInput, _runId: string): Promise<ClaudeTaskResult> {
  // --- job_id continuation path ---
  if (input.job_id) {
    const jobStore = await getJobStore();
    const record = await jobStore.get(input.job_id);
    if (!record || record.cwd !== input.cwd) {
      return {
        delegated_mode: "read",
        status: "failed",
        summary: `Job not found: ${input.job_id}`,
        do_not_start_duplicate_job: true,
        wait: buildWaitMetadata({
          timeoutSec: input.wait_timeout_sec ?? 540,
          completedInline: false,
          waiting: false,
          doNotStartDuplicateJob: true,
        }),
        warnings: [],
        next_actions: [],
      };
    }

    const job = toJobSummary(record);
    if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
      return buildClaudeTaskInlineResult({
        cwd: input.cwd,
        job,
        jobRecord: record,
        delegatedMode: delegatedModeForJobType(job.type),
        completedInline: true,
      });
    }

    const waitTimeoutMs = (input.wait_timeout_sec ?? 540) * 1000;
    const inlineResult = await waitForJobCompletionInline(jobStore, input.job_id, input.cwd, waitTimeoutMs);

    if (inlineResult.status === "not_found") {
      return {
        delegated_mode: delegatedModeForJobType(job.type),
        status: "failed",
        summary: `Job not found during wait: ${input.job_id}`,
        wait: buildWaitMetadata({
          timeoutSec: input.wait_timeout_sec ?? 540,
          completedInline: false,
          waiting: false,
          doNotStartDuplicateJob: true,
        }),
        warnings: [],
        next_actions: [],
      };
    }

    if (inlineResult.status === "completed" && inlineResult.jobRecord) {
      return buildClaudeTaskInlineResult({
        cwd: input.cwd,
        job: inlineResult.job!,
        jobRecord: inlineResult.jobRecord,
        delegatedMode: delegatedModeForJobType(inlineResult.job!.type),
        completedInline: true,
      });
    }

    if (inlineResult.status === "stale") {
      const staleRecord = await jobStore.get(input.job_id);
      return buildClaudeTaskInlineResult({
        cwd: input.cwd,
        job: inlineResult.job!,
        jobRecord: staleRecord ?? record,
        delegatedMode: delegatedModeForJobType(inlineResult.job!.type),
        completedInline: false,
        staled: true,
      });
    }

    const stillRunning = await jobStore.get(input.job_id);
    return {
      delegated_mode: delegatedModeForJobType((stillRunning ?? record).type),
      status: "running",
      summary: `Job ${input.job_id} is still running.`,
      job: toJobSummary(stillRunning ?? record),
      completed_inline: false,
      waiting: true,
      do_not_start_duplicate_job: true,
      wait: buildWaitMetadata({
        timeoutSec: input.wait_timeout_sec ?? 540,
        completedInline: false,
        waiting: true,
        timedOut: true,
        doNotStartDuplicateJob: true,
      }),
      warnings: [],
      next_actions: [
        {
          tool: "claude_task",
          reason: "Claude is still working. Continue waiting for the same job_id instead of starting a duplicate task.",
          args: { cwd: input.cwd, job_id: input.job_id, wait_strategy: "block", wait_timeout_sec: 540 },
        },
      ],
    };
  }

  // --- new task path ---
  const delegatedMode = inferClaudeTaskMode(input);
  const { instructionFiles, warnings } = resolveTaskInstructionFiles(input);
  // wait_strategy takes precedence over legacy background alias
  const effectiveWaitStrategy = input.wait_strategy ?? (input.background === true ? "background" : "block");
  const isBackground = effectiveWaitStrategy === "background";

  const INTERNAL_CLAUDE_TIMEOUT_SEC = 3600;

  async function enqueueAndWait() {
    let queued: BackgroundJobEnqueueResult | ClaudeResult;

    if (delegatedMode === "read") {
      queued = await startBackgroundQuery({
        cwd: input.cwd,
        task: input.task!,
        instruction_files: instructionFiles,
        timeout_sec: INTERNAL_CLAUDE_TIMEOUT_SEC,
      });
    } else if (delegatedMode === "review") {
      queued = await startBackgroundReview({
        cwd: input.cwd,
        task: input.task!,
        diff: input.diff,
        instruction_files: instructionFiles,
        timeout_sec: INTERNAL_CLAUDE_TIMEOUT_SEC,
      });
    } else {
      const implementResult = await startBackgroundImplement({
        cwd: input.cwd,
        task: input.task!,
        instruction_files: instructionFiles,
        constraints: input.constraints,
        timeout_sec: INTERNAL_CLAUDE_TIMEOUT_SEC,
        resume_latest: input.resume_latest,
        dirty_policy: input.dirty_policy,
        security_profile: input.security_profile,
      });
      if (!("job" in implementResult)) {
        return {
          delegated_mode: delegatedMode,
          status: "needs_user",
          summary: "Write task needs a dirty-workspace decision before it can be delegated.",
          result: implementResult as unknown as Record<string, unknown>,
          wait: buildWaitMetadata({
            timeoutSec: input.wait_timeout_sec ?? 540,
            completedInline: false,
            waiting: false,
            doNotStartDuplicateJob: false,
          }),
          warnings,
          next_actions: [],
        } satisfies ClaudeTaskResult;
      }
      queued = implementResult;
    }

    if (!("job" in queued)) {
      return {
        delegated_mode: delegatedMode,
        status: "failed",
        summary: "Failed to create background job.",
        wait: buildWaitMetadata({
          timeoutSec: input.wait_timeout_sec ?? 540,
          completedInline: false,
          waiting: false,
          doNotStartDuplicateJob: false,
        }),
        warnings,
        next_actions: [],
      } satisfies ClaudeTaskResult;
    }

    if (isBackground) {
      return {
        delegated_mode: delegatedMode,
        status: "running",
        summary: queued.message ?? summarizeTaskDispatch(delegatedMode, true),
        job: queued.job,
        deduped: queued.deduped,
        completed_inline: false,
        do_not_start_duplicate_job: queued.do_not_start_duplicate_job ?? (queued.deduped ? true : undefined),
        wait: buildWaitMetadata({
          mode: "background",
          timeoutSec: input.wait_timeout_sec ?? 540,
          completedInline: false,
          waiting: false,
          doNotStartDuplicateJob: queued.do_not_start_duplicate_job ?? queued.deduped === true,
        }),
        warnings,
        next_actions: [
          {
            tool: "claude_task",
            reason: "Continue waiting for this existing job when you want the result.",
            args: { cwd: input.cwd, job_id: queued.job.job_id, wait_strategy: "block", wait_timeout_sec: 540 },
          },
        ],
      } satisfies ClaudeTaskResult;
    }

    // Default block mode: wait inline
    const jobStore = await getJobStore();
    const waitTimeoutMs = (input.wait_timeout_sec ?? 540) * 1000;
    const inlineResult = await waitForJobCompletionInline(jobStore, queued.job.job_id, input.cwd, waitTimeoutMs);

    if (inlineResult.status === "not_found") {
      return {
        delegated_mode: delegatedMode,
        status: "failed",
        summary: `Job ${queued.job.job_id} not found during inline wait.`,
        job: queued.job,
        deduped: queued.deduped,
        wait: buildWaitMetadata({
          timeoutSec: input.wait_timeout_sec ?? 540,
          completedInline: false,
          waiting: false,
          doNotStartDuplicateJob: true,
        }),
        warnings,
        next_actions: [],
      } satisfies ClaudeTaskResult;
    }

    if (inlineResult.status === "completed" && inlineResult.jobRecord) {
      return buildClaudeTaskInlineResult({
        cwd: input.cwd,
        job: inlineResult.job!,
        jobRecord: inlineResult.jobRecord,
        delegatedMode,
        completedInline: true,
      });
    }

    if (inlineResult.status === "stale") {
      const staleRecord = await jobStore.get(queued.job.job_id);
      if (!staleRecord) {
        return {
          delegated_mode: delegatedMode,
          status: "failed",
          summary: `Job ${queued.job.job_id} disappeared during inline wait.`,
          wait: buildWaitMetadata({
            timeoutSec: input.wait_timeout_sec ?? 540,
            completedInline: false,
            waiting: false,
            doNotStartDuplicateJob: true,
          }),
          warnings,
          next_actions: [],
        } satisfies ClaudeTaskResult;
      }
      return buildClaudeTaskInlineResult({
        cwd: input.cwd,
        job: inlineResult.job!,
        jobRecord: staleRecord,
        delegatedMode,
        completedInline: false,
        staled: true,
      });
    }

    const stillRunning = await jobStore.get(queued.job.job_id);
    return {
      delegated_mode: delegatedMode,
      status: "running",
      summary: `Job ${queued.job.job_id} is still running.`,
      job: stillRunning ? toJobSummary(stillRunning) : queued.job,
      deduped: queued.deduped,
      completed_inline: false,
      waiting: true,
      do_not_start_duplicate_job: true,
      wait: buildWaitMetadata({
        timeoutSec: input.wait_timeout_sec ?? 540,
        completedInline: false,
        waiting: true,
        timedOut: true,
        doNotStartDuplicateJob: true,
      }),
      warnings,
      next_actions: [
        {
          tool: "claude_task",
          reason: "Claude is still working. Continue waiting for the same job_id instead of starting a duplicate task.",
          args: { cwd: input.cwd, job_id: queued.job.job_id, wait_strategy: "block", wait_timeout_sec: 540 },
        },
      ],
    } satisfies ClaudeTaskResult;
  }

  return enqueueAndWait();
}

function delegatedModeForJobType(type: BackgroundJobType): Exclude<ClaudeTaskMode, "auto"> {
  switch (type) {
    case "query": return "read";
    case "review": return "review";
    case "implement": return "write";
    default: return "read";
  }
}

export async function enqueueBackgroundJob(input: {
  cwd: string;
  type: BackgroundJobType;
  payload: Record<string, unknown>;
  dedupe?: boolean;
}): Promise<BackgroundJobEnqueueResult> {
  return enqueueBackgroundJobCore(input);
}

export async function startBackgroundReview(input: ClaudeReviewInput): Promise<BackgroundJobEnqueueResult> {
  const queued = await startBackgroundReviewCore(input);
  await markReviewGatePending(input.cwd, false, "review").catch(() => {});
  return queued;
}

export async function startBackgroundQuery(input: ClaudeQueryInput): Promise<BackgroundJobEnqueueResult> {
  return startBackgroundQueryCore(input);
}

export async function startBackgroundImplement(input: ClaudeImplementInput): Promise<BackgroundJobEnqueueResult | ClaudeResult> {
  if ((input.dirty_policy ?? "ask") === "ask") {
    const { requestedFiles, dirtyFiles } = await preflightImplementDirtyState(input);
    if (dirtyFiles.length > 0) {
      return dirtyNeedsUserResult(input, dirtyFiles, requestedFiles);
    }
  }
  const queued = await startBackgroundImplementCore(input);
  await markReviewGatePending(input.cwd, true, "write").catch(() => {});
  return queued;
}

export async function startBackgroundApply(input: ClaudeApplyInput): Promise<BackgroundJobEnqueueResult> {
  const queued = await startBackgroundApplyCore(input);
  await markReviewGatePending(input.cwd, true, "write").catch(() => {});
  return queued;
}

export async function startBackgroundCleanup(input: ClaudeCleanupInput): Promise<BackgroundJobEnqueueResult> {
  return startBackgroundCleanupCore(input);
}

export async function listBackgroundJobs(input: ClaudeJobsInput): Promise<ClaudeJobsResult> {
  return listBackgroundJobsCore(input);
}

export async function getBackgroundJobResult(
  input: ClaudeJobResultInput
): Promise<{ job: BackgroundJobSummary; result?: Record<string, unknown> } | null> {
  return getBackgroundJobResultCore(input);
}

export async function waitForBackgroundJob(
  input: ClaudeJobWaitInput
): Promise<ClaudeJobWaitResult> {
  return waitForBackgroundJobCore(input);
}

export async function cancelBackgroundJob(
  input: ClaudeJobCancelInput
): Promise<{ cancelled: boolean; job?: BackgroundJobSummary; error?: string }> {
  return cancelBackgroundJobCore(input);
}

export async function cleanupBackgroundJobs(
  input: ClaudeJobCleanupInput
): Promise<ClaudeJobCleanupResult> {
  return cleanupBackgroundJobsCore(input);
}

export interface DelegateArtifactCleanupInput {
  cwd: string;
  older_than_hours: number;
  dry_run: boolean;
  limit: number;
}

export interface DelegateArtifactCleanupResult {
  jobs: ClaudeJobCleanupResult;
  run_logs: {
    dry_run: boolean;
    matched_count: number;
    removed_count: number;
    failed_count: number;
    entries: Array<{
      run_id: string;
      removed: boolean;
      updated_at?: string;
      error?: string;
    }>;
  };
}

export async function cleanupDelegateArtifacts(
  input: DelegateArtifactCleanupInput
): Promise<DelegateArtifactCleanupResult> {
  const jobStore = await getJobStore();
  const jobs = await jobStore.cleanup({
    cwd: input.cwd,
    older_than_hours: input.older_than_hours,
    dry_run: input.dry_run,
    limit: input.limit,
  });
  const activeRunIds = new Set(
    (await jobStore.list({ cwd: input.cwd, limit: 1000 }))
      .filter((job) => job.status === "queued" || job.status === "running")
      .map((job) => job.run_id)
      .filter((runId): runId is string => typeof runId === "string" && runId.length > 0)
  );
  const cutoff = Date.now() - input.older_than_hours * 60 * 60 * 1000;
  const logDir = getRunLogDir(input.cwd);
  const names = await readdir(logDir).catch(() => []);
  const candidates = (await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const file = path.join(logDir, name);
        try {
          const st = await stat(file);
          const runId = name.replace(/\.json$/, "");
          if (st.mtimeMs > cutoff || activeRunIds.has(runId)) return null;
          return { run_id: runId, file, updated_at: st.mtime.toISOString(), mtimeMs: st.mtimeMs };
        } catch {
          return null;
        }
      })
  ))
    .filter((entry): entry is { run_id: string; file: string; updated_at: string; mtimeMs: number } => entry !== null)
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .slice(0, input.limit);

  const entries: DelegateArtifactCleanupResult["run_logs"]["entries"] = [];
  let removedCount = 0;
  let failedCount = 0;
  for (const candidate of candidates) {
    if (input.dry_run) {
      entries.push({ run_id: candidate.run_id, removed: false, updated_at: candidate.updated_at });
      continue;
    }
    try {
      await unlink(candidate.file);
      removedCount += 1;
      entries.push({ run_id: candidate.run_id, removed: true, updated_at: candidate.updated_at });
    } catch (err) {
      failedCount += 1;
      entries.push({
        run_id: candidate.run_id,
        removed: false,
        updated_at: candidate.updated_at,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    jobs,
    run_logs: {
      dry_run: input.dry_run,
      matched_count: candidates.length,
      removed_count: removedCount,
      failed_count: failedCount,
      entries,
    },
  };
}

export async function resolveLatestImplementSession(input: { cwd: string }): Promise<{ run_id: string; session_id: string } | null> {
  const runs = await listRunLogs({ cwd: input.cwd, type: "implement", limit: 50 });
  for (const run of runs.entries) {
    const raw = await readRunLogFile(run.run_id, input.cwd);
    const sessionId =
      raw && typeof raw.session?.returned_session_id === "string"
        ? raw.session.returned_session_id
        : null;
    if (sessionId) {
      return { run_id: run.run_id, session_id: sessionId };
    }
  }
  return null;
}

async function ensureImplementWorkspaceScaffold(worktreePath: string): Promise<void> {
  await Promise.all([
    mkdir(path.join(worktreePath, "src"), { recursive: true }),
    mkdir(path.join(worktreePath, "tests"), { recursive: true }),
    mkdir(path.join(worktreePath, ".github", "workflows"), { recursive: true }),
  ]);
}

async function findDirtyFiles(cwd: string, requestedFiles: string[]): Promise<string[]> {
  if (requestedFiles.length === 0) return [];
  const output = await execCapture("git", ["status", "--porcelain=v1", "-z", "--", ...requestedFiles], { cwd }).catch(() => "");
  const dirty = new Set<string>();
  for (const entry of parseStatusPorcelainZ(output)) {
    if (entry.file) dirty.add(entry.file);
  }
  return [...dirty].sort();
}

function isIgnoredMainWorkspaceDirtyFile(file: string): boolean {
  return file === ".claude" ||
    file.startsWith(".claude/") ||
    file === ".codex-claude-delegate" ||
    file.startsWith(".codex-claude-delegate/");
}

async function findDirtyMainWorkspaceFiles(cwd: string): Promise<string[]> {
  const output = await execCapture("git", ["status", "--porcelain=v1", "-z"], { cwd }).catch(() => "");
  const dirty = new Set<string>();
  for (const entry of parseStatusPorcelainZ(output)) {
    const file = normalizeRepoPath(cwd, entry.file);
    if (!file || isIgnoredMainWorkspaceDirtyFile(file)) continue;
    dirty.add(file);
  }
  return [...dirty].sort();
}

async function listDirtyMainWorkspaceEntries(cwd: string): Promise<Array<{ status: string; file: string }>> {
  const output = await execCapture("git", ["status", "--porcelain=v1", "-z"], { cwd }).catch(() => "");
  return parseStatusPorcelainZ(output)
    .map((entry) => ({ ...entry, file: normalizeRepoPath(cwd, entry.file) }))
    .filter((entry) => entry.file && !isIgnoredMainWorkspaceDirtyFile(entry.file))
    .sort((a, b) => a.file.localeCompare(b.file));
}

async function findDirtyImplementFiles(cwd: string, requestedFiles: string[]): Promise<string[]> {
  return requestedFiles.length > 0
    ? findDirtyFiles(cwd, requestedFiles)
    : findDirtyMainWorkspaceFiles(cwd);
}

function formatDirtyImplementMessage(dirtyFiles: string[], requestedFiles: string[]): string {
  return requestedFiles.length > 0
    ? `Requested files contain uncommitted changes in main workspace: ${dirtyFiles.join(", ")}. Choose dirty_policy=\"snapshot\" to include current uncommitted changes, dirty_policy=\"committed\" to use HEAD only, or commit/stash/clean them before retrying.`
    : `Main workspace contains uncommitted changes: ${dirtyFiles.join(", ")}. Choose dirty_policy=\"snapshot\" to include current uncommitted changes, dirty_policy=\"committed\" to use HEAD only, or commit/stash/clean them before retrying.`;
}

function dirtyNeedsUserResult(input: ClaudeImplementInput, dirtyFiles: string[], requestedFiles: string[], startTime = Date.now()): ClaudeResult {
  const summary = requestedFiles.length > 0
    ? `Requested files have uncommitted changes: ${dirtyFiles.join(", ")}.`
    : `Main workspace has uncommitted changes: ${dirtyFiles.join(", ")}.`;
  const report = {
    status: "needs_user",
    summary,
    changed_files: dirtyFiles,
    commands_run: ["git status --porcelain=v1 -z"],
    tests: { ran: false },
    risks: [
      "A delegated worktree created from HEAD will not include uncommitted main-workspace changes unless dirty_policy=\"snapshot\" is used.",
    ],
    next_steps: [
      "Commit or stash the current main-workspace changes, then rerun claude_task without dirty_policy.",
      "Use committed state only and intentionally ignore current uncommitted changes: dirty_policy=committed.",
      "Snapshot current uncommitted changes into the delegated worktree before Claude starts: dirty_policy=snapshot.",
    ],
  };
  return makeEnvelope("needs_user", undefined, successExecution(Date.now() - startTime), [], {
    claude_report: report,
    server_observed: {
      repo_root: input.cwd,
      changed_files: dirtyFiles,
      diff_stat: "",
      diff_name_only: dirtyFiles.map((file) => `dirty\t${file}`).join("\n"),
      scope: {
        requested_files: requestedFiles.length > 0 ? requestedFiles : undefined,
        out_of_scope_files: [],
        scope_exceeded: false,
        warnings: [],
      },
    },
  });
}

async function preflightImplementDirtyState(input: ClaudeImplementInput): Promise<{ requestedFiles: string[]; dirtyFiles: string[] }> {
  const requestedFiles = normalizeRequestedFiles(input.cwd, input.files);
  const dirtyFiles = await findDirtyImplementFiles(input.cwd, requestedFiles);
  return { requestedFiles, dirtyFiles };
}

async function applyDirtySnapshotToWorktree(cwd: string, worktreePath: string): Promise<string[]> {
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

async function expandDirectoryChange(
  change: { status: string; file: string },
  worktreeRoot: string
): Promise<Array<{ status: string; file: string }>> {
  if (change.status === "D") return [change];
  const sourcePath = path.join(worktreeRoot, change.file);
  let sourceStat;
  try {
    sourceStat = await stat(sourcePath);
  } catch {
    return [change];
  }
  if (!sourceStat.isDirectory()) return [change];

  const expanded: Array<{ status: string; file: string }> = [];
  const walk = async (relativeDir: string): Promise<void> => {
    const dirPath = path.join(worktreeRoot, relativeDir);
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const childRelative = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        await walk(childRelative);
      } else if (entry.isFile()) {
        expanded.push({
          status: change.status,
          file: normalizeRepoPath(worktreeRoot, childRelative),
        });
      }
    }
  };

  await walk(change.file);
  return expanded.sort((a, b) => a.file.localeCompare(b.file));
}

// ---- Spawn Claude with structured output ----



export const DANGEROUS_DISALLOWED_TOOLS = [
  "Bash(rm *)",
  "Bash(rm -rf *)",
  "Bash(rm -r *)",
  "Bash(sudo *)",
  "Bash(curl *)",
  "Bash(wget *)",
  "Bash(chmod *)",
  "Bash(chown *)",
  "Bash(git push *)",
  "Bash(ssh *)",
  "Bash(scp *)",
  "Bash(nc *)",
  "Bash(netcat *)",
];

export function buildQueryArgs(input: ClaudeQueryInput): string[] {
  return buildClaudeArgs(createQueryOptions(input));
}

export function buildReviewArgs(input: ClaudeReviewInput): string[] {
  return buildClaudeArgs(createReviewOptions(input));
}

export function buildImplementArgs(input: ClaudeImplementInput): string[] {
  return buildClaudeArgs(createImplementOptions(input));
}





// ---- Server-side observation ----

async function observeResult(
  cwd: string,
  worktree?: string,
  baseCommit?: string,
  requestedFiles?: string[]
): Promise<ServerObserved> {
  const obsCwd = worktree ? path.join(cwd, ".claude", "worktrees", worktree) : cwd;
  const warnings: string[] = [];
  const gitStatusShort = await execCapture("git", ["status", "--short"], { cwd: obsCwd }).catch((err) => {
    warnings.push(`Unable to read git status: ${err instanceof Error ? err.message : String(err)}`);
    return "";
  });
  const headCommit = await execCapture("git", ["rev-parse", "HEAD"], { cwd: obsCwd }).catch((err) => {
    warnings.push(`Unable to read HEAD commit: ${err instanceof Error ? err.message : String(err)}`);
    return "";
  });

  try {
    const trackedCommittedNameOnly = baseCommit
      ? await execCapture("git", ["diff", "--name-only", baseCommit, "HEAD"], { cwd: obsCwd }).catch(() => "")
      : "";
    const trackedCommittedStat = baseCommit
      ? await execCapture("git", ["diff", "--stat", baseCommit, "HEAD"], { cwd: obsCwd }).catch(() => "")
      : "";

    const [trackedUncommittedNameOnly, untrackedStatusPorcelainZ] = await Promise.all([
      execCapture("git", ["diff", "--name-only"], { cwd: obsCwd }).catch(() => ""),
      execCapture("git", ["status", "--porcelain=v1", "-z"], { cwd: obsCwd }).catch(() => ""),
    ]);

    const fileSet = new Set<string>();
    for (const source of [trackedCommittedNameOnly, trackedUncommittedNameOnly]) {
      for (const line of source.split("\n")) {
        const file = line.trim();
        if (file) fileSet.add(file);
      }
    }
    for (const entry of parseStatusPorcelainZ(untrackedStatusPorcelainZ)) {
      if (entry.file) fileSet.add(entry.file);
    }

    const changedFiles = [...fileSet].sort();
    const normalizedRequestedFiles = normalizeRequestedFiles(cwd, requestedFiles);
    const outOfScopeFiles = normalizedRequestedFiles.length === 0
      ? []
      : changedFiles.filter((file) => !normalizedRequestedFiles.some((requested) => isUnderRequestedFile(file, requested)));
    const scopeWarnings = outOfScopeFiles.map((file) =>
      `Changed ${file} outside requested files: ${normalizedRequestedFiles.join(", ")}`
    );

    const diffNameOnlySegments: string[] = [];
    if (trackedCommittedNameOnly.trim()) {
      diffNameOnlySegments.push(`[tracked_since_base ${baseCommit ?? "unknown"}..HEAD]\n${trackedCommittedNameOnly.trimEnd()}`);
    }
    if (trackedUncommittedNameOnly.trim()) {
      diffNameOnlySegments.push(`[uncommitted_tracked]\n${trackedUncommittedNameOnly.trimEnd()}`);
    }
    if (untrackedStatusPorcelainZ.trim()) {
      const untrackedLines = parseStatusPorcelainZ(untrackedStatusPorcelainZ)
        .map((entry) => `${entry.status}\t${entry.file}`)
        .join("\n");
      if (untrackedLines) {
        diffNameOnlySegments.push(`[status_porcelain_z]\n${untrackedLines}`);
      }
    }

    const diffStatSegments: string[] = [];
    if (trackedCommittedStat.trim()) {
      diffStatSegments.push(`[tracked_since_base ${baseCommit ?? "unknown"}..HEAD]\n${trackedCommittedStat.trimEnd()}`);
    }
    const fallbackStat = changedFiles.length > 0
      ? changedFiles.map((file) => `*\t${file}`).join("\n")
      : "(no changes)";
    const diffStat = diffStatSegments.join("\n\n") || fallbackStat;
    const diffNameOnly = diffNameOnlySegments.join("\n\n") || "(no changes)";

    return {
      repo_root: cwd,
      worktree_name: worktree,
      changed_files: changedFiles,
      diff_stat: diffStat,
      diff_name_only: diffNameOnly,
      base_commit: baseCommit,
      head_commit: headCommit.trim() || undefined,
      git_status_short: gitStatusShort,
      worktree_path: worktree ? `.claude/worktrees/${worktree}` : undefined,
      scope: {
        requested_files: normalizedRequestedFiles.length > 0 ? normalizedRequestedFiles : undefined,
        out_of_scope_files: outOfScopeFiles,
        scope_exceeded: outOfScopeFiles.length > 0,
        warnings: [...warnings, ...scopeWarnings],
      },
    };
  } catch {
    const normalizedRequestedFiles = normalizeRequestedFiles(cwd, requestedFiles);
    return {
      repo_root: cwd,
      worktree_name: worktree,
      changed_files: [],
      diff_stat: "(unable to observe)",
      diff_name_only: "(unable to observe)",
      base_commit: baseCommit,
      head_commit: headCommit.trim() || undefined,
      git_status_short: gitStatusShort,
      worktree_path: worktree ? `.claude/worktrees/${worktree}` : undefined,
      scope: {
        requested_files: normalizedRequestedFiles.length > 0 ? normalizedRequestedFiles : undefined,
        out_of_scope_files: [],
        scope_exceeded: false,
        warnings,
      },
    };
  }
}

// ---- Check git status in worktree ----

async function getWorktreeStatus(cwd: string, worktree: string): Promise<string> {
  const worktreePath = path.join(cwd, ".claude", "worktrees", worktree);
  try {
    return await execCapture("git", ["status", "--short"], { cwd: worktreePath });
  } catch {
    return "(unable to get worktree status)";
  }
}

// ---- Public API ----

function readOnlyDisallowedTools(): string[] {
  return DANGEROUS_DISALLOWED_TOOLS;
}

function createQueryOptions(input: ClaudeQueryInput): ClaudeRunOptions {
  const effectiveMaxTurns = input.max_turns ?? (input.fast ? 2 : undefined);
  const effectiveTimeoutSec = input.timeout_sec ?? (input.fast ? 45 : 120);
  return {
    prompt: buildQueryPrompt(input),
    cwd: input.cwd,
    tools: "Read,Glob,Grep,Bash",
    allowedTools: [
      "Read",
      "Glob",
      "Grep",
      "Bash(git diff *)",
      "Bash(git log *)",
      "Bash(git status)",
      "Bash(git show *)",
      "Bash(find *)",
      "Bash(rg *)",
      "Bash(wc *)",
      "Bash(ls *)",
      "Bash(head *)",
      "Bash(tail *)",
      "Bash(cat *)",
    ],
    disallowedTools: readOnlyDisallowedTools(),
    maxTurns: effectiveMaxTurns,
    timeoutSec: effectiveTimeoutSec,
    jsonSchema: QUERY_SCHEMA,
  };
}

function createReviewOptions(input: ClaudeReviewInput): ClaudeRunOptions {
  return {
    prompt: buildReviewPrompt(input),
    cwd: input.cwd,
    tools: "Read,Glob,Grep,Bash",
    allowedTools: [
      "Read",
      "Glob",
      "Grep",
      "Bash(git diff *)",
      "Bash(git log *)",
      "Bash(git status)",
      "Bash(git show *)",
      "Bash(git blame *)",
    ],
    disallowedTools: readOnlyDisallowedTools(),
    maxTurns: input.max_turns,
    timeoutSec: input.timeout_sec ?? 180,
    jsonSchema: REVIEW_SCHEMA,
    noSessionPersistence: true,
  };
}

function createImplementOptions(
  input: ClaudeImplementInput,
  resumeSessionId?: string,
  forked?: boolean
): ClaudeRunOptions {
  return {
    prompt: buildImplementPrompt(input),
    cwd: input.cwd,
    tools: "Read,Glob,Grep,Edit,Write,Bash",
    allowedTools: implementAllowedTools(input.security_profile ?? "default"),
    disallowedTools: [
      ...DANGEROUS_DISALLOWED_TOOLS,
      "Bash(git push --force *)",
      "Bash(git branch -D *)",
      "Bash(git reset --hard *)",
      "Bash(git clean *)",
      "Bash(shutdown *)",
      "Bash(reboot *)",
      "Bash(docker *)",
      "Bash(kubectl *)",
      "Bash(brew *)",
      "Bash(npm install *)",
      "Bash(npm uninstall *)",
      "Bash(npm publish *)",
      "Bash(pip install *)",
      "Bash(pip uninstall *)",
      "Bash(yarn add *)",
      "Bash(yarn remove *)",
      "Bash(pnpm add *)",
      "Bash(pnpm remove *)",
    ],
    maxTurns: input.max_turns,
    timeoutSec: input.timeout_sec ?? 600,
    jsonSchema: IMPLEMENT_SCHEMA,
    resumeSessionId,
    forkSession: forked,
    maxBudgetUsd: input.max_cost_usd,
  };
}

function implementAllowedTools(profile: SecurityProfile): string[] {
  const strictTools = [
    "Read",
    "Glob",
    "Grep",
    "Edit",
    "Write",
    "Bash(git status)",
    "Bash(git diff *)",
    "Bash(git add *)",
    "Bash(git log *)",
    "Bash(git show *)",
    "Bash(npm test *)",
    "Bash(npm run test *)",
    "Bash(npm run lint *)",
    "Bash(pytest *)",
    "Bash(go test *)",
    "Bash(cargo test *)",
    "Bash(yarn test *)",
    "Bash(pnpm test *)",
    "Bash(pnpm run lint *)",
    "Bash(ls *)",
    "Bash(cat *)",
    "Bash(wc *)",
    "Bash(find *)",
    "Bash(head *)",
    "Bash(tail *)",
    "Bash(sort *)",
    "Bash(uniq *)",
    "Bash(grep *)",
    "Bash(rg *)",
    "Bash(which *)",
    "Bash(echo *)",
    "Bash(date *)",
  ];
  const defaultTools = [
    ...strictTools,
    "Bash(mkdir *)",
    "Bash(mkdir -p *)",
    "Bash(cp *)",
    "Bash(mv *)",
    "Bash(node *)",
    "Bash(python *)",
    "Bash(python3 *)",
    "Bash(tsc *)",
    "Bash(eslint *)",
  ];
  if (profile === "strict") return strictTools;
  if (profile === "permissive") return [...defaultTools, "Bash(npx *)"];
  return defaultTools;
}

export async function checkClaudeStatus(cwd: string): Promise<ClaudeStatusResult> {
  const result: ClaudeStatusResult = {
    claude_available: false,
    claude_version: null,
    auth_status: null,
    git_available: false,
    worktree_capable: false,
    cwd_valid: false,
    cwd_is_git_repo: false,
    delegated_worktrees_count: 0,
    delegated_worktrees: [],
    stale_worktrees_count: 0,
    errors: [],
  };

  const [claudeVersionResult, gitVersionResult, gitRepoResult] = await Promise.all([
    execCapture(CLAUDE_BIN, ["--version"], { cwd }).then((version) => ({ ok: true as const, version })).catch(() => ({ ok: false as const })),
    execCapture("git", ["--version"], { cwd }).then(() => ({ ok: true as const })).catch(() => ({ ok: false as const })),
    execCapture("git", ["rev-parse", "--git-dir"], { cwd }).then(() => ({ ok: true as const })).catch(() => ({ ok: false as const })),
  ]);

  if (claudeVersionResult.ok) {
    result.claude_available = true;
    result.claude_version = claudeVersionResult.version;
  } else {
    result.errors.push("claude CLI not found in PATH");
  }

  if (gitVersionResult.ok) {
    result.git_available = true;
  } else {
    result.errors.push("git not found in PATH");
  }

  result.cwd_is_git_repo = gitRepoResult.ok;

  const [authResult, worktreeResult] = await Promise.all([
    result.claude_available
      ? execCapture(CLAUDE_BIN, ["auth", "status"], { cwd })
        .then((authOutput) => ({ ok: true as const, authOutput }))
        .catch(() => ({ ok: false as const }))
      : Promise.resolve({ ok: false as const }),
    result.git_available
      ? execCapture("git", ["worktree", "list"], { cwd })
        .then((wl) => ({ ok: true as const, wl }))
        .catch(() => ({ ok: false as const }))
      : Promise.resolve({ ok: false as const }),
  ]);

  if (result.claude_available) {
    if (authResult.ok) {
      try {
        const authJson = JSON.parse(authResult.authOutput);
        result.auth_status = authJson.loggedIn === true ? "authenticated" : "not authenticated";
      } catch {
        result.auth_status = authResult.authOutput.includes("Logged in") || authResult.authOutput.includes("loggedIn") ? "authenticated" : "unknown";
      }
    } else {
      result.auth_status = "unauthenticated or unknown";
      result.errors.push("claude auth status could not be verified");
    }
  }

  if (result.git_available) {
    if (worktreeResult.ok) {
      result.worktree_capable = worktreeResult.wl.length >= 0;
    } else {
      result.errors.push("git worktree not supported in this repo");
    }
  }

  result.cwd_valid = result.git_available && result.cwd_is_git_repo;

  // Scan for delegated worktrees
  const worktreeDir = path.join(cwd, ".claude", "worktrees");
  try {
    const { readdirSync, statSync } = await import("node:fs");
    if (existsSync(worktreeDir)) {
      const entries = readdirSync(worktreeDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      result.delegated_worktrees = entries.filter((n) => n.startsWith("codex-delegated-")).sort();
      result.delegated_worktrees_count = result.delegated_worktrees.length;
      // Count worktrees older than 24h as stale
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      result.stale_worktrees_count = result.delegated_worktrees.filter((n) => {
        try {
          return statSync(path.join(worktreeDir, n)).mtimeMs < cutoff;
        } catch { return false; }
      }).length;
    }
  } catch {
    // best-effort worktree scan
  }

  // Environment diagnostics (best-effort)
  try {
    result.environment_diagnostics = await getEnvironmentDiagnostics();
  } catch {
    // best-effort only
  }

  return result;
}

export async function runClaudeQuery(
  input: ClaudeQueryInput,
  runId: string
): Promise<ToolEnvelope<Record<string, unknown>>> {
  const queryStart = Date.now();
  const store = await getStore(input.cwd);
  const repoKey = await computeRepoKey(input.cwd);
  const sessionLookupStart = Date.now();

  // Auto-resume: find recent query session for the same repo
  const shouldResume = input.resume ?? !input.fast;
  const recent = shouldResume ? store.getRecent(repoKey, "query", RECENT_WINDOW_MINUTES) : null;
  const requestedSessionId = shouldResume ? (recent?.session_id ?? null) : null;
  const sessionLookupMs = Date.now() - sessionLookupStart;
  let resumed = false;
  let forked = false;

  const opts: ClaudeRunOptions = {
    ...createQueryOptions(input),
    resumeSessionId: requestedSessionId ?? undefined,
  };

  let returnedSessionId: string | null = null;

  try {
    const claudeRunStart = Date.now();
    const { report, session_id, execution } = await spawnClaude(opts);
    const claudeRunMs = Date.now() - claudeRunStart;
    returnedSessionId = session_id;
    resumed = !!requestedSessionId;

    // Persist session
    if (session_id) {
      store.upsert(session_id, "query", repoKey, input.cwd, String((report.answer as string) ?? "").slice(0, 200));
    }

    const sessionLog: SessionLog = { requested_session_id: requestedSessionId, resumed, forked, returned_session_id: session_id };
    const logWriteStart = Date.now();
    await logRun(runId, { type: "query", input, report, session: sessionLog }, input.cwd);
    const logWriteMs = Date.now() - logWriteStart;
    const pruneStart = Date.now();
    store.prune();
    const pruneMs = Date.now() - pruneStart;
    return makeEnvelope(
      "success",
      report,
      {
        ...execution,
        timings: {
          session_lookup_ms: sessionLookupMs,
          claude_run_ms: claudeRunMs,
          log_write_ms: logWriteMs,
          store_prune_ms: pruneMs,
          total_ms: Date.now() - queryStart,
        },
      },
      [],
      { claude_report: report }
    );
  } catch (err) {
    const errorMsg = (err as Error).message;

    // If resume failed (session not found / expired), mark expired and retry without resume
    if (requestedSessionId && isSessionNotFoundError(errorMsg)) {
      store.markExpired(requestedSessionId);
      log(`Session ${requestedSessionId} not found, falling back to new session`);

      // Retry without resume
      const retryOpts: ClaudeRunOptions = { ...opts, resumeSessionId: undefined };
      try {
        const claudeRunStart = Date.now();
        const { report, session_id, execution } = await spawnClaude(retryOpts);
        const claudeRunMs = Date.now() - claudeRunStart;
        returnedSessionId = session_id;
        if (session_id) {
          store.upsert(session_id, "query", repoKey, input.cwd, String((report.answer as string) ?? "").slice(0, 200));
        }
        const sessionLog: SessionLog = { requested_session_id: requestedSessionId, resumed: false, forked: false, returned_session_id: session_id };
        const logWriteStart = Date.now();
        await logRun(runId, { type: "query", input, report, session: sessionLog, retried_after_session_expired: true }, input.cwd);
        const logWriteMs = Date.now() - logWriteStart;
        return makeEnvelope(
          "success",
          report,
          {
            ...execution,
            timings: {
              session_lookup_ms: sessionLookupMs,
              claude_run_ms: claudeRunMs,
              log_write_ms: logWriteMs,
              retried_after_session_expired: 1,
              total_ms: Date.now() - queryStart,
            },
          },
          [],
          { claude_report: report }
        );
      } catch (retryErr) {
        await logRun(runId, { type: "query", input, error: (retryErr as Error).message, retried_after_session_expired: true }, input.cwd);
        throw retryErr;
      }
    }

    await logRun(runId, { type: "query", input, error: errorMsg }, input.cwd);
    throw err;
  }
}

// ---- Session failure detection ----

function isSessionNotFoundError(msg: string): boolean {
  const patterns = ["session not found", "no conversation found", "not found", "session.*expired", "invalid session"];
  return patterns.some((p) => new RegExp(p, "i").test(msg));
}

export async function executeBackgroundJob(jobId: string): Promise<void> {
  const jobStore = await getJobStore();
  const job = await jobStore.get(jobId);
  if (!job) {
    throw new Error(`Background job not found: ${jobId}`);
  }
  if (job.status === "cancelled") {
    return;
  }

  const runningAt = new Date().toISOString();
  const running = await jobStore.update(jobId, {
    status: "running",
    updated_at: runningAt,
    heartbeat_at: runningAt,
  });
  if (!running || running.status === "cancelled") {
    return;
  }

  const runId = randomUUID();
  const stopHeartbeat = startJobHeartbeat(jobStore, jobId);

  try {
    const parsePayloadOrThrow = (): ClaudeQueryInput | ClaudeReviewInput | ClaudeImplementInput | ClaudeApplyInput | ClaudeCleanupInput => {
      if (running.type === "query") {
        const parsed = claudeQueryInputSchema.safeParse(running.payload);
        if (!parsed.success) throw new Error(`Background payload schema validation failed for query: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
        return parsed.data;
      }
      if (running.type === "review") {
        const parsed = claudeReviewInputSchema.safeParse(running.payload);
        if (!parsed.success) throw new Error(`Background payload schema validation failed for review: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
        return parsed.data;
      }
      if (running.type === "implement") {
        const parsed = claudeImplementInputSchema.safeParse(running.payload);
        if (!parsed.success) throw new Error(`Background payload schema validation failed for implement: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
        return parsed.data;
      }
      if (running.type === "apply") {
        const parsed = claudeApplyInputSchema.safeParse(running.payload);
        if (!parsed.success) throw new Error(`Background payload schema validation failed for apply: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
        return parsed.data;
      }
      const parsed = claudeCleanupInputSchema.safeParse(running.payload);
      if (!parsed.success) throw new Error(`Background payload schema validation failed for cleanup: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
      return parsed.data;
    };

    const payload = parsePayloadOrThrow();
    let result: Record<string, unknown>;
    if (running.type === "query") {
      result = await runClaudeQuery(payload as ClaudeQueryInput, runId) as unknown as Record<string, unknown>;
    } else if (running.type === "review") {
      result = await runClaudeReview(payload as ClaudeReviewInput, runId) as unknown as Record<string, unknown>;
    } else if (running.type === "implement") {
      result = await runClaudeImplement(payload as ClaudeImplementInput, runId) as unknown as Record<string, unknown>;
    } else if (running.type === "apply") {
      result = await runClaudeApply(payload as ClaudeApplyInput, runId) as unknown as Record<string, unknown>;
    } else {
      result = await runClaudeCleanup(payload as ClaudeCleanupInput, runId) as unknown as Record<string, unknown>;
    }

    await jobStore.update(jobId, {
      status: "succeeded",
      result_status: extractBackgroundResultStatus(result),
      updated_at: new Date().toISOString(),
      result,
      summary: summarizeBackgroundResult(running.type, result),
      run_id: runId,
      worktree_name: getBackgroundWorktreeName(running.type, running.payload, result),
      error: undefined,
    });
  } catch (err) {
    const current = await jobStore.get(jobId);
    if (current?.status === "cancelled") {
      return;
    }
    await jobStore.update(jobId, {
      status: "failed",
      updated_at: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
      summary: `Background ${running.type} job failed`,
    });
    throw err;
  } finally {
    stopHeartbeat();
  }
}

export async function runClaudeReview(
  input: ClaudeReviewInput,
  runId: string
): Promise<ToolEnvelope<Record<string, unknown>>> {
  const opts = createReviewOptions(input);

  try {
    const { report, execution } = await spawnClaude(opts);
    await logRun(runId, { type: "review", input, report }, input.cwd);
    await markReviewGatePending(input.cwd, false, "review").catch(() => {});
    return makeEnvelope("success", report, execution, [], { claude_report: report });
  } catch (err) {
    await logRun(runId, { type: "review", input, error: (err as Error).message }, input.cwd);
    throw err;
  }
}

export async function runClaudeImplement(
  input: ClaudeImplementInput,
  runId: string
): Promise<ClaudeResult> {
  const store = await getStore(input.cwd);
  const repoKey = await computeRepoKey(input.cwd);
  let implementInput = input;

  if (implementInput.resume_latest) {
    const latest = await resolveLatestImplementSession({ cwd: implementInput.cwd });
    if (!latest) {
      throw new Error("No resumable implement session found for this repository.");
    }
    implementInput = { ...implementInput, session_key: latest.session_id };
  }

  const worktreeName = implementInput.worktreeName ?? `codex-delegated-${runId.slice(0, 8)}`;
  const worktreeRelPath = path.join(".claude", "worktrees", worktreeName);
  const worktreePath = path.join(implementInput.cwd, worktreeRelPath);
  const requestedFiles = normalizeRequestedFiles(implementInput.cwd, implementInput.files);
  const dirtyPolicy = implementInput.dirty_policy ?? "ask";
  let baseCommit: string | undefined;

  const dirtyFiles = await findDirtyImplementFiles(implementInput.cwd, requestedFiles);
  if (dirtyPolicy === "ask" && dirtyFiles.length > 0) {
    const message = formatDirtyImplementMessage(dirtyFiles, requestedFiles);
    const result = dirtyNeedsUserResult(implementInput, dirtyFiles, requestedFiles);
    await logRun(runId, {
      type: "implement",
      input: implementInput,
      report: result.claude_report,
      observed: result.server_observed,
      execution: result.execution,
      requested_files: requestedFiles,
      dirty_requested_files: dirtyFiles,
      error: message,
      duration_ms: 0,
    }, implementInput.cwd);
    return result;
  }

  try {
    if (!existsSync(worktreePath)) {
      await mkdir(path.dirname(worktreePath), { recursive: true });
      await execCapture("git", ["worktree", "add", "--detach", worktreeRelPath, "HEAD"], {
        cwd: implementInput.cwd,
        timeoutMs: 30000,
      });
    }
    const resolvedBase = await execCapture("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
    baseCommit = resolvedBase.trim() || undefined;
    if (dirtyPolicy === "snapshot") {
      await applyDirtySnapshotToWorktree(implementInput.cwd, worktreePath);
    }
    await ensureImplementWorkspaceScaffold(worktreePath);
  } catch (err) {
    await logRun(runId, {
      type: "implement",
      input: implementInput,
      error: `Failed to prepare worktree/base commit: ${err instanceof Error ? err.message : String(err)}`,
      duration_ms: 0,
    }, implementInput.cwd);
      throw err;
  }

  const resumeSessionId = implementInput.session_key ?? undefined;
  const forked = implementInput.fork_session ?? false;

  const claudeInput: ClaudeImplementInput = {
    ...implementInput,
    cwd: worktreePath,
    files: requestedFiles.length > 0 ? requestedFiles : undefined,
  };
  const opts = createImplementOptions(claudeInput, resumeSessionId, forked);

  let report: Record<string, unknown>;
  let returnedSessionId: string | null = null;
  let execution: ExecutionMetadata;
  const startTime = Date.now();

  try {
    const result = await spawnClaude(opts);
    report = result.report;
    returnedSessionId = result.session_id;
    execution = result.execution;
  } catch (err) {
    const errorMsg = (err as Error).message;

    if (resumeSessionId && isSessionNotFoundError(errorMsg)) {
      store.markExpired(resumeSessionId);
      log(`Session ${resumeSessionId} not found, marked expired`);
      const durationMs = Date.now() - startTime;
      const failedExecution: ExecutionMetadata = {
        exit_code: 1,
        duration_ms: durationMs,
        timed_out: false,
        stdout_tail: "",
        stderr_tail: errorMsg.slice(-4000),
      };
      const warnings = [
        `Claude session ${resumeSessionId} is unavailable and was marked expired. Start a fresh claude_implement run instead of resume_latest.`,
      ];
      const failedReport = {
        status: "failed",
        summary: `Claude session ${resumeSessionId} is unavailable.`,
        changed_files: [],
        commands_run: [],
        tests: { ran: false },
        risks: ["The delegated worktree may still exist and should be inspected or cleaned up."],
        next_steps: [
          "Inspect the failed run with claude_run_inspect.",
          "Start a fresh claude_implement run if the task still needs to continue.",
          "Clean up the delegated worktree if it is not useful.",
        ],
      };
      const observed = await observeResult(implementInput.cwd, worktreeName, baseCommit, requestedFiles).catch(() => undefined);
      const sessionLog: SessionLog = {
        requested_session_id: resumeSessionId,
        resumed: true,
        forked,
        returned_session_id: null,
      };
      await logRun(runId, {
        type: "implement",
        input: implementInput,
        report: failedReport,
        observed,
        execution: failedExecution,
        session: sessionLog,
        error: errorMsg,
        duration_ms: durationMs,
      }, implementInput.cwd);
      return makeEnvelope("failed", undefined, failedExecution, warnings, {
        claude_report: failedReport,
        server_observed: observed,
      });
    }

    await logRun(runId, { type: "implement", input: implementInput, error: errorMsg, duration_ms: Date.now() - startTime }, implementInput.cwd);
    throw err;
  }

  // Persist session (record only, never auto-resume implement)
  if (returnedSessionId) {
    store.upsert(returnedSessionId, "implement", repoKey, implementInput.cwd, (report.summary as string) ?? "");
  }

  // Observe actual changes (don't trust Claude's self-report alone)
  const observed = await observeResult(implementInput.cwd, worktreeName, baseCommit, requestedFiles);

  // Check resource limits
  if (implementInput.max_changed_files !== undefined || implementInput.max_cost_usd !== undefined) {
    const warnings: string[] = [];
    const exceeded =
      implementInput.max_changed_files !== undefined &&
      observed.changed_files.length > implementInput.max_changed_files;
    if (exceeded) {
      const msg = `Changed ${observed.changed_files.length} files, exceeds limit of ${implementInput.max_changed_files}`;
      warnings.push(msg);
      log(`Resource warning: ${msg}`);
    }
    observed.resource_limits = {
      max_cost_usd: implementInput.max_cost_usd,
      max_changed_files: implementInput.max_changed_files,
      actual_changed_files: observed.changed_files.length,
      changed_files_exceeded: exceeded,
      warnings,
    };
  }
  if (observed.scope?.scope_exceeded) {
    for (const warning of observed.scope.warnings) {
      log(`Scope warning: ${warning}`);
    }
  }

  const sessionLog: SessionLog = {
    requested_session_id: resumeSessionId ?? null,
    resumed: !!resumeSessionId,
    forked,
    returned_session_id: returnedSessionId,
  };

  await logRun(runId, {
    type: "implement",
    input: implementInput,
    report,
    observed,
    execution,
    session: sessionLog,
    duration_ms: Date.now() - startTime,
  }, implementInput.cwd);

  store.prune();
  const status = implementEnvelopeStatus(report, execution, observed);
  const recoveryWarnings = status === "partial"
    ? [
        "Claude ended before a clean completion, but changed files were observed. Inspect the worktree with claude_result or claude_run_inspect before preview/apply, and consider resuming with claude_implement if needed.",
      ]
    : status === "failed"
      ? [
          "Claude ended before a clean completion and no changed files were observed. Inspect diagnostics, then retry or resume instead of applying this worktree.",
        ]
      : [];
  const warnings = [
    ...(observed.resource_limits?.warnings ?? []),
    ...(observed.scope?.warnings ?? []),
    ...recoveryWarnings,
    "Worktree is retained for inspection. After applying results, call claude_cleanup to remove old delegated worktrees.",
  ];
  await markReviewGatePending(implementInput.cwd, true, "write").catch(() => {});
  return makeEnvelope(status, undefined, execution, warnings, {
    claude_report: report,
    server_observed: observed,
  });
}

// ---- Apply worktree diff to main workspace ----

export async function runClaudeApply(input: ClaudeApplyInput, runId: string): Promise<ClaudeApplyResult> {
  const startTime = Date.now();
  const finish = async (result: ClaudeApplyResult): Promise<ClaudeApplyResult> => {
    await logRun(runId, {
      type: "apply",
      input,
      applied_files: result.applied_files,
      cleanup_performed: result.cleanup_performed,
      preview: input.preview === true,
      planned_changes: result.planned_changes,
      conflicts: result.conflicts,
      error: result.error,
      duration_ms: Date.now() - startTime,
    }, input.cwd);
    const wtRelPath = path.join(".claude", "worktrees", path.basename(path.resolve(input.cwd, input.worktree_path)));
    if (input.preview === true) {
      await updateImplementLifecycleForWorktree(wtRelPath, {
        current_lifecycle: result.error ? "apply_blocked" : "success",
        previewed_at: new Date().toISOString(),
        last_apply_run_id: runId,
      }, input.cwd).catch(() => {});
    } else {
      await updateImplementLifecycleForWorktree(wtRelPath, {
        current_lifecycle: result.error ? "apply_blocked" : (result.applied_files.length > 0 ? "applied" : "unknown"),
        applied_at: result.applied_files.length > 0 ? new Date().toISOString() : undefined,
        last_apply_run_id: runId,
      }, input.cwd).catch(() => {});
    }
    if (!result.error && input.preview !== true && result.applied_files.length > 0) {
      await markReviewGatePending(input.cwd, true, "write").catch(() => {});
    }
    return result;
  };

  // Validate worktree path
  const wtReal = path.resolve(input.cwd, input.worktree_path);
  const wtDir = path.join(input.cwd, ".claude", "worktrees");
  if (!wtReal.startsWith(wtDir + path.sep)) {
    return finish({ applied_files: [], diff_stat: "", cleanup_performed: false, conflicts: [], error: `worktree_path must be under ${wtDir}` });
  }
  if (!wtReal.startsWith(wtDir + path.sep + "codex-delegated-")) {
    return finish({ applied_files: [], diff_stat: "", cleanup_performed: false, conflicts: [], error: "worktree_path must be a delegated worktree (codex-delegated-*)" });
  }
  if (!existsSync(wtReal)) {
    return finish({ applied_files: [], diff_stat: "", cleanup_performed: false, conflicts: [], error: `worktree directory not found: ${wtReal}` });
  }

  const worktreeLock = await acquireFileLock({
    cwd: input.cwd,
    resource: `worktree:${path.basename(wtReal)}`,
  }).catch((err) => {
    if (err instanceof LockBusyError) return err;
    throw err;
  });
  if (worktreeLock instanceof LockBusyError) {
    return finish({
      applied_files: [],
      diff_stat: "",
      cleanup_performed: false,
      conflicts: [],
      error: `Another operation is already using delegated worktree ${path.basename(wtReal)}. Retry after the current apply or cleanup finishes.`,
      preview: input.preview === true,
      planned_changes: [],
    });
  }

  try {
  // Non-preview apply requires explicit user approval
  if (input.preview !== true && input.confirmed_by_user !== true) {
    return finish({
      applied_files: [],
      diff_stat: "",
      cleanup_performed: false,
      conflicts: [],
      error: "Non-preview claude_apply requires confirmed_by_user=true after the user explicitly approves applying the previewed diff.",
      preview: false,
      planned_changes: [],
    });
  }

  const wtRelPath = path.join(".claude", "worktrees", path.basename(wtReal));

  // Try deterministic job-based lookup first, then scan-based fallback
  const jobMatch = await findImplementJobForWorktree(wtRelPath, input.cwd);
  let implementLog: ImplementRunLog | null = null;

  if (jobMatch?.run_id) {
    const raw = await readRunLogFile(jobMatch.run_id, input.cwd);
    if (raw) {
      implementLog = raw as unknown as ImplementRunLog;
    }
  }

  if (!implementLog) {
    implementLog = await findImplementLogForWorktree(wtRelPath, input.cwd);
  }

  const observedBaseCommit =
    typeof implementLog?.observed?.base_commit === "string" ? implementLog.observed.base_commit.trim() : "";
  const baseCommit = observedBaseCommit || undefined;
  const observedChangedFiles = Array.isArray(implementLog?.observed?.changed_files)
    ? implementLog.observed.changed_files.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  const hasObservedScope = baseCommit !== undefined && observedChangedFiles.length > 0;
  const pathspecs = hasObservedScope ? observedChangedFiles : [];

  // Fail closed when implement metadata is missing — no legacy fallback
  if (!baseCommit) {
    const wtName = path.basename(wtReal);
    return finish({
      applied_files: [],
      diff_stat: "",
      cleanup_performed: false,
      conflicts: [],
      error: `No implement metadata found for worktree "${wtName}". The implement run's base commit and changed files could not be resolved. Use claude_result or claude_run_inspect to find the implement session, then retry apply with the correct worktree_path.`,
      preview: input.preview === true,
      planned_changes: [],
    });
  }

  let diffStat = "";
  diffStat = await execCapture("git", ["diff", "--stat", baseCommit, "HEAD", "--", ...pathspecs], { cwd: wtReal, timeoutMs: 10000 }).catch(() => "");

  const [trackedStatus, uncommittedStatus, untrackedStatus] = await Promise.all([
    execCapture("git", ["diff", "--name-status", "-z", baseCommit, "HEAD", "--", ...pathspecs], { cwd: wtReal, timeoutMs: 10000 }).catch(() => ""),
    execCapture("git", ["diff", "--name-status", "-z", "--", ...pathspecs], { cwd: wtReal, timeoutMs: 10000 }).catch(() => ""),
    execCapture("git", ["status", "--porcelain=v1", "-z", "--", ...pathspecs], { cwd: wtReal, timeoutMs: 10000 }).catch(() => ""),
  ]);

  const changesByFile = new Map<string, { status: string; file: string }>();
  function addChange(change: { status: string; file: string }): void {
    if (hasObservedScope && !observedChangedFiles.some((observed) => isUnderRequestedFile(change.file, observed))) {
      return;
    }
    changesByFile.set(change.file, change);
  }

  for (const change of parseNameStatusPorcelainZ(trackedStatus)) addChange(change);
  for (const change of parseNameStatusPorcelainZ(uncommittedStatus)) addChange(change);
  for (const change of parseStatusPorcelainZ(untrackedStatus)) addChange(change);

  const changes = (await Promise.all(
    [...changesByFile.values()].map((change) => expandDirectoryChange(change, wtReal))
  ))
    .flat()
    .sort((a, b) => a.file.localeCompare(b.file));
  if (!diffStat.trim() && changes.length > 0) {
    diffStat = changes.map((c) => `${c.status}\t${c.file}`).join("\n");
  }
  const plannedChanges: ApplyPlannedChange[] = changes.map((c) => ({ status: c.status, file: c.file }));
  if (changes.length === 0) {
    return finish({ applied_files: [], diff_stat: diffStat, cleanup_performed: false, conflicts: [], error: "No changed files found in worktree", preview: input.preview === true, planned_changes: plannedChanges });
  }

  const resourceLimits = implementLog?.observed?.resource_limits;
  if (resourceLimits?.changed_files_exceeded === true) {
    const warnings = Array.isArray(resourceLimits.warnings)
      ? resourceLimits.warnings.filter((item): item is string => typeof item === "string")
      : [];
    return finish({
      applied_files: [],
      diff_stat: diffStat,
      cleanup_performed: false,
      conflicts: warnings,
      error: "Worktree exceeded implement resource limits; apply refused",
      preview: input.preview === true,
      planned_changes: plannedChanges,
    });
  }

  const observedScope = implementLog?.observed?.scope;
  if (observedScope?.scope_exceeded === true) {
    const warnings = Array.isArray(observedScope.warnings)
      ? observedScope.warnings.filter((item): item is string => typeof item === "string")
      : [];
    return finish({
      applied_files: [],
      diff_stat: diffStat,
      cleanup_performed: false,
      conflicts: warnings,
      error: "Worktree contains changes outside requested files; apply refused",
      preview: input.preview === true,
      planned_changes: plannedChanges,
    });
  }

  // Preflight: check for uncommitted changes in main workspace and
  // unsupported status codes. If any issues found, refuse the entire apply.
  const conflicts: string[] = [];
  const validStatuses = new Set(["A", "M", "D"]);

  for (const c of changes) {
    if (!validStatuses.has(c.status)) {
      conflicts.push(`${c.file}: unsupported status "${c.status}" (only A/M/D supported)`);
      continue;
    }
    try {
      const shortStat = await execCapture("git", ["status", "--short", "--", c.file], { cwd: input.cwd, timeoutMs: 10000 });
      if (shortStat.trim()) {
        conflicts.push(`${c.file}: main workspace has uncommitted changes (${shortStat.trim().slice(0, 80)})`);
      }
    } catch {}
  }

  if (conflicts.length > 0) {
    return finish({ applied_files: [], diff_stat: diffStat, cleanup_performed: false, conflicts, error: "Main workspace has uncommitted or unsupported changes; apply refused", preview: input.preview === true, planned_changes: plannedChanges });
  }

  if (input.preview) {
    return finish({
      applied_files: [],
      diff_stat: diffStat,
      cleanup_performed: false,
      conflicts: [],
      preview: true,
      planned_changes: plannedChanges,
    });
  }

  // Apply changes
  const copied: string[] = [];
  for (const c of changes) {
    const dest = path.join(input.cwd, c.file);
    const src = path.join(wtReal, c.file);
    try {
      if (c.status === "D") {
        // Deletion
        if (existsSync(dest)) {
          await import("node:fs/promises").then((m) => m.rm(dest, { recursive: true, force: true }).catch(() => {}));
        }
        copied.push(c.file);
      } else {
        const content = await import("node:fs/promises").then((m) => m.readFile(src));
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, content);
        copied.push(c.file);
      }
    } catch (err) {
      conflicts.push(`${c.file} (${c.status}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (copied.length === 0) {
    return finish({ applied_files: [], diff_stat: diffStat, cleanup_performed: false, conflicts, error: "No changes could be applied", planned_changes: plannedChanges });
  }

  // Optional: cleanup worktree
  let cleanupPerformed = false;
  if (input.cleanup) {
    try {
      await execCapture("git", ["worktree", "remove", "--force", wtRelPath], { cwd: input.cwd, timeoutMs: 30000 });
      await execCapture("git", ["worktree", "prune"], { cwd: input.cwd, timeoutMs: 10000 });
      cleanupPerformed = true;
    } catch (err) {
      log(`worktree remove failed for ${wtReal}: ${err}`);
    }
  }

  return finish({ applied_files: copied, diff_stat: diffStat, cleanup_performed: cleanupPerformed, conflicts, planned_changes: plannedChanges });
  } finally {
    await worktreeLock.release();
  }
}

// ---- Cleanup delegated worktrees ----

export async function runClaudeCleanup(input: ClaudeCleanupInput, runId: string): Promise<ClaudeCleanupResult> {
  const startTime = Date.now();
  const dryRun = input.dry_run !== false; // default true
  const olderThanHours = input.older_than_hours ?? 0;

  const cleanupLock = await acquireFileLock({
    cwd: input.cwd,
    resource: "workspace:cleanup",
  }).catch((err) => {
    if (err instanceof LockBusyError) return err;
    throw err;
  });
  if (cleanupLock instanceof LockBusyError) {
    return {
      dry_run: dryRun,
      removed_count: 0,
      failed_count: 1,
      entries: [{
        worktree_name: "",
        removed: false,
        error: "Another cleanup operation is already running for this workspace. Retry after it finishes.",
      }],
    };
  }

  try {
  const worktreeDir = path.join(input.cwd, ".claude", "worktrees");
  const entries: CleanupEntry[] = [];
  let removedCount = 0;
  let failedCount = 0;

  try {
    const { readdirSync } = await import("node:fs");
    const { statSync } = await import("node:fs");

    if (!existsSync(worktreeDir)) {
      return { dry_run: dryRun, removed_count: 0, failed_count: 0, entries: [] };
    }

    const dirs = readdirSync(worktreeDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("codex-delegated-"))
      .map((d) => d.name);

    const cutoff = olderThanHours > 0 ? Date.now() - olderThanHours * 60 * 60 * 1000 : 0;

    for (const name of dirs) {
      const dirPath = path.join(worktreeDir, name);
      const wtRelPath = path.join(".claude", "worktrees", name);

      // Check age if filter set
      if (olderThanHours > 0) {
        try {
          if (statSync(dirPath).mtimeMs > cutoff) {
            entries.push({ worktree_name: name, removed: false, error: "skipped (within time window)" });
            continue;
          }
        } catch {
          entries.push({ worktree_name: name, removed: false, error: "unable to stat" });
          continue;
        }
      }

      if (dryRun) {
        entries.push({ worktree_name: name, removed: false });
        continue;
      }

      // Actual remove — use relative path from repo root, not just basename
      const worktreeLock = await acquireFileLock({
        cwd: input.cwd,
        resource: `worktree:${name}`,
      }).catch((err) => {
        if (err instanceof LockBusyError) return err;
        throw err;
      });
      if (worktreeLock instanceof LockBusyError) {
        failedCount++;
        entries.push({
          worktree_name: name,
          removed: false,
          error: `Another operation is already using delegated worktree ${name}. Retry after it finishes.`,
        });
        continue;
      }
      try {
        await execCapture("git", ["worktree", "remove", "--force", wtRelPath], { cwd: input.cwd, timeoutMs: 30000 });
        removedCount++;
        entries.push({ worktree_name: name, removed: true });
        await updateImplementLifecycleForWorktree(wtRelPath, {
          current_lifecycle: "cleaned",
          cleaned_at: new Date().toISOString(),
          last_cleanup_run_id: runId,
        }, input.cwd).catch(() => {});
      } catch (err) {
        failedCount++;
        entries.push({ worktree_name: name, removed: false, error: err instanceof Error ? err.message : String(err) });
      } finally {
        await worktreeLock.release();
      }
    }

    if (!dryRun) {
      await execCapture("git", ["worktree", "prune"], { cwd: input.cwd, timeoutMs: 10000 }).catch(() => {});
    }
  } catch (err) {
    log(`cleanup scan failed: ${err}`);
    return {
      dry_run: dryRun,
      removed_count: 0,
      failed_count: 1,
      entries: [{ worktree_name: "", removed: false, error: err instanceof Error ? err.message : String(err) }],
    };
  }

  await logRun(runId, {
    type: "cleanup",
    input,
    removed_count: removedCount,
    failed_count: failedCount,
    duration_ms: Date.now() - startTime,
  }, input.cwd);

  return { dry_run: dryRun, removed_count: removedCount, failed_count: failedCount, entries };
  } finally {
    await cleanupLock.release();
  }
}
