import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// ---- Environment diagnostics types ----

export type EnvStatus = "set" | "set-redacted" | "present-in-parent-stripped" | "unset";

// ---- Tool input types ----

export interface ClaudeStatusInput {
  cwd: string;
}

export interface ClaudeQueryInput {
  task: string;
  cwd: string;
  timeout_sec?: number;
  max_turns?: number;
  background?: boolean;
  fast?: boolean;
  resume?: boolean;
}

export interface ClaudeReviewInput {
  task: string;
  cwd: string;
  diff?: string;
  files?: string[];
  timeout_sec?: number;
  max_turns?: number;
  background?: boolean;
}

export interface ClaudeImplementInput {
  task: string;
  cwd: string;
  files?: string[];
  constraints?: string[];
  timeout_sec?: number;
  max_turns?: number;
  session_key?: string;
  fork_session?: boolean;
  resume_latest?: boolean;
  max_cost_usd?: number;
  max_changed_files?: number;
  worktreeName?: string;
  background?: boolean;
  dirty_policy?: "ask" | "committed" | "snapshot";
}

export type ClaudeTaskMode = "auto" | "read" | "review" | "write";

export interface ClaudeTaskInput {
  cwd: string;
  task: string;
  mode?: ClaudeTaskMode;
  background?: boolean;
  resume_latest?: boolean;
  files?: string[];
  constraints?: string[];
  diff?: string;
  timeout_sec?: number;
  max_turns?: number;
  dirty_policy?: "ask" | "committed" | "snapshot";
}

export type BackgroundJobType = "query" | "review" | "implement" | "apply" | "cleanup";
export type BackgroundJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface BackgroundJobSummary {
  job_id: string;
  type: BackgroundJobType;
  status: BackgroundJobStatus;
  result_status?: RunLogStatus;
  cwd: string;
  created_at: string;
  updated_at: string;
  pid?: number;
  run_id?: string;
  worktree_name?: string;
  summary?: string;
  error?: string;
}

export interface ClaudeJobsInput {
  cwd: string;
  limit?: number;
  status?: BackgroundJobStatus;
  type?: BackgroundJobType;
}

export interface ClaudeJobsResult {
  entries: BackgroundJobSummary[];
}

export interface ClaudeJobResultInput {
  cwd: string;
  job_id: string;
}

export type ClaudeResultPrefer = "latest-job" | "latest-run" | "latest-implement" | "latest-review";

export interface ClaudeResultInput {
  cwd: string;
  job_id?: string;
  run_id?: string;
  prefer?: ClaudeResultPrefer;
}

export interface ClaudeJobWaitInput {
  cwd: string;
  job_id: string;
  timeout_ms?: number;
  poll_interval_ms?: number;
}

export interface ClaudeJobWaitResult {
  job: BackgroundJobSummary;
  result?: Record<string, unknown>;
  waiting: boolean;
  timed_out: boolean;
  next_actions: WorkflowNextAction[];
}

export interface ClaudeJobCancelInput {
  cwd: string;
  job_id: string;
}

export interface ClaudeJobCleanupInput {
  cwd: string;
  older_than_hours?: number;
  dry_run?: boolean;
  limit?: number;
}

export interface BackgroundJobCleanupEntry {
  job_id: string;
  type: BackgroundJobType;
  status: BackgroundJobStatus;
  updated_at: string;
  removed: boolean;
  summary?: string;
  error?: string;
}

export interface ClaudeJobCleanupResult {
  dry_run: boolean;
  matched_count: number;
  removed_count: number;
  failed_count: number;
  entries: BackgroundJobCleanupEntry[];
}

export interface WorkflowSessionSummary {
  session_id: string;
  type: "query" | "review" | "implement";
  repo_path?: string;
  last_used?: string;
  use_count?: number;
  summary?: string;
  requested_session_id?: string | null;
  returned_session_id?: string | null;
  resumed?: boolean;
  forked?: boolean;
  source: "run" | "store";
}

export interface WorkflowNextAction {
  tool: string;
  reason: string;
  args?: Record<string, unknown>;
}

export interface ClaudeResultResult {
  source_type: "job" | "run";
  summary: string;
  job?: BackgroundJobSummary;
  run?: RunLogEntrySummary;
  session?: WorkflowSessionSummary;
  result?: Record<string, unknown>;
  related_runs?: {
    apply_run_id?: string;
    cleanup_run_id?: string;
  };
  next_actions: WorkflowNextAction[];
}

export interface ClaudeWorkspaceStatusInput {
  cwd: string;
  limit?: number;
  include_terminal?: boolean;
}

export interface ClaudeSetupInput {
  cwd: string;
  configure_allow_root?: boolean;
}

export type ClaudeReviewGateAction = "status" | "enable" | "disable";

export interface ClaudeReviewGateInput {
  cwd: string;
  action?: ClaudeReviewGateAction;
}

export interface DelegatedWorktreeSummary {
  worktree_name: string;
  worktree_path: string;
  updated_at?: string;
  stale: boolean;
  orphaned?: boolean;
}

export interface WorkspaceAttentionItem {
  kind: "queued_job" | "apply_blocked" | "stale_worktree" | "orphan_worktree";
  severity: "info" | "warning";
  message: string;
}

export interface ClaudeWorkspaceStatusResult {
  workspace_root: string;
  running_jobs: BackgroundJobSummary[];
  queued_jobs: BackgroundJobSummary[];
  recent_terminal_jobs: BackgroundJobSummary[];
  recent_runs: RunLogEntrySummary[];
  latest_sessions: WorkflowSessionSummary[];
  delegated_worktrees: DelegatedWorktreeSummary[];
  counts: {
    running_jobs: number;
    queued_jobs: number;
    terminal_jobs: number;
    recent_runs: number;
    delegated_worktrees: number;
    stale_worktrees: number;
    orphan_worktrees: number;
    apply_blocked_runs: number;
  };
  attention_items: WorkspaceAttentionItem[];
}

export interface ReviewGateState {
  workspace_root: string;
  config_path: string;
  hook_manifest_path: string;
  hook_script_path: string;
  hook_installed: boolean;
  enabled: boolean;
  mode: "soft-stop";
  pending_review: boolean;
  updated_at?: string;
  last_write_at?: string;
  last_review_at?: string;
}

export interface ClaudeReviewGateResult extends ReviewGateState {
  action: ClaudeReviewGateAction;
  changed: boolean;
  summary: string;
  next_steps: string[];
}

export interface ClaudeSetupResult {
  workspace_root: string;
  allow_root_configuration?: Record<string, unknown>;
  review_gate: ReviewGateState;
  claude_available: boolean;
  claude_version: string | null;
  auth_status: "ok" | "missing" | "unknown";
  git_available: boolean;
  worktree_capable: boolean;
  cwd_valid: boolean;
  cwd_is_git_repo: boolean;
  errors: string[];
  next_steps: string[];
}

export interface ClaudeTaskResult {
  delegated_mode: Exclude<ClaudeTaskMode, "auto">;
  summary: string;
  result?: Record<string, unknown>;
  job?: BackgroundJobSummary;
  session?: WorkflowSessionSummary;
  next_actions: WorkflowNextAction[];
}

// ---- Structured output types ----

export interface TestResult {
  ran: boolean;
  command?: string;
  passed?: boolean;
  output_tail?: string;
}

export interface ClaudeReport {
  status: "success" | "failed" | "partial" | "needs_user";
  summary: string;
  changed_files: string[];
  commands_run: string[];
  tests: TestResult;
  risks: string[];
  next_steps: string[];
}

export interface ResourceLimits {
  max_cost_usd?: number;
  max_changed_files?: number;
  actual_changed_files: number;
  changed_files_exceeded: boolean;
  warnings: string[];
}

export interface ObserveScope {
  requested_files?: string[];
  out_of_scope_files: string[];
  scope_exceeded: boolean;
  warnings: string[];
}

export interface ServerObserved {
  repo_root?: string;
  worktree_name?: string;
  changed_files: string[];
  diff_stat: string;
  diff_name_only: string;
  base_commit?: string;
  head_commit?: string;
  git_status_short?: string;
  worktree_path?: string;
  resource_limits?: ResourceLimits;
  scope?: ObserveScope;
}

export interface ExecutionMetadata {
  exit_code: number | null;
  duration_ms: number;
  timed_out: boolean;
  stdout_tail: string;
  stderr_tail: string;
  timings?: Record<string, number>;
}

export interface ToolEnvelope<T> {
  status: "success" | "failed" | "partial" | "needs_user";
  data?: T;
  claude_report?: unknown;
  server_observed?: unknown;
  execution: ExecutionMetadata;
  warnings: string[];
}

export function localExecution(startTime: number): ExecutionMetadata {
  return {
    exit_code: 0,
    duration_ms: Date.now() - startTime,
    timed_out: false,
    stdout_tail: "",
    stderr_tail: "",
  };
}

export type ClaudeResult = ToolEnvelope<undefined>;

export interface EnvironmentDiagnostics {
  proxy_env_present: boolean;
  http_proxy: EnvStatus;
  https_proxy: EnvStatus;
  no_proxy: EnvStatus;
  anthropic_base_url: EnvStatus;
  anthropic_auth_token: EnvStatus;
  anthropic_api_key: EnvStatus;
  local_proxy_host?: string;
  local_proxy_port?: number;
  local_proxy_reachable?: boolean;
  local_proxy_error?: string;
  likely_sandbox_blocked: boolean;
  recommendation?: string;
}

export interface ClaudeStatusResult {
  claude_available: boolean;
  claude_version: string | null;
  auth_status: string | null;
  git_available: boolean;
  worktree_capable: boolean;
  cwd_valid: boolean;
  cwd_is_git_repo: boolean;
  delegated_worktrees_count: number;
  delegated_worktrees: string[];
  stale_worktrees_count: number;
  errors: string[];
  environment_diagnostics?: EnvironmentDiagnostics;
  recent_runs?: RecentRunsSummary;
}

export interface SessionLog {
  requested_session_id: string | null;
  resumed: boolean;
  forked: boolean;
  returned_session_id: string | null;
}

// ---- Apply types ----

export interface ClaudeApplyInput {
  cwd: string;
  worktree_path: string;
  cleanup?: boolean;
  preview?: boolean;
  background?: boolean;
}

export interface ApplyPlannedChange {
  status: string;
  file: string;
}

export interface ClaudeApplyResult {
  applied_files: string[];
  diff_stat: string;
  cleanup_performed: boolean;
  conflicts: string[];
  error?: string;
  preview?: boolean;
  planned_changes?: ApplyPlannedChange[];
}

export interface ClaudeCleanupInput {
  cwd: string;
  older_than_hours?: number;
  dry_run?: boolean;
  background?: boolean;
}

export interface CleanupEntry {
  worktree_name: string;
  removed: boolean;
  error?: string;
}

export interface ClaudeCleanupResult {
  dry_run: boolean;
  removed_count: number;
  failed_count: number;
  entries: CleanupEntry[];
}

export type RunLogType = "query" | "review" | "implement" | "apply" | "cleanup";
export type RunLogStatus = "success" | "failed" | "partial" | "needs_user" | "unknown";
export type RunLifecycle = "queued" | "running" | "success" | "partial" | "failed" | "apply_blocked" | "applied" | "cleaned" | "unknown";

export interface ClaudeRunsInput {
  cwd: string;
  limit?: number;
  type?: RunLogType;
  status?: RunLogStatus;
  worktree_name?: string;
}

export interface ClaudeRunInspectInput {
  cwd: string;
  run_id: string;
}

export interface RunLogEntrySummary {
  run_id: string;
  type: string;
  status: RunLogStatus;
  lifecycle: RunLifecycle;
  cwd?: string;
  summary?: string;
  error?: string;
  worktree_path?: string;
  worktree_name?: string;
  requested_session_id?: string | null;
  returned_session_id?: string | null;
  retried_after_session_expired?: boolean;
  started_at?: string;
  updated_at?: string;
}

export interface ClaudeRunsResult {
  entries: RunLogEntrySummary[];
  total_entries: number;
}

export interface ClaudeRunInspectResult {
  entry: RunLogEntrySummary;
  raw: Record<string, unknown>;
  related_runs?: {
    apply_run_id?: string;
    cleanup_run_id?: string;
  };
}

export interface RunSummaryCounts {
  [key: string]: number;
}

export interface RecentRunsSummary {
  entries: RunLogEntrySummary[];
  lifecycle_counts: RunSummaryCounts;
}

// ---- Tool input validation ----

const cwdSchema = z.string().trim().min(1, "cwd is required");
const taskSchema = z.string().trim().min(1, "task is required");
const timeoutSchema = z.number().int().positive().max(3600).optional();
const maxTurnsSchema = z.number().int().positive().max(50).optional();
const filesSchema = z.array(z.string().trim().min(1)).optional();
const constraintsSchema = z.array(z.string().trim().min(1)).optional();
const worktreeNameSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, "worktreeName may only contain letters, numbers, hyphens, and underscores").optional();
const dirtyPolicySchema = z.enum(["ask", "committed", "snapshot"]).optional();

export const claudeStatusInputSchema = z.object({
  cwd: cwdSchema,
});

export const claudeSetupInputSchema = z.object({
  cwd: cwdSchema,
  configure_allow_root: z.boolean().optional().default(false),
});

export const claudeQueryInputSchema = z.object({
  task: taskSchema,
  cwd: cwdSchema,
  timeout_sec: timeoutSchema.optional(),
  max_turns: maxTurnsSchema.optional(),
  background: z.boolean().optional(),
  fast: z.boolean().optional(),
  resume: z.boolean().optional(),
});

export const claudeReviewInputSchema = z.object({
  task: taskSchema,
  cwd: cwdSchema,
  diff: z.string().optional(),
  files: filesSchema,
  timeout_sec: timeoutSchema.default(180),
  max_turns: maxTurnsSchema.optional(),
  background: z.boolean().optional(),
});

export const claudeImplementInputSchema = z.object({
  task: taskSchema,
  cwd: cwdSchema,
  files: filesSchema,
  constraints: constraintsSchema,
  timeout_sec: timeoutSchema.default(600),
  max_turns: maxTurnsSchema.optional(),
  session_key: z.string().trim().min(1).optional(),
  fork_session: z.boolean().optional(),
  resume_latest: z.boolean().optional(),
  max_cost_usd: z.number().positive().max(10).optional(),
  max_changed_files: z.number().int().positive().max(100).optional(),
  worktreeName: worktreeNameSchema,
  background: z.boolean().optional(),
  dirty_policy: dirtyPolicySchema,
}).refine((value) => !value.fork_session || !!value.session_key, {
  message: "fork_session requires session_key",
  path: ["fork_session"],
}).refine((value) => !value.resume_latest || !value.session_key, {
  message: "resume_latest cannot be combined with session_key",
  path: ["resume_latest"],
});

export const claudeTaskInputSchema = z.object({
  cwd: cwdSchema,
  task: taskSchema,
  mode: z.enum(["auto", "read", "review", "write"]).optional().default("auto"),
  background: z.boolean().optional(),
  resume_latest: z.boolean().optional(),
  files: filesSchema,
  constraints: constraintsSchema,
  diff: z.string().optional(),
  timeout_sec: timeoutSchema.optional(),
  max_turns: maxTurnsSchema.optional(),
  dirty_policy: dirtyPolicySchema,
}).refine((value) => value.mode !== "read" || !value.resume_latest, {
  message: "resume_latest is only supported for write mode",
  path: ["resume_latest"],
}).refine((value) => value.mode !== "review" || !value.resume_latest, {
  message: "resume_latest is only supported for write mode",
  path: ["resume_latest"],
});

export const claudeApplyInputSchema = z.object({
  cwd: cwdSchema,
  worktree_path: z.string().trim().min(1, "worktree_path is required"),
  cleanup: z.boolean().optional(),
  preview: z.boolean().optional(),
  background: z.boolean().optional(),
});

export const claudeCleanupInputSchema = z.object({
  cwd: cwdSchema,
  older_than_hours: z.number().nonnegative().max(24 * 365).optional().default(24),
  dry_run: z.boolean().optional().default(true),
  background: z.boolean().optional(),
});

export const claudeRunsInputSchema = z.object({
  cwd: cwdSchema,
  limit: z.number().int().positive().max(200).optional().default(20),
  type: z.enum(["query", "review", "implement", "apply", "cleanup"]).optional(),
  status: z.enum(["success", "failed", "partial", "needs_user", "unknown"]).optional(),
  worktree_name: z.string().trim().min(1).optional(),
});

export const claudeRunInspectInputSchema = z.object({
  cwd: cwdSchema,
  run_id: z.string().trim().min(1, "run_id is required"),
});

export const claudeJobsInputSchema = z.object({
  cwd: cwdSchema,
  limit: z.number().int().positive().max(200).optional().default(20),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]).optional(),
  type: z.enum(["query", "review", "implement", "apply", "cleanup"]).optional(),
});

export const claudeJobResultInputSchema = z.object({
  cwd: cwdSchema,
  job_id: z.string().trim().min(1, "job_id is required"),
});

export const claudeResultInputSchema = z.object({
  cwd: cwdSchema,
  job_id: z.string().trim().min(1).optional(),
  run_id: z.string().trim().min(1).optional(),
  prefer: z.enum(["latest-job", "latest-run", "latest-implement", "latest-review"]).optional().default("latest-job"),
}).refine((value) => !(value.job_id && value.run_id), {
  message: "job_id and run_id cannot be combined",
  path: ["job_id"],
});

export const claudeJobWaitInputSchema = z.object({
  cwd: cwdSchema,
  job_id: z.string().trim().min(1, "job_id is required"),
  timeout_ms: z.number().int().positive().max(3_600_000).optional().default(30_000),
  poll_interval_ms: z.number().int().positive().max(10_000).optional().default(1_000),
});

export const claudeJobCancelInputSchema = z.object({
  cwd: cwdSchema,
  job_id: z.string().trim().min(1, "job_id is required"),
});

export const claudeJobCleanupInputSchema = z.object({
  cwd: cwdSchema,
  older_than_hours: z.number().nonnegative().max(24 * 365).optional().default(24),
  dry_run: z.boolean().optional().default(true),
  limit: z.number().int().positive().max(200).optional().default(20),
});

export const claudeWorkspaceStatusInputSchema = z.object({
  cwd: cwdSchema,
  limit: z.number().int().positive().max(200).optional().default(10),
  include_terminal: z.boolean().optional().default(true),
});

export const claudeReviewGateInputSchema = z.object({
  cwd: cwdSchema,
  action: z.enum(["status", "enable", "disable"]).optional().default("status"),
});

export function validationErrorMessage(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "input";
      return `${path}: ${issue.message}`;
    }).join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}

// ---- JSON Schemas for --json-schema flag ----

// For claude_query: answer-focused, no file/tool fields.
export const QUERY_SCHEMA = {
  type: "object",
  required: ["answer"],
  properties: {
    answer: { type: "string", description: "The full, detailed answer to the question. Include all relevant information." },
  },
} as const;

// For claude_review: findings-focused, read-only.
export const REVIEW_SCHEMA = {
  type: "object",
  required: ["findings", "recommendations", "severity"],
  properties: {
    findings: { type: "string", description: "Detailed review findings: bugs, design issues, security concerns, performance problems." },
    recommendations: { type: "string", description: "Specific, actionable recommendations for each finding." },
    severity: { type: "string", enum: ["critical", "high", "medium", "low", "none"], description: "Overall severity of issues found." },
  },
} as const;

// For claude_implement: full task report with file changes and test results.
export const IMPLEMENT_SCHEMA = {
  type: "object",
  required: ["status", "summary", "changed_files", "commands_run", "tests", "risks", "next_steps"],
  properties: {
    status: {
      type: "string",
      enum: ["success", "failed", "partial", "needs_user"],
    },
    summary: { type: "string" },
    changed_files: {
      type: "array",
      items: { type: "string" },
    },
    commands_run: {
      type: "array",
      items: { type: "string" },
    },
    tests: {
      type: "object",
      required: ["ran"],
      properties: {
        ran: { type: "boolean" },
        command: { type: "string" },
        passed: { type: "boolean" },
        output_tail: { type: "string" },
      },
    },
    risks: {
      type: "array",
      items: { type: "string" },
    },
    next_steps: {
      type: "array",
      items: { type: "string" },
    },
  },
} as const;

// Backwards-compatible alias
export const RESULT_SCHEMA = IMPLEMENT_SCHEMA;

// ---- Prompt templates ----

export function buildImplementPrompt(input: ClaudeImplementInput): string {
  let prompt = `## Task\n\n${input.task}\n\n`;

  if (input.files?.length) {
    prompt += `## Relevant Files\n\n${input.files.map((f) => `- \`${f}\``).join("\n")}\n\n`;
  }

  prompt += `## Constraints\n\n`;
  prompt += `- You are a worker delegated by Codex. Do NOT call Codex or any Codex-related tools.\n`;
  prompt += `- Do not delegate this task to another agent. Complete it yourself.\n`;
  prompt += `- Work exclusively within the provided worktree.\n`;
  prompt += `- After making changes, run the project's tests if available.\n`;

  if (input.constraints?.length) {
    prompt += input.constraints.map((c) => `- ${c}`).join("\n") + "\n";
  }

  prompt += `\n## Deliverable\n\n`;
  prompt += `Return a structured result with: status (success/failed/partial/needs_user), summary, changed_files list, commands_run list, tests (ran, command, passed, output_tail), risks list, and next_steps list.`;

  return prompt;
}

export function buildReviewPrompt(input: ClaudeReviewInput): string {
  let prompt = `## Review Request\n\n${input.task}\n\n`;

  if (input.diff) {
    prompt += `## Diff to Review\n\n\`\`\`diff\n${input.diff}\n\`\`\`\n\n`;
  }

  if (input.files?.length) {
    prompt += `## Relevant Files\n\n${input.files.map((f) => `- \`${f}\``).join("\n")}\n\n`;
  }

  prompt += `\n## Instructions\n\n`;
  prompt += `- You are a reviewer. Do NOT modify any files.\n`;
  prompt += `- Do NOT call Codex or any Codex-related tools.\n`;
  prompt += `- Follow the user's review request exactly. If the request asks for repository status, file lists, command output, workflow validation, or another read-only audit, perform that audit directly instead of inventing code-review findings.\n`;
  prompt += `- If the user restricts you to specific commands or methods, use only those exact commands or methods. Do not try command variants, path-qualified forms, or additional diagnostic commands.\n`;
  prompt += `- When constrained to specific commands or methods, base your findings only on information those commands or methods provide. Do not add file-content analysis, diff stats, or inferred details from other sources.\n`;
  prompt += `- Do not mention line counts, diff size, file contents, or file purpose unless the user explicitly asks for those details.\n`;
  prompt += `- When reviewing code changes, focus on bugs, behavioral regressions, security concerns, performance problems, and missing tests.\n`;
  prompt += `- Return your findings in a structured result with: findings (detailed description of each issue), recommendations (specific actionable fixes), and severity (one of: critical, high, medium, low, none).\n`;

  return prompt;
}

export function buildQueryPrompt(input: ClaudeQueryInput): string {
  let prompt = `## Question\n\n${input.task}\n\n`;

  prompt += `## Instructions\n\n`;
  prompt += `- You are in read-only mode. Do NOT modify any files.\n`;
  prompt += `- Do NOT call Codex or any Codex-related tools.\n`;
  if (input.fast) {
    prompt += `- Prefer a concise answer. Read only the minimum files needed to answer confidently.\n`;
    prompt += `- If repository structure is needed, prefer package/config files and top-level source names before deep file reads.\n`;
  } else {
    prompt += `- Answer thoroughly with all relevant details.\n`;
  }
  prompt += `- Return your answer in a structured result with: answer (a single string containing your complete answer with all details).\n`;

  return prompt;
}

// ---- MCP tool result helpers ----

export function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

export class StructuredToolError extends Error {
  payload: Record<string, unknown>;

  constructor(message: string, payload: Record<string, unknown>) {
    super(message);
    this.name = "StructuredToolError";
    this.payload = payload;
  }
}

export function errorResult(error: string | Record<string, unknown>): CallToolResult {
  const payload = typeof error === "string" ? { error } : error;
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: true,
  };
}

export function formatDuration(ms: number): string {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}m ${seconds}s`;
}

// end of file
