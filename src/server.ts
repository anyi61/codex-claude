import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";

import { validateCwd, validateFilesWithinCwd, checkRecursion, MAX_BRIDGE_DEPTH } from "./guard.js";
import {
  checkClaudeStatus,
  runClaudeQuery,
  runClaudeReview,
  runClaudeImplement,
  runClaudeApply,
  runClaudeCleanup,
} from "./claude-cli.js";
import {
  claudeApplyInputSchema,
  claudeCleanupInputSchema,
  claudeImplementInputSchema,
  claudeQueryInputSchema,
  claudeReviewInputSchema,
  claudeStatusInputSchema,
  errorResult,
  jsonResult,
  localExecution,
  validationErrorMessage,
} from "./schema.js";

const BRIDGE_DEPTH = checkRecursion();

// ---- Init ----

const server = new Server(
  { name: "codex-claude-delegate-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// Prevent recursion: if Codex is already inside a Claude-delegated task,
// refuse to spawn another Claude.
if (BRIDGE_DEPTH >= MAX_BRIDGE_DEPTH) {
  process.stderr.write(
    `[claude-delegate] FATAL: BRIDGE_DEPTH=${BRIDGE_DEPTH} >= ${MAX_BRIDGE_DEPTH}. Refusing to start MCP server to prevent recursive agent delegation.\n`
  );
  process.exit(1);
}

// ---- Tool definitions ----

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
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
      name: "claude_query",
      description:
        "Ask Claude a read-only question. Claude can read files and run safe git commands but cannot modify anything. Use for code explanations, architecture questions, and analysis.",
      inputSchema: {
        type: "object",
        required: ["task", "cwd"],
        properties: {
          task: { type: "string", description: "The question or analysis task" },
          cwd: { type: "string", description: "Working directory (must be within allowed roots)" },
          timeout_sec: { type: "number", description: "Timeout in seconds (default 120)" },
        },
      },
    },
    {
      name: "claude_review",
      description:
        "Have Claude Code review code changes. Claude runs in read-only mode. Provide a diff and/or file list for context.",
      inputSchema: {
        type: "object",
        required: ["task", "cwd"],
        properties: {
          task: { type: "string", description: "Review instructions (what to look for)" },
          cwd: { type: "string", description: "Working directory (must be within allowed roots)" },
          diff: { type: "string", description: "The diff to review (optional; Claude can also git diff itself)" },
          files: { type: "array", items: { type: "string" }, description: "Specific files to focus on" },
          timeout_sec: { type: "number", description: "Timeout in seconds (default 180)" },
        },
      },
    },
    {
      name: "claude_implement",
      description:
        "Delegate an implementation task to Claude Code. Claude runs in an isolated git worktree, makes changes, runs tests, and returns a structured result with a diff. Does NOT modify the main working tree.",
      inputSchema: {
        type: "object",
        required: ["task", "cwd"],
        properties: {
          task: { type: "string", description: "Implementation task description" },
          cwd: { type: "string", description: "Working directory (must be within allowed roots and a git repo)" },
          files: { type: "array", items: { type: "string" }, description: "Relevant files for context" },
          constraints: { type: "array", items: { type: "string" }, description: "Constraints (e.g. 'do not modify tests')" },
          timeout_sec: { type: "number", description: "Timeout in seconds (default 600)" },
          session_key: { type: "string", description: "Resume an existing Claude session by ID (implement does NOT auto-resume)" },
          fork_session: { type: "boolean", description: "When used with session_key, fork the session instead of continuing it" },
          max_cost_usd: { type: "number", description: "Maximum USD budget for this task (passed as --max-budget-usd to Claude). Must be > 0 and <= 10." },
          max_changed_files: { type: "number", description: "Warn if Claude changes more than this many files. Must be a positive integer <= 100." },
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
        },
      },
    },
  ],
}));

// ---- Tool handler ----

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const runId = randomUUID();

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
          execution: localExecution(startTime),
          warnings: status.errors,
        });
      }

      case "claude_query": {
        const parsed = claudeQueryInputSchema.safeParse(args);
        if (!parsed.success) return errorResult(validationErrorMessage(parsed.error));
        const { task, cwd, timeout_sec, max_turns } = parsed.data;

        const check = await validateCwd(cwd);
        if (!check.ok) return errorResult(check.error!);

        const report = await runClaudeQuery(
          { task, cwd: check.resolved, timeout_sec, max_turns },
          runId
        );
        return jsonResult(report);
      }

      case "claude_review": {
        const parsed = claudeReviewInputSchema.safeParse(args);
        if (!parsed.success) return errorResult(validationErrorMessage(parsed.error));
        const { task, cwd, diff, files, timeout_sec, max_turns } = parsed.data;

        const check = await validateCwd(cwd);
        if (!check.ok) return errorResult(check.error!);
        const fileCheck = await validateFilesWithinCwd(check.resolved, files);
        if (!fileCheck.ok) return errorResult(fileCheck.error!);

        const report = await runClaudeReview(
          { task, cwd: check.resolved, diff, files, timeout_sec, max_turns },
          runId
        );
        return jsonResult(report);
      }

      case "claude_implement": {
        const parsed = claudeImplementInputSchema.safeParse(args);
        if (!parsed.success) return errorResult(validationErrorMessage(parsed.error));
        const { task, cwd, files, constraints, timeout_sec, max_turns, session_key, fork_session, max_cost_usd, max_changed_files, worktreeName } = parsed.data;

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

        const result = await runClaudeImplement(
          { task, cwd: check.resolved, files, constraints, timeout_sec, max_turns, session_key, fork_session, max_cost_usd, max_changed_files, worktreeName },
          runId
        );
        return jsonResult(result);
      }

      case "claude_apply": {
        const startTime = Date.now();
        const parsed = claudeApplyInputSchema.safeParse(args);
        if (!parsed.success) return errorResult(validationErrorMessage(parsed.error));
        const { cwd, worktree_path, cleanup } = parsed.data;

        const check = await validateCwd(cwd);
        if (!check.ok) return errorResult(check.error!);

        const result = await runClaudeApply(
          { cwd: check.resolved, worktree_path, cleanup },
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
        const { cwd, older_than_hours, dry_run } = parsed.data;
        const check = await validateCwd(cwd);
        if (!check.ok) return errorResult(check.error!);

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
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[claude-delegate] ERROR (${name}): ${msg}\n`);
    return errorResult(msg);
  }
});

// ---- Start ----

const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write("[claude-delegate] MCP server started (stdio)\n");
