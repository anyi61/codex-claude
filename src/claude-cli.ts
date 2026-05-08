import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { cp, rm, writeFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execCapture, sanitizeEnv, resolveRepoLocalPath } from "./guard.js";
import { JobStore, type BackgroundJobRecord } from "./jobs.js";
import { SessionStore, computeRepoKey, RECENT_WINDOW_MINUTES, type Session } from "./session.js";
import type {
  ApplyPlannedChange,
  BackgroundJobEnqueueResult,
  BackgroundJobStaleState,
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
  EnvironmentDiagnostics,
  EnvStatus,
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
} from "./schema.js";
import {
  QUERY_SCHEMA,
  REVIEW_SCHEMA,
  IMPLEMENT_SCHEMA,
  buildImplementPrompt,
  buildQueryPrompt,
  buildReviewPrompt,
  StructuredToolError,
} from "./schema.js";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

function getRunLogDir(cwd?: string): string {
  if (process.env.CODEX_CLAUDE_RUN_LOG_DIR) {
    return path.resolve(process.env.CODEX_CLAUDE_RUN_LOG_DIR);
  }
  const base = cwd ?? process.cwd();
  return path.join(base, ".codex-claude-delegate", "runs");
}
const JOB_STATE_DIR_ENV = "CODEX_CLAUDE_BACKGROUND_STATE_DIR";
const REVIEW_GATE_RELATIVE_PATH = path.join(".codex-claude-delegate", "review-gate.json");
const REVIEW_GATE_HOOK_COMMAND = "node '${CLAUDE_PLUGIN_ROOT}/hooks/review-gate-stop.mjs'";

const JOB_HEARTBEAT_INTERVAL_MS = 15000;
const STALE_CANDIDATE_HEARTBEAT_MS = 90_000;
const STALE_HEARTBEAT_MS = 300_000;

// ---- Session store (cwd-scoped, lazy init) ----

const stores = new Map<string, SessionStore>();
let activeClaudeChild: ChildProcess | null = null;

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

function getBackgroundStateDir(): string {
  if (process.env[JOB_STATE_DIR_ENV]) {
    return path.resolve(process.env[JOB_STATE_DIR_ENV]!);
  }
  if (process.env.CODEX_CLAUDE_RUN_LOG_DIR) {
    return path.dirname(path.resolve(process.env.CODEX_CLAUDE_RUN_LOG_DIR));
  }
  return path.join(process.cwd(), ".codex-claude-delegate");
}

async function getJobStore(): Promise<JobStore> {
  const store = new JobStore(getBackgroundStateDir());
  await store.init();
  return store;
}

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

function normalizeSessionType(value: unknown): "query" | "review" | "implement" | undefined {
  if (value === "query" || value === "review" || value === "implement") return value;
  return undefined;
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

function toJobSummary(record: BackgroundJobRecord): BackgroundJobSummary {
  return {
    job_id: record.job_id,
    type: record.type,
    status: record.status,
    result_status: record.result_status ?? extractBackgroundResultStatus(record.result),
    cwd: record.cwd,
    created_at: record.created_at,
    updated_at: record.updated_at,
    heartbeat_at: record.heartbeat_at,
    last_wait_at: record.last_wait_at,
    last_wait_recommended_delay_ms: record.last_wait_recommended_delay_ms,
    fingerprint: record.fingerprint,
    pid: record.pid,
    run_id: record.run_id,
    worktree_name: record.worktree_name,
    summary: record.summary,
    error: record.error,
  };
}

function extractBackgroundResultStatus(result?: Record<string, unknown>): RunLogStatus | undefined {
  if (!result) return undefined;
  if (isRunLogStatus(result.status)) return result.status;
  const claudeReport = result.claude_report;
  if (claudeReport && typeof claudeReport === "object") {
    const reportStatus = (claudeReport as { status?: unknown }).status;
    if (isRunLogStatus(reportStatus)) return reportStatus;
  }
  return undefined;
}

function isRunLogStatus(value: unknown): value is RunLogStatus {
  return value === "success" || value === "failed" || value === "partial" || value === "needs_user" || value === "unknown";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

function buildFingerprintPayload(input: {
  cwd: string;
  type: BackgroundJobType;
  payload: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    cwd: path.resolve(input.cwd),
    tool: input.type,
    mode: input.payload.mode,
    task: typeof input.payload.task === "string" ? input.payload.task.trim() : undefined,
    files: normalizeStringArray(input.payload.files),
    instruction_files: normalizeStringArray(input.payload.instruction_files),
    dirty_policy: input.payload.dirty_policy ?? (input.type === "implement" ? "ask" : undefined),
    session_key: input.payload.session_key,
    resume_latest: input.payload.resume_latest,
    fork_session: input.payload.fork_session,
    max_changed_files: input.payload.max_changed_files,
    max_cost_usd: input.payload.max_cost_usd,
  };
}

export function createTaskFingerprint(input: {
  cwd: string;
  type: BackgroundJobType;
  payload: Record<string, unknown>;
}): string {
  const normalized = buildFingerprintPayload(input);
  return createHash("sha256").update(stableJson(normalized)).digest("hex");
}

function buildDuplicateJobMessage(job: BackgroundJobSummary): string {
  return `An equivalent ${job.type} job is already ${job.status}: ${job.job_id}. Continue polling claude_job_wait for this job_id; do not restart or duplicate the task.`;
}

function startJobHeartbeat(jobStore: JobStore, jobId: string, intervalMs = JOB_HEARTBEAT_INTERVAL_MS): () => void {
  let stopped = false;
  const touch = () => {
    if (stopped) return;
    void jobStore.touchHeartbeat(jobId).catch(() => {});
  };
  touch();
  const timer = setInterval(touch, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function ageMsSince(timestamp: string | undefined, nowMs = Date.now()): number | undefined {
  if (!timestamp) return undefined;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, nowMs - parsed);
}

function isPidAlive(pid: number | undefined): boolean | undefined {
  if (!pid) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function classifyJobStaleState(input: {
  job: BackgroundJobSummary;
  heartbeatAgeMs?: number;
  pidAlive?: boolean;
}): BackgroundJobStaleState {
  if (input.job.status !== "queued" && input.job.status !== "running") {
    return "fresh";
  }
  if (input.pidAlive === false) {
    return "stale";
  }
  const heartbeatAgeMs = input.heartbeatAgeMs;
  if (heartbeatAgeMs === undefined) {
    return "fresh";
  }
  if (heartbeatAgeMs > STALE_HEARTBEAT_MS) {
    return "stale";
  }
  if (heartbeatAgeMs > STALE_CANDIDATE_HEARTBEAT_MS) {
    return "stale_candidate";
  }
  return "fresh";
}

function recommendedDelayMs(input: {
  ageMs: number;
  staleState: BackgroundJobStaleState;
}): number | undefined {
  if (input.staleState === "stale") return undefined;
  if (input.staleState === "stale_candidate") return 30_000;
  if (input.ageMs < 30_000) return 10_000;
  if (input.ageMs < 120_000) return 20_000;
  if (input.ageMs < 600_000) return 45_000;
  if (input.ageMs < 1_800_000) return 60_000;
  return 90_000;
}

function buildActiveWaitActions(input: {
  cwd: string;
  job: BackgroundJobSummary;
  staleState: BackgroundJobStaleState;
  nextAllowedPollAt?: string;
}): WorkflowNextAction[] {
  if (input.staleState === "stale") {
    return [
      {
        tool: "claude_job_cancel",
        reason: "Job appears stale because heartbeat is too old or its pid is gone. Cancel only after inspecting or when intentionally abandoning this run.",
        args: { cwd: input.cwd, job_id: input.job.job_id },
      },
      {
        tool: "claude_workspace_status",
        reason: "Inspect workspace-level state before deciding whether to cancel, apply, cleanup, or retry.",
        args: { cwd: input.cwd },
      },
      {
        tool: "claude_job_result",
        reason: "Inspect persisted job details before starting a replacement job.",
        args: { cwd: input.cwd, job_id: input.job.job_id },
      },
    ];
  }

  return [
    {
      tool: "claude_job_wait",
      reason: input.nextAllowedPollAt
        ? "Poll again only after next_allowed_poll_at. Do not start a duplicate task."
        : input.staleState === "stale_candidate"
          ? "Job heartbeat is delayed but not stale yet. Wait once more before inspecting or cancelling; do not start a duplicate job."
          : "Job is active. Poll this same job_id again after the recommended delay; do not start a duplicate job.",
      args: {
        cwd: input.cwd,
        job_id: input.job.job_id,
        ...(input.nextAllowedPollAt ? { not_before: input.nextAllowedPollAt } : {}),
      },
    },
  ];
}

function summarizeWithOutcome(type: BackgroundJobType, result: Record<string, unknown>, summary: string): string {
  const status = extractBackgroundResultStatus(result);
  if (!status || status === "success") return summary;
  const label =
    type === "query" ? "Query" :
      type === "review" ? "Review" :
        type === "implement" ? "Implement" :
          type === "apply" ? "Apply" : "Cleanup";
  return `${label} ${status}: ${summary}`;
}

function summarizeBackgroundResult(type: BackgroundJobType, result: Record<string, unknown>): string | undefined {
  if (type === "query") {
    const data = result.data;
    if (data && typeof data === "object" && typeof (data as { answer?: unknown }).answer === "string") {
      return summarizeWithOutcome(type, result, `Query completed: ${String((data as { answer: string }).answer).slice(0, 80)}`);
    }
    return summarizeWithOutcome(type, result, "Query completed");
  }
  if (type === "implement") {
    const claudeReport = result.claude_report;
    if (claudeReport && typeof claudeReport === "object" && typeof (claudeReport as { summary?: unknown }).summary === "string") {
      return summarizeWithOutcome(type, result, (claudeReport as { summary: string }).summary);
    }
    return summarizeWithOutcome(type, result, "Implement job completed");
  }
  if (type === "apply") {
    const data = result.data;
    if (data && typeof data === "object" && Array.isArray((data as { applied_files?: unknown }).applied_files)) {
      return `Apply completed (${(data as { applied_files: unknown[] }).applied_files.length} files)`;
    }
    return "Apply completed";
  }
  if (type === "cleanup") {
    const data = result.data;
    if (data && typeof data === "object" && typeof (data as { removed_count?: unknown }).removed_count === "number") {
      return `Cleanup completed (${(data as { removed_count: number }).removed_count} removed)`;
    }
    return "Cleanup completed";
  }
  const data = result.data;
  if (data && typeof data === "object" && typeof (data as { severity?: unknown }).severity === "string") {
    return summarizeWithOutcome(type, result, `Review completed (${(data as { severity: string }).severity})`);
  }
  return summarizeWithOutcome(type, result, "Review completed");
}

function getBackgroundWorktreeName(type: BackgroundJobType, payload: Record<string, unknown>, result: Record<string, unknown>): string | undefined {
  if (type === "apply" && typeof payload.worktree_path === "string") {
    return path.basename(payload.worktree_path);
  }
  const observed = result.server_observed;
  if (!observed || typeof observed !== "object") return undefined;
  return typeof (observed as { worktree_name?: unknown }).worktree_name === "string"
    ? (observed as { worktree_name: string }).worktree_name
    : undefined;
}

function getJobRunnerArgs(jobId: string): string[] {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  if (currentFile.endsWith(".ts") && process.argv[1]?.includes("tsx")) {
    return [process.argv[1], path.join(currentDir, "job-runner.ts"), jobId];
  }
  return [path.join(currentDir, "job-runner.js"), jobId];
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
  const repoKey = await computeRepoKey(input.cwd);
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

    const type = normalizeSessionType(run.type);
    if (type) {
      return {
        session_id: run.returned_session_id,
        type,
        requested_session_id: run.requested_session_id,
        returned_session_id: run.returned_session_id,
        resumed: !!run.requested_session_id,
        source: "run",
      };
    }
  }

  const type = normalizeSessionType(run?.type);
  if (!type) return undefined;
  const recent = store.listByRepo(repoKey, 20).find((session) => session.type === type && !session.expired);
  return recent ? toWorkflowSessionSummaryFromStore(recent) : undefined;
}

function buildNextActions(input: {
  cwd: string;
  job?: BackgroundJobSummary;
  run?: RunLogEntrySummary;
  related_runs?: ClaudeRunInspectResult["related_runs"];
  session?: WorkflowSessionSummary;
}): WorkflowNextAction[] {
  const actions: WorkflowNextAction[] = [];
  const run = input.run;
  const job = input.job;
  const type = run?.type ?? job?.type;
  const worktreePath = run?.worktree_path;

  if (job && (job.status === "queued" || job.status === "running")) {
    return [
      {
        tool: "claude_job_wait",
        reason: "This job is still active. Continue polling this job_id and do not start another job for the same task.",
        args: { cwd: input.cwd, job_id: job.job_id },
      },
    ];
  }

  if (type === "implement") {
    if (worktreePath) {
      actions.push({
        tool: "claude_apply",
        reason: "Preview the delegated worktree diff before modifying the main workspace. After preview, ask the user for explicit approval before any non-preview apply.",
        args: { cwd: input.cwd, worktree_path: worktreePath, preview: true },
      });
    }
    if (input.session?.session_id) {
      actions.push({
        tool: "claude_implement",
        reason: "This implementation has a resumable Claude session.",
        args: { cwd: input.cwd, resume_latest: true },
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
    actions.push({
      tool: "claude_implement",
      reason: "If the Claude session cannot be resumed, start a fresh implementation with the same task.",
      args: { cwd: input.cwd },
    });
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
    tool: "claude_job_wait",
    reason: "Workspace has an active delegated job. Poll this job_id instead of starting a duplicate task.",
    args: { cwd: input.cwd, job_id: job.job_id },
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

function summarizeTaskDispatch(mode: Exclude<ClaudeTaskMode, "auto">, background: boolean): string {
  if (background) {
    return `Delegated ${mode} task as a background job.`;
  }
  return `Delegated ${mode} task and returned the current result.`;
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

export async function runClaudeTask(input: ClaudeTaskInput, _runId: string): Promise<ClaudeTaskResult> {
  const delegatedMode = inferClaudeTaskMode(input);
  const { instructionFiles, warnings } = resolveTaskInstructionFiles(input);

  if (delegatedMode === "read") {
    const queued = await startBackgroundQuery({
      cwd: input.cwd,
      task: input.task,
      instruction_files: instructionFiles,
      timeout_sec: input.timeout_sec,
    });
    return {
      delegated_mode: delegatedMode,
      summary: queued.message ?? summarizeTaskDispatch(delegatedMode, true),
      job: queued.job,
      deduped: queued.deduped,
      do_not_start_duplicate_job: queued.do_not_start_duplicate_job,
      warnings,
      next_actions: queued.next_actions ?? buildNextActions({ cwd: input.cwd, job: queued.job }),
    };
  }

  if (delegatedMode === "review") {
    const queued = await startBackgroundReview({
      cwd: input.cwd,
      task: input.task,
      diff: input.diff,
      instruction_files: instructionFiles,
      timeout_sec: input.timeout_sec,
    });
    return {
      delegated_mode: delegatedMode,
      summary: queued.message ?? summarizeTaskDispatch(delegatedMode, true),
      job: queued.job,
      deduped: queued.deduped,
      do_not_start_duplicate_job: queued.do_not_start_duplicate_job,
      warnings,
      next_actions: queued.next_actions ?? buildNextActions({ cwd: input.cwd, job: queued.job }),
    };
  }

  const queued = await startBackgroundImplement({
    cwd: input.cwd,
    task: input.task,
    instruction_files: instructionFiles,
    constraints: input.constraints,
    timeout_sec: input.timeout_sec,
    resume_latest: input.resume_latest,
    dirty_policy: input.dirty_policy,
  });
  if (!("job" in queued)) {
    return {
      delegated_mode: delegatedMode,
      summary: "Write task needs a dirty-workspace decision before it can be delegated.",
      result: queued as unknown as Record<string, unknown>,
      warnings,
      next_actions: [],
    };
  }
  return {
    delegated_mode: delegatedMode,
    summary: queued.message ?? summarizeTaskDispatch(delegatedMode, true),
    job: queued.job,
    deduped: queued.deduped,
    do_not_start_duplicate_job: queued.do_not_start_duplicate_job,
    warnings,
    next_actions: queued.next_actions ?? buildNextActions({ cwd: input.cwd, job: queued.job }),
  };
}

function buildBackgroundJobResponse(input: {
  cwd: string;
  job: BackgroundJobSummary;
  deduped?: boolean;
}): BackgroundJobEnqueueResult {
  const deduped = input.deduped === true;
  return {
    job: input.job,
    deduped,
    do_not_start_duplicate_job: deduped || input.job.status === "queued" || input.job.status === "running",
    message: deduped ? buildDuplicateJobMessage(input.job) : undefined,
    next_actions: buildNextActions({ cwd: input.cwd, job: input.job }),
  };
}

export async function enqueueBackgroundJob(input: {
  cwd: string;
  type: BackgroundJobType;
  payload: Record<string, unknown>;
  dedupe?: boolean;
}): Promise<BackgroundJobEnqueueResult> {
  const stateDir = getBackgroundStateDir();
  const jobStore = new JobStore(stateDir);
  await jobStore.init();

  const fingerprint = input.dedupe === true
    ? createTaskFingerprint({ cwd: input.cwd, type: input.type, payload: input.payload })
    : undefined;

  if (fingerprint) {
    const existing = await jobStore.findActiveByFingerprint({
      cwd: input.cwd,
      type: input.type,
      fingerprint,
    });
    if (existing) {
      return buildBackgroundJobResponse({
        cwd: input.cwd,
        job: toJobSummary(existing),
        deduped: true,
      });
    }
  }

  const now = new Date().toISOString();
  const jobId = `job-${randomUUID()}`;
  const record: BackgroundJobRecord = {
    job_id: jobId,
    type: input.type,
    status: "queued",
    cwd: input.cwd,
    created_at: now,
    updated_at: now,
    fingerprint,
    payload: input.payload,
  };

  await jobStore.create(record);

  const child = spawn(process.execPath, getJobRunnerArgs(jobId), {
    cwd: input.cwd,
    detached: true,
    stdio: "ignore",
    env: {
      ...sanitizeEnv(),
      [JOB_STATE_DIR_ENV]: getBackgroundStateDir(),
    },
  });
  child.unref();

  const updated = await jobStore.update(jobId, {
    pid: child.pid ?? undefined,
    updated_at: new Date().toISOString(),
  });

  return buildBackgroundJobResponse({
    cwd: input.cwd,
    job: toJobSummary(updated ?? { ...record, pid: child.pid ?? undefined }),
  });
}

export async function startBackgroundReview(input: ClaudeReviewInput): Promise<BackgroundJobEnqueueResult> {
  const queued = await enqueueBackgroundJob({
    cwd: input.cwd,
    type: "review",
    payload: input as unknown as Record<string, unknown>,
    dedupe: true,
  });
  await markReviewGatePending(input.cwd, false, "review").catch(() => {});
  return queued;
}

export async function startBackgroundQuery(input: ClaudeQueryInput): Promise<BackgroundJobEnqueueResult> {
  return enqueueBackgroundJob({
    cwd: input.cwd,
    type: "query",
    payload: input as unknown as Record<string, unknown>,
    dedupe: true,
  });
}

export async function startBackgroundImplement(input: ClaudeImplementInput): Promise<BackgroundJobEnqueueResult | ClaudeResult> {
  if ((input.dirty_policy ?? "ask") === "ask") {
    const { requestedFiles, dirtyFiles } = await preflightImplementDirtyState(input);
    if (dirtyFiles.length > 0) {
      return dirtyNeedsUserResult(input, dirtyFiles, requestedFiles);
    }
  }
  const queued = await enqueueBackgroundJob({
    cwd: input.cwd,
    type: "implement",
    payload: input as unknown as Record<string, unknown>,
    dedupe: true,
  });
  await markReviewGatePending(input.cwd, true, "write").catch(() => {});
  return queued;
}

export async function startBackgroundApply(input: ClaudeApplyInput): Promise<BackgroundJobEnqueueResult> {
  const queued = await enqueueBackgroundJob({
    cwd: input.cwd,
    type: "apply",
    payload: input as unknown as Record<string, unknown>,
  });
  await markReviewGatePending(input.cwd, true, "write").catch(() => {});
  return queued;
}

export async function startBackgroundCleanup(input: ClaudeCleanupInput): Promise<BackgroundJobEnqueueResult> {
  return enqueueBackgroundJob({
    cwd: input.cwd,
    type: "cleanup",
    payload: input as unknown as Record<string, unknown>,
  });
}

export async function listBackgroundJobs(input: ClaudeJobsInput): Promise<ClaudeJobsResult> {
  const jobStore = await getJobStore();
  const entries = await jobStore.list({
    cwd: input.cwd,
    limit: input.limit ?? 20,
    status: input.status,
    type: input.type,
  });
  return { entries: entries.map(toJobSummary) };
}

export async function getBackgroundJobResult(
  input: ClaudeJobResultInput
): Promise<{ job: BackgroundJobSummary; result?: Record<string, unknown> } | null> {
  const jobStore = await getJobStore();
  const job = await jobStore.get(input.job_id);
  if (!job || job.cwd !== input.cwd) return null;
  return {
    job: toJobSummary(job),
    result: job.result,
  };
}

export async function waitForBackgroundJob(
  input: ClaudeJobWaitInput
): Promise<ClaudeJobWaitResult> {
  const jobStore = await getJobStore();
  const record = await jobStore.get(input.job_id);
  if (!record || record.cwd !== input.cwd) {
    throw new Error(`Job not found: ${input.job_id}`);
  }
  const result = {
    job: toJobSummary(record),
    result: record.result,
  };

  const terminal = result.job.status === "succeeded" || result.job.status === "failed" || result.job.status === "cancelled";
  const nowMs = Date.now();
  const ageMs = ageMsSince(result.job.created_at, nowMs) ?? 0;
  const heartbeatAgeMs = terminal
    ? undefined
    : ageMsSince(result.job.heartbeat_at ?? result.job.updated_at, nowMs);
  const staleState = classifyJobStaleState({
    job: result.job,
    heartbeatAgeMs,
    pidAlive: terminal ? undefined : isPidAlive(result.job.pid),
  });
  const delayMs = terminal ? undefined : recommendedDelayMs({ ageMs, staleState });
  const previousDelayMs = typeof result.job.last_wait_recommended_delay_ms === "number"
    ? result.job.last_wait_recommended_delay_ms
    : delayMs;
  const lastWaitAgeMs = terminal ? undefined : ageMsSince(result.job.last_wait_at, nowMs);
  const pollTooSoon = !terminal && staleState !== "stale" && previousDelayMs !== undefined && lastWaitAgeMs !== undefined && lastWaitAgeMs < previousDelayMs;
  const remainingDelayMs = pollTooSoon && previousDelayMs !== undefined && lastWaitAgeMs !== undefined
    ? Math.max(0, previousDelayMs - lastWaitAgeMs)
    : undefined;
  const nextAllowedPollAt = !terminal && staleState !== "stale" && delayMs !== undefined
    ? new Date((result.job.last_wait_at ? Date.parse(result.job.last_wait_at) : nowMs) + (pollTooSoon ? previousDelayMs ?? delayMs : delayMs)).toISOString()
    : undefined;

  let job = result.job;
  if (!terminal && !pollTooSoon) {
    const updated = await jobStore.touchWait(input.job_id, new Date(nowMs).toISOString(), delayMs);
    if (updated) {
      job = toJobSummary(updated);
    }
  }

  return {
    job,
    result: result.result,
    status: job.status,
    summary: terminal
      ? `Job ${result.job.job_id} is ${result.job.status}; use the returned result or claude_result for follow-up.`
      : staleState === "stale"
        ? `Job ${result.job.job_id} appears stale; inspect or cancel it before starting any replacement job.`
        : pollTooSoon
          ? `Job ${result.job.job_id} was polled too soon. Do not call claude_job_wait again before ${nextAllowedPollAt}; wait ${remainingDelayMs}ms and poll the same job_id.`
          : `Job ${result.job.job_id} is still ${result.job.status}; do not duplicate this task locally. Poll claude_job_wait again after the recommended delay.`,
    waiting: !terminal,
    timed_out: false,
    do_not_start_duplicate_job: !terminal && staleState !== "stale",
    poll_too_soon: pollTooSoon || undefined,
    recommended_delay_ms: delayMs,
    remaining_delay_ms: remainingDelayMs,
    next_allowed_poll_at: nextAllowedPollAt,
    age_ms: ageMs,
    heartbeat_age_ms: heartbeatAgeMs,
    stale_state: staleState,
    next_actions: terminal
      ? buildNextActions({ cwd: input.cwd, job })
      : buildActiveWaitActions({ cwd: input.cwd, job, staleState, nextAllowedPollAt }),
  };
}

export async function cancelBackgroundJob(
  input: ClaudeJobCancelInput
): Promise<{ cancelled: boolean; job?: BackgroundJobSummary; error?: string }> {
  const jobStore = await getJobStore();
  const job = await jobStore.get(input.job_id);
  if (!job || job.cwd !== input.cwd) {
    return { cancelled: false, error: `Job not found: ${input.job_id}` };
  }

  if (job.status === "cancelled" || job.status === "failed" || job.status === "succeeded") {
    return { cancelled: false, job: toJobSummary(job), error: `Job is already ${job.status}` };
  }

  if (job.status === "running" && job.pid) {
    try {
      process.kill(job.pid, "SIGTERM");
    } catch (err) {
      return {
        cancelled: false,
        job: toJobSummary(job),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const updated = await jobStore.update(job.job_id, {
    status: "cancelled",
    updated_at: new Date().toISOString(),
    summary: job.summary ?? "Cancelled by user",
    error: undefined,
  });

  return { cancelled: true, job: updated ? toJobSummary(updated) : undefined };
}

export async function cleanupBackgroundJobs(
  input: ClaudeJobCleanupInput
): Promise<ClaudeJobCleanupResult> {
  const jobStore = await getJobStore();
  return jobStore.cleanup({
    cwd: input.cwd,
    older_than_hours: input.older_than_hours ?? 24,
    dry_run: input.dry_run ?? true,
    limit: input.limit ?? 20,
  });
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

// ---- Sensitive data redaction for stderr ----

function redactSensitive(input: string): string {
  return input
    .replace(/(ANTHROPIC_AUTH_TOKEN=)[^\s]+/gi, "$1***")
    .replace(/(ANTHROPIC_API_KEY=)[^\s]+/gi, "$1***")
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, "$1***")
    .replace(/\b(sk-ant-[a-zA-Z0-9]{20,})\b/g, "sk-ant-***")
    .replace(/\b(sk-[a-zA-Z0-9]{20,})\b/g, "sk-***");
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

export interface ClaudeRunOptions {
  prompt: string;
  cwd: string;
  worktree?: string;
  tools: string;
  allowedTools: string[];
  disallowedTools: string[];
  maxTurns?: number;
  timeoutSec: number;
  jsonSchema: object;
  maxBudgetUsd?: number;
  // Session options
  resumeSessionId?: string;
  forkSession?: boolean;
  noSessionPersistence?: boolean;
}

interface ClaudeSpawnResult {
  report: Record<string, unknown>;
  session_id: string | null;
  execution: ExecutionMetadata;
}

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

export function truncateTail(input: string, maxChars = 4000): string {
  return input.length <= maxChars ? input : input.slice(-maxChars);
}

export function buildSafeEnv(): Record<string, string> {
  return sanitizeEnv();
}

export function abortActiveClaudeRun(signal: NodeJS.Signals = "SIGTERM"): boolean {
  if (!activeClaudeChild?.pid) return false;
  try {
    process.kill(activeClaudeChild.pid, signal);
    return true;
  } catch {
    return false;
  }
}

export function buildClaudeArgs(opts: ClaudeRunOptions): string[] {
  const args: string[] = ["-p"];

  if (opts.worktree) {
    args.push("-w", opts.worktree);
  }

  if (opts.resumeSessionId) {
    args.push("-r", opts.resumeSessionId);
  }

  if (opts.forkSession) {
    args.push("--fork-session");
  }

  if (opts.noSessionPersistence) {
    args.push("--no-session-persistence");
  }

  args.push(
    "--permission-mode", "dontAsk",
  );

  if (opts.maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", String(opts.maxBudgetUsd));
  }

  args.push("--tools", opts.tools);

  if (opts.maxTurns !== undefined) {
    args.push("--max-turns", String(opts.maxTurns));
  }

  args.push("--output-format", "json");

  // --allowedTools / --disallowedTools must come before --json-schema.
  // --json-schema must be the last flag before the positional prompt.
  // If placed before --allowedTools/--disallowedTools, the CLI incorrectly
  // consumes subsequent flags as part of the schema value.
  if (opts.allowedTools.length > 0) {
    args.push("--allowedTools");
    for (const t of opts.allowedTools) {
      args.push(t);
    }
  }

  if (opts.disallowedTools.length > 0) {
    args.push("--disallowedTools");
    for (const t of opts.disallowedTools) {
      args.push(t);
    }
  }

  args.push("--json-schema", JSON.stringify(opts.jsonSchema));
  args.push(opts.prompt);
  return args;
}

export function buildQueryArgs(input: ClaudeQueryInput): string[] {
  return buildClaudeArgs(createQueryOptions(input));
}

export function buildReviewArgs(input: ClaudeReviewInput): string[] {
  return buildClaudeArgs(createReviewOptions(input));
}

export function buildImplementArgs(input: ClaudeImplementInput): string[] {
  return buildClaudeArgs(createImplementOptions(input));
}

function successExecution(durationMs = 0): ExecutionMetadata {
  return { exit_code: 0, duration_ms: durationMs, timed_out: false, stdout_tail: "", stderr_tail: "" };
}

function makeEnvelope<T>(
  status: ToolEnvelope<T>["status"],
  data: T | undefined,
  execution: ExecutionMetadata,
  warnings: string[] = [],
  extra: Pick<ToolEnvelope<T>, "claude_report" | "server_observed"> = {}
): ToolEnvelope<T> {
  return { status, data, execution, warnings, ...extra };
}

function reportIndicatesFailure(report: Record<string, unknown>, execution: ExecutionMetadata): boolean {
  return (
    (execution.exit_code !== null && execution.exit_code !== 0) ||
    execution.timed_out ||
    report.is_error === true ||
    report.status === "failed"
  );
}

function implementEnvelopeStatus(
  report: Record<string, unknown>,
  execution: ExecutionMetadata,
  observed: ServerObserved
): ToolEnvelope<undefined>["status"] {
  if (!reportIndicatesFailure(report, execution)) {
    if (report.status === "partial" || report.status === "needs_user") return report.status;
    return "success";
  }
  return observed.changed_files.length > 0 ? "partial" : "failed";
}

function noOutputPayload(
  message: string,
  opts: ClaudeRunOptions,
  code: number | null,
  signal: NodeJS.Signals | null,
  stdout: string,
  stderr: string,
  stderrTail: string,
  environmentDiagnostics?: EnvironmentDiagnostics
): Record<string, unknown> {
  return {
    error: message,
    diagnostics: {
      exit_code: code,
      signal: signal ?? "none",
      timeout_sec: opts.timeoutSec,
      stdout_len: stdout.length,
      stderr_len: stderr.length,
      stderr_tail: stderrTail,
      environment_diagnostics: environmentDiagnostics,
    },
    next_actions: [
      {
        tool: "claude_review",
        reason: "Retry with a higher timeout_sec if the review scope is broad or Claude was still starting.",
      },
      {
        tool: "claude_review",
        args: { background: true },
        reason: "Run broad reviews in the background so Codex can poll the job instead of timing out foreground execution.",
      },
      {
        tool: "claude_status",
        reason: "Check Claude CLI auth, PATH, proxy, and local environment diagnostics before retrying.",
      },
    ],
  };
}

function spawnClaude(opts: ClaudeRunOptions): Promise<ClaudeSpawnResult> {
  const args = buildClaudeArgs(opts);
  const safeEnv = sanitizeEnv();
  const startTime = Date.now();

  log(`spawning: ${CLAUDE_BIN} -p (${args.length} args, worktree=${opts.worktree ?? "none"}, maxTurns=${opts.maxTurns ?? "unlimited"})`);

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd: opts.cwd,
      env: safeEnv,
      timeout: opts.timeoutSec * 1000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeClaudeChild = child;

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      activeClaudeChild = null;
      if (err.code === "ENOENT") {
        reject(new Error(`Claude CLI not found. Ensure "claude" is in PATH or set CLAUDE_BIN env var.`));
      } else {
        reject(err);
      }
    });

    child.on("close", async (code, signal) => {
      activeClaudeChild = null;
      if (stderr) log(`claude stderr: ${redactSensitive(stderr.slice(0, 2000))}`);

      // Try to parse stdout even when exit code is non-zero.
      // Claude may exit with code 1 on max_turns but still produce
      // valid structured_output in the result payload.
      try {
        const trimmed = stdout.trim();
        if (!trimmed) {
          const stderrTail = redactSensitive(stderr.slice(-1000));
          let environmentDiagnostics: EnvironmentDiagnostics | undefined;
          let diagStr = "";
          try {
            environmentDiagnostics = await getEnvironmentDiagnostics(safeEnv);
            diagStr = ` environment_diagnostics=${JSON.stringify(environmentDiagnostics)}`;
          } catch {}
          const message =
            `Claude produced no output (exit ${code}, signal ${signal ?? "none"}, timeout_sec=${opts.timeoutSec}, stdoutLen=${stdout.length}, stderrLen=${stderr.length}, stderrTail=${JSON.stringify(stderrTail)})` +
            diagStr;
          reject(new StructuredToolError(
            message,
            noOutputPayload(message, opts, code, signal, stdout, stderr, stderrTail, environmentDiagnostics)
          ));
          return;
        }

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          const lines = trimmed.split("\n").filter((l) => l.trim());
          if (lines.length === 0) {
            reject(new Error(`Claude produced unparseable output (exit ${code}): ${trimmed.slice(0, 500)}`));
            return;
          }
          const lastLine = lines[lines.length - 1];
          parsed = JSON.parse(lastLine);
        }

        // Extract structured_output if present, otherwise use the whole result
        const report = (parsed.structured_output ?? parsed) as Record<string, unknown>;

        // Extract session_id for session management
        const sessionId = (parsed.session_id as string) ?? null;

        // If Claude hit max_turns with partial results, still return what we have.
        // The subtype field signals whether this was a clean completion or an early exit.
        if (code !== 0 && code !== null) {
          log(`Claude exited ${code} (subtype=${parsed.subtype ?? "unknown"}), returning partial result`);
        }

        resolve({
          report,
          session_id: sessionId,
          execution: {
            exit_code: code,
            duration_ms: Date.now() - startTime,
            timed_out: signal === "SIGTERM",
            stdout_tail: truncateTail(stdout),
            stderr_tail: redactSensitive(truncateTail(stderr)),
          },
        });
      } catch (err) {
        const diag = `exit=${code}, signal=${signal ?? "none"}, timeout_sec=${opts.timeoutSec}, stdoutLen=${stdout.length}, stderrLen=${stderr.length}, stderr=${redactSensitive(stderr.slice(0, 200))}`;
        reject(new Error(`Failed to parse Claude output. ${diag}\n${(err as Error).message}`));
      }
    });
  });
}

// ---- Environment diagnostics ----

function redactEnvStatus(key: string, safeEnv: Record<string, string>): EnvStatus {
  if (safeEnv[key]) {
    return key.includes("TOKEN") || key.includes("API_KEY") ? "set-redacted" : "set";
  }
  if (process.env[key]) {
    return "present-in-parent-stripped";
  }
  return "unset";
}

function parseLocalProxy(raw?: string): { host: string; port: number } | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname;
    const port = Number.parseInt(url.port, 10);
    if (!host || !Number.isFinite(port)) return null;
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return null;
    return { host, port };
  } catch {
    return null;
  }
}

async function probeLocalPort(host: string, port: number, timeoutMs = 1000): Promise<{ reachable: boolean; error?: string }> {
  const net = await import("node:net");
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ reachable: false, error: "timeout" });
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ reachable: true });
    });

    socket.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ reachable: false, error: err.code ?? err.message });
    });
  });
}

async function getEnvironmentDiagnostics(safeEnv: Record<string, string> = sanitizeEnv()): Promise<EnvironmentDiagnostics> {
  const proxyRaw = safeEnv.HTTPS_PROXY ?? safeEnv.HTTP_PROXY ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  const localProxy = parseLocalProxy(proxyRaw);

  let reachable: boolean | undefined;
  let proxyError: string | undefined;

  if (localProxy) {
    const probe = await probeLocalPort(localProxy.host, localProxy.port);
    reachable = probe.reachable;
    proxyError = probe.error;
  }

  const likelySandboxBlocked =
    !!localProxy &&
    reachable === false &&
    (proxyError === "EPERM" || proxyError === "EACCES" || proxyError === "timeout");

  return {
    proxy_env_present: !!(safeEnv.HTTP_PROXY || safeEnv.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY),
    http_proxy: redactEnvStatus("HTTP_PROXY", safeEnv),
    https_proxy: redactEnvStatus("HTTPS_PROXY", safeEnv),
    no_proxy: redactEnvStatus("NO_PROXY", safeEnv),
    anthropic_base_url: redactEnvStatus("ANTHROPIC_BASE_URL", safeEnv),
    anthropic_auth_token: redactEnvStatus("ANTHROPIC_AUTH_TOKEN", safeEnv),
    anthropic_api_key: redactEnvStatus("ANTHROPIC_API_KEY", safeEnv),
    local_proxy_host: localProxy?.host,
    local_proxy_port: localProxy?.port,
    local_proxy_reachable: reachable,
    local_proxy_error: proxyError,
    likely_sandbox_blocked: likelySandboxBlocked,
    recommendation: likelySandboxBlocked
      ? "Claude CLI likely cannot reach its local proxy/API from this sandbox. Run the MCP server outside the restricted sandbox or approve the outer command execution."
      : undefined,
  };
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
    allowedTools: [
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
      "Bash(npx *)",
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
      "Bash(mkdir *)",
      "Bash(mkdir -p *)",
      "Bash(cp *)",
      "Bash(mv *)",
      "Bash(node *)",
      "Bash(python *)",
      "Bash(python3 *)",
      "Bash(tsc *)",
      "Bash(eslint *)",
    ],
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
    let result: Record<string, unknown>;
    if (running.type === "query") {
      result = await runClaudeQuery(running.payload as unknown as ClaudeQueryInput, runId) as unknown as Record<string, unknown>;
    } else if (running.type === "review") {
      result = await runClaudeReview(running.payload as unknown as ClaudeReviewInput, runId) as unknown as Record<string, unknown>;
    } else if (running.type === "implement") {
      result = await runClaudeImplement(running.payload as unknown as ClaudeImplementInput, runId) as unknown as Record<string, unknown>;
    } else if (running.type === "apply") {
      result = await runClaudeApply(running.payload as unknown as ClaudeApplyInput, runId) as unknown as Record<string, unknown>;
    } else {
      result = await runClaudeCleanup(running.payload as unknown as ClaudeCleanupInput, runId) as unknown as Record<string, unknown>;
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
}

// ---- Cleanup delegated worktrees ----

export async function runClaudeCleanup(input: ClaudeCleanupInput, runId: string): Promise<ClaudeCleanupResult> {
  const startTime = Date.now();
  const dryRun = input.dry_run !== false; // default true
  const olderThanHours = input.older_than_hours ?? 0;

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
}
