import { describe, expect, it } from "vitest";
import {
  IMPLEMENT_SCHEMA,
  QUERY_SCHEMA,
  REVIEW_SCHEMA,
  claudeApplyInputSchema,
  claudeImplementInputSchema,
  claudeJobCancelInputSchema,
  claudeJobResultInputSchema,
  claudeJobsInputSchema,
  claudeRunInspectInputSchema,
  claudeRunsInputSchema,
  claudeReviewInputSchema,
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
  });

  it("accepts apply preview and validates run filters", () => {
    expect(claudeApplyInputSchema.safeParse({ cwd: "/repo", worktree_path: ".claude/worktrees/codex-delegated-x", preview: true }).success).toBe(true);
    expect(claudeRunsInputSchema.safeParse({ cwd: "/repo", limit: 10, type: "implement", status: "failed" }).success).toBe(true);
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
    expect(claudeReviewInputSchema.safeParse({ cwd: "/repo", task: "review this", background: true }).success).toBe(true);
    expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", task: "ship it", background: true }).success).toBe(true);
    expect(claudeJobsInputSchema.safeParse({ cwd: "/repo", limit: 10 }).success).toBe(true);
    expect(claudeJobResultInputSchema.safeParse({ cwd: "/repo", job_id: "job-123" }).success).toBe(true);
    expect(claudeJobCancelInputSchema.safeParse({ cwd: "/repo", job_id: "job-123" }).success).toBe(true);
    expect(claudeJobResultInputSchema.safeParse({ cwd: "/repo", job_id: "" }).success).toBe(false);
  });
});
