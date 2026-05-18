import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { SessionStore, computeRepoKey, type Session } from "./session.js";

import type {
  BackgroundJobSummary,
  ClaudeResultInput,
  ClaudeResultResult,
  ClaudeRunInspectResult,
  ClaudeWorkspaceStatusInput,
  ClaudeWorkspaceStatusResult,
  DelegatedWorktreeSummary,
  RunLogEntrySummary,
  WorkflowNextAction,
  WorkflowSessionSummary,
  WorkspaceAttentionItem,
} from "./schema.js";

import {
  buildResultSummaryFromRun,
  buildRunResultPayload,
  getRunLogById,
  listRunLogs,
  readRunLogFile,
} from "./run-logs.js";
import type { GenericRunLog } from "./run-logs.js";

import { getBackgroundJobResult, listBackgroundJobs } from "./background-jobs.js";

// ---- Session store (cwd-scoped, lazy init) ----

const stores = new Map<string, SessionStore>();

export async function getStore(cwd: string): Promise<SessionStore> {
  let sessionStore = stores.get(cwd);
  if (!sessionStore) {
    const sessionDir = path.join(cwd, ".codex-claude-delegate");
    sessionStore = new SessionStore(sessionDir);
    await sessionStore.init();
    stores.set(cwd, sessionStore);
  }
  return sessionStore;
}

// ---- Workflow session summary ----

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

export async function resolveWorkflowSessionSummary(input: {
  cwd: string;
  run?: RunLogEntrySummary;
}): Promise<WorkflowSessionSummary | undefined> {
  const store = await getStore(input.cwd);
  const run = input.run;

  if (run?.returned_session_id) {
    const stored = await store.getById(run.returned_session_id);
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

// ---- Next actions ----

export function buildNextActions(input: {
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

// ---- Utility ----

function compareRecency(a?: string, b?: string): number {
  const aTime = a ? Date.parse(a) : 0;
  const bTime = b ? Date.parse(b) : 0;
  return aTime - bTime;
}

// ---- Delegated worktrees ----

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

// ---- Main exported functions ----

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
  const latestSessions = (await store.listByRepo(repoKey, limit))
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
