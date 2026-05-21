import { writeFile, mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { execCapture } from "./guard.js";
import {
  applyDirtySnapshotToWorktree,
  ensureImplementWorkspaceScaffold,
  findDirtyFiles,
  findDirtyImplementFiles,
  findDirtyMainWorkspaceFiles,
  formatDirtyImplementMessage,
  getWorktreeStatus,
  isIgnoredMainWorkspaceDirtyFile,
  listDirtyMainWorkspaceEntries,
  parseNameStatusPorcelainZ,
  parseStatusPorcelainZ,
} from "./worktree-observer.js";
export { parseStatusPorcelainZ, parseNameStatusPorcelainZ };
import type { BackgroundJobRecord } from "./jobs.js";
import { acquireFileLock, LockBusyError } from "./lock.js";
import { computeRepoKey, RECENT_WINDOW_MINUTES } from "./session.js";
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
  ClaudeJobWaitInput,
  ClaudeJobWaitResult,
  ClaudeJobsInput,
  ClaudeJobsResult,
  ClaudeQueryInput,
  ClaudeReviewInput,
  ClaudeResult,
  ClaudeRunInspectInput,
  ClaudeRunsInput,
  ClaudeRunsResult,
  ClaudeStatusResult,
  ClaudeSetupInput,
  ClaudeSetupResult,
  ClaudeTaskInput,
  ClaudeTaskMode,
  ClaudeTaskResult,
  CleanupEntry,
  ExecutionMetadata,
  ModeInference,
  ServerObserved,
  SessionLog,
  ToolEnvelope,
  SecurityProfile,
  SensitiveFilePolicy,
} from "./schema.js";
import {
  QUERY_SCHEMA,
  REVIEW_SCHEMA,
  IMPLEMENT_SCHEMA,
  ImplementRunLogSchema,
  buildSensitiveFileDenyPatterns,
  claudeApplyInputSchema,
  claudeCleanupInputSchema,
  claudeImplementInputSchema,
  claudeQueryInputSchema,
  claudeReviewInputSchema,
  buildImplementPrompt,
  buildQueryPrompt,
  buildReviewPrompt,
  toResultRecord,
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
  getRunLogDir,
  normalizeRepoPath,
  isUnderRequestedFile,
  normalizeRequestedFiles,
  logRun,
  findImplementLogForWorktree,
  updateImplementLifecycleForWorktree,
  readRunLogFile,
  listRunLogs,
  getRecentRunsSummary,
  getRunLogById,
} from "./run-logs.js";
import type { ImplementRunLog } from "./run-logs.js";
export { listRunLogs, getRecentRunsSummary, getRunLogById } from "./run-logs.js";
import {
  __test as backgroundJobsTestState,
  cancelBackgroundJob as cancelBackgroundJobCore,
  cleanupBackgroundJobs as cleanupBackgroundJobsCore,
  enqueueBackgroundJob as enqueueBackgroundJobCore,
  extractBackgroundResultStatus as extractBackgroundResultStatusCore,
  findActiveImplementByWorktree as findActiveImplementByWorktreeCore,
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
  recoverCrashedJobs as recoverCrashedJobsCore,
} from "./background-jobs.js";

import {
  buildWaitMetadata,
  createTaskFingerprint,
  manageClaudeReviewGate,
  markReviewGatePending,
  clearReviewGatePendingIfMatches,
  runClaudeSetup as executeReviewGateSetup,
} from "./review-gate.js";
export { manageClaudeReviewGate, markReviewGatePending, clearReviewGatePendingIfMatches, createTaskFingerprint };

// Test-only overrides for inline wait timing (never read from env in production)
export const __test = backgroundJobsTestState;

import { getStore, resolveWorkflowSessionSummary, buildNextActions, getClaudeResult } from "./workflow-results.js";
export { getClaudeResult, getWorkspaceStatus } from "./workflow-results.js";

const getBackgroundStateDir = getBackgroundStateDirCore;
const getJobStore = getJobStoreCore;
const toJobSummary = toJobSummaryCore;
const extractBackgroundResultStatus = extractBackgroundResultStatusCore;
const waitForJobCompletionInline = waitForJobCompletionInlineCore;
const startJobHeartbeat = startJobHeartbeatCore;
const summarizeBackgroundResult = summarizeBackgroundResultCore;
const getBackgroundWorktreeName = getBackgroundWorktreeNameCore;
const findActiveImplementByWorktree = findActiveImplementByWorktreeCore;

export const recoverCrashedJobs = recoverCrashedJobsCore;

export async function runClaudeSetup(input: ClaudeSetupInput): Promise<ClaudeSetupResult> {
  return executeReviewGateSetup(input, checkClaudeStatus);
}

export function deriveImplementWorktreeName(input: { worktreeName?: string }, runId: string): string {
  return input.worktreeName ?? `codex-delegated-${runId.slice(0, 8)}`;
}

// ---- Logging (stderr only, never stdout) ----

function log(msg: string): void {
  process.stderr.write(`[claude-delegate] ${msg}\n`);
}

async function findImplementJobForWorktree(worktreePath: string, cwd: string): Promise<BackgroundJobRecord | null> {
  const wtName = path.basename(worktreePath);
  const jobStore = await getJobStore();
  const jobs = await jobStore.list({
    cwd,
    limit: 100,
    type: "implement",
  });
  const terminalStatuses = new Set(["succeeded", "failed", "cancelled", "crashed"]);
  return jobs.find((job) => job.worktree_name === wtName && terminalStatuses.has(job.status)) ?? null;
}

// ---- Mode inference helpers ----

/** English write keywords (used with \b word boundary). */
const EN_WRITE_RE = /\b(fix|change|implement|write|edit|modify|update|refactor|patch|add|create)\b/;
/** Chinese write keywords — no \b since JS \b is unreliable for CJK. */
const ZH_WRITE_RE = /修复|实现|修改|添加|重构|补充|提交|更新|创建|编写|删除|移除|调整|优化|改造/;
/** English review keywords. */
const EN_REVIEW_RE = /\b(review|audit|inspect|check|find bugs|look for issues|critique)\b/;
/** Chinese review keywords. */
const ZH_REVIEW_RE = /审查|检查|评审|看看有没有问题|找一下风险|找\s?bug|找问题/;
/** English read keywords. */
const EN_READ_RE = /\b(explain|analyse|analyze|why|how|what|summarize|describe|read-only|understand)\b/;
/** Chinese read keywords. */
const ZH_READ_RE = /解释|分析|总结|为什么|怎么|如何|说明|描述|理解/;
/** Chinese query prefixes — checked at start of task only. */
const ZH_QUERY_PREFIX_RE = /^(解释|说明|为什么|怎么|如何|怎样|分析|总结|描述|理解|搞清楚)/;

export function inferClaudeTaskMode(input: ClaudeTaskInput): { mode: Exclude<ClaudeTaskMode, "auto">; inference: ModeInference } {
  const requestedMode: ClaudeTaskMode = input.mode ?? "auto";

  // Priority 1: explicit mode
  if (input.mode && input.mode !== "auto") {
    return {
      mode: input.mode,
      inference: { requested_mode: requestedMode, delegated_mode: input.mode, reason: "explicit", confidence: "high", matched_hints: ["explicit"] },
    };
  }

  const text = (input.task ?? "").toLowerCase();

  // Priority 2: diff present → review
  if (typeof input.diff === "string" && input.diff.trim().length > 0) {
    return {
      mode: "review",
      inference: { requested_mode: "auto", delegated_mode: "review", reason: "diff", confidence: "high", matched_hints: ["diff"] },
    };
  }

  // Priority 3: constraints → write
  if ((input.constraints?.length ?? 0) > 0) {
    return {
      mode: "write",
      inference: { requested_mode: "auto", delegated_mode: "write", reason: "constraints", confidence: "high", matched_hints: ["constraints"] },
    };
  }

  // Priority 4: query prefix at task start → read (overrides write hints)
  if (input.task) {
    const taskText = input.task.trimStart();
    if (ZH_QUERY_PREFIX_RE.test(taskText)) {
      const matched = taskText.match(ZH_QUERY_PREFIX_RE)?.[0] ?? "query_prefix";
      return {
        mode: "read",
        inference: { requested_mode: "auto", delegated_mode: "read", reason: "query_prefix_override", confidence: "medium", matched_hints: [matched] },
      };
    }
  }

  // Priority 5: write hints (English uses \b; Chinese does not)
  if (input.task) {
    const enMatch = text.match(EN_WRITE_RE);
    const zhMatch = input.task.match(ZH_WRITE_RE);
    if (enMatch || zhMatch) {
      const hints: string[] = [];
      if (enMatch) hints.push(enMatch[0]);
      if (zhMatch) hints.push(zhMatch[0]);
      return {
        mode: "write",
        inference: { requested_mode: "auto", delegated_mode: "write", reason: "write_hints", confidence: "high", matched_hints: hints },
      };
    }
  }

  // Priority 6: review hints
  if (input.task) {
    const enMatch = text.match(EN_REVIEW_RE);
    const zhMatch = input.task.match(ZH_REVIEW_RE);
    if (enMatch || zhMatch) {
      const hints: string[] = [];
      if (enMatch) hints.push(enMatch[0]);
      if (zhMatch) hints.push(zhMatch[0]);
      return {
        mode: "review",
        inference: { requested_mode: "auto", delegated_mode: "review", reason: "review_hints", confidence: "high", matched_hints: hints },
      };
    }
  }

  // Priority 7: read hints
  if (input.task) {
    const enMatch = text.match(EN_READ_RE);
    const zhMatch = input.task.match(ZH_READ_RE);
    if (enMatch || zhMatch) {
      const hints: string[] = [];
      if (enMatch) hints.push(enMatch[0]);
      if (zhMatch) hints.push(zhMatch[0]);
      return {
        mode: "read",
        inference: { requested_mode: "auto", delegated_mode: "read", reason: "read_hints", confidence: "high", matched_hints: hints },
      };
    }
  }

  // Priority 8: files → review
  if ((input.files?.length ?? 0) > 0) {
    return {
      mode: "review",
      inference: { requested_mode: "auto", delegated_mode: "review", reason: "files_fallback", confidence: "medium", matched_hints: ["files"] },
    };
  }

  // Priority 9: default read
  return {
    mode: "read",
    inference: { requested_mode: "auto", delegated_mode: "read", reason: "default_read", confidence: "low", matched_hints: [] },
  };
}

function summarizeTaskDispatch(mode: Exclude<ClaudeTaskMode, "auto">, isBackground: boolean): string {
  if (isBackground) {
    return `Delegated ${mode} task as a background job.`;
  }
  return `Delegated ${mode} task with inline wait for result.`;
}

const CLAUDE_TASK_FILES_DEPRECATED_WARNING =
  "claude_task.files is deprecated and treated as instruction_files, not apply scope. Use allowed_files for strict file modification limits.";

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
  modeInference?: ModeInference;
}): Promise<ClaudeTaskResult> {
  const { cwd, job, jobRecord, delegatedMode, completedInline, waiting, staled, modeInference } = input;

  // For completed inline results: reuse getClaudeResult for standardized aggregation
  if (completedInline && !staled) {
    const claudeResult = await getClaudeResult({ cwd, job_id: job.job_id }).catch(() => null);
    if (claudeResult) {
      return {
        delegated_mode: delegatedMode,
        mode_inference: modeInference,
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
    mode_inference: modeInference,
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
    if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled" || job.status === "crashed") {
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
  const { mode: delegatedMode, inference: modeInference } = inferClaudeTaskMode(input);
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
        sensitive_file_policy: input.sensitive_file_policy,
      });
    } else if (delegatedMode === "review") {
      queued = await startBackgroundReview({
        cwd: input.cwd,
        task: input.task!,
        diff: input.diff,
        instruction_files: instructionFiles,
        timeout_sec: INTERNAL_CLAUDE_TIMEOUT_SEC,
        reviewed_run_id: input.reviewed_run_id,
        reviewed_worktree_path: input.reviewed_worktree_path,
        sensitive_file_policy: input.sensitive_file_policy,
      });
    } else {
      const implementResult = await startBackgroundImplement({
        cwd: input.cwd,
        task: input.task!,
        instruction_files: instructionFiles,
        files: input.allowed_files,
        constraints: input.constraints,
        timeout_sec: INTERNAL_CLAUDE_TIMEOUT_SEC,
        resume_latest: input.resume_latest,
        dirty_policy: input.dirty_policy,
        security_profile: input.security_profile,
        sensitive_file_policy: input.sensitive_file_policy,
        max_changed_files: input.max_changed_files,
      });
      if (!("job" in implementResult)) {
        return {
          delegated_mode: delegatedMode,
          mode_inference: modeInference,
          status: "needs_user",
          summary: "Write task needs a dirty-workspace decision before it can be delegated.",
          result: toResultRecord(implementResult),
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
        mode_inference: modeInference,
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
        mode_inference: modeInference,
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
        mode_inference: modeInference,
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
        modeInference,
      });
    }

    if (inlineResult.status === "stale") {
      const staleRecord = await jobStore.get(queued.job.job_id);
      if (!staleRecord) {
        return {
          delegated_mode: delegatedMode,
          mode_inference: modeInference,
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
        modeInference,
      });
    }

    const stillRunning = await jobStore.get(queued.job.job_id);
    return {
      delegated_mode: delegatedMode,
      mode_inference: modeInference,
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
  return startBackgroundReviewCore(input);
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
  return startBackgroundImplementCore(input);
}

export async function startBackgroundApply(input: ClaudeApplyInput): Promise<BackgroundJobEnqueueResult> {
  return startBackgroundApplyCore(input);
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
  const store = await getStore(input.cwd);
  const cutoff = Date.now() - RECENT_WINDOW_MINUTES * 60 * 1000;
  for (const run of runs.entries) {
    const raw = await readRunLogFile(run.run_id, input.cwd);
    const sessionId =
      raw && typeof raw.session?.returned_session_id === "string"
        ? raw.session.returned_session_id
        : null;
    if (!sessionId) continue;
    const session = await store.getById(sessionId);
    if (!session) continue;
    if (session.expired) continue;
    if (new Date(session.last_used).getTime() <= cutoff) continue;
    return { run_id: run.run_id, session_id: sessionId };
  }
  return null;
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


// ---- Public API ----

function readOnlyDisallowedTools(): string[] {
  return DANGEROUS_DISALLOWED_TOOLS;
}

function createQueryOptions(input: ClaudeQueryInput): ClaudeRunOptions {
  const effectiveMaxTurns = input.max_turns ?? (input.fast ? 2 : undefined);
  const effectiveTimeoutSec = input.timeout_sec ?? (input.fast ? 45 : 120);
  const sfp = buildSensitiveFileDenyPatterns(input.sensitive_file_policy ?? "default");
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
    disallowedTools: [...readOnlyDisallowedTools(), ...sfp.readDeny, ...sfp.grepGlobDeny, ...sfp.bashReadDeny],
    maxTurns: effectiveMaxTurns,
    timeoutSec: effectiveTimeoutSec,
    jsonSchema: QUERY_SCHEMA,
  };
}

function createReviewOptions(input: ClaudeReviewInput): ClaudeRunOptions {
  const sfp = buildSensitiveFileDenyPatterns(input.sensitive_file_policy ?? "default");
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
    disallowedTools: [...readOnlyDisallowedTools(), ...sfp.readDeny, ...sfp.grepGlobDeny, ...sfp.bashReadDeny],
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
  const sfp = buildSensitiveFileDenyPatterns(input.sensitive_file_policy ?? "default");
  return {
    prompt: buildImplementPrompt(input),
    cwd: input.cwd,
    tools: "Read,Glob,Grep,Edit,Write,Bash",
    allowedTools: implementAllowedTools(input.security_profile ?? "default"),
    disallowedTools: [
      ...DANGEROUS_DISALLOWED_TOOLS,
      ...sfp.readDeny,
      ...sfp.grepGlobDeny,
      ...sfp.bashReadDeny,
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
  const recent = shouldResume ? await store.getRecent(repoKey, "query", RECENT_WINDOW_MINUTES) : null;
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
      await store.upsert(session_id, "query", repoKey, input.cwd, String((report.answer as string) ?? "").slice(0, 200));
    }

    const sessionLog: SessionLog = { requested_session_id: requestedSessionId, resumed, forked, returned_session_id: session_id };
    const logWriteStart = Date.now();
    await logRun(runId, { type: "query", input, report, session: sessionLog }, input.cwd);
    const logWriteMs = Date.now() - logWriteStart;
    const pruneStart = Date.now();
    await store.prune();
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
      await store.markExpired(requestedSessionId);
      log(`Session ${requestedSessionId} not found, falling back to new session`);

      // Retry without resume
      const retryOpts: ClaudeRunOptions = { ...opts, resumeSessionId: undefined };
      try {
        const claudeRunStart = Date.now();
        const { report, session_id, execution } = await spawnClaude(retryOpts);
        const claudeRunMs = Date.now() - claudeRunStart;
        returnedSessionId = session_id;
        if (session_id) {
          await store.upsert(session_id, "query", repoKey, input.cwd, String((report.answer as string) ?? "").slice(0, 200));
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
      result = toResultRecord(await runClaudeQuery(payload as ClaudeQueryInput, runId));
    } else if (running.type === "review") {
      result = toResultRecord(await runClaudeReview(payload as ClaudeReviewInput, runId));
    } else if (running.type === "implement") {
      const implPayload = payload as ClaudeImplementInput;
      const worktreeName = deriveImplementWorktreeName(implPayload, runId);
      await jobStore.update(jobId, { worktree_name: worktreeName, run_id: runId });
      result = toResultRecord(await runClaudeImplement(implPayload, runId));
    } else if (running.type === "apply") {
      result = toResultRecord(await runClaudeApply(payload as ClaudeApplyInput, runId));
    } else {
      result = toResultRecord(await runClaudeCleanup(payload as ClaudeCleanupInput, runId));
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
    await clearReviewGatePendingIfMatches(input.cwd, {
      review_run_id: runId,
      reviewed_run_id: input.reviewed_run_id,
      reviewed_worktree_path: input.reviewed_worktree_path,
    }).catch(() => {});
    return makeEnvelope("success", report, execution, [], { claude_report: report });
  } catch (err) {
    await logRun(runId, { type: "review", input, error: (err as Error).message }, input.cwd);
    throw err;
  }
}

function buildPermissionDenialWarning(report: Record<string, unknown>): string | null {
  const denials = report.permission_denials;
  if (!Array.isArray(denials) || denials.length === 0) return null;
  const uniqueTools = [...new Set(
    denials
      .map((d) => (d as Record<string, unknown>)?.tool_name)
      .filter((name): name is string => typeof name === "string" && name.length > 0)
  )];
  const count = denials.length;
  const maxTools = 5;
  const shown = uniqueTools.slice(0, maxTools);
  const remaining = uniqueTools.length - maxTools;
  const toolsText = remaining > 0
    ? `${shown.join(", ")} and ${remaining} more`
    : shown.join(", ") || "unknown";
  return `Claude was denied permission for ${count} tool call${count === 1 ? "" : "s"} (denied: ${toolsText}); treat any self-reported test or verification results as incomplete and rerun verification locally.`;
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

  const worktreeName = deriveImplementWorktreeName(implementInput, runId);
  const worktreeRelPath = path.join(".claude", "worktrees", worktreeName);
  const worktreePath = path.join(implementInput.cwd, worktreeRelPath);
  const requestedFiles = normalizeRequestedFiles(implementInput.cwd, implementInput.files);
  const dirtyPolicy = implementInput.dirty_policy ?? "ask";
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

  const worktreeLock = await acquireFileLock({
    cwd: implementInput.cwd,
    resource: `worktree:${worktreeName}`,
    staleMs: 5 * 60 * 1000,
  });

  try {
    let baseCommit: string | undefined;

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
  let fallbackFreshRetry = false;
  const startTime = Date.now();

  try {
    const result = await spawnClaude(opts);
    report = result.report;
    returnedSessionId = result.session_id;
    execution = result.execution;
  } catch (err) {
    const errorMsg = (err as Error).message;

    if (resumeSessionId && isSessionNotFoundError(errorMsg)) {
      await store.markExpired(resumeSessionId);
      log(`Session ${resumeSessionId} not found, marked expired; falling back to fresh implement`);

      // Bounded fresh retry: one shot in the same worktree, no recursion.
      const { session_key: _, ...inputWithoutSession } = implementInput;
      const freshInput: ClaudeImplementInput = {
        ...inputWithoutSession,
        cwd: worktreePath,
        files: requestedFiles.length > 0 ? requestedFiles : undefined,
      };
      const freshOpts = createImplementOptions(freshInput, undefined, forked);

      try {
        const freshResult = await spawnClaude(freshOpts);
        report = freshResult.report;
        returnedSessionId = freshResult.session_id;
        execution = freshResult.execution;
        fallbackFreshRetry = true;
      } catch (retryErr) {
        const retryErrorMsg = (retryErr as Error).message;
        const durationMs = Date.now() - startTime;
        const failedExecution: ExecutionMetadata = {
          exit_code: 1,
          duration_ms: durationMs,
          timed_out: false,
          stdout_tail: "",
          stderr_tail: retryErrorMsg.slice(-4000),
        };
        const failureWarnings = [
          `Claude session ${resumeSessionId} is unavailable and was marked expired. A fresh implement retry also failed: ${retryErrorMsg.slice(0, 200)}`,
        ];
        const failedReport = {
          status: "failed",
          summary: `Claude session ${resumeSessionId} is unavailable and fresh retry also failed.`,
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
          error: retryErrorMsg,
          duration_ms: durationMs,
          fallback_fresh_retry_failed: true,
        }, implementInput.cwd);
        return makeEnvelope("failed", undefined, failedExecution, failureWarnings, {
          claude_report: failedReport,
          server_observed: observed,
        });
      }
    } else {
      await logRun(runId, { type: "implement", input: implementInput, error: errorMsg, duration_ms: Date.now() - startTime }, implementInput.cwd);
      throw err;
    }
  }

  // Persist session (record only, never auto-resume implement)
  if (returnedSessionId) {
    await store.upsert(returnedSessionId, "implement", repoKey, implementInput.cwd, (report.summary as string) ?? "");
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
    resumed: fallbackFreshRetry ? false : !!resumeSessionId,
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
    ...(fallbackFreshRetry ? { fallback_fresh_retry: true } : {}),
  }, implementInput.cwd);

  await store.prune();
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
  const fallbackWarning = fallbackFreshRetry && resumeSessionId
    ? `resume_latest session ${resumeSessionId} is unavailable on Claude's side and was marked expired. The delegated worktree fell back to a fresh implement — inspect results carefully.`
    : null;
  const permissionDenialWarning = buildPermissionDenialWarning(report);
  if (permissionDenialWarning) {
    log(`Permission denials: ${Array.isArray(report.permission_denials) ? report.permission_denials.length : 0} tool calls denied`);
  }
  const warnings = [
    ...(fallbackWarning ? [fallbackWarning] : []),
    ...(permissionDenialWarning ? [permissionDenialWarning] : []),
    ...(observed.resource_limits?.warnings ?? []),
    ...(observed.scope?.warnings ?? []),
    ...recoveryWarnings,
    "Worktree is retained for inspection. After applying results, call claude_cleanup to remove old delegated worktrees.",
  ];
  await markReviewGatePending(implementInput.cwd, {
    activity: "write",
    run_id: runId,
    worktree_path: observed.worktree_path,
  }).catch(() => {});
  return makeEnvelope(status, undefined, execution, warnings, {
    claude_report: report,
    server_observed: observed,
  });
  } finally {
    await worktreeLock.release();
  }
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
      await markReviewGatePending(input.cwd, {
        activity: "apply",
        run_id: runId,
        worktree_path: input.worktree_path,
      }).catch(() => {});
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
  // Reject nested delegated worktree paths (e.g. worktrees/codex-delegated-a/worktrees/codex-delegated-b)
  const nestedMarker = `${path.sep}.claude${path.sep}worktrees${path.sep}codex-delegated-`;
  const firstMarkerIdx = wtReal.indexOf(nestedMarker);
  if (firstMarkerIdx >= 0 && wtReal.indexOf(nestedMarker, firstMarkerIdx + 1) >= 0) {
    return finish({
      applied_files: [],
      diff_stat: "",
      cleanup_performed: false,
      conflicts: [],
      preview: input.preview === true,
      planned_changes: [],
      error: "Nested delegated worktrees are not supported by claude_apply. Use the original repository cwd and top-level delegated worktree path instead.",
    });
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
      error: `Another operation (implement/apply/cleanup) is already using delegated worktree ${path.basename(wtReal)}. Retry after the current operation finishes.`,
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
      implementLog = ImplementRunLogSchema.parse(raw);
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

  // Patch generation for preview-with-patch mode
  let patchResult: {
    patch?: string;
    patch_truncated?: boolean;
    patch_path?: string;
    diff_sha256?: string;
    patch_bytes?: number;
    untracked_not_in_patch?: boolean;
  } = {};

  const patchMaxBytes = input.patch_max_bytes ?? 60000;

  if (input.include_patch === true) {
    let fullPatch = "";
    try {
      fullPatch = await execCapture("git", ["diff", "--binary", baseCommit, "--", ...pathspecs], {
        cwd: wtReal,
        timeoutMs: 30000,
      });
    } catch (err) {
      return finish({
        applied_files: [],
        diff_stat: diffStat,
        cleanup_performed: false,
        conflicts,
        error: `Patch generation failed: ${err instanceof Error ? err.message : String(err)}`,
        preview: input.preview === true,
        planned_changes: plannedChanges,
      });
    }

    if (fullPatch.trim()) {
      const patchBuf = Buffer.from(fullPatch, "utf8");
      const fullBytes = patchBuf.byteLength;
      const sha256 = createHash("sha256").update(patchBuf).digest("hex");

      patchResult.diff_sha256 = sha256;
      patchResult.patch_bytes = fullBytes;

      if (fullBytes <= patchMaxBytes) {
        patchResult.patch = fullPatch;
        patchResult.patch_truncated = false;
      } else {
        const patchesDir = path.join(input.cwd, ".claude", "patches");
        await mkdir(patchesDir, { recursive: true });
        const patchPath = `.claude/patches/${runId}.patch`;
        await writeFile(path.join(input.cwd, patchPath), fullPatch, "utf8");
        patchResult.patch_truncated = true;
        patchResult.patch_path = patchPath;
      }
    } else {
      patchResult.diff_sha256 = createHash("sha256").update("").digest("hex");
      patchResult.patch_bytes = 0;
      patchResult.patch_truncated = false;
    }

    // Detect untracked files: any file from untrackedStatus that maps to "??"
    // in raw porcelain is not covered by git diff.
    if (untrackedStatus) {
      const rawEntries = untrackedStatus.split("\0").filter(Boolean);
      const hasUntracked = rawEntries.some((entry) => {
        const code = entry.slice(0, 2);
        return code === "??";
      });
      if (hasUntracked) {
        patchResult.untracked_not_in_patch = true;
      }
    }
  }

  if (input.preview) {
    return finish({
      applied_files: [],
      diff_stat: diffStat,
      cleanup_performed: false,
      conflicts: [],
      preview: true,
      planned_changes: plannedChanges,
      ...patchResult,
    });
  }

  // Apply changes transactionally
  // Dynamic import to avoid circular dependency during module loading
  const { applyChangesTransactional } = await import("./transaction.js");
  const txResult = await applyChangesTransactional(input.cwd, wtReal, changes);

  if (txResult.error) {
    return finish({
      applied_files: txResult.applied_files,
      diff_stat: diffStat,
      cleanup_performed: false,
      conflicts,
      error: txResult.error,
      planned_changes: plannedChanges,
      dirty_recovery_needed: txResult.dirty_recovery_needed,
      dirty_files: txResult.dirty_files,
      rollback_error: txResult.rollback_error,
    });
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

  return finish({ applied_files: txResult.applied_files, diff_stat: diffStat, cleanup_performed: cleanupPerformed, conflicts, planned_changes: plannedChanges });
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

      // Check for active implement jobs first — always report active_job_id
      // regardless of age window.
      const activeJob = await findActiveImplementByWorktree({ cwd: input.cwd, worktree_name: name });
      if (activeJob) {
        entries.push({
          worktree_name: name,
          removed: false,
          active_job_id: activeJob.job_id,
          safe_to_remove: false,
          error: `Worktree ${name} has an active implement job (${activeJob.job_id}) and cannot be cleaned up yet.`,
        });
        continue;
      }

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
        entries.push({ worktree_name: name, removed: false, safe_to_remove: true });
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
          error: `Another operation (implement/apply/cleanup) is already using delegated worktree ${name}. Retry after the current operation finishes.`,
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
