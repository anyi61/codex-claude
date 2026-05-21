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
  errorResult,
  jsonResult,
  safeErrorMessage,
  safeErrorPayload,
} from "../src/schema.js";
import { TOOL_DEFINITIONS } from "../src/server.js";

describe("schema definitions", () => {
  it("returns MCP structuredContent alongside backwards-compatible text JSON", () => {
    const payload = { ok: true, nested: { value: 1 } };
    const result = jsonResult(payload);

    expect(JSON.parse(result.content[0]!.text)).toEqual(payload);
    expect(result.structuredContent).toEqual(payload);
  });

  it("returns structuredContent for MCP errors", () => {
    const result = errorResult("bad input");

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ error: "bad input" });
    expect(result.structuredContent).toEqual({ error: "bad input" });
  });

  it("safeErrorMessage strips quoted absolute paths", () => {
    expect(safeErrorMessage(`Path "/Users/anyi/codex-claude/src/cli.ts" is outside allowed roots`))
      .toBe(`Path "[path]" is outside allowed roots`);
  });

  it("safeErrorMessage strips standalone absolute paths", () => {
    expect(safeErrorMessage("EACCES: /Users/anyi/projects"))
      .toMatch(/\[path\]/);
    expect(safeErrorMessage("EACCES: /Users/anyi/projects")).not.toMatch(/\/Users\/anyi/);
  });

  it("safeErrorPayload recursively sanitizes string values in nested object", () => {
    const input = {
      error: "No output from: /usr/local/bin/claude",
      diagnostics: {
        stderr_tail: "ENOENT: /home/user/.claude/config",
        env_path: "/usr/bin:/bin",
      },
      exit_code: 1,
    };
    const result = safeErrorPayload(input);
    expect(result.error).toMatch(/\[path\]/);
    expect(result.error).not.toMatch(/\/usr\/local/);
    expect((result.diagnostics as Record<string, unknown>).stderr_tail).toMatch(/\[path\]/);
    expect((result.diagnostics as Record<string, unknown>).stderr_tail).not.toMatch(/\/home\/user/);
    expect(result.exit_code).toBe(1);
  });

  it("safeErrorPayload sanitizes strings inside arrays and nested arrays", () => {
    const input = {
      errors: ["ENOENT: /home/user/file.ts", "OK"],
      nested: {
        warnings: ["Path not found: /usr/local/bin", "Retrying"],
      },
    };
    const result = safeErrorPayload(input);
    expect((result.errors as string[])[0]).toMatch(/\[path\]/);
    expect((result.errors as string[])[0]).not.toMatch(/\/home\/user/);
    expect((result.errors as string[])[1]).toBe("OK");
    const nested = result.nested as Record<string, unknown>;
    expect((nested.warnings as string[])[0]).toMatch(/\[path\]/);
  });

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

  it("accepts explicit implement security profiles and rejects unknown profiles", () => {
    expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", task: "x", security_profile: "strict" }).success).toBe(true);
    expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", task: "x", security_profile: "default" }).success).toBe(true);
    expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", task: "x", security_profile: "permissive" }).success).toBe(true);
    expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", task: "x", security_profile: "unsafe" }).success).toBe(false);
    expect(claudeTaskInputSchema.safeParse({ cwd: "/repo", task: "x", mode: "write", security_profile: "strict" }).success).toBe(true);
    expect(claudeTaskInputSchema.safeParse({ cwd: "/repo", task: "x", mode: "write", security_profile: "unsafe" }).success).toBe(false);
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

  it("accepts include_patch and valid patch_max_bytes on claude_apply", () => {
    expect(claudeApplyInputSchema.safeParse({
      cwd: "/repo",
      worktree_path: ".claude/worktrees/codex-delegated-x",
      preview: true,
      include_patch: true,
      patch_max_bytes: 60000,
    }).success).toBe(true);
    expect(claudeApplyInputSchema.safeParse({
      cwd: "/repo",
      worktree_path: ".claude/worktrees/codex-delegated-x",
      preview: true,
      include_patch: true,
    }).success).toBe(true);
  });

  it("rejects patch_max_bytes < 1024 and > 500000", () => {
    expect(claudeApplyInputSchema.safeParse({
      cwd: "/repo",
      worktree_path: ".claude/worktrees/codex-delegated-x",
      include_patch: true,
      patch_max_bytes: 1023,
    }).success).toBe(false);
    expect(claudeApplyInputSchema.safeParse({
      cwd: "/repo",
      worktree_path: ".claude/worktrees/codex-delegated-x",
      include_patch: true,
      patch_max_bytes: 500001,
    }).success).toBe(false);
  });

  it("still rejects preview=true with cleanup=true even when include_patch is set", () => {
    expect(claudeApplyInputSchema.safeParse({
      cwd: "/repo",
      worktree_path: ".claude/worktrees/codex-delegated-x",
      preview: true,
      cleanup: true,
      include_patch: true,
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
    expect(claudeJobsInputSchema.safeParse({ cwd: "/repo", status: "crashed" }).success).toBe(true);
    expect(claudeJobResultInputSchema.safeParse({ cwd: "/repo", job_id: "job-123" }).success).toBe(true);
    expect(claudeJobCancelInputSchema.safeParse({ cwd: "/repo", job_id: "job-123" }).success).toBe(true);
    expect(claudeJobCleanupInputSchema.safeParse({ cwd: "/repo", dry_run: true, older_than_hours: 12, limit: 5 }).success).toBe(true);
    expect(claudeJobWaitInputSchema.safeParse({ cwd: "/repo", job_id: "job-1" }).success).toBe(true);
    expect(claudeJobWaitInputSchema.safeParse({ cwd: "/repo", job_id: "job-1" }).success).toBe(true);
    expect(claudeJobResultInputSchema.safeParse({ cwd: "/repo", job_id: "" }).success).toBe(false);
    expect(claudeJobCleanupInputSchema.safeParse({ cwd: "/repo", limit: 0 }).success).toBe(false);
    expect(claudeJobCleanupInputSchema.safeParse({ cwd: "/repo", older_than_hours: -1 }).success).toBe(false);
    expect(claudeJobWaitInputSchema.safeParse({ cwd: "/repo", job_id: "" }).success).toBe(false);
    expect(claudeJobWaitInputSchema.safeParse({ cwd: "/repo", job_id: "job-1", not_before: "2026-05-06T00:00:30.000Z" }).success).toBe(false);
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

  it("accepts allowed_files and max_changed_files on claude_task", () => {
    const parsed = claudeTaskInputSchema.safeParse({
      cwd: "/repo",
      task: "write docs",
      mode: "write",
      allowed_files: ["src/a.ts", "src/b.ts"],
      max_changed_files: 5,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("unexpected parse failure");
    expect(parsed.data.allowed_files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(parsed.data.max_changed_files).toBe(5);
  });

  it("rejects invalid claude_task max_changed_files", () => {
    expect(claudeTaskInputSchema.safeParse({
      cwd: "/repo",
      task: "write docs",
      max_changed_files: 0,
    }).success).toBe(false);
    expect(claudeTaskInputSchema.safeParse({
      cwd: "/repo",
      task: "write docs",
      max_changed_files: 101,
    }).success).toBe(false);
    expect(claudeTaskInputSchema.safeParse({
      cwd: "/repo",
      task: "write docs",
      max_changed_files: -1,
    }).success).toBe(false);
  });

  it("buildImplementPrompt labels files as allowed files scope", () => {
    const prompt = buildImplementPrompt({
      cwd: "/repo",
      task: "implement feature",
      files: ["src/a.ts"],
    });
    expect(prompt).toContain("## Allowed Files");
    expect(prompt).toContain("Modify only these files");
    expect(prompt).not.toContain("## Relevant Files");
  });

  it("buildImplementPrompt omits allowed files section when files are absent", () => {
    const prompt = buildImplementPrompt({
      cwd: "/repo",
      task: "implement feature",
    });
    expect(prompt).not.toContain("## Allowed Files");
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

  it("rejects max_turns on claude_task input", () => {
    const parsed = claudeTaskInputSchema.safeParse({
      cwd: "/repo",
      task: "write docs",
      mode: "write",
      max_turns: 2,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects timeout_sec on claude_task input", () => {
    const parsed = claudeTaskInputSchema.safeParse({
      cwd: "/repo",
      task: "write docs",
      timeout_sec: 10,
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts wait_strategy, wait_timeout_sec, and job_id on claude_task", () => {
    const parsed = claudeTaskInputSchema.safeParse({
      cwd: "/repo",
      task: "do work",
      wait_strategy: "block",
      wait_timeout_sec: 300,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("unexpected parse failure");
    expect(parsed.data.wait_strategy).toBe("block");
    expect(parsed.data.wait_timeout_sec).toBe(300);

    const bg = claudeTaskInputSchema.safeParse({
      cwd: "/repo",
      task: "do work",
      wait_strategy: "background",
    });
    expect(bg.success).toBe(true);
    expect(bg.data!.wait_strategy).toBe("background");

    const jobOnly = claudeTaskInputSchema.safeParse({
      cwd: "/repo",
      job_id: "job-123",
    });
    expect(jobOnly.success).toBe(true);
    expect(jobOnly.data!.job_id).toBe("job-123");
  });

  it("rejects claude_task with neither task nor job_id", () => {
    expect(claudeTaskInputSchema.safeParse({ cwd: "/repo" }).success).toBe(false);
    expect(claudeTaskInputSchema.safeParse({ cwd: "/repo", mode: "read" }).success).toBe(false);
  });

  it("rejects wait_timeout_sec above 540", () => {
    expect(claudeTaskInputSchema.safeParse({ cwd: "/repo", task: "x", wait_timeout_sec: 541 }).success).toBe(false);
    expect(claudeTaskInputSchema.safeParse({ cwd: "/repo", task: "x", wait_timeout_sec: 540 }).success).toBe(true);
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

  it("accepts reviewed_run_id and reviewed_worktree_path on claudeReviewInputSchema", () => {
    expect(claudeReviewInputSchema.safeParse({
      cwd: "/repo",
      task: "review this",
      reviewed_run_id: "run-abc123",
      reviewed_worktree_path: ".claude/worktrees/codex-delegated-abc",
    }).success).toBe(true);
    expect(claudeReviewInputSchema.safeParse({
      cwd: "/repo",
      task: "review this",
      reviewed_run_id: "run-abc123",
    }).success).toBe(true);
    expect(claudeReviewInputSchema.safeParse({
      cwd: "/repo",
      task: "review this",
      reviewed_worktree_path: ".claude/worktrees/codex-delegated-abc",
    }).success).toBe(true);
    expect(claudeReviewInputSchema.safeParse({
      cwd: "/repo",
      task: "review this",
      reviewed_run_id: "",
    }).success).toBe(false);
    expect(claudeReviewInputSchema.safeParse({
      cwd: "/repo",
      task: "review this",
      reviewed_worktree_path: "",
    }).success).toBe(false);
  });

  it("accepts reviewed_run_id and reviewed_worktree_path on claudeTaskInputSchema", () => {
    expect(claudeTaskInputSchema.safeParse({
      cwd: "/repo",
      task: "review this",
      mode: "review",
      reviewed_run_id: "run-abc123",
      reviewed_worktree_path: ".claude/worktrees/codex-delegated-abc",
    }).success).toBe(true);
    expect(claudeTaskInputSchema.safeParse({
      cwd: "/repo",
      task: "review this",
      mode: "review",
      reviewed_run_id: "run-abc123",
    }).success).toBe(true);
    expect(claudeTaskInputSchema.safeParse({
      cwd: "/repo",
      task: "review this",
      mode: "review",
      reviewed_run_id: "",
    }).success).toBe(false);
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

  it("default tools expose MCP metadata and strict input schemas", () => {
    const defaultTools = new Set([
      "claude_setup",
      "claude_task",
      "claude_result",
      "claude_apply",
      "claude_cleanup",
    ]);

    for (const def of TOOL_DEFINITIONS.filter((tool) => defaultTools.has(tool.name))) {
      expect(def.title).toBeTruthy();
      expect(def.annotations).toEqual(expect.any(Object));
      expect(def.outputSchema).toEqual(expect.objectContaining({ type: "object" }));
      expect(def.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("claude_job_wait remains advanced and outside the default tool set", async () => {
    const { DEFAULT_ENABLED_TOOLS } = await import("../src/codex-config.js");

    expect(DEFAULT_ENABLED_TOOLS).toEqual([
      "claude_setup",
      "claude_task",
      "claude_result",
      "claude_apply",
      "claude_cleanup",
    ]);
    expect(DEFAULT_ENABLED_TOOLS).not.toContain("claude_job_wait");
    expect(TOOL_DEFINITIONS.find((tool) => tool.name === "claude_job_wait")?.description)
      .toMatch(/^Advanced \/ Recovery/);
  });
});

describe("ModeInference type and mode_inference field", () => {
  it("accepts valid ModeInference object on ClaudeTaskResult", () => {
    const result: import("../src/schema.js").ClaudeTaskResult = {
      delegated_mode: "write",
      mode_inference: {
        requested_mode: "auto",
        delegated_mode: "write",
        reason: "write_hints",
        confidence: "high",
        matched_hints: ["修复"],
      },
      summary: "test",
      next_actions: [],
    };
    expect(result.mode_inference?.reason).toBe("write_hints");
    expect(result.mode_inference?.confidence).toBe("high");
    expect(result.mode_inference?.matched_hints).toEqual(["修复"]);
  });

  it("accepts ClaudeTaskResult without mode_inference (optional)", () => {
    const result: import("../src/schema.js").ClaudeTaskResult = {
      delegated_mode: "read",
      summary: "test",
      next_actions: [],
    };
    expect(result.mode_inference).toBeUndefined();
  });

  it("accepts all valid ModeInferenceReason values", () => {
    const validReasons: import("../src/schema.js").ModeInferenceReason[] = [
      "explicit",
      "diff",
      "constraints",
      "query_prefix_override",
      "write_hints",
      "review_hints",
      "read_hints",
      "files_fallback",
      "default_read",
    ];
    for (const reason of validReasons) {
      const inference: import("../src/schema.js").ModeInference = {
        requested_mode: "auto",
        delegated_mode: "read",
        reason,
        confidence: "medium",
        matched_hints: [],
      };
      expect(inference.reason).toBe(reason);
    }
  });

  it("accepts high, medium, low confidence values", () => {
    const validConfidence: Array<"high" | "medium" | "low"> = ["high", "medium", "low"];
    for (const confidence of validConfidence) {
      const inference: import("../src/schema.js").ModeInference = {
        requested_mode: "auto",
        delegated_mode: "read",
        reason: "default_read",
        confidence,
        matched_hints: [],
      };
      expect(inference.confidence).toBe(confidence);
    }
  });
});
