import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeEnv } from "./guard.js";
import { JobStore, type BackgroundJobRecord } from "./jobs.js";
import type {
  BackgroundJobEnqueueResult,
  BackgroundJobStaleState,
  BackgroundJobSummary,
  BackgroundJobType,
  ClaudeApplyInput,
  ClaudeCleanupInput,
  ClaudeImplementInput,
  ClaudeJobCancelInput,
  ClaudeJobCleanupInput,
  ClaudeJobCleanupResult,
  ClaudeJobResultInput,
  ClaudeJobWaitInput,
  ClaudeJobWaitResult,
  ClaudeJobsInput,
  ClaudeJobsResult,
  ClaudeQueryInput,
  ClaudeResult,
  ClaudeReviewInput,
  ClaudeWaitMetadata,
  RunLogStatus,
  WorkflowNextAction,
} from "./schema.js";

export const JOB_STATE_DIR_ENV = "CODEX_CLAUDE_BACKGROUND_STATE_DIR";
const JOB_HEARTBEAT_INTERVAL_MS = 15000;
const JOB_RUNNER_STARTUP_GRACE_MS = 100;
const STALE_CANDIDATE_HEARTBEAT_MS = 90_000;
const STALE_HEARTBEAT_MS = 300_000;

export const __test: {
  inlineWaitPollIntervalMs: number;
  inlineWaitTimeoutMs: number;
} = {
  inlineWaitPollIntervalMs: 2000,
  inlineWaitTimeoutMs: 540_000,
};

export function getBackgroundStateDir(): string {
  if (process.env[JOB_STATE_DIR_ENV]) {
    return path.resolve(process.env[JOB_STATE_DIR_ENV]!);
  }
  if (process.env.CODEX_CLAUDE_RUN_LOG_DIR) {
    return path.dirname(path.resolve(process.env.CODEX_CLAUDE_RUN_LOG_DIR));
  }
  return path.join(process.cwd(), ".codex-claude-delegate");
}

export async function getJobStore(): Promise<JobStore> {
  const store = new JobStore(getBackgroundStateDir());
  await store.init();
  return store;
}

function isRunLogStatus(value: unknown): value is RunLogStatus {
  return value === "success" || value === "failed" || value === "partial" || value === "needs_user" || value === "unknown";
}

export function extractBackgroundResultStatus(result?: Record<string, unknown>): RunLogStatus | undefined {
  if (!result) return undefined;
  if (isRunLogStatus(result.status)) return result.status;
  const claudeReport = result.claude_report;
  if (claudeReport && typeof claudeReport === "object") {
    const reportStatus = (claudeReport as { status?: unknown }).status;
    if (isRunLogStatus(reportStatus)) return reportStatus;
  }
  return undefined;
}

export function toJobSummary(record: BackgroundJobRecord): BackgroundJobSummary {
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
  return `An equivalent ${job.type} job is already ${job.status}: ${job.job_id}. Use claude_task(job_id="${job.job_id}") to continue waiting; do not restart or duplicate the task.`;
}

export function buildWaitMetadata(input: {
  mode?: "block" | "background";
  timeoutSec?: number;
  completedInline?: boolean;
  waiting?: boolean;
  timedOut?: boolean;
  doNotStartDuplicateJob?: boolean;
}): ClaudeWaitMetadata {
  return {
    mode: input.mode ?? "block",
    timeout_sec: input.timeoutSec ?? 540,
    completed_inline: input.completedInline === true,
    waiting: input.waiting === true,
    timed_out: input.timedOut === true,
    do_not_start_duplicate_job: input.doNotStartDuplicateJob === true,
    continuation_tool: "claude_task",
    progress_notifications: "not_available",
    progress_note: "The current MCP SDK/server wrapper does not expose a request progress token in this handler, so progress is represented in structured wait metadata.",
  };
}

export type InlineWaitResult = {
  status: "completed" | "running" | "stale" | "not_found";
  job?: BackgroundJobSummary;
  jobRecord?: BackgroundJobRecord;
};

export async function waitForJobCompletionInline(
  jobStore: JobStore,
  jobId: string,
  cwd: string,
  waitTimeoutMs: number,
  pollIntervalMs?: number,
): Promise<InlineWaitResult> {
  const interval = pollIntervalMs ?? __test.inlineWaitPollIntervalMs;
  const deadline = Date.now() + waitTimeoutMs;

  while (Date.now() < deadline) {
    const record = await jobStore.get(jobId);
    if (!record || record.cwd !== cwd) {
      return { status: "not_found" };
    }

    const job = toJobSummary(record);
    if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled" || job.status === "crashed") {
      return { status: "completed", job, jobRecord: record };
    }

    const heartbeatAgeMs = ageMsSince(job.heartbeat_at ?? job.updated_at, Date.now()) ?? 0;
    const pidAlive = isPidAlive(job.pid);
    if (classifyJobStaleState({ job, heartbeatAgeMs, pidAlive }) === "stale") {
      return { status: "stale", job };
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  const record = await jobStore.get(jobId);
  if (!record || record.cwd !== cwd) return { status: "not_found" };
  return { status: "running", job: toJobSummary(record) };
}

export function startJobHeartbeat(jobStore: JobStore, jobId: string, intervalMs = JOB_HEARTBEAT_INTERVAL_MS): () => void {
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
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function classifyJobStaleState(input: {
  job: BackgroundJobSummary;
  heartbeatAgeMs?: number;
  pidAlive?: boolean;
}): BackgroundJobStaleState {
  if (input.job.status !== "queued" && input.job.status !== "running") return "fresh";
  if (input.pidAlive === false) return "stale";
  const heartbeatAgeMs = input.heartbeatAgeMs;
  if (heartbeatAgeMs === undefined) return "fresh";
  if (heartbeatAgeMs > STALE_HEARTBEAT_MS) return "stale";
  if (heartbeatAgeMs > STALE_CANDIDATE_HEARTBEAT_MS) return "stale_candidate";
  return "fresh";
}

function buildActiveWaitActions(cwd: string, job: BackgroundJobSummary, staleState: BackgroundJobStaleState): WorkflowNextAction[] {
  if (staleState === "stale") {
    return [
      {
        tool: "claude_job_cancel",
        reason: "Job appears stale because heartbeat is too old or its pid is gone. Cancel only after inspecting or when intentionally abandoning this run.",
        args: { cwd, job_id: job.job_id },
      },
      {
        tool: "claude_workspace_status",
        reason: "Inspect workspace-level state before deciding whether to cancel, apply, cleanup, or retry.",
        args: { cwd },
      },
      {
        tool: "claude_job_result",
        reason: "Inspect persisted job details before starting a replacement job.",
        args: { cwd, job_id: job.job_id },
      },
    ];
  }
  return [{ tool: "claude_task", reason: "Claude is still working. Continue waiting for the same job_id instead of starting a duplicate task.", args: { cwd, job_id: job.job_id, wait_strategy: "block", wait_timeout_sec: 540 } }];
}

function buildJobNextActions(cwd: string, job: BackgroundJobSummary): WorkflowNextAction[] {
  if (job.status === "queued" || job.status === "running") {
    return buildActiveWaitActions(cwd, job, "fresh");
  }

  if (job.type === "review") {
    return [
      {
        tool: "claude_review",
        reason: "Run another review pass or adjust review instructions if follow-up validation is needed.",
        args: { cwd },
      },
    ];
  }

  return [];
}

function summarizeWithOutcome(type: BackgroundJobType, result: Record<string, unknown>, summary: string): string {
  const status = extractBackgroundResultStatus(result);
  if (!status || status === "success") return summary;
  const label = type === "query" ? "Query" : type === "review" ? "Review" : type === "implement" ? "Implement" : type === "apply" ? "Apply" : "Cleanup";
  return `${label} ${status}: ${summary}`;
}

export function summarizeBackgroundResult(type: BackgroundJobType, result: Record<string, unknown>): string | undefined {
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
  return summarizeWithOutcome(type, result, "Review completed");
}

export function getBackgroundWorktreeName(type: BackgroundJobType, payload: Record<string, unknown>, result: Record<string, unknown>): string | undefined {
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

function formatJobRunnerCommand(args: string[]): string {
  return [process.execPath, ...args].join(" ");
}

function waitForJobRunnerStartup(child: ChildProcess, args: string[], timeoutMs = JOB_RUNNER_STARTUP_GRACE_MS): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      resolve(error);
    };
    const onError = (err: Error) => finish(`Background job runner failed to start: ${err.message}`);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      finish(`Background job runner exited during startup (${reason}). Command: ${formatJobRunnerCommand(args)}`);
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    timer.unref?.();
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function buildBackgroundJobResponse(input: { cwd: string; job: BackgroundJobSummary; deduped?: boolean }): BackgroundJobEnqueueResult {
  const deduped = input.deduped === true;
  return {
    job: input.job,
    deduped,
    do_not_start_duplicate_job: deduped || input.job.status === "queued" || input.job.status === "running",
    message: deduped ? buildDuplicateJobMessage(input.job) : undefined,
    next_actions: buildJobNextActions(input.cwd, input.job),
  };
}

export async function enqueueBackgroundJob(input: {
  cwd: string;
  type: BackgroundJobType;
  payload: Record<string, unknown>;
  dedupe?: boolean;
}): Promise<BackgroundJobEnqueueResult> {
  const jobStore = await getJobStore();
  const fingerprint = input.dedupe === true ? createTaskFingerprint({ cwd: input.cwd, type: input.type, payload: input.payload }) : undefined;
  if (fingerprint) {
    const existing = await jobStore.findActiveByFingerprint({ cwd: input.cwd, type: input.type, fingerprint });
    if (existing) return buildBackgroundJobResponse({ cwd: input.cwd, job: toJobSummary(existing), deduped: true });
  }

  const now = new Date().toISOString();
  const jobId = `job-${randomUUID()}`;
  const record: BackgroundJobRecord = { job_id: jobId, type: input.type, status: "queued", cwd: input.cwd, created_at: now, updated_at: now, fingerprint, payload: input.payload };
  await jobStore.create(record);

  let child: ChildProcess;
  const runnerArgs = getJobRunnerArgs(jobId);
  try {
    child = spawn(process.execPath, runnerArgs, {
      cwd: input.cwd,
      detached: true,
      stdio: "ignore",
      env: { ...sanitizeEnv(), [JOB_STATE_DIR_ENV]: getBackgroundStateDir() },
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const updated = await jobStore.update(jobId, { status: "failed", updated_at: new Date().toISOString(), summary: "Background job runner failed to start", error });
    return buildBackgroundJobResponse({ cwd: input.cwd, job: toJobSummary(updated ?? { ...record, status: "failed", error }) });
  }
  child.unref();

  const launchError = await waitForJobRunnerStartup(child, runnerArgs);
  if (launchError) {
    const updated = await jobStore.update(jobId, { status: "failed", pid: child.pid ?? undefined, updated_at: new Date().toISOString(), summary: "Background job runner failed to start", error: launchError });
    return buildBackgroundJobResponse({ cwd: input.cwd, job: toJobSummary(updated ?? { ...record, status: "failed", pid: child.pid ?? undefined, error: launchError }) });
  }

  const updated = await jobStore.update(jobId, { pid: child.pid ?? undefined, updated_at: new Date().toISOString() });
  return buildBackgroundJobResponse({ cwd: input.cwd, job: toJobSummary(updated ?? { ...record, pid: child.pid ?? undefined }) });
}

export async function startBackgroundReview(input: ClaudeReviewInput): Promise<BackgroundJobEnqueueResult> {
  return enqueueBackgroundJob({ cwd: input.cwd, type: "review", payload: { ...input }, dedupe: true });
}

export async function startBackgroundQuery(input: ClaudeQueryInput): Promise<BackgroundJobEnqueueResult> {
  return enqueueBackgroundJob({ cwd: input.cwd, type: "query", payload: { ...input }, dedupe: true });
}

export async function startBackgroundImplement(input: ClaudeImplementInput): Promise<BackgroundJobEnqueueResult> {
  return enqueueBackgroundJob({ cwd: input.cwd, type: "implement", payload: { ...input }, dedupe: true });
}

export async function startBackgroundApply(input: ClaudeApplyInput): Promise<BackgroundJobEnqueueResult> {
  return enqueueBackgroundJob({ cwd: input.cwd, type: "apply", payload: { ...input } });
}

export async function startBackgroundCleanup(input: ClaudeCleanupInput): Promise<BackgroundJobEnqueueResult> {
  return enqueueBackgroundJob({ cwd: input.cwd, type: "cleanup", payload: { ...input } });
}

export async function listBackgroundJobs(input: ClaudeJobsInput): Promise<ClaudeJobsResult> {
  const jobStore = await getJobStore();
  const entries = await jobStore.list({ cwd: input.cwd, limit: input.limit ?? 20, status: input.status, type: input.type });
  return { entries: entries.map(toJobSummary) };
}

export async function getBackgroundJobResult(input: ClaudeJobResultInput): Promise<{ job: BackgroundJobSummary; result?: Record<string, unknown> } | null> {
  const jobStore = await getJobStore();
  const job = await jobStore.get(input.job_id);
  if (!job || job.cwd !== input.cwd) return null;
  return { job: toJobSummary(job), result: job.result };
}

export async function waitForBackgroundJob(input: ClaudeJobWaitInput): Promise<ClaudeJobWaitResult> {
  const jobStore = await getJobStore();
  const record = await jobStore.get(input.job_id);
  if (!record || record.cwd !== input.cwd) throw new Error(`Job not found: ${input.job_id}`);

  if (record.status === "succeeded" || record.status === "failed" || record.status === "cancelled" || record.status === "crashed") {
    const job = toJobSummary(record);
    return {
      job,
      result: record.result,
      status: job.status,
      summary: `Job ${input.job_id} is ${job.status}; use the returned result or claude_result for follow-up.`,
      waiting: false,
      timed_out: false,
      do_not_start_duplicate_job: false,
      age_ms: ageMsSince(record.created_at, Date.now()) ?? 0,
      stale_state: "fresh",
      wait: buildWaitMetadata({ completedInline: true, waiting: false, doNotStartDuplicateJob: false }),
      next_actions: buildJobNextActions(input.cwd, job),
    };
  }

  const inlineResult = await waitForJobCompletionInline(jobStore, input.job_id, input.cwd, Math.min(__test.inlineWaitTimeoutMs, 540_000));
  if (inlineResult.status === "not_found") throw new Error(`Job not found: ${input.job_id}`);
  if (inlineResult.status === "completed") {
    const job = inlineResult.job!;
    return {
      job,
      result: inlineResult.jobRecord?.result,
      status: job.status,
      summary: `Job ${input.job_id} is ${job.status}; use the returned result or claude_result for follow-up.`,
      waiting: false,
      timed_out: false,
      do_not_start_duplicate_job: false,
      age_ms: ageMsSince(job.created_at, Date.now()) ?? 0,
      stale_state: "fresh",
      wait: buildWaitMetadata({ completedInline: true, waiting: false, doNotStartDuplicateJob: false }),
      next_actions: buildJobNextActions(input.cwd, job),
    };
  }
  if (inlineResult.status === "stale") {
    const job = inlineResult.job!;
    return {
      job,
      result: undefined,
      status: job.status,
      summary: `Job ${input.job_id} appears stale; inspect or cancel it before starting any replacement job.`,
      waiting: true,
      timed_out: false,
      do_not_start_duplicate_job: true,
      age_ms: ageMsSince(job.created_at, Date.now()) ?? 0,
      heartbeat_age_ms: ageMsSince(job.heartbeat_at ?? job.updated_at, Date.now()),
      stale_state: "stale",
      wait: buildWaitMetadata({ completedInline: false, waiting: true, doNotStartDuplicateJob: true }),
      next_actions: buildActiveWaitActions(input.cwd, job, "stale"),
    };
  }

  const job = inlineResult.job!;
  return {
    job,
    result: undefined,
    status: job.status,
    summary: `Job ${input.job_id} is still ${job.status}; do not duplicate this task locally. Use claude_task(job_id=...) to continue waiting.`,
    waiting: true,
    timed_out: false,
    do_not_start_duplicate_job: true,
    age_ms: ageMsSince(job.created_at, Date.now()) ?? 0,
    heartbeat_age_ms: ageMsSince(job.heartbeat_at ?? job.updated_at, Date.now()),
    stale_state: classifyJobStaleState({ job, heartbeatAgeMs: ageMsSince(job.heartbeat_at ?? job.updated_at, Date.now()), pidAlive: isPidAlive(job.pid) }),
    wait: buildWaitMetadata({ completedInline: false, waiting: true, doNotStartDuplicateJob: true }),
    next_actions: buildActiveWaitActions(input.cwd, job, "fresh"),
  };
}

export async function cancelBackgroundJob(input: ClaudeJobCancelInput): Promise<{ cancelled: boolean; job?: BackgroundJobSummary; error?: string }> {
  const jobStore = await getJobStore();
  const job = await jobStore.get(input.job_id);
  if (!job || job.cwd !== input.cwd) return { cancelled: false, error: `Job not found: ${input.job_id}` };
  if (job.status === "cancelled" || job.status === "failed" || job.status === "succeeded" || job.status === "crashed") {
    return { cancelled: false, job: toJobSummary(job), error: `Job is already ${job.status}` };
  }
  if (job.status === "running" && job.pid) {
    try {
      process.kill(job.pid, "SIGTERM");
    } catch (err) {
      return { cancelled: false, job: toJobSummary(job), error: err instanceof Error ? err.message : String(err) };
    }
  }
  const updated = await jobStore.update(job.job_id, { status: "cancelled", updated_at: new Date().toISOString(), summary: job.summary ?? "Cancelled by user", error: undefined });
  return { cancelled: true, job: updated ? toJobSummary(updated) : undefined };
}

export async function findActiveImplementByWorktree(input: { cwd: string; worktree_name: string }): Promise<BackgroundJobRecord | null> {
  const jobStore = await getJobStore();
  return jobStore.findActiveImplementByWorktree(input);
}

export async function cleanupBackgroundJobs(input: ClaudeJobCleanupInput): Promise<ClaudeJobCleanupResult> {
  const jobStore = await getJobStore();
  return jobStore.cleanup({ cwd: input.cwd, older_than_hours: input.older_than_hours ?? 24, dry_run: input.dry_run ?? true, limit: input.limit ?? 20 });
}

// ---- Crash recovery constants ----

const RECOVERY_MIN_AGE_MS = 30_000;
const RECOVERY_STALE_HEARTBEAT_MS = 300_000;
const RECOVERY_QUEUED_NO_PID_MIN_AGE_MS = 300_000;

function isPidAliveForRecovery(pid: number | undefined): boolean | undefined {
  if (!pid) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function ageMsForRecovery(timestamp: string | undefined, nowMs: number): number | undefined {
  if (!timestamp) return undefined;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, nowMs - parsed);
}

export async function recoverCrashedJobs(): Promise<number> {
  const store = await getJobStore();
  const activeQueued = await store.list({ limit: 1000, status: "queued" });
  const activeRunning = await store.list({ limit: 1000, status: "running" });
  const candidates = [...activeQueued, ...activeRunning];
  if (candidates.length === 0) return 0;

  const nowMs = Date.now();
  let crashedCount = 0;

  for (const job of candidates) {
    const jobAgeMs = ageMsForRecovery(job.created_at, nowMs) ?? 0;
    if (jobAgeMs < RECOVERY_MIN_AGE_MS) continue;

    const pidAlive = isPidAliveForRecovery(job.pid);
    const heartbeatAgeMs = ageMsForRecovery(job.heartbeat_at ?? job.updated_at, nowMs);

    let shouldCrash = false;

    // A live PID wins over stale heartbeat data. PID reuse can leave a dead job
    // looking alive, but marking it crashed would risk misclassifying active work.
    if (pidAlive === true) continue;

    if (job.status === "running") {
      if (pidAlive === false) {
        shouldCrash = true;
      } else if (heartbeatAgeMs !== undefined && heartbeatAgeMs > RECOVERY_STALE_HEARTBEAT_MS) {
        shouldCrash = true;
      }
    } else if (job.status === "queued") {
      if (!job.pid && jobAgeMs < RECOVERY_QUEUED_NO_PID_MIN_AGE_MS) continue;
      if (pidAlive === false) {
        shouldCrash = true;
      } else if (!job.pid && (heartbeatAgeMs === undefined || heartbeatAgeMs > RECOVERY_STALE_HEARTBEAT_MS)) {
        shouldCrash = true;
      } else if (heartbeatAgeMs !== undefined && heartbeatAgeMs > RECOVERY_STALE_HEARTBEAT_MS) {
        shouldCrash = true;
      }
    }

    if (!shouldCrash) continue;

    const now = new Date().toISOString();
    await store.update(job.job_id, {
      status: "crashed",
      updated_at: now,
      error: "Background job process is no longer alive and was recovered as crashed on server restart.",
    });
    crashedCount++;
  }

  return crashedCount;
}
