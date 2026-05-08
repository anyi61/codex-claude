import { describe, expect, it } from "vitest";
import {
  IMPLEMENT_SCHEMA,
  QUERY_SCHEMA,
  REVIEW_SCHEMA,
  claudeApplyInputSchema,
  claudeImplementInputSchema,
  claudeJobCancelInputSchema,
  claudeJobCleanupInputSchema,
  claudeJobResultInputSchema,
  claudeJobWaitInputSchema,
  claudeJobsInputSchema,
  claudeQueryInputSchema,
  claudeReviewGateInputSchema,
  claudeResultInputSchema,
  claudeSetupInputSchema,
  claudeTaskInputSchema,
  claudeRunInspectInputSchema,
  claudeRunsInputSchema,
  claudeReviewInputSchema,
  claudeWorkspaceStatusInputSchema,
  claudeCleanupInputSchema,
  claudeStatusInputSchema,
  buildImplementPrompt,
} from "../src/schema.js";
import { TOOL_DEFINITIONS } from "../src/server.js";

describe("schema definitions", () => {
  it("defines implement structured output fields", () => {
    expect(IMPLEMENT_SCHEMA.required).toEqual([
      "status",
      "summary",
      "changed_files",
      "commands_run",
      "tests",
      "risks",
      "next_steps",
    ]);
  });

  it("limits implement status values", () => {
    expect(IMPLEMENT_SCHEMA.properties.status.enum).toEqual([
      "success",
      "failed",
      "partial",
      "needs_user",
    ]);
  });

  it("defines review output fields", () => {
    expect(REVIEW_SCHEMA.required).toEqual(["findings", "recommendations", "severity"]);
  });

  it("defines query answer output", () => {
    expect(QUERY_SCHEMA.required).toEqual(["answer"]);
  });

  it("rejects invalid implement inputs", () => {
    expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", task: "" }).success).toBe(false);
    expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", task: "x", timeout_sec: 3601 }).success).toBe(false);
    expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", task: "x", worktreeName: "../bad" }).success).toBe(false);
    expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", task: "x", files: "src" }).success).toBe(false);
    expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", task: "x", max_changed_files: 101 }).success).toBe(false);
    expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", task: "x", dirty_policy: "merge" }).success).toBe(false);
  });

  it("accepts dirty workspace policy inputs", () => {
    expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", task: "x", dirty_policy: "ask" }).success).toBe(true);
    expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", task: "x", dirty_policy: "committed" }).success).toBe(true);
    expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", task: "x", dirty_policy: "snapshot" }).success).toBe(true);
    expect(claudeTaskInputSchema.safeParse({ cwd: "/repo", task: "x", mode: "write", dirty_policy: "snapshot" }).success).toBe(true);
  });

  it("accepts apply preview and validates run filters", () => {
    expect(claudeApplyInputSchema.safeParse({ cwd: "/repo", worktree_path: ".claude/worktrees/codex-delegated-x", preview: true }).success).toBe(true);
    expect(claudeApplyInputSchema.safeParse({ cwd: "/repo", worktree_path: ".claude/worktrees/codex-delegated-x", background: true }).success).toBe(true);
    expect(claudeRunsInputSchema.safeParse({ cwd: "/repo", limit: 10, type: "implement", status: "failed" }).success).toBe(true);
    expect(claudeJobsInputSchema.safeParse({ cwd: "/repo", type: "apply" }).success).toBe(true);
    expect(claudeJobsInputSchema.safeParse({ cwd: "/repo", type: "cleanup" }).success).toBe(true);
    expect(claudeRunsInputSchema.safeParse({ cwd: "/repo", limit: 0 }).success).toBe(false);
    expect(claudeRunsInputSchema.safeParse({ cwd: "/repo", type: "bad-type" }).success).toBe(false);
  });

  it("accepts preview without confirmed_by_user", () => {
    expect(claudeApplyInputSchema.safeParse({
      cwd: "/repo",
      worktree_path: ".claude/worktrees/codex-delegated-x",
      preview: true,
    }).success).toBe(true);
  });

  it("accepts non-preview apply with confirmed_by_user", () => {
    expect(claudeApplyInputSchema.safeParse({
      cwd: "/repo",
      worktree_path: ".claude/worktrees/codex-delegated-x",
      cleanup: true,
      confirmed_by_user: true,
    }).success).toBe(true);
  });

  it("rejects preview=true combined with cleanup=true", () => {
    expect(claudeApplyInputSchema.safeParse({
      cwd: "/repo",
      worktree_path: ".claude/worktrees/codex-delegated-x",
      preview: true,
      cleanup: true,
    }).success).toBe(false);
  });

  it("validates run inspect inputs", () => {
    expect(claudeRunInspectInputSchema.safeParse({ cwd: "/repo", run_id: "abc" }).success).toBe(true);
    expect(claudeRunInspectInputSchema.safeParse({ cwd: "/repo", run_id: "" }).success).toBe(false);
  });

  it("accepts resume_latest only with a valid implement task", () => {
    expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", task: "x", resume_latest: true }).success).toBe(true);
    expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", resume_latest: true }).success).toBe(false);
    expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", task: "", resume_latest: true }).success).toBe(false);
    expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", task: "x", resume_latest: true, session_key: "sess-1" }).success).toBe(false);
  });

  it("accepts background job inputs", () => {
    expect(claudeQueryInputSchema.safeParse({ cwd: "/repo", task: "explain" }).success).toBe(true);
    expect(claudeQueryInputSchema.safeParse({ cwd: "/repo", task: "explain", fast: true, resume: false }).success).toBe(true);
    expect(claudeReviewInputSchema.safeParse({ cwd: "/repo", task: "review this" }).success).toBe(true);
    expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", task: "ship it" }).success).toBe(true);
    expect(claudeJobsInputSchema.safeParse({ cwd: "/repo", limit: 10, type: "query" }).success).toBe(true);
    expect(claudeJobResultInputSchema.safeParse({ cwd: "/repo", job_id: "job-123" }).success).toBe(true);
    expect(claudeJobCancelInputSchema.safeParse({ cwd: "/repo", job_id: "job-123" }).success).toBe(true);
    expect(claudeJobCleanupInputSchema.safeParse({ cwd: "/repo", dry_run: true, older_than_hours: 12, limit: 5 }).success).toBe(true);
    expect(claudeJobWaitInputSchema.safeParse({ cwd: "/repo", job_id: "job-1" }).success).toBe(true);
    expect(claudeJobWaitInputSchema.safeParse({ cwd: "/repo", job_id: "job-1", not_before: "2026-05-06T00:00:30.000Z" }).success).toBe(true);
    expect(claudeJobResultInputSchema.safeParse({ cwd: "/repo", job_id: "" }).success).toBe(false);
    expect(claudeJobCleanupInputSchema.safeParse({ cwd: "/repo", limit: 0 }).success).toBe(false);
    expect(claudeJobCleanupInputSchema.safeParse({ cwd: "/repo", older_than_hours: -1 }).success).toBe(false);
    expect(claudeJobWaitInputSchema.safeParse({ cwd: "/repo", job_id: "" }).success).toBe(false);
    expect(claudeJobWaitInputSchema.safeParse({ cwd: "/repo", job_id: "job-1", timeout_ms: 5000 }).success).toBe(false);
  });

  it("accepts claude_task instruction files and deprecated files", () => {
    const parsed = claudeTaskInputSchema.safeParse({
      cwd: "/repo",
      task: "execute PROJECT_EXPANSION_PLAN.md",
      mode: "write",
      instruction_files: ["PROJECT_EXPANSION_PLAN.md"],
      files: ["LEGACY_PLAN.md"],
    });

    expect(parsed.success).toBe(true);
  });

  it("adds instruction files to implement prompts without making them relevant scope files", () => {
    const prompt = buildImplementPrompt({
      cwd: "/repo",
      task: "execute the plan",
      instruction_files: ["PROJECT_EXPANSION_PLAN.md"],
    });

    expect(prompt).toContain("## Instruction Files");
    expect(prompt).toContain("not a modification scope limit");
    expect(prompt).toContain("PROJECT_EXPANSION_PLAN.md");
    expect(prompt).not.toContain("## Relevant Files");
  });

  it("accepts high-level result inputs and rejects ambiguous selectors", () => {
    expect(claudeResultInputSchema.safeParse({ cwd: "/repo" }).success).toBe(true);
    expect(claudeResultInputSchema.safeParse({ cwd: "/repo", job_id: "job-1" }).success).toBe(true);
    expect(claudeResultInputSchema.safeParse({ cwd: "/repo", run_id: "run-1", prefer: "latest-run" }).success).toBe(true);
    expect(claudeResultInputSchema.safeParse({ cwd: "/repo", job_id: "job-1", run_id: "run-1" }).success).toBe(false);
    expect(claudeResultInputSchema.safeParse({ cwd: "/repo", prefer: "bad" }).success).toBe(false);
  });

  it("accepts workspace status inputs and validates limits", () => {
    expect(claudeWorkspaceStatusInputSchema.safeParse({ cwd: "/repo" }).success).toBe(true);
    expect(claudeWorkspaceStatusInputSchema.safeParse({ cwd: "/repo", limit: 5, include_terminal: false }).success).toBe(true);
    expect(claudeWorkspaceStatusInputSchema.safeParse({ cwd: "/repo", limit: 0 }).success).toBe(false);
  });

  it("silently drops max_turns from claude_task input", () => {
    const parsed = claudeTaskInputSchema.safeParse({
      cwd: "/repo",
      task: "write docs",
      mode: "write",
      max_turns: 2,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("unexpected parse failure");
    expect(parsed.data).not.toHaveProperty("max_turns");
  });

  it("validates high-level task routing inputs", () => {
    expect(claudeTaskInputSchema.safeParse({ cwd: "/repo", task: "explain auth", mode: "read" }).success).toBe(true);
    expect(claudeTaskInputSchema.safeParse({ cwd: "/repo", task: "review this diff", mode: "review", diff: "diff --git a b" }).success).toBe(true);
    expect(claudeTaskInputSchema.safeParse({ cwd: "/repo", task: "change code", mode: "write", resume_latest: true }).success).toBe(true);
    expect(claudeTaskInputSchema.safeParse({ cwd: "/repo", task: "explain auth", mode: "read", resume_latest: true }).success).toBe(false);
    expect(claudeTaskInputSchema.safeParse({ cwd: "/repo", task: "review this diff", mode: "review", resume_latest: true }).success).toBe(false);
  });

  it("accepts setup and review-gate inputs", () => {
    expect(claudeSetupInputSchema.safeParse({ cwd: "/repo" }).success).toBe(true);
    expect(claudeSetupInputSchema.safeParse({ cwd: "/repo", configure_allow_root: true }).success).toBe(true);
    expect(claudeReviewGateInputSchema.safeParse({ cwd: "/repo", action: "status" }).success).toBe(true);
    expect(claudeReviewGateInputSchema.safeParse({ cwd: "/repo", action: "enable" }).success).toBe(true);
    expect(claudeReviewGateInputSchema.safeParse({ cwd: "/repo", action: "disable" }).success).toBe(true);
    expect(claudeReviewGateInputSchema.safeParse({ cwd: "/repo", action: "bad" }).success).toBe(false);
  });
});

describe("schema-to-tool-definition contract", () => {
  const SCHEMA_MAP: Record<string, { schema: import("zod").ZodTypeAny; exposedInternal?: string[] }> = {
    claude_status: { schema: claudeStatusInputSchema },
    claude_setup: { schema: claudeSetupInputSchema },
    claude_runs: { schema: claudeRunsInputSchema },
    claude_run_inspect: { schema: claudeRunInspectInputSchema },
    claude_result: { schema: claudeResultInputSchema },
    claude_workspace_status: { schema: claudeWorkspaceStatusInputSchema },
    claude_task: { schema: claudeTaskInputSchema },
    claude_review_gate: { schema: claudeReviewGateInputSchema },
    claude_query: { schema: claudeQueryInputSchema },
    claude_review: { schema: claudeReviewInputSchema },
    claude_implement: { schema: claudeImplementInputSchema },
    claude_jobs: { schema: claudeJobsInputSchema },
    claude_job_result: { schema: claudeJobResultInputSchema },
    claude_job_cancel: { schema: claudeJobCancelInputSchema },
    claude_job_wait: { schema: claudeJobWaitInputSchema },
    claude_job_cleanup: { schema: claudeJobCleanupInputSchema },
    claude_apply: { schema: claudeApplyInputSchema },
    claude_cleanup: { schema: claudeCleanupInputSchema },
  };

  function getZodKeys(schema: import("zod").ZodTypeAny): string[] {
    return Object.keys((schema as unknown as { _def: { shape: Record<string, unknown> } })._def.shape);
  }

  for (const def of TOOL_DEFINITIONS) {
    const entry = SCHEMA_MAP[def.name];
    if (!entry) continue;

    it(`${def.name}: every Zod schema field has a matching tool definition property`, () => {
      const zodKeys = getZodKeys(entry.schema);
      const toolKeys = Object.keys(def.inputSchema.properties ?? {});

      for (const key of zodKeys) {
        expect(toolKeys).toContain(key);
      }
    });

    it(`${def.name}: every tool definition property has a matching Zod schema field`, () => {
      const zodKeys = getZodKeys(entry.schema);
      const toolKeys = Object.keys(def.inputSchema.properties ?? {});

      for (const key of toolKeys) {
        expect(zodKeys).toContain(key);
      }
    });
  }
});
