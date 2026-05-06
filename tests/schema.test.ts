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
} from "../src/schema.js";

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
    expect(claudeQueryInputSchema.safeParse({ cwd: "/repo", task: "explain", background: true }).success).toBe(true);
    expect(claudeQueryInputSchema.safeParse({ cwd: "/repo", task: "explain", fast: true, resume: false }).success).toBe(true);
    expect(claudeReviewInputSchema.safeParse({ cwd: "/repo", task: "review this", background: true }).success).toBe(true);
    expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", task: "ship it", background: true }).success).toBe(true);
    expect(claudeJobsInputSchema.safeParse({ cwd: "/repo", limit: 10, type: "query" }).success).toBe(true);
    expect(claudeJobResultInputSchema.safeParse({ cwd: "/repo", job_id: "job-123" }).success).toBe(true);
    expect(claudeJobCancelInputSchema.safeParse({ cwd: "/repo", job_id: "job-123" }).success).toBe(true);
    expect(claudeJobCleanupInputSchema.safeParse({ cwd: "/repo", dry_run: true, older_than_hours: 12, limit: 5 }).success).toBe(true);
    expect(claudeJobWaitInputSchema.safeParse({ cwd: "/repo", job_id: "job-1" }).success).toBe(true);
    expect(claudeJobWaitInputSchema.safeParse({ cwd: "/repo", job_id: "job-1", timeout_ms: 5000 }).success).toBe(true);
    expect(claudeJobResultInputSchema.safeParse({ cwd: "/repo", job_id: "" }).success).toBe(false);
    expect(claudeJobCleanupInputSchema.safeParse({ cwd: "/repo", limit: 0 }).success).toBe(false);
    expect(claudeJobCleanupInputSchema.safeParse({ cwd: "/repo", older_than_hours: -1 }).success).toBe(false);
    expect(claudeJobWaitInputSchema.safeParse({ cwd: "/repo", job_id: "" }).success).toBe(false);
    expect(claudeJobWaitInputSchema.safeParse({ cwd: "/repo", job_id: "job-1", timeout_ms: 0 }).success).toBe(false);
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
