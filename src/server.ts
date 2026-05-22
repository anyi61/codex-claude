import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateCwd, validateFilesWithinCwd, isDelegatedWorktreePath, checkRecursion, MAX_BRIDGE_DEPTH } from "./guard.js";
import { getPackageInfo } from "./package-info.js";
import { configureCodexAllowRoot, type CodexAllowRootConfiguration } from "./codex-config.js";
import {
  cancelBackgroundJob,
  checkClaudeStatus,
  cleanupBackgroundJobs,
  getClaudeResult,
  getBackgroundJobResult,
  getRunLogById,
  inferClaudeTaskMode,
  manageClaudeReviewGate,
  recoverCrashedJobs,
  runClaudeSetup,
  runClaudeTask,
  runClaudeApply,
  runClaudeCleanup,
  getRecentRunsSummary,
  listBackgroundJobs,
  listRunLogs,
  startBackgroundApply,
  startBackgroundCleanup,
  startBackgroundImplement,
  startBackgroundQuery,
  startBackgroundReview,
  getWorkspaceStatus,
  waitForBackgroundJob,
} from "./claude-cli.js";
import {
  claudeApplyInputSchema,
  claudeCleanupInputSchema,
  claudeImplementInputSchema,
  claudeJobCancelInputSchema,
  claudeJobCleanupInputSchema,
  claudeJobResultInputSchema,
  claudeJobWaitInputSchema,
  claudeJobsInputSchema,
  claudeQueryInputSchema,
  claudeResultInputSchema,
  claudeRunInspectInputSchema,
  claudeReviewInputSchema,
  claudeReviewGateInputSchema,
  claudeRunsInputSchema,
  claudeSetupInputSchema,
  claudeStatusInputSchema,
  claudeTaskInputSchema,
  claudeWorkspaceStatusInputSchema,
  errorResult,
  jsonResult,
  localExecution,
  StructuredToolError,
  validationErrorMessage,
  withInteraction,
  type ClaudeTaskResult,
  type InteractionBlock,
} from "./schema.js";

const BASE_TOOL_DEFINITIONS = [
  {
    name: "claude_status",
    description:
      "Advanced / Debug. Check Claude Code CLI availability, auth status, git worktree support, and environment readiness.",
    inputSchema: {
      type: "object",
      required: ["cwd"],
      properties: {
        cwd: { type: "string", description: "Working directory to check" },
      },
    },
  },
  {
    name: "claude_setup",
    description:
      "Default tool. Check workspace readiness for the high-level workflow layer, including review-gate hook installability and current gate state.",
    inputSchema: {
      type: "object",
      required: ["cwd"],
      properties: {
        cwd: { type: "string", description: "Working directory to inspect and prepare" },
        configure_allow_root: {
          type: "boolean",
          description:
            "When true, add cwd to CODEX_CLAUDE_ALLOW_ROOTS in the Codex config and update this MCP process so setup can continue.",
        },
      },
    },
  },
  {
    name: "claude_runs",
    description:
      "Advanced / Debug. Inspect recent delegated run logs for this repository. Use to trace implement/apply/cleanup history without reading raw JSON files.",
    inputSchema: {
      type: "object",
      required: ["cwd"],
      properties: {
        cwd: { type: "string", description: "Working directory (must be within allowed roots)" },
        limit: { type: "number", description: "Maximum number of recent runs to return (default 20)" },
        type: { type: "string", enum: ["query", "review", "implement", "apply", "cleanup"], description: "Filter by tool type" },
        status: { type: "string", enum: ["success", "failed", "partial", "needs_user", "unknown"], description: "Filter by derived run status" },
        worktree_name: { type: "string", description: "Filter by delegated worktree name" },
      },
    },
  },
  {
    name: "claude_run_inspect",
    description:
      "Advanced / Debug. Inspect a single delegated run log by run id, including normalized details and lifecycle metadata.",
    inputSchema: {
      type: "object",
      required: ["cwd", "run_id"],
      properties: {
        cwd: { type: "string", description: "Working directory (must be within allowed roots)" },
        run_id: { type: "string", description: "Run log id without the .json suffix" },
      },
    },
  },
  {
    name: "claude_result",
    description:
      "Default tool. Resolve the most relevant finished job or run for this workspace and return a normalized summary, session, and next actions.",
    inputSchema: {
      type: "object",
      required: ["cwd"],
      properties: {
        cwd: { type: "string", description: "Working directory (must be within allowed roots)" },
        job_id: { type: "string", description: "Explicit background job id to resolve first" },
        run_id: { type: "string", description: "Explicit run id to resolve if no job id is provided" },
        prefer: { type: "string", enum: ["latest-job", "latest-run", "latest-implement", "latest-review"], description: "How to choose the latest result when no explicit id is provided" },
      },
    },
  },
  {
    name: "claude_workspace_status",
    description:
      "Advanced / Debug. Show a workspace-centric view of current jobs, recent runs, recent sessions, delegated worktrees, and attention items.",
    inputSchema: {
      type: "object",
      required: ["cwd"],
      properties: {
        cwd: { type: "string", description: "Working directory (must be within allowed roots)" },
        limit: { type: "number", description: "Maximum number of recent jobs, runs, and sessions to include (default 10)" },
        include_terminal: { type: "boolean", description: "Include recent terminal background jobs in the aggregated status view (default true)" },
      },
    },
  },
  {
    name: "claude_task",
    description:
      "Default tool. High-level task entrypoint that delegates to Claude Code and waits inline for the result (up to wait_timeout_sec). Returns finalized results when the job completes within the wait window. Use claude_task(job_id=...) to continue waiting for a long-running job. Does not accept max_turns \u2014 use Advanced/Debug tools for explicit turn caps.",
    inputSchema: {
      type: "object",
      required: ["cwd"],
      properties: {
        cwd: { type: "string", description: "Working directory (must be within allowed roots)" },
        task: { type: "string", description: "High-level task to delegate. Optional when job_id is provided." },
        mode: { type: "string", enum: ["auto", "read", "review", "write"], description: "Routing mode. auto infers from diff/task wording." },
        background: { type: "boolean", description: "Legacy alias for wait_strategy='background'. Queue and return immediately." },
        wait_strategy: { type: "string", enum: ["block", "background"], description: "block (default) waits inline for the result. background returns immediately with a running job." },
        wait_timeout_sec: { type: "number", description: "Maximum seconds to wait inline for the job to finish (default 540, max 540)." },
        job_id: { type: "string", description: "Continue waiting for an existing job by id. When provided, task is ignored and no new job is created." },
        resume_latest: { type: "boolean", description: "For write mode, resume the latest implement session for this repository." },
        instruction_files: { type: "array", items: { type: "string" }, description: "Task instruction/context files. These are not apply scope limits." },
        files: { type: "array", items: { type: "string" }, description: "Deprecated for claude_task: treated as instruction_files only. Use allowed_files for hard file modification scope." },
        allowed_files: { type: "array", items: { type: "string" }, description: "Hard file modification scope. Only these files may be changed in write mode. Files changed outside this list will be rejected." },
        max_changed_files: { type: "number", description: "Warn if Claude changes more than this many files. Must be a positive integer <= 100." },
        constraints: { type: "array", items: { type: "string" }, description: "Implementation constraints for write mode" },
        diff: { type: "string", description: "Diff to review. Presence strongly biases auto mode toward review." },
        dirty_policy: { type: "string", enum: ["ask", "committed", "snapshot"], description: "Write-mode handling for uncommitted main-workspace changes: ask (default), committed (ignore dirty changes and use HEAD), or snapshot (copy dirty files into the delegated worktree)." },
        security_profile: { type: "string", enum: ["strict", "default", "permissive"], description: "Write-mode command allowlist profile. default is conservative and does not allow npx; permissive restores broader local command flexibility." },
        reviewed_run_id: { type: "string", description: "Bind this review to a specific implement/apply run id for review-gate clearing." },
        reviewed_worktree_path: { type: "string", description: "Bind this review to a specific worktree path for review-gate clearing." },
        sensitive_file_policy: { type: "string", enum: ["default", "strict", "off"], description: "Controls sensitive-file deny rules. default blocks .env/.env.*/secrets/** reads; strict adds .pem/.key/.ssh/.aws/credentials and similar; off removes only sensitive-file denies (dangerous Bash denies remain)." },
        verification_commands: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", minLength: 1, maxLength: 200 }, description: "Server-side verification commands to run in the delegated worktree after a write-mode task completes. Commands are parsed into argv and executed without a shell under a conservative allowlist." },
      },
    },
  },
  {
    name: "claude_review_gate",
    description:
      "Advanced / Debug. Inspect, enable, or disable the review gate for the current workspace. Enable persists a repo-local gate flag and ensures the stop-hook manifest is present.",
    inputSchema: {
      type: "object",
      required: ["cwd", "action"],
      properties: {
        cwd: { type: "string", description: "Working directory for the repo-local review gate state" },
        action: { type: "string", enum: ["status", "enable", "disable"], description: "Review gate action" },
      },
    },
  },
  {
    name: "claude_query",
    description:
      "Advanced / Debug. Ask Claude a read-only question as a persistent background job. Claude can read files and run safe git commands but cannot modify anything.",
    inputSchema: {
      type: "object",
      required: ["task", "cwd"],
      properties: {
        task: { type: "string", description: "The question or analysis task" },
        cwd: { type: "string", description: "Working directory (must be within allowed roots)" },
        instruction_files: { type: "array", items: { type: "string" }, description: "Task instruction/context files for the query" },
        timeout_sec: { type: "number", description: "Timeout in seconds (default 120)" },
        max_turns: { type: "number", description: "Maximum Claude turns for this query. Omitted means no explicit turn cap; fast=true uses 2 unless max_turns is provided." },
        fast: {
          type: "boolean",
          description: "Use a lower-latency query mode with smaller turn budget and concise prompt guidance.",
        },
        resume: {
          type: "boolean",
          description: "Control query session resume behavior. Defaults to true, but fast mode defaults to false.",
        },
        sensitive_file_policy: { type: "string", enum: ["default", "strict", "off"], description: "Controls sensitive-file deny rules. default blocks .env/.env.*/secrets/** reads; strict adds .pem/.key/.ssh/.aws/credentials and similar; off removes only sensitive-file denies (dangerous Bash denies remain)." },
      },
    },
  },
  {
    name: "claude_review",
    description:
      "Advanced / Debug. Have Claude Code review code changes as a persistent background job. Claude runs in read-only mode. Provide a diff and/or file list for context.",
    inputSchema: {
      type: "object",
      required: ["task", "cwd"],
      properties: {
        task: { type: "string", description: "Review instructions (what to look for)" },
        cwd: { type: "string", description: "Working directory (must be within allowed roots)" },
        instruction_files: { type: "array", items: { type: "string" }, description: "Review instruction/context files" },
        diff: { type: "string", description: "The diff to review (optional; Claude can also git diff itself)" },
        files: { type: "array", items: { type: "string" }, description: "Specific files to focus on" },
        timeout_sec: { type: "number", description: "Timeout in seconds (default 180)" },
        max_turns: { type: "number", description: "Maximum Claude turns for this review. Omitted means no explicit turn cap." },
        reviewed_run_id: { type: "string", description: "Bind this review to a specific implement/apply run id for review-gate clearing." },
        reviewed_worktree_path: { type: "string", description: "Bind this review to a specific worktree path for review-gate clearing." },
        sensitive_file_policy: { type: "string", enum: ["default", "strict", "off"], description: "Controls sensitive-file deny rules. default blocks .env/.env.*/secrets/** reads; strict adds .pem/.key/.ssh/.aws/credentials and similar; off removes only sensitive-file denies (dangerous Bash denies remain)." },
      },
    },
  },
  {
    name: "claude_implement",
    description:
      "Advanced / Debug. Delegate an implementation task to Claude Code as a persistent background job. Claude runs in an isolated git worktree and does NOT modify the main working tree.",
    inputSchema: {
      type: "object",
      required: ["task", "cwd"],
      properties: {
        task: { type: "string", description: "Implementation task description" },
        cwd: { type: "string", description: "Working directory (must be within allowed roots and a git repo)" },
        instruction_files: { type: "array", items: { type: "string" }, description: "Task instruction/context files for the implementation" },
        files: { type: "array", items: { type: "string" }, description: "Hard file modification scope for implement tasks. Only listed files may be changed. Matches claude_task.allowed_files semantics." },
        constraints: { type: "array", items: { type: "string" }, description: "Constraints (e.g. 'do not modify tests')" },
        timeout_sec: { type: "number", description: "Timeout in seconds (default 600)" },
        max_turns: { type: "number", description: "Maximum Claude turns for this implementation. Omitted means no explicit turn cap." },
        session_key: { type: "string", description: "Resume an existing Claude session by ID (implement does NOT auto-resume)" },
        fork_session: { type: "boolean", description: "When used with session_key, fork the session instead of continuing it" },
        resume_latest: { type: "boolean", description: "Resume the latest implement session recorded for this repository. Cannot be combined with session_key." },
        max_cost_usd: { type: "number", description: "Maximum USD budget for this task (passed as --max-budget-usd to Claude). Must be > 0 and <= 10." },
        max_changed_files: { type: "number", description: "Warn if Claude changes more than this many files. Must be a positive integer <= 100." },
        worktreeName: { type: "string", description: "Optional delegated worktree name override" },
        dirty_policy: { type: "string", enum: ["ask", "committed", "snapshot"], description: "Handling for uncommitted main-workspace changes: ask (default), committed (ignore dirty changes and use HEAD), or snapshot (copy dirty files into the delegated worktree)." },
        security_profile: { type: "string", enum: ["strict", "default", "permissive"], description: "Command allowlist profile for implementation tasks. default excludes remote package execution paths such as npx; permissive allows broader local project commands." },
        sensitive_file_policy: { type: "string", enum: ["default", "strict", "off"], description: "Controls sensitive-file deny rules. default blocks .env/.env.*/secrets/** reads; strict adds .pem/.key/.ssh/.aws/credentials and similar; off removes only sensitive-file denies (dangerous Bash denies remain)." },
        verification_commands: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", minLength: 1, maxLength: 200 }, description: "Server-side verification commands to run in the delegated worktree after Claude completes. Commands are parsed into argv and executed without a shell under a conservative allowlist. Results appear in the output as server_verified." },
      },
    },
  },
  {
    name: "claude_jobs",
    description:
      "Advanced / Debug. List recent background review/implement jobs for this repository.",
    inputSchema: {
      type: "object",
      required: ["cwd"],
      properties: {
        cwd: { type: "string", description: "Working directory (must be within allowed roots)" },
        limit: { type: "number", description: "Maximum number of recent jobs to return (default 20)" },
        status: { type: "string", enum: ["queued", "running", "succeeded", "failed", "cancelled", "crashed"], description: "Filter by background job status" },
        type: { type: "string", enum: ["query", "review", "implement", "apply", "cleanup"], description: "Filter by background job type" },
      },
    },
  },
  {
    name: "claude_job_result",
    description:
      "Advanced / Debug. Load one background job record, including process status, Claude result_status, and final result when available.",
    inputSchema: {
      type: "object",
      required: ["cwd", "job_id"],
      properties: {
        cwd: { type: "string", description: "Working directory (must be within allowed roots)" },
        job_id: { type: "string", description: "Background job id" },
      },
    },
  },
  {
    name: "claude_job_cancel",
    description:
      "Advanced / Debug. Cancel a running or queued background job by id.",
    inputSchema: {
      type: "object",
      required: ["cwd", "job_id"],
      properties: {
        cwd: { type: "string", description: "Working directory (must be within allowed roots)" },
        job_id: { type: "string", description: "Background job id" },
      },
    },
  },
  {
    name: "claude_job_wait",
    description:
      "Advanced / Recovery. Wait for a background job process to reach a terminal state. Uses the same inline wait mechanism as claude_task(job_id=...). Replaces legacy short-polling behavior.",
    inputSchema: {
      type: "object",
      required: ["cwd", "job_id"],
      properties: {
        cwd: { type: "string", description: "Working directory (must be within allowed roots)" },
        job_id: { type: "string", description: "Background job id" },
      },
    },
  },
  {
    name: "claude_job_cleanup",
    description:
      "Advanced / Debug. Dry-run or remove old terminal background jobs for this repository.",
    inputSchema: {
      type: "object",
      required: ["cwd"],
      properties: {
        cwd: { type: "string", description: "Working directory (must be within allowed roots)" },
        older_than_hours: { type: "number", description: "Only target terminal jobs older than this many hours (default 24)" },
        dry_run: { type: "boolean", description: "List matching jobs without removing them (default true)" },
        limit: { type: "number", description: "Maximum number of matching jobs to inspect/remove (default 20)" },
      },
    },
  },
  {
    name: "claude_apply",
    description:
      "Default tool. Preview a delegated worktree diff, or apply it only after explicit user approval. Non-preview apply requires confirmed_by_user=true.",
    inputSchema: {
      type: "object",
      required: ["cwd", "worktree_path"],
        properties: {
          cwd: { type: "string", description: "Working directory (must be within allowed roots)" },
          worktree_path: { type: "string", description: "Path to worktree, e.g. .claude/worktrees/codex-delegated-xxx" },
          cleanup: { type: "boolean", description: "Remove worktree after successful apply (default false)" },
          preview: { type: "boolean", description: "Preview which files would be applied without modifying the main working tree" },
          background: { type: "boolean", description: "Queue apply as a persistent background job" },
          confirmed_by_user: {
            type: "boolean",
            description: "Required for non-preview apply after the user explicitly approves applying the previewed diff. Not required for preview=true.",
          },
          include_patch: { type: "boolean", description: "Generate a binary git diff patch for previewed planned_changes. The patch covers tracked committed and uncommitted changes within the observed scope." },
          patch_max_bytes: { type: "number", description: "Maximum inline patch bytes before writing to a persistent .claude/patches/<runId>.patch file (default 60000, min 1024, max 500000)." },
        },
      },
    },
  {
    name: "claude_cleanup",
    description:
      "Default tool. List and remove stale delegated worktrees. Defaults to dry-run. Use after verifying apply to clean up resources.",
    inputSchema: {
      type: "object",
      required: ["cwd"],
        properties: {
          cwd: { type: "string", description: "Working directory (must be within allowed roots)" },
          older_than_hours: { type: "number", description: "Only remove worktrees older than this many hours (0 = all delegated worktrees)" },
          dry_run: { type: "boolean", description: "List worktrees without removing (default true)" },
          background: { type: "boolean", description: "Queue cleanup as a persistent background job" },
        },
      },
    },
] as const;

const DEFAULT_TOOL_METADATA: Record<string, {
  title: string;
  annotations: Record<string, boolean>;
  outputSchema: Record<string, unknown>;
}> = {
  claude_status: {
    title: "Check Claude Code Status",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    outputSchema: { type: "object", additionalProperties: true },
  },
  claude_setup: {
    title: "Check Claude Delegation Setup",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    outputSchema: { type: "object", additionalProperties: true },
  },
  claude_runs: {
    title: "List Recent Run Logs",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    outputSchema: { type: "object", additionalProperties: true },
  },
  claude_run_inspect: {
    title: "Inspect Run Log",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    outputSchema: { type: "object", additionalProperties: true },
  },
  claude_result: {
    title: "Resolve Claude Result",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    outputSchema: { type: "object", additionalProperties: true },
  },
  claude_workspace_status: {
    title: "View Workspace Status",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    outputSchema: { type: "object", additionalProperties: true },
  },
  claude_task: {
    title: "Delegate Task To Claude",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    outputSchema: { type: "object", additionalProperties: true },
  },
  claude_review_gate: {
    title: "Manage Review Gate",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    outputSchema: { type: "object", additionalProperties: true },
  },
  claude_query: {
    title: "Query Claude (Background)",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    outputSchema: { type: "object", additionalProperties: true },
  },
  claude_review: {
    title: "Review Code (Background)",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    outputSchema: { type: "object", additionalProperties: true },
  },
  claude_implement: {
    title: "Implement Task (Background)",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    outputSchema: { type: "object", additionalProperties: true },
  },
  claude_jobs: {
    title: "List Background Jobs",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    outputSchema: { type: "object", additionalProperties: true },
  },
  claude_job_result: {
    title: "Get Job Result",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    outputSchema: { type: "object", additionalProperties: true },
  },
  claude_job_cancel: {
    title: "Cancel Background Job",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    outputSchema: { type: "object", additionalProperties: true },
  },
  claude_job_wait: {
    title: "Wait For Background Job",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    outputSchema: { type: "object", additionalProperties: true },
  },
  claude_job_cleanup: {
    title: "Clean Old Jobs",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    outputSchema: { type: "object", additionalProperties: true },
  },
  claude_apply: {
    title: "Preview Or Apply Delegated Changes",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    outputSchema: { type: "object", additionalProperties: true },
  },
  claude_cleanup: {
    title: "Clean Delegated Worktrees",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    outputSchema: { type: "object", additionalProperties: true },
  },
};

export const TOOL_DEFINITIONS = BASE_TOOL_DEFINITIONS.map((tool) => ({
  ...tool,
  ...(DEFAULT_TOOL_METADATA[tool.name] ?? {}),
  inputSchema: {
    additionalProperties: false,
    ...tool.inputSchema,
  },
}));

function hasWorktreeObservation(result: ClaudeTaskResult): boolean {
  return result.server_observed != null && typeof result.server_observed === "object" &&
    "worktree_path" in (result.server_observed as Record<string, unknown>);
}

export function buildTaskInteraction(result: ClaudeTaskResult): InteractionBlock {
  const isWriteResult = result.delegated_mode === "write";
  const hasSession = result.session?.session_id != null;
  const hasWorktree = hasWorktreeObservation(result);
  const hasWriteRecoveryContext = isWriteResult && (hasSession || hasWorktree);

  if (result.completed_inline && result.status === "success") {
    return {
      headline: "Claude result is ready.",
      state: "result_ready",
      next_step: hasWorktree
        ? "Preview the worktree changes with claude_apply preview=true."
        : "Review the result above. No apply step is needed for read-only tasks.",
    };
  }
  if (result.completed_inline && result.status === "failed") {
    if (hasWriteRecoveryContext) {
      return {
        headline: "Claude task failed.",
        state: "failed",
        next_step: hasWorktree
          ? hasSession
            ? "Inspect the error. Preview any worktree changes with claude_apply preview=true, then ask the user whether to apply, resume, start fresh, or discard. Do not auto-resume or auto-apply."
            : "Inspect the error. Preview any worktree changes with claude_apply preview=true, then ask the user whether to apply, start fresh, or discard. Do not auto-apply."
          : "Inspect the error, then ask the user whether to resume the session, start fresh, or discard. Do not auto-resume.",
      };
    }
    return {
      headline: "Claude task failed.",
      state: "failed",
      next_step: "Inspect the error and retry with adjusted instructions.",
    };
  }
  if (result.completed_inline && result.status === "partial") {
    if (hasWriteRecoveryContext) {
      return {
        headline: "Claude result is partially ready.",
        state: "result_ready",
        next_step: hasWorktree
          ? hasSession
            ? "Preview the worktree changes with claude_apply preview=true. Then ask the user whether to apply, resume, start fresh, or discard. Do not auto-resume or auto-apply."
            : "Preview the worktree changes with claude_apply preview=true. Then ask the user whether to apply, start fresh, or discard. Do not auto-apply."
          : "Review the partial result, then ask the user whether to resume the session, start fresh, or discard. Do not auto-resume.",
      };
    }
    return {
      headline: "Claude result is partially ready.",
      state: "result_ready",
      next_step: hasWorktree
        ? "Preview the worktree changes with claude_apply preview=true. Note that the task did not complete fully."
        : "Review the partial result above.",
    };
  }
  if (result.completed_inline && result.status === "cancelled") {
    return {
      headline: "Claude task was cancelled.",
      state: "failed",
      next_step: "The job was cancelled. Start a new task if needed.",
    };
  }
  if (result.completed_inline && result.status === "needs_user") {
    if (hasWriteRecoveryContext) {
      return {
        headline: "Claude needs input.",
        state: "needs_user",
        next_step: hasWorktree
          ? hasSession
            ? "Inspect the requested input and preview existing worktree changes if useful. Then ask the user whether to provide input, resume, start fresh, or discard. Do not auto-resume."
            : "Inspect the requested input and preview existing worktree changes if useful. Then ask the user whether to provide input, start fresh, or discard."
          : "Inspect the requested input, then ask the user whether to provide input, resume the session, start fresh, or discard. Do not auto-resume.",
      };
    }
    return {
      headline: "Claude needs input.",
      state: "needs_user",
      next_step: "Provide the required input or inspect the job result for details.",
    };
  }
  if (result.waiting) {
    return {
      headline: "Claude is still working.",
      state: "waiting",
      next_step: "Continue this same job with claude_task(job_id=...). Do not start a duplicate task.",
    };
  }
  if (result.status === "needs_attention" || result.status === "stale") {
    return {
      headline: "Claude job appears stale.",
      state: "needs_attention",
      next_step: "Inspect or cancel this job before starting a replacement.",
    };
  }
  if (!result.job && result.result) {
    return {
      headline: "Write task needs a workspace decision before delegation.",
      state: "needs_user",
      next_step: "Commit or stash changes, or use dirty_policy=committed or dirty_policy=snapshot.",
    };
  }
  if (result.job && !result.completed_inline) {
    return {
      headline: "Claude task started in background.",
      state: "delegated_execution",
      next_step: "Continue this job later with claude_task(job_id=...).",
    };
  }
  return {
    headline: "Task completed.",
    state: "result_ready",
    next_step: "Review the result and proceed.",
  };
}

function wouldBeWriteTask(args: {
  mode?: string;
  task?: string;
  diff?: string;
  constraints?: string[];
  resume_latest?: boolean;
}): boolean {
  if (args.mode === "write") return true;
  if (args.mode === "read" || args.mode === "review") return false;

  // mode is "auto" or omitted — delegate to the single source of truth
  if (args.resume_latest === true) return true;
  const { mode } = inferClaudeTaskMode({
    cwd: "/dev/null",
    task: args.task,
    mode: "auto",
    diff: args.diff,
    constraints: args.constraints,
  });
  return mode === "write";
}

export function registerToolDefinitions(server: Server): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));
}

export async function handleToolCall(name: string, args: unknown, runId = randomUUID()) {
  try {
    switch (name) {
      case "claude_status": {
        const startTime = Date.now();
        const parsed = claudeStatusInputSchema.safeParse(args);
        if (!parsed.success) return errorResult(validationErrorMessage(parsed.error));
        const { cwd } = parsed.data;
        const check = await validateCwd(cwd);
        if (!check.ok) {
          return jsonResult({
            cwd_valid: false,
            cwd_is_git_repo: false,
            errors: [check.error!],
            claude_available: false,
            claude_version: null,
            auth_status: null,
            git_available: false,
            worktree_capable: false,
            execution: localExecution(startTime),
            warnings: [check.error!],
          });
        }
        const status = await checkClaudeStatus(check.resolved);
        return jsonResult({
          ...status,
          recent_runs: await getRecentRunsSummary(check.resolved),
          execution: localExecution(startTime),
          warnings: status.errors,
        });
      }

      case "claude_setup": {
        const parsed = claudeSetupInputSchema.safeParse(args);
        if (!parsed.success) return errorResult(validationErrorMessage(parsed.error));
        let check = await validateCwd(parsed.data.cwd);
        let allowRootConfiguration: CodexAllowRootConfiguration | undefined;
        if (!check.ok && parsed.data.configure_allow_root) {
          allowRootConfiguration = await configureCodexAllowRoot(parsed.data.cwd);
          check = await validateCwd(parsed.data.cwd);
        }
        if (!check.ok) {
          return jsonResult(withInteraction({
            error: check.error!,
            next_actions: [
              {
                tool: "claude_setup",
                args: { cwd: parsed.data.cwd, configure_allow_root: true },
                reason:
                  "Add this cwd to CODEX_CLAUDE_ALLOW_ROOTS in the Codex config, then retry setup in the same MCP process.",
              },
            ],
            config_hint: {
              env_key: "CODEX_CLAUDE_ALLOW_ROOTS",
              separator: process.platform === "win32" ? ";" : ":",
              example: `/path/to/repo${process.platform === "win32" ? ";" : ":"}/path/to/another-repo`,
            },
          }, {
            headline: "Claude delegation needs setup.",
            state: "needs_attention",
            next_step: "Add this repo to allow roots, restart Codex, then run claude_setup again.",
          }));
        }
        const result = await runClaudeSetup({ cwd: check.resolved });
        const needsAttention = result.errors.length > 0 || !result.claude_available;
        const payload = allowRootConfiguration ? { ...result, allow_root_configuration: allowRootConfiguration } : result;
        return jsonResult(withInteraction(payload, {
          headline: needsAttention ? "Claude delegation needs setup." : "Claude delegation is ready.",
          state: needsAttention ? "needs_attention" : "ready",
          next_step: needsAttention ? "Fix the reported errors, then run claude_setup again." : "Use claude_task to delegate a read, review, or write task.",
        }));
      }

      case "claude_runs": {
        const parsed = claudeRunsInputSchema.safeParse(args);
        if (!parsed.success) return errorResult(validationErrorMessage(parsed.error));
        const { cwd, limit, type, status, worktree_name } = parsed.data;
        const check = await validateCwd(cwd);
        if (!check.ok) return errorResult(check.error!);
        return jsonResult(await listRunLogs({ cwd: check.resolved, limit, type, status, worktree_name }));
      }

      case "claude_run_inspect": {
        const parsed = claudeRunInspectInputSchema.safeParse(args);
        if (!parsed.success) return errorResult(validationErrorMessage(parsed.error));
        const check = await validateCwd(parsed.data.cwd);
        if (!check.ok) return errorResult(check.error!);
        const result = await getRunLogById({ cwd: check.resolved, run_id: parsed.data.run_id });
        if (!result) return errorResult(`Run not found: ${parsed.data.run_id}`);
        return jsonResult(result);
      }

      case "claude_result": {
        const parsed = claudeResultInputSchema.safeParse(args);
        if (!parsed.success) return errorResult(validationErrorMessage(parsed.error));
        const check = await validateCwd(parsed.data.cwd);
        if (!check.ok) return errorResult(check.error!);
        const resultData = await getClaudeResult({ ...parsed.data, cwd: check.resolved });
        const hasJobResult = resultData.job?.result_status === "success" || resultData.job?.result_status === "partial";
        const hasRunResult = resultData.source_type === "run" && (resultData.run?.status === "success" || resultData.run?.status === "partial");
        const hasResult = hasJobResult || hasRunResult;
        return jsonResult(withInteraction(resultData, {
          headline: hasResult ? "Claude result is ready." : "Claude result is not available.",
          state: hasResult ? "result_ready" : "needs_attention",
          next_step: hasResult ? "Preview the worktree changes with claude_apply preview=true." : "Check active jobs with claude_workspace_status or claude_task(job_id=...).",
        }));
      }

      case "claude_workspace_status": {
        const parsed = claudeWorkspaceStatusInputSchema.safeParse(args);
        if (!parsed.success) return errorResult(validationErrorMessage(parsed.error));
        const check = await validateCwd(parsed.data.cwd);
        if (!check.ok) return errorResult(check.error!);
        return jsonResult(await getWorkspaceStatus({ ...parsed.data, cwd: check.resolved }));
      }

      case "claude_task": {
        const parsed = claudeTaskInputSchema.safeParse(args);
        if (!parsed.success) return errorResult(validationErrorMessage(parsed.error));
        const { cwd: inputCwd, mode, files, instruction_files, allowed_files, job_id } = parsed.data;
        const check = await validateCwd(inputCwd);
        if (!check.ok) return errorResult(check.error!);

        if (!job_id) {
          const fileCheck = await validateFilesWithinCwd(check.resolved, [
            ...(instruction_files ?? []),
            ...(files ?? []),
            ...(allowed_files ?? []),
          ]);
          if (!fileCheck.ok) return errorResult(fileCheck.error!);

          if (wouldBeWriteTask(parsed.data)) {
            const { supportsWorktree } = await import("./guard.js");
            if (isDelegatedWorktreePath(check.resolved)) {
              return errorResult("Refusing to start delegated write work from inside an existing delegated worktree. Use the original repository cwd instead.");
            }
            const wtCapable = await supportsWorktree(check.resolved);
            if (!wtCapable) {
              return errorResult("claude_task write mode requires a git repository with worktree support");
            }
          }
        }

        const taskResult = await runClaudeTask({ ...parsed.data, cwd: check.resolved }, runId);
        const taskInteraction = buildTaskInteraction(taskResult);
        return jsonResult(withInteraction(taskResult, taskInteraction));
      }

      case "claude_review_gate": {
        const parsed = claudeReviewGateInputSchema.safeParse(args);
        if (!parsed.success) return errorResult(validationErrorMessage(parsed.error));
        const check = await validateCwd(parsed.data.cwd);
        if (!check.ok) return errorResult(check.error!);
        return jsonResult(await manageClaudeReviewGate({ ...parsed.data, cwd: check.resolved }));
      }

      case "claude_query": {
        const parsed = claudeQueryInputSchema.safeParse(args);
        if (!parsed.success) return errorResult(validationErrorMessage(parsed.error));
        const { task, cwd, instruction_files, timeout_sec, max_turns, fast, resume, sensitive_file_policy } = parsed.data;
        const resolvedTimeout = timeout_sec ?? (fast ? 45 : 120);
        const resolvedMaxTurns = max_turns ?? (fast ? 2 : undefined);

        const check = await validateCwd(cwd);
        if (!check.ok) return errorResult(check.error!);
        const fileCheck = await validateFilesWithinCwd(check.resolved, instruction_files);
        if (!fileCheck.ok) return errorResult(fileCheck.error!);

        return jsonResult(await startBackgroundQuery(
          {
            task,
            cwd: check.resolved,
            instruction_files,
            timeout_sec: resolvedTimeout,
            max_turns: resolvedMaxTurns,
            fast,
            resume,
            sensitive_file_policy,
          },
        ));
      }

      case "claude_review": {
        const parsed = claudeReviewInputSchema.safeParse(args);
        if (!parsed.success) return errorResult(validationErrorMessage(parsed.error));
        const { task, cwd, diff, instruction_files, files, timeout_sec, max_turns, reviewed_run_id, reviewed_worktree_path, sensitive_file_policy } = parsed.data;

        const check = await validateCwd(cwd);
        if (!check.ok) return errorResult(check.error!);
        const mergedFiles = [...(files ?? []), ...(instruction_files ?? [])];
        const fileCheck = await validateFilesWithinCwd(check.resolved, mergedFiles.length > 0 ? mergedFiles : undefined);
        if (!fileCheck.ok) return errorResult(fileCheck.error!);

        return jsonResult(await startBackgroundReview(
          { task, cwd: check.resolved, diff, instruction_files, files, timeout_sec, max_turns, reviewed_run_id, reviewed_worktree_path, sensitive_file_policy },
        ));
      }

      case "claude_implement": {
        const parsed = claudeImplementInputSchema.safeParse(args);
        if (!parsed.success) return errorResult(validationErrorMessage(parsed.error));
        const { task, cwd, files, constraints, timeout_sec, max_turns, session_key, fork_session, resume_latest, max_cost_usd, max_changed_files, worktreeName, dirty_policy, security_profile, sensitive_file_policy, verification_commands } = parsed.data;

        const check = await validateCwd(cwd);
        if (!check.ok) return errorResult(check.error!);
        const fileCheck = await validateFilesWithinCwd(check.resolved, files);
        if (!fileCheck.ok) return errorResult(fileCheck.error!);

        if (isDelegatedWorktreePath(check.resolved)) {
          return errorResult("Refusing to start delegated write work from inside an existing delegated worktree. Use the original repository cwd instead.");
        }
        const { supportsWorktree } = await import("./guard.js");
        const wtCapable = await supportsWorktree(check.resolved);
        if (!wtCapable) {
          return errorResult("claude_implement requires a git repository with worktree support");
        }

        return jsonResult(await startBackgroundImplement({
          task,
          cwd: check.resolved,
          files,
          constraints,
          timeout_sec,
          max_turns,
          session_key,
          fork_session,
          resume_latest,
          max_cost_usd,
          max_changed_files,
          worktreeName,
          dirty_policy,
          security_profile,
          sensitive_file_policy,
          verification_commands,
        }));
      }

      case "claude_jobs": {
        const parsed = claudeJobsInputSchema.safeParse(args);
        if (!parsed.success) return errorResult(validationErrorMessage(parsed.error));
        const check = await validateCwd(parsed.data.cwd);
        if (!check.ok) return errorResult(check.error!);
        return jsonResult(await listBackgroundJobs({ ...parsed.data, cwd: check.resolved }));
      }

      case "claude_job_result": {
        const parsed = claudeJobResultInputSchema.safeParse(args);
        if (!parsed.success) return errorResult(validationErrorMessage(parsed.error));
        const check = await validateCwd(parsed.data.cwd);
        if (!check.ok) return errorResult(check.error!);
        const result = await getBackgroundJobResult({ ...parsed.data, cwd: check.resolved });
        if (!result) return errorResult(`Job not found: ${parsed.data.job_id}`);
        return jsonResult(result);
      }

      case "claude_job_cancel": {
        const parsed = claudeJobCancelInputSchema.safeParse(args);
        if (!parsed.success) return errorResult(validationErrorMessage(parsed.error));
        const check = await validateCwd(parsed.data.cwd);
        if (!check.ok) return errorResult(check.error!);
        const result = await cancelBackgroundJob({ ...parsed.data, cwd: check.resolved });
        if (!result.cancelled && result.error) {
          return errorResult(result.error);
        }
        return jsonResult(result);
      }

      case "claude_job_wait": {
        const parsed = claudeJobWaitInputSchema.safeParse(args);
        if (!parsed.success) return errorResult(validationErrorMessage(parsed.error));
        const check = await validateCwd(parsed.data.cwd);
        if (!check.ok) return errorResult(check.error!);
        const waitResult = await waitForBackgroundJob({ ...parsed.data, cwd: check.resolved });
        let interaction: InteractionBlock;
        if (waitResult.stale_state === "stale") {
          interaction = { headline: "Claude job appears stale.", state: "needs_attention", next_step: "Inspect this job result before starting a replacement." };
        } else if (waitResult.waiting) {
          interaction = { headline: "Claude job is still running.", state: "waiting", next_step: "Use claude_task(job_id=...) to continue waiting for this job." };
        } else {
          interaction = { headline: "Claude job completed.", state: "completed", next_step: "Use claude_result to inspect the result." };
        }
        return jsonResult(withInteraction(waitResult, interaction));
      }

      case "claude_job_cleanup": {
        const parsed = claudeJobCleanupInputSchema.safeParse(args);
        if (!parsed.success) return errorResult(validationErrorMessage(parsed.error));
        const check = await validateCwd(parsed.data.cwd);
        if (!check.ok) return errorResult(check.error!);
        return jsonResult(await cleanupBackgroundJobs({ ...parsed.data, cwd: check.resolved }));
      }

      case "claude_apply": {
        const startTime = Date.now();
        const parsed = claudeApplyInputSchema.safeParse(args);
        if (!parsed.success) return errorResult(validationErrorMessage(parsed.error));
        const { cwd, worktree_path, cleanup, preview, background, confirmed_by_user, include_patch, patch_max_bytes } = parsed.data;

        const check = await validateCwd(cwd);
        if (!check.ok) return errorResult(check.error!);

        if (background === true) {
          return jsonResult(await startBackgroundApply(
            { cwd: check.resolved, worktree_path, cleanup, preview, background, confirmed_by_user, include_patch, patch_max_bytes },
          ));
        }

        const result = await runClaudeApply(
          { cwd: check.resolved, worktree_path, cleanup, preview, confirmed_by_user, include_patch, patch_max_bytes },
          runId
        );
        const payload = {
          ...result,
          execution: localExecution(startTime),
          warnings: [...result.conflicts, ...(result.error ? [result.error] : [])],
        };
        let applyInteraction: InteractionBlock;
        if (result.preview) {
          applyInteraction = { headline: "Delegated changes are ready for review.", state: "apply_preview", next_step: "Review planned_changes. If safe, ask the user whether to apply these changes." };
        } else if (result.dirty_recovery_needed) {
          applyInteraction = { headline: "Apply rollback failed — workspace may be dirty.", state: "needs_user", next_step: "Inspect dirty_files and restore affected files manually. Backup data may be preserved." };
        } else if (result.error) {
          applyInteraction = { headline: "Apply could not complete.", state: "needs_user", next_step: "Review the error. Changes were rolled back and the workspace should be clean." };
        } else if (result.applied_files.length > 0) {
          applyInteraction = { headline: "Delegated changes applied.", state: "applied", next_step: "Run project tests and review the final diff." };
        } else {
          applyInteraction = { headline: "Delegated changes are ready for review.", state: "apply_preview", next_step: "Review planned_changes. If safe, ask the user whether to apply these changes." };
        }
        return jsonResult(withInteraction(payload, applyInteraction));
      }

      case "claude_cleanup": {
        const startTime = Date.now();
        const parsed = claudeCleanupInputSchema.safeParse(args);
        if (!parsed.success) return errorResult(validationErrorMessage(parsed.error));
        const { cwd, older_than_hours, dry_run, background } = parsed.data;
        const check = await validateCwd(cwd);
        if (!check.ok) return errorResult(check.error!);

        if (background === true) {
          return jsonResult(await startBackgroundCleanup(
            { cwd: check.resolved, older_than_hours, dry_run, background },
          ));
        }

        const result = await runClaudeCleanup(
          { cwd: check.resolved, older_than_hours, dry_run },
          runId
        );
        const cleanupPayload = {
          ...result,
          execution: localExecution(startTime),
          warnings: result.entries.flatMap((entry) => entry.error ? [`${entry.worktree_name}: ${entry.error}`] : []),
        };
        return jsonResult(withInteraction(cleanupPayload, {
          headline: dry_run ? "Delegated worktrees found." : "Delegated worktrees cleaned.",
          state: dry_run ? "cleanup_preview" : "cleaned",
          next_step: dry_run ? "Review entries. If these worktrees are no longer needed, call claude_cleanup with dry_run=false." : "Run claude_cleanup dry_run=true again only if you want to confirm no stale delegated worktrees remain.",
        }));
      }

      default:
        return errorResult(`Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof StructuredToolError) {
      process.stderr.write(`[claude-delegate] ERROR (${name}): ${err.message}\n`);
      return errorResult(err.payload);
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[claude-delegate] ERROR (${name}): ${msg}\n`);
    return errorResult(msg);
  }
}

export function registerToolHandlers(server: Server): void {
  server.setRequestHandler(CallToolRequestSchema, async (request) => (
    handleToolCall(request.params.name, request.params.arguments)
  ));
}

export async function createServer(): Promise<Server> {
  const info = await getPackageInfo();
  const server = new Server(
    { name: info.name, version: info.version },
    { capabilities: { tools: {} } }
  );
  registerToolDefinitions(server);
  registerToolHandlers(server);
  return server;
}

function assertCanStartServer(): void {
  const bridgeDepth = checkRecursion();
  if (bridgeDepth >= MAX_BRIDGE_DEPTH) {
    process.stderr.write(
      `[claude-delegate] FATAL: BRIDGE_DEPTH=${bridgeDepth} >= ${MAX_BRIDGE_DEPTH}. Refusing to start MCP server to prevent recursive agent delegation.\n`
    );
    process.exit(1);
  }
}

export async function main(): Promise<void> {
  assertCanStartServer();
  void recoverCrashedJobsOnStartup();
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[claude-delegate] MCP server started (stdio)\n");
}

export async function recoverCrashedJobsOnStartup(
  recover: () => Promise<unknown> = recoverCrashedJobs
): Promise<void> {
  await recover().catch(() => {});
}

export { main as startServer };

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) {
  await main();
}
