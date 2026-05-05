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
}

export type BackgroundJobType = "query" | "review" | "implement" | "apply" | "cleanup";
export type BackgroundJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface BackgroundJobSummary {
  job_id: string;
  type: BackgroundJobType;
  status: BackgroundJobStatus;
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

export interface ClaudeJobWaitInput {
  cwd: string;
  job_id: string;
  timeout_ms?: number;
  poll_interval_ms?: number;
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

export const claudeStatusInputSchema = z.object({
  cwd: cwdSchema,
});

export const claudeQueryInputSchema = z.object({
  task: taskSchema,
  cwd: cwdSchema,
  timeout_sec: timeoutSchema.default(120),
  max_turns: maxTurnsSchema.default(8),
  background: z.boolean().optional(),
});

export const claudeReviewInputSchema = z.object({
  task: taskSchema,
  cwd: cwdSchema,
  diff: z.string().optional(),
  files: filesSchema,
  timeout_sec: timeoutSchema.default(180),
  max_turns: maxTurnsSchema.default(10),
  background: z.boolean().optional(),
});

export const claudeImplementInputSchema = z.object({
  task: taskSchema,
  cwd: cwdSchema,
  files: filesSchema,
  constraints: constraintsSchema,
  timeout_sec: timeoutSchema.default(600),
  max_turns: maxTurnsSchema.default(15),
  session_key: z.string().trim().min(1).optional(),
  fork_session: z.boolean().optional(),
  resume_latest: z.boolean().optional(),
  max_cost_usd: z.number().positive().max(10).optional(),
  max_changed_files: z.number().int().positive().max(100).optional(),
  worktreeName: worktreeNameSchema,
  background: z.boolean().optional(),
}).refine((value) => !value.fork_session || !!value.session_key, {
  message: "fork_session requires session_key",
  path: ["fork_session"],
}).refine((value) => !value.resume_latest || !value.session_key, {
  message: "resume_latest cannot be combined with session_key",
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
  prompt += `- Answer thoroughly with all relevant details.\n`;
  prompt += `- Return your answer in a structured result with: answer (a single string containing your complete answer with all details).\n`;

  return prompt;
}

// ---- MCP tool result helpers ----

export function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

export function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
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
