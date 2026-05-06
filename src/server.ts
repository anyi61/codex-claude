import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateCwd, validateFilesWithinCwd, checkRecursion, MAX_BRIDGE_DEPTH } from "./guard.js";
import { configureCodexAllowRoot, type CodexAllowRootConfiguration } from "./codex-config.js";
import {
  cancelBackgroundJob,
  checkClaudeStatus,
  cleanupBackgroundJobs,
  getClaudeResult,
  getBackgroundJobResult,
  getRunLogById,
  manageClaudeReviewGate,
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
} from "./schema.js";

const TOOL_DEFINITIONS = [
  {
    name: "claude_status",
    description:
      "Check Claude Code CLI availability, auth status, git worktree support, and environment readiness.",
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
      "Check workspace readiness for the high-level workflow layer, including review-gate hook installability and current gate state.",
    inputSchema: {
      type: "object",
      required: ["cwd"],
      properties: {
        cwd: { type: "string", description: "Working directory to inspect and prepare" },
        configure_allow_root: {
          type: "boolean",
          description:
            "When true, add cwd to CODEX_CLAUDE_ALLOW_ROOTS in the Codex MCP config and update this MCP process so setup can continue.",
        },
      },
    },
  },
  {
    name: "claude_runs",
    description:
      "Inspect recent delegated run logs for this repository. Use to trace implement/apply/cleanup history without reading raw JSON files.",
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
      "Inspect a single delegated run log by run id, including normalized details and lifecycle metadata.",
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
      "Resolve the most relevant finished job or run for this workspace and return a normalized summary, session, and next actions.",
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
      "Show a workspace-centric view of current jobs, recent runs, recent sessions, delegated worktrees, and attention items.",
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
      "High-level rescue/task entrypoint that routes to query, review, or implement and returns a background job for polling.",
    inputSchema: {
      type: "object",
      required: ["cwd", "task"],
      properties: {
        cwd: { type: "string", description: "Working directory (must be within allowed roots)" },
        task: { type: "string", description: "High-level task to delegate" },
        mode: { type: "string", enum: ["auto", "read", "review", "write"], description: "Routing mode. auto infers from diff/files/task wording." },
        background: { type: "boolean", description: "Queue the delegated task as a persistent background job" },
        resume_latest: { type: "boolean", description: "For write mode, resume the latest implement session for this repository." },
        files: { type: "array", items: { type: "string" }, description: "Relevant files for review or implementation context" },
        constraints: { type: "array", items: { type: "string" }, description: "Implementation constraints for write mode" },
        diff: { type: "string", description: "Diff to review. Presence strongly biases auto mode toward review." },
        timeout_sec: { type: "number", description: "Timeout in seconds for the delegated task" },
        max_turns: { type: "number", description: "Maximum Claude turns for the delegated task" },
        dirty_policy: { type: "string", enum: ["ask", "committed", "snapshot"], description: "Write-mode handling for uncommitted main-workspace changes: ask (default), committed (ignore dirty changes and use HEAD), or snapshot (copy dirty files into the delegated worktree)." },
      },
    },
  },
  {
    name: "claude_review_gate",
    description:
      "Inspect, enable, or disable the review gate for the current workspace. Enable persists a repo-local gate flag and ensures the stop-hook manifest is present.",
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
      "Ask Claude a read-only question as a persistent background job. Claude can read files and run safe git commands but cannot modify anything.",
    inputSchema: {
      type: "object",
      required: ["task", "cwd"],
      properties: {
        task: { type: "string", description: "The question or analysis task" },
        cwd: { type: "string", description: "Working directory (must be within allowed roots)" },
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
        background: { type: "boolean", description: "Queue the query as a persistent background job" },
      },
    },
  },
  {
    name: "claude_review",
    description:
      "Have Claude Code review code changes as a persistent background job. Claude runs in read-only mode. Provide a diff and/or file list for context.",
    inputSchema: {
      type: "object",
      required: ["task", "cwd"],
      properties: {
        task: { type: "string", description: "Review instructions (what to look for)" },
        cwd: { type: "string", description: "Working directory (must be within allowed roots)" },
        diff: { type: "string", description: "The diff to review (optional; Claude can also git diff itself)" },
        files: { type: "array", items: { type: "string" }, description: "Specific files to focus on" },
        timeout_sec: { type: "number", description: "Timeout in seconds (default 180)" },
        max_turns: { type: "number", description: "Maximum Claude turns for this review. Omitted means no explicit turn cap." },
        background: { type: "boolean", description: "Queue the review as a persistent background job" },
      },
    },
  },
  {
    name: "claude_implement",
    description:
      "Delegate an implementation task to Claude Code as a persistent background job. Claude runs in an isolated git worktree and does NOT modify the main working tree.",
    inputSchema: {
      type: "object",
      required: ["task", "cwd"],
      properties: {
        task: { type: "string", description: "Implementation task description" },
        cwd: { type: "string", description: "Working directory (must be within allowed roots and a git repo)" },
        files: { type: "array", items: { type: "string" }, description: "Relevant files for context" },
        constraints: { type: "array", items: { type: "string" }, description: "Constraints (e.g. 'do not modify tests')" },
        timeout_sec: { type: "number", description: "Timeout in seconds (default 600)" },
        max_turns: { type: "number", description: "Maximum Claude turns for this implementation. Omitted means no explicit turn cap." },
        session_key: { type: "string", description: "Resume an existing Claude session by ID (implement does NOT auto-resume)" },
        fork_session: { type: "boolean", description: "When used with session_key, fork the session instead of continuing it" },
        resume_latest: { type: "boolean", description: "Resume the latest implement session recorded for this repository. Cannot be combined with session_key." },
        max_cost_usd: { type: "number", description: "Maximum USD budget for this task (passed as --max-budget-usd to Claude). Must be > 0 and <= 10." },
        max_changed_files: { type: "number", description: "Warn if Claude changes more than this many files. Must be a positive integer <= 100." },
        worktreeName: { type: "string", description: "Optional delegated worktree name override" },
        background: { type: "boolean", description: "Queue the implementation as a persistent background job; execution tools queue by default" },
        dirty_policy: { type: "string", enum: ["ask", "committed", "snapshot"], description: "Handling for uncommitted main-workspace changes: ask (default), committed (ignore dirty changes and use HEAD), or snapshot (copy dirty files into the delegated worktree)." },
      },
    },
  },
  {
    name: "claude_jobs",
    description:
      "List recent background review/implement jobs for this repository.",
    inputSchema: {
      type: "object",
      required: ["cwd"],
      properties: {
        cwd: { type: "string", description: "Working directory (must be within allowed roots)" },
        limit: { type: "number", description: "Maximum number of recent jobs to return (default 20)" },
        status: { type: "string", enum: ["queued", "running", "succeeded", "failed", "cancelled"], description: "Filter by background job status" },
        type: { type: "string", enum: ["query", "review", "implement", "apply", "cleanup"], description: "Filter by background job type" },
      },
    },
  },
  {
    name: "claude_job_result",
    description:
      "Load one background job record, including process status, Claude result_status, and final result when available.",
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
      "Cancel a running or queued background job by id.",
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
      "Wait for a background job process to reach a terminal state or timeout; inspect job.result_status for the Claude task outcome.",
    inputSchema: {
      type: "object",
      required: ["cwd", "job_id"],
      properties: {
        cwd: { type: "string", description: "Working directory (must be within allowed roots)" },
        job_id: { type: "string", description: "Background job id" },
        timeout_ms: { type: "number", description: "Maximum wait time in milliseconds (default 30000)" },
        poll_interval_ms: { type: "number", description: "Polling interval in milliseconds (default 1000)" },
      },
    },
  },
  {
    name: "claude_job_cleanup",
    description:
      "Dry-run or remove old terminal background jobs for this repository.",
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
      "Apply a worktree's diff to the main working tree, then optionally clean up the worktree. Use after claude_implement to land changes.",
    inputSchema: {
      type: "object",
      required: ["cwd", "worktree_path"],
        properties: {
          cwd: { type: "string", description: "Working directory (must be within allowed roots)" },
          worktree_path: { type: "string", description: "Path to worktree, e.g. .claude/worktrees/codex-delegated-xxx" },
          cleanup: { type: "boolean", description: "Remove worktree after successful apply (default false)" },
          preview: { type: "boolean", description: "Preview which files would be applied without modifying the main working tree" },
          background: { type: "boolean", description: "Queue apply as a persistent background job" },
        },
      },
    },
  {
    name: "claude_cleanup",
    description:
      "List and remove stale delegated worktrees. Defaults to dry-run. Use after verifying apply to clean up resources.",
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
];

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
          return errorResult({
            error: check.error!,
            next_actions: [
              {
                tool: "claude_setup",
                args: { cwd: parsed.data.cwd, configure_allow_root: true },
                reason:
                  "Add this cwd to CODEX_CLAUDE_ALLOW_ROOTS in the Codex MCP config, then retry setup in the same MCP process.",
              },
            ],
            config_hint: {
              env_key: "CODEX_CLAUDE_ALLOW_ROOTS",
              separator: process.platform === "win32" ? ";" : ":",
              example: `/path/to/repo${process.platform === "win32" ? ";" : ":"}/path/to/another-repo`,
            },
          });
        }
        const result = await runClaudeSetup({ cwd: check.resolved });
        return jsonResult(allowRootConfiguration ? { ...result, allow_root_configuration: allowRootConfiguration } : result);
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
        return jsonResult(await getClaudeResult({ ...parsed.data, cwd: check.resolved }));
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
        const { cwd, mode, files } = parsed.data;
        const check = await validateCwd(cwd);
        if (!check.ok) return errorResult(check.error!);
        const fileCheck = await validateFilesWithinCwd(check.resolved, files);
        if (!fileCheck.ok) return errorResult(fileCheck.error!);

        if (mode === "write" || (mode === "auto" && (parsed.data.resume_latest || (parsed.data.constraints?.length ?? 0) > 0))) {
          const { supportsWorktree } = await import("./guard.js");
          const wtCapable = await supportsWorktree(check.resolved);
          if (!wtCapable) {
            return errorResult("claude_task write mode requires a git repository with worktree support");
          }
        }

        return jsonResult(await runClaudeTask({ ...parsed.data, cwd: check.resolved }, runId));
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
        const { task, cwd, timeout_sec, max_turns, fast, resume } = parsed.data;
        const resolvedTimeout = timeout_sec ?? (fast ? 45 : 120);
        const resolvedMaxTurns = max_turns ?? (fast ? 2 : undefined);

        const check = await validateCwd(cwd);
        if (!check.ok) return errorResult(check.error!);

        return jsonResult(await startBackgroundQuery(
          {
            task,
            cwd: check.resolved,
            timeout_sec: resolvedTimeout,
            max_turns: resolvedMaxTurns,
            fast,
            resume,
            background: true,
          },
        ));
      }

      case "claude_review": {
        const parsed = claudeReviewInputSchema.safeParse(args);
        if (!parsed.success) return errorResult(validationErrorMessage(parsed.error));
        const { task, cwd, diff, files, timeout_sec, max_turns } = parsed.data;

        const check = await validateCwd(cwd);
        if (!check.ok) return errorResult(check.error!);
        const fileCheck = await validateFilesWithinCwd(check.resolved, files);
        if (!fileCheck.ok) return errorResult(fileCheck.error!);

        return jsonResult(await startBackgroundReview(
          { task, cwd: check.resolved, diff, files, timeout_sec, max_turns, background: true },
        ));
      }

      case "claude_implement": {
        const parsed = claudeImplementInputSchema.safeParse(args);
        if (!parsed.success) return errorResult(validationErrorMessage(parsed.error));
        const { task, cwd, files, constraints, timeout_sec, max_turns, session_key, fork_session, resume_latest, max_cost_usd, max_changed_files, worktreeName, dirty_policy } = parsed.data;

        const check = await validateCwd(cwd);
        if (!check.ok) return errorResult(check.error!);
        const fileCheck = await validateFilesWithinCwd(check.resolved, files);
        if (!fileCheck.ok) return errorResult(fileCheck.error!);

        // implement requires a git repo (for worktree)
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
          background: true,
          dirty_policy,
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
        return jsonResult(await waitForBackgroundJob({ ...parsed.data, cwd: check.resolved }));
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
        const { cwd, worktree_path, cleanup, preview, background } = parsed.data;

        const check = await validateCwd(cwd);
        if (!check.ok) return errorResult(check.error!);

        if (background === true) {
          return jsonResult(await startBackgroundApply(
            { cwd: check.resolved, worktree_path, cleanup, preview, background },
          ));
        }

        const result = await runClaudeApply(
          { cwd: check.resolved, worktree_path, cleanup, preview },
          runId
        );
        return jsonResult({
          ...result,
          execution: localExecution(startTime),
          warnings: [...result.conflicts, ...(result.error ? [result.error] : [])],
        });
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
        return jsonResult({
          ...result,
          execution: localExecution(startTime),
          warnings: result.entries.flatMap((entry) => entry.error ? [`${entry.worktree_name}: ${entry.error}`] : []),
        });
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

export function createServer(): Server {
  const server = new Server(
    { name: "codex-claude-delegate-mcp", version: "0.1.0" },
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

export async function startServer(): Promise<void> {
  assertCanStartServer();
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[claude-delegate] MCP server started (stdio)\n");
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) {
  await startServer();
}
