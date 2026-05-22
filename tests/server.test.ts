import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  validateCwdMock,
  validateFilesWithinCwdMock,
  checkRecursionMock,
  supportsWorktreeMock,
  isDelegatedWorktreePathMock,
  getClaudeResultMock,
  manageClaudeReviewGateMock,
  runClaudeSetupMock,
  runClaudeTaskMock,
  getWorkspaceStatusMock,
  recoverCrashedJobsMock,
  listBackgroundJobsMock,
  getBackgroundJobResultMock,
  cancelBackgroundJobMock,
  cleanupBackgroundJobsMock,
  configureCodexAllowRootMock,
  startBackgroundApplyMock,
  startBackgroundCleanupMock,
  startBackgroundImplementMock,
  startBackgroundQueryMock,
  startBackgroundReviewMock,
  waitForBackgroundJobMock,
} = vi.hoisted(() => ({
  validateCwdMock: vi.fn(),
  validateFilesWithinCwdMock: vi.fn(),
  checkRecursionMock: vi.fn(() => 0),
  supportsWorktreeMock: vi.fn(async () => true),
  isDelegatedWorktreePathMock: vi.fn(() => false),
  getClaudeResultMock: vi.fn(),
  manageClaudeReviewGateMock: vi.fn(),
  runClaudeSetupMock: vi.fn(),
  runClaudeTaskMock: vi.fn(),
  getWorkspaceStatusMock: vi.fn(),
  recoverCrashedJobsMock: vi.fn(),
  listBackgroundJobsMock: vi.fn(),
  getBackgroundJobResultMock: vi.fn(),
  cancelBackgroundJobMock: vi.fn(),
  cleanupBackgroundJobsMock: vi.fn(),
  configureCodexAllowRootMock: vi.fn(),
  startBackgroundApplyMock: vi.fn(),
  startBackgroundCleanupMock: vi.fn(),
  startBackgroundImplementMock: vi.fn(),
  startBackgroundQueryMock: vi.fn(),
  startBackgroundReviewMock: vi.fn(),
  waitForBackgroundJobMock: vi.fn(),
}));

vi.mock("../src/guard.js", () => ({
  MAX_BRIDGE_DEPTH: 2,
  checkRecursion: checkRecursionMock,
  supportsWorktree: supportsWorktreeMock,
  isDelegatedWorktreePath: isDelegatedWorktreePathMock,
  validateCwd: validateCwdMock,
  validateFilesWithinCwd: validateFilesWithinCwdMock,
}));

vi.mock("../src/codex-config.js", () => ({
  configureCodexAllowRoot: configureCodexAllowRootMock,
}));

vi.mock("../src/claude-cli.js", () => ({
  cancelBackgroundJob: cancelBackgroundJobMock,
  checkClaudeStatus: vi.fn(),
  cleanupBackgroundJobs: cleanupBackgroundJobsMock,
  getClaudeResult: getClaudeResultMock,
  getBackgroundJobResult: getBackgroundJobResultMock,
  getRunLogById: vi.fn(),
  getWorkspaceStatus: getWorkspaceStatusMock,
  recoverCrashedJobs: recoverCrashedJobsMock,
  manageClaudeReviewGate: manageClaudeReviewGateMock,
  runClaudeSetup: runClaudeSetupMock,
  runClaudeTask: runClaudeTaskMock,
  runClaudeQuery: vi.fn(),
  runClaudeReview: vi.fn(),
  runClaudeImplement: vi.fn(),
  runClaudeApply: vi.fn(),
  runClaudeCleanup: vi.fn(),
  getRecentRunsSummary: vi.fn(),
  listBackgroundJobs: listBackgroundJobsMock,
  listRunLogs: vi.fn(),
  startBackgroundApply: startBackgroundApplyMock,
  startBackgroundCleanup: startBackgroundCleanupMock,
  startBackgroundImplement: startBackgroundImplementMock,
  startBackgroundQuery: startBackgroundQueryMock,
  startBackgroundReview: startBackgroundReviewMock,
  waitForBackgroundJob: waitForBackgroundJobMock,
  inferClaudeTaskMode: vi.fn((input: { task?: string; diff?: string; constraints?: string[] }) => {
    const text = (input.task ?? "").toLowerCase();
    if (typeof input.diff === "string" && input.diff.trim().length > 0) return { mode: "review", inference: { reason: "diff" } };
    if ((input.constraints?.length ?? 0) > 0) return { mode: "write", inference: { reason: "constraints" } };
    if (/\b(fix|change|implement|write|edit|modify|update|refactor|patch|add|create)\b/.test(text)) return { mode: "write", inference: { reason: "write_hints" } };
    if (/修复|实现|修改|添加|重构|补充|提交|更新|创建|编写|删除|移除|调整|优化|改造/.test(input.task ?? "")) return { mode: "write", inference: { reason: "write_hints" } };
    return { mode: "read", inference: { reason: "default_read" } };
  }),
}));

const { handleToolCall, registerToolDefinitions, TOOL_DEFINITIONS, buildTaskInteraction, recoverCrashedJobsOnStartup } = await import("../src/server.js");

function parsePayload(result: Awaited<ReturnType<typeof handleToolCall>>) {
  expect(result.content[0]?.type).toBe("text");
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("server background job handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validateCwdMock.mockResolvedValue({ ok: true, resolved: "/repo/resolved" });
    validateFilesWithinCwdMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers the complete MCP tool surface", async () => {
    let listToolsHandler: (() => Promise<{ tools: Array<{ name: string }> }>) | undefined;
    const fakeServer = {
      setRequestHandler: vi.fn((_schema: unknown, handler: () => Promise<{ tools: Array<{ name: string }> }>) => {
        listToolsHandler = handler;
      }),
    };

    registerToolDefinitions(fakeServer as never);

    const result = await listToolsHandler!();
    expect(result.tools.map((tool) => tool.name)).toEqual([
      "claude_status",
      "claude_setup",
      "claude_runs",
      "claude_run_inspect",
      "claude_result",
      "claude_workspace_status",
      "claude_task",
      "claude_review_gate",
      "claude_query",
      "claude_review",
      "claude_implement",
      "claude_jobs",
      "claude_job_result",
      "claude_job_cancel",
      "claude_job_wait",
      "claude_job_cleanup",
      "claude_apply",
      "claude_cleanup",
    ]);
  });

  it("runs crashed job recovery as best-effort startup work", async () => {
    const recover = vi.fn(async () => {
      throw new Error("store unavailable");
    });

    await expect(recoverCrashedJobsOnStartup(recover)).resolves.toBeUndefined();

    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("routes claude_jobs through listBackgroundJobs with resolved cwd", async () => {
    listBackgroundJobsMock.mockResolvedValue({
      entries: [{ job_id: "job-1", status: "queued" }],
      total_entries: 1,
    });

    const result = await handleToolCall("claude_jobs", { cwd: "/repo/input", limit: 5 });
    const payload = parsePayload(result);

    expect(validateCwdMock).toHaveBeenCalledWith("/repo/input");
    expect(listBackgroundJobsMock).toHaveBeenCalledWith({ cwd: "/repo/resolved", limit: 5 });
    expect(payload.entries).toEqual([{ job_id: "job-1", status: "queued" }]);
    expect(result.isError).toBeUndefined();
  });

  it("routes claude_result through getClaudeResult with resolved cwd", async () => {
    getClaudeResultMock.mockResolvedValue({
      source_type: "job",
      summary: "Implement job completed",
      job: { job_id: "job-1", type: "implement", status: "succeeded" },
      run: { run_id: "run-1", type: "implement", lifecycle: "success" },
      next_actions: [{ tool: "claude_apply", reason: "land it" }],
    });

    const result = await handleToolCall("claude_result", {
      cwd: "/repo/input",
      job_id: "job-1",
    });
    const payload = parsePayload(result);

    expect(validateCwdMock).toHaveBeenCalledWith("/repo/input");
    expect(getClaudeResultMock).toHaveBeenCalledWith({
      cwd: "/repo/resolved",
      job_id: "job-1",
      prefer: "latest-job",
    });
    expect(payload.summary).toBe("Implement job completed");
    expect(result.isError).toBeUndefined();
  });

  it("routes claude_setup through runClaudeSetup with resolved cwd", async () => {
    runClaudeSetupMock.mockResolvedValue({
      workspace_root: "/repo/resolved",
      review_gate: { enabled: false, pending_review: false },
      claude_available: true,
      claude_version: "1.0.0",
      auth_status: "ok",
      git_available: true,
      worktree_capable: true,
      cwd_valid: true,
      cwd_is_git_repo: true,
      errors: [],
      next_steps: [],
    });

    const result = await handleToolCall("claude_setup", { cwd: "/repo/input" });
    const payload = parsePayload(result);

    expect(validateCwdMock).toHaveBeenCalledWith("/repo/input");
    expect(runClaudeSetupMock).toHaveBeenCalledWith({ cwd: "/repo/resolved" });
    expect(payload.workspace_root).toBe("/repo/resolved");
    expect(result.isError).toBeUndefined();
  });

  it("can configure the requested cwd as an allow root before running claude_setup", async () => {
    validateCwdMock
      .mockResolvedValueOnce({ ok: false, resolved: "/repo/input", error: "outside allowed roots" })
      .mockResolvedValueOnce({ ok: true, resolved: "/repo/input" });
    configureCodexAllowRootMock.mockResolvedValue({
      config_path: "/home/user/.codex/config.toml",
      changed: true,
      allow_roots: ["/repo/input"],
      env_value: "/repo/input",
    });
    runClaudeSetupMock.mockResolvedValue({
      workspace_root: "/repo/input",
      review_gate: { enabled: false, pending_review: false },
      claude_available: true,
      claude_version: "1.0.0",
      auth_status: "ok",
      git_available: true,
      worktree_capable: true,
      cwd_valid: true,
      cwd_is_git_repo: true,
      errors: [],
      next_steps: [],
    });

    const result = await handleToolCall("claude_setup", {
      cwd: "/repo/input",
      configure_allow_root: true,
    });
    const payload = parsePayload(result);

    expect(configureCodexAllowRootMock).toHaveBeenCalledWith("/repo/input");
    expect(validateCwdMock).toHaveBeenCalledTimes(2);
    expect(runClaudeSetupMock).toHaveBeenCalledWith({ cwd: "/repo/input" });
    expect(payload.allow_root_configuration).toMatchObject({
      changed: true,
      env_value: "/repo/input",
    });
    expect(result.isError).toBeUndefined();
  });

  it("returns validation errors for claude_result when both job_id and run_id are provided", async () => {
    const result = await handleToolCall("claude_result", {
      cwd: "/repo/input",
      job_id: "job-1",
      run_id: "run-1",
    });
    const payload = parsePayload(result);

    expect(validateCwdMock).not.toHaveBeenCalled();
    expect(getClaudeResultMock).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(String(payload.error)).toContain("cannot be combined");
  });

  it("returns a shaped error when claude_result cannot resolve an artifact", async () => {
    getClaudeResultMock.mockRejectedValue(new Error("No matching finished job or run found for this workspace."));

    const result = await handleToolCall("claude_result", {
      cwd: "/repo/input",
      prefer: "latest-job",
    });
    const payload = parsePayload(result);

    expect(validateCwdMock).toHaveBeenCalledWith("/repo/input");
    expect(getClaudeResultMock).toHaveBeenCalledWith({
      cwd: "/repo/resolved",
      prefer: "latest-job",
    });
    expect(result.isError).toBe(true);
    expect(payload).toEqual({ error: "No matching finished job or run found for this workspace." });
  });

  it("routes claude_workspace_status through getWorkspaceStatus with resolved cwd", async () => {
    getWorkspaceStatusMock.mockResolvedValue({
      workspace_root: "/repo/resolved",
      running_jobs: [],
      queued_jobs: [],
      crashed_jobs: [],
      recent_terminal_jobs: [],
      recent_runs: [],
      latest_sessions: [],
      delegated_worktrees: [],
      counts: {
        running_jobs: 0,
        queued_jobs: 0,
        crashed_jobs: 0,
        terminal_jobs: 0,
        recent_runs: 0,
        delegated_worktrees: 0,
        stale_worktrees: 0,
        apply_blocked_runs: 0,
      },
      attention_items: [],
    });

    const result = await handleToolCall("claude_workspace_status", {
      cwd: "/repo/input",
      limit: 7,
      include_terminal: false,
    });
    const payload = parsePayload(result);

    expect(validateCwdMock).toHaveBeenCalledWith("/repo/input");
    expect(getWorkspaceStatusMock).toHaveBeenCalledWith({
      cwd: "/repo/resolved",
      limit: 7,
      include_terminal: false,
    });
    expect(payload.workspace_root).toBe("/repo/resolved");
    expect(result.isError).toBeUndefined();
  });

  it("routes claude_task through runClaudeTask with resolved cwd", async () => {
    runClaudeTaskMock.mockResolvedValue({
      delegated_mode: "read",
      summary: "Delegated read task as a background job.",
      status: "running",
      job: { job_id: "job-read", type: "query", status: "queued" },
      completed_inline: false,
      next_actions: [],
    });

    const result = await handleToolCall("claude_task", {
      cwd: "/repo/input",
      task: "Explain auth flow",
      mode: "read",
      background: true,
      sensitive_file_policy: "strict",
    });
    const payload = parsePayload(result);

    expect(validateCwdMock).toHaveBeenCalledWith("/repo/input");
    expect(validateFilesWithinCwdMock).toHaveBeenCalledWith("/repo/resolved", []);
    expect(runClaudeTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/repo/resolved",
      task: "Explain auth flow",
      mode: "read",
      background: true,
      sensitive_file_policy: "strict",
    }), expect.any(String));
    expect(payload.delegated_mode).toBe("read");
    expect(result.isError).toBeUndefined();
  });

  it("validates claude_task instruction files and deprecated files before routing", async () => {
    runClaudeTaskMock.mockResolvedValue({
      delegated_mode: "write",
      summary: "Delegated write task as a background job.",
      job: { job_id: "job-write", type: "implement", status: "queued" },
      warnings: [
        "claude_task.files is deprecated and treated as instruction_files, not apply scope. Use allowed_files for strict file modification limits.",
      ],
      next_actions: [],
    });

    const result = await handleToolCall("claude_task", {
      cwd: "/repo/input",
      task: "Execute PROJECT_EXPANSION_PLAN.md",
      mode: "write",
      instruction_files: ["PROJECT_EXPANSION_PLAN.md"],
      files: ["LEGACY_PLAN.md"],
      dirty_policy: "committed",
    });
    const payload = parsePayload(result);

    expect(validateFilesWithinCwdMock).toHaveBeenCalledWith("/repo/resolved", [
      "PROJECT_EXPANSION_PLAN.md",
      "LEGACY_PLAN.md",
    ]);
    expect(runClaudeTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/repo/resolved",
      task: "Execute PROJECT_EXPANSION_PLAN.md",
      mode: "write",
      instruction_files: ["PROJECT_EXPANSION_PLAN.md"],
      files: ["LEGACY_PLAN.md"],
      dirty_policy: "committed",
    }), expect.any(String));
    expect(payload.warnings).toEqual([
      "claude_task.files is deprecated and treated as instruction_files, not apply scope. Use allowed_files for strict file modification limits.",
    ]);
  });

  it("routes claude_review_gate through manageClaudeReviewGate with resolved cwd", async () => {
    manageClaudeReviewGateMock.mockResolvedValue({
      action: "enable",
      changed: true,
      enabled: true,
      hook_installed: true,
      summary: "Review gate enabled for this workspace and stop-hook manifest is ready.",
      next_steps: [],
    });

    const result = await handleToolCall("claude_review_gate", {
      cwd: "/repo/input",
      action: "enable",
    });
    const payload = parsePayload(result);

    expect(validateCwdMock).toHaveBeenCalledWith("/repo/input");
    expect(manageClaudeReviewGateMock).toHaveBeenCalledWith({
      cwd: "/repo/resolved",
      action: "enable",
    });
    expect(payload.enabled).toBe(true);
    expect(result.isError).toBeUndefined();
  });

  it("returns a validation error for claude_review_gate when cwd is invalid", async () => {
    validateCwdMock.mockResolvedValueOnce({ ok: false, error: "cwd is outside allowed roots" });

    const result = await handleToolCall("claude_review_gate", {
      cwd: "/repo/input",
      action: "enable",
    });
    const payload = parsePayload(result);

    expect(validateCwdMock).toHaveBeenCalledWith("/repo/input");
    expect(manageClaudeReviewGateMock).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(payload).toEqual({ error: "cwd is outside allowed roots" });
  });

  it("routes claude_query background requests through startBackgroundQuery", async () => {
    startBackgroundQueryMock.mockResolvedValue({
      job: { job_id: "job-query", type: "query", status: "queued" },
    });

    const result = await handleToolCall("claude_query", {
      cwd: "/repo/input",
      task: "explain this",
    });
    const payload = parsePayload(result);

    expect(validateCwdMock).toHaveBeenCalledWith("/repo/input");
    expect(startBackgroundQueryMock).toHaveBeenCalledWith({
      cwd: "/repo/resolved",
      task: "explain this",
      timeout_sec: 120,
      max_turns: undefined,
      fast: undefined,
      resume: undefined,
    });
    expect((payload.job as Record<string, unknown>).type).toBe("query");
  });

  it("routes claude_query default requests through startBackgroundQuery", async () => {
    startBackgroundQueryMock.mockResolvedValue({
      job: { job_id: "job-query-default", type: "query", status: "queued" },
    });

    const result = await handleToolCall("claude_query", {
      cwd: "/repo/input",
      task: "explain this without blocking",
    });
    const payload = parsePayload(result);

    expect(validateCwdMock).toHaveBeenCalledWith("/repo/input");
    expect(startBackgroundQueryMock).toHaveBeenCalledWith({
      cwd: "/repo/resolved",
      task: "explain this without blocking",
      timeout_sec: 120,
      max_turns: undefined,
      fast: undefined,
      resume: undefined,
    });
    expect((payload.job as Record<string, unknown>).job_id).toBe("job-query-default");
    expect(result.isError).toBeUndefined();
  });

  it("uses fast query defaults and passes resume override", async () => {
    startBackgroundQueryMock.mockResolvedValue({
      job: { job_id: "job-query-fast", type: "query", status: "queued" },
    });

    const result = await handleToolCall("claude_query", {
      cwd: "/repo/input",
      task: "explain this quickly",
      fast: true,
      resume: false,
    });
    const payload = parsePayload(result);

    expect(validateCwdMock).toHaveBeenCalledWith("/repo/input");
    expect(startBackgroundQueryMock).toHaveBeenCalledWith({
      cwd: "/repo/resolved",
      task: "explain this quickly",
      timeout_sec: 45,
      max_turns: 2,
      fast: true,
      resume: false,
    });
    expect((payload.job as Record<string, unknown>).type).toBe("query");
  });

  it("routes claude_review default requests through startBackgroundReview", async () => {
    startBackgroundReviewMock.mockResolvedValue({
      job: { job_id: "job-review-default", type: "review", status: "queued" },
    });

    const result = await handleToolCall("claude_review", {
      cwd: "/repo/input",
      task: "review this",
      files: ["README.md"],
    });
    const payload = parsePayload(result);

    expect(validateCwdMock).toHaveBeenCalledWith("/repo/input");
    expect(validateFilesWithinCwdMock).toHaveBeenCalledWith("/repo/resolved", ["README.md"]);
    expect(startBackgroundReviewMock).toHaveBeenCalledWith({
      cwd: "/repo/resolved",
      task: "review this",
      diff: undefined,
      instruction_files: undefined,
      files: ["README.md"],
      timeout_sec: 180,
      max_turns: undefined,
      reviewed_run_id: undefined,
      reviewed_worktree_path: undefined,
    });
    expect((payload.job as Record<string, unknown>).job_id).toBe("job-review-default");
    expect(result.isError).toBeUndefined();
  });

  it("forwards reviewed_run_id and reviewed_worktree_path through claude_review", async () => {
    startBackgroundReviewMock.mockResolvedValue({
      job: { job_id: "job-review-bound", type: "review", status: "queued" },
    });

    const result = await handleToolCall("claude_review", {
      cwd: "/repo/input",
      task: "review this",
      reviewed_run_id: "run-implement-123",
      reviewed_worktree_path: ".claude/worktrees/codex-delegated-abc",
    });
    parsePayload(result);

    expect(startBackgroundReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/repo/resolved",
        task: "review this",
        reviewed_run_id: "run-implement-123",
        reviewed_worktree_path: ".claude/worktrees/codex-delegated-abc",
      }),
    );
    expect(result.isError).toBeUndefined();
  });

  it("forwards reviewed_run_id and reviewed_worktree_path through claude_task review mode", async () => {
    runClaudeTaskMock.mockResolvedValue({
      delegated_mode: "review",
      summary: "review ok",
      status: "success",
      completed_inline: true,
      next_actions: [],
    });

    const result = await handleToolCall("claude_task", {
      cwd: "/repo/input",
      task: "review this",
      mode: "review",
      reviewed_run_id: "run-implement-456",
      reviewed_worktree_path: ".claude/worktrees/codex-delegated-def",
    });
    parsePayload(result);

    expect(runClaudeTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/repo/resolved",
        task: "review this",
        mode: "review",
        reviewed_run_id: "run-implement-456",
        reviewed_worktree_path: ".claude/worktrees/codex-delegated-def",
      }),
      expect.any(String),
    );
    expect(result.isError).toBeUndefined();
  });

  it("routes claude_implement default requests through startBackgroundImplement", async () => {
    startBackgroundImplementMock.mockResolvedValue({
      job: { job_id: "job-implement-default", type: "implement", status: "queued" },
    });

    const result = await handleToolCall("claude_implement", {
      cwd: "/repo/input",
      task: "implement this",
      files: ["README.md"],
      dirty_policy: "committed",
      sensitive_file_policy: "off",
    });
    const payload = parsePayload(result);

    expect(validateCwdMock).toHaveBeenCalledWith("/repo/input");
    expect(validateFilesWithinCwdMock).toHaveBeenCalledWith("/repo/resolved", ["README.md"]);
    expect(supportsWorktreeMock).toHaveBeenCalledWith("/repo/resolved");
    expect(startBackgroundImplementMock).toHaveBeenCalledWith({
      cwd: "/repo/resolved",
      task: "implement this",
      files: ["README.md"],
      constraints: undefined,
      timeout_sec: 600,
      max_turns: undefined,
      session_key: undefined,
      fork_session: undefined,
      resume_latest: undefined,
      max_cost_usd: undefined,
      max_changed_files: undefined,
      worktreeName: undefined,
      dirty_policy: "committed",
      security_profile: "default",
      sensitive_file_policy: "off",
    });
    expect((payload.job as Record<string, unknown>).job_id).toBe("job-implement-default");
    expect(result.isError).toBeUndefined();
  });

  it("routes claude_implement verification_commands through to startBackgroundImplement", async () => {
    startBackgroundImplementMock.mockResolvedValue({
      job: { job_id: "job-verify", type: "implement", status: "queued" },
    });

    const result = await handleToolCall("claude_implement", {
      cwd: "/repo/input",
      task: "implement with verification",
      verification_commands: ["npm test", "npm run typecheck"],
    });
    const payload = parsePayload(result);

    expect(startBackgroundImplementMock).toHaveBeenCalledWith({
      cwd: "/repo/resolved",
      task: "implement with verification",
      files: undefined,
      constraints: undefined,
      timeout_sec: 600,
      max_turns: undefined,
      session_key: undefined,
      fork_session: undefined,
      resume_latest: undefined,
      max_cost_usd: undefined,
      max_changed_files: undefined,
      worktreeName: undefined,
      dirty_policy: undefined,
      security_profile: "default",
      sensitive_file_policy: undefined,
      verification_commands: ["npm test", "npm run typecheck"],
    });
    expect((payload.job as Record<string, unknown>).job_id).toBe("job-verify");
    expect(result.isError).toBeUndefined();
  });

  it("routes claude_implement with undefined verification_commands when omitted", async () => {
    startBackgroundImplementMock.mockResolvedValue({
      job: { job_id: "job-noverify", type: "implement", status: "queued" },
    });

    await handleToolCall("claude_implement", {
      cwd: "/repo/input",
      task: "no verification",
    });

    expect(startBackgroundImplementMock).toHaveBeenCalledTimes(1);
    const callArgs = startBackgroundImplementMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.verification_commands).toBeUndefined();
  });

  it("returns validation errors for claude_job_result with empty job_id", async () => {
    const result = await handleToolCall("claude_job_result", { cwd: "/repo/input", job_id: "" });
    const payload = parsePayload(result);

    expect(validateCwdMock).not.toHaveBeenCalled();
    expect(getBackgroundJobResultMock).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(String(payload.error)).toContain("job_id");
  });

  it("returns not found error when claude_job_result has no record", async () => {
    getBackgroundJobResultMock.mockResolvedValue(null);

    const result = await handleToolCall("claude_job_result", { cwd: "/repo/input", job_id: "job-missing" });
    const payload = parsePayload(result);

    expect(validateCwdMock).toHaveBeenCalledWith("/repo/input");
    expect(getBackgroundJobResultMock).toHaveBeenCalledWith({
      cwd: "/repo/resolved",
      job_id: "job-missing",
    });
    expect(result.isError).toBe(true);
    expect(payload.error).toBe("Job not found: job-missing");
  });

  it("returns cancel error when claude_job_cancel reports not cancelled", async () => {
    cancelBackgroundJobMock.mockResolvedValue({
      job_id: "job-1",
      cancelled: false,
      error: "worker is already finished",
    });

    const result = await handleToolCall("claude_job_cancel", { cwd: "/repo/input", job_id: "job-1" });
    const payload = parsePayload(result);

    expect(validateCwdMock).toHaveBeenCalledWith("/repo/input");
    expect(cancelBackgroundJobMock).toHaveBeenCalledWith({
      cwd: "/repo/resolved",
      job_id: "job-1",
    });
    expect(result.isError).toBe(true);
    expect(payload.error).toBe("worker is already finished");
  });

  it("routes claude_job_wait through waitForBackgroundJob with resolved cwd", async () => {
    waitForBackgroundJobMock.mockResolvedValue({
      job: { job_id: "job-1", status: "succeeded" },
      status: "succeeded",
      summary: "Job job-1 is succeeded; use the returned result or claude_result for follow-up.",
      waiting: false,
      timed_out: false,
      do_not_start_duplicate_job: false,
      age_ms: 1000,
      stale_state: "fresh",
      result: { ok: true },
      next_actions: [],
    });

    const result = await handleToolCall("claude_job_wait", {
      cwd: "/repo/input",
      job_id: "job-1",
    });
    const payload = parsePayload(result);

    expect(validateCwdMock).toHaveBeenCalledWith("/repo/input");
    expect(waitForBackgroundJobMock).toHaveBeenCalledWith({
      cwd: "/repo/resolved",
      job_id: "job-1",
    });
    expect((payload.job as Record<string, unknown>).status).toBe("succeeded");
    expect(payload.timed_out).toBe(false);
    expect(result.isError).toBeUndefined();
  });

  it("routes claude_job_cleanup through cleanupBackgroundJobs with resolved cwd", async () => {
    cleanupBackgroundJobsMock.mockResolvedValue({
      dry_run: true,
      matched_count: 1,
      removed_count: 0,
      failed_count: 0,
      entries: [{ job_id: "job-1", status: "succeeded", removed: false }],
    });

    const result = await handleToolCall("claude_job_cleanup", {
      cwd: "/repo/input",
      older_than_hours: 48,
      dry_run: true,
      limit: 10,
    });
    const payload = parsePayload(result);

    expect(validateCwdMock).toHaveBeenCalledWith("/repo/input");
    expect(cleanupBackgroundJobsMock).toHaveBeenCalledWith({
      cwd: "/repo/resolved",
      older_than_hours: 48,
      dry_run: true,
      limit: 10,
    });
    expect(payload.matched_count).toBe(1);
    expect(result.isError).toBeUndefined();
  });

  it("routes claude_apply background requests through startBackgroundApply", async () => {
    startBackgroundApplyMock.mockResolvedValue({
      job: { job_id: "job-apply", type: "apply", status: "queued" },
    });

    const result = await handleToolCall("claude_apply", {
      cwd: "/repo/input",
      worktree_path: ".claude/worktrees/codex-delegated-apply",
      background: true,
    });
    const payload = parsePayload(result);

    expect(validateCwdMock).toHaveBeenCalledWith("/repo/input");
    expect(startBackgroundApplyMock).toHaveBeenCalledWith({
      cwd: "/repo/resolved",
      worktree_path: ".claude/worktrees/codex-delegated-apply",
      cleanup: undefined,
      preview: undefined,
      background: true,
    });
    expect((payload.job as Record<string, unknown>).type).toBe("apply");
  });

  it("forwards confirmed_by_user to runClaudeApply", async () => {
    const runClaudeApply = (await import("../src/claude-cli.js")).runClaudeApply as ReturnType<typeof vi.fn>;
    runClaudeApply.mockResolvedValue({
      applied_files: [], diff_stat: "", cleanup_performed: false, conflicts: [],
      preview: false, planned_changes: [],
    });

    await handleToolCall("claude_apply", {
      cwd: "/repo/input",
      worktree_path: ".claude/worktrees/codex-delegated-x",
      confirmed_by_user: true,
    });

    expect(runClaudeApply).toHaveBeenCalledWith(
      expect.objectContaining({ confirmed_by_user: true }),
      expect.any(String),
    );
  });

  it("forwards confirmed_by_user to startBackgroundApply", async () => {
    startBackgroundApplyMock.mockResolvedValue({
      job: { job_id: "job-bg-apply", type: "apply", status: "queued" },
    });

    await handleToolCall("claude_apply", {
      cwd: "/repo/input",
      worktree_path: ".claude/worktrees/codex-delegated-x",
      background: true,
      confirmed_by_user: true,
    });

    expect(startBackgroundApplyMock).toHaveBeenCalledWith(
      expect.objectContaining({ confirmed_by_user: true }),
    );
  });

  it("returns needs_user interaction when apply result has dirty_recovery_needed", async () => {
    const runClaudeApply = (await import("../src/claude-cli.js")).runClaudeApply as ReturnType<typeof vi.fn>;
    runClaudeApply.mockResolvedValue({
      applied_files: [],
      diff_stat: "",
      cleanup_performed: false,
      conflicts: [],
      preview: false,
      planned_changes: [{ status: "M", file: "file1.txt" }],
      dirty_recovery_needed: true,
      dirty_files: [{ file: "file1.txt", status: "rollback_restore_failed" }],
      rollback_error: "ENOSPC during rollback",
      error: "Apply failed for file2.txt: ENOSPC. Rollback also failed.",
    });

    const result = await handleToolCall("claude_apply", {
      cwd: "/repo/input",
      worktree_path: ".claude/worktrees/codex-delegated-x",
      confirmed_by_user: true,
    });
    const payload = parsePayload(result);

    expect(payload.dirty_recovery_needed).toBe(true);
    expect(payload.dirty_files).toBeDefined();
    expect(payload.rollback_error).toBe("ENOSPC during rollback");
    expect(payload.interaction).toBeDefined();
    const interaction = payload.interaction as Record<string, unknown>;
    expect(interaction.state).toBe("needs_user");
    expect(interaction.headline).toContain("rollback");
  });

  it("returns needs_user interaction when rollback succeeded but apply had error", async () => {
    const runClaudeApply = (await import("../src/claude-cli.js")).runClaudeApply as ReturnType<typeof vi.fn>;
    runClaudeApply.mockResolvedValue({
      applied_files: [],
      diff_stat: "",
      cleanup_performed: false,
      conflicts: [],
      preview: false,
      planned_changes: [{ status: "M", file: "file1.txt" }],
      error: "Apply failed for file2.txt: ENOSPC: no space",
    });

    const result = await handleToolCall("claude_apply", {
      cwd: "/repo/input",
      worktree_path: ".claude/worktrees/codex-delegated-x",
      confirmed_by_user: true,
    });
    const payload = parsePayload(result);

    expect(payload.applied_files).toEqual([]);
    expect(payload.error).toContain("ENOSPC");
    expect(payload.interaction).toBeDefined();
    const interaction = payload.interaction as Record<string, unknown>;
    expect(interaction.state).toBe("needs_user");
    expect(interaction.headline).not.toContain("Applied");
  });

  it("routes claude_cleanup background requests through startBackgroundCleanup", async () => {
    startBackgroundCleanupMock.mockResolvedValue({
      job: { job_id: "job-cleanup", type: "cleanup", status: "queued" },
    });

    const result = await handleToolCall("claude_cleanup", {
      cwd: "/repo/input",
      dry_run: true,
      older_than_hours: 24,
      background: true,
    });
    const payload = parsePayload(result);

    expect(validateCwdMock).toHaveBeenCalledWith("/repo/input");
    expect(startBackgroundCleanupMock).toHaveBeenCalledWith({
      cwd: "/repo/resolved",
      dry_run: true,
      older_than_hours: 24,
      background: true,
    });
    expect((payload.job as Record<string, unknown>).type).toBe("cleanup");
  });

  it("does not expose max_turns on claude_task input schema", () => {
    const taskTool = TOOL_DEFINITIONS.find((tool) => tool.name === "claude_task");
    expect(taskTool?.inputSchema.properties).not.toHaveProperty("max_turns");
  });

  it("does not expose timeout_sec on claude_task input schema", () => {
    const taskTool = TOOL_DEFINITIONS.find((tool) => tool.name === "claude_task");
    expect(taskTool?.inputSchema.properties).not.toHaveProperty("timeout_sec");
  });

  it("documents job_id and wait_strategy in claude_task metadata", () => {
    const taskTool = TOOL_DEFINITIONS.find((tool) => tool.name === "claude_task");
    expect(taskTool?.inputSchema.properties).toHaveProperty("job_id");
    expect(taskTool?.inputSchema.properties).toHaveProperty("wait_strategy");
    expect(taskTool?.inputSchema.properties).toHaveProperty("wait_timeout_sec");
    expect(taskTool?.inputSchema.required).not.toContain("task");
    expect(taskTool?.inputSchema.required).toEqual(["cwd"]);
  });

  it("routes claude_task job_id continuation without requiring task", async () => {
    runClaudeTaskMock.mockResolvedValue({
      delegated_mode: "read",
      summary: "Continuing job job-existing.",
      status: "running",
      job: { job_id: "job-existing", type: "query", status: "running" },
      completed_inline: false,
      waiting: true,
      do_not_start_duplicate_job: true,
      next_actions: [{ tool: "claude_task", reason: "continue", args: { cwd: "/repo/resolved", job_id: "job-existing" } }],
    });

    const result = await handleToolCall("claude_task", {
      cwd: "/repo/input",
      job_id: "job-existing",
    });
    const payload = parsePayload(result);

    expect(validateCwdMock).toHaveBeenCalledWith("/repo/input");
    expect(runClaudeTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/repo/resolved",
      job_id: "job-existing",
    }), expect.any(String));
    expect(result.isError).toBeUndefined();
  });

  it("claude_job_wait description marks it as Advanced/Recovery", () => {
    const waitTool = TOOL_DEFINITIONS.find((tool) => tool.name === "claude_job_wait");
    expect(waitTool?.description).toMatch(/^Advanced \/ Recovery/);
  });

  it("exposes confirmed_by_user on claude_apply input schema", () => {
    const applyTool = TOOL_DEFINITIONS.find((tool) => tool.name === "claude_apply");
    expect(applyTool?.inputSchema.properties).toHaveProperty("confirmed_by_user");
  });

  it("documents allowed_files and max_changed_files in claude_task metadata", () => {
    const taskTool = TOOL_DEFINITIONS.find((tool) => tool.name === "claude_task");
    expect(taskTool?.inputSchema.properties).toHaveProperty("allowed_files");
    expect(taskTool?.inputSchema.properties).toHaveProperty("max_changed_files");
  });

  it("exposes sensitive_file_policy on claude_task, claude_query, claude_review, and claude_implement tool definitions", () => {
    const taskTool = TOOL_DEFINITIONS.find((tool) => tool.name === "claude_task");
    const queryTool = TOOL_DEFINITIONS.find((tool) => tool.name === "claude_query");
    const reviewTool = TOOL_DEFINITIONS.find((tool) => tool.name === "claude_review");
    const implementTool = TOOL_DEFINITIONS.find((tool) => tool.name === "claude_implement");

    expect(taskTool?.inputSchema.properties).toHaveProperty("sensitive_file_policy");
    expect(queryTool?.inputSchema.properties).toHaveProperty("sensitive_file_policy");
    expect(reviewTool?.inputSchema.properties).toHaveProperty("sensitive_file_policy");
    expect(implementTool?.inputSchema.properties).toHaveProperty("sensitive_file_policy");
  });

  it("rejects claude_task allowed_files outside cwd", async () => {
    validateFilesWithinCwdMock.mockResolvedValue({ ok: false, error: "File is outside allowed roots" });

    const result = await handleToolCall("claude_task", {
      cwd: "/repo/input",
      task: "write docs",
      mode: "write",
      allowed_files: ["../secret"],
      dirty_policy: "committed",
    });
    const payload = parsePayload(result);

    expect(result.isError).toBe(true);
    expect(String(payload.error)).toContain("outside allowed roots");
    expect(validateFilesWithinCwdMock).toHaveBeenCalledWith("/repo/resolved", ["../secret"]);
    expect(runClaudeTaskMock).not.toHaveBeenCalled();
  });

  it("does not treat allowed_files alone as write-mode nested guard signal", async () => {
    runClaudeTaskMock.mockResolvedValue({
      delegated_mode: "read",
      summary: "read ok",
      status: "success",
      completed_inline: true,
      next_actions: [],
    });

    const result = await handleToolCall("claude_task", {
      cwd: "/repo/input",
      task: "explain src/a.ts",
      mode: "auto",
      allowed_files: ["src/a.ts"],
    });
    const payload = parsePayload(result);

    expect(result.isError).toBeUndefined();
    expect(payload.delegated_mode).toBe("read");
    expect(runClaudeTaskMock).toHaveBeenCalled();
    expect(supportsWorktreeMock).not.toHaveBeenCalled();
  });

  it("rejects nested claude_task when write intent uses allowed_files", async () => {
    isDelegatedWorktreePathMock.mockReturnValue(true);

    const result = await handleToolCall("claude_task", {
      cwd: "/repo/.claude/worktrees/codex-delegated-abc123",
      task: "implement feature",
      mode: "write",
      allowed_files: ["src/a.ts"],
    });
    const payload = parsePayload(result);

    expect(result.isError).toBe(true);
    expect(String(payload.error)).toContain("Refusing to start delegated write work from inside an existing delegated worktree");
    expect(runClaudeTaskMock).not.toHaveBeenCalled();
  });

  it("exposes include_patch and patch_max_bytes in TOOL_DEFINITIONS for claude_apply", () => {
    const applyTool = TOOL_DEFINITIONS.find((tool) => tool.name === "claude_apply");
    expect(applyTool?.inputSchema.properties).toHaveProperty("include_patch");
    expect(applyTool?.inputSchema.properties).toHaveProperty("patch_max_bytes");
  });

  it("forwards include_patch and patch_max_bytes to runClaudeApply", async () => {
    const runClaudeApply = (await import("../src/claude-cli.js")).runClaudeApply as ReturnType<typeof vi.fn>;
    runClaudeApply.mockResolvedValue({
      applied_files: [], diff_stat: "", cleanup_performed: false, conflicts: [],
      preview: true, planned_changes: [],
    });

    await handleToolCall("claude_apply", {
      cwd: "/repo/input",
      worktree_path: ".claude/worktrees/codex-delegated-x",
      preview: true,
      include_patch: true,
      patch_max_bytes: 12345,
    });

    expect(runClaudeApply).toHaveBeenCalledWith(
      expect.objectContaining({ include_patch: true, patch_max_bytes: 12345 }),
      expect.any(String),
    );
  });

  it("forwards include_patch and patch_max_bytes to startBackgroundApply", async () => {
    startBackgroundApplyMock.mockResolvedValue({
      job: { job_id: "job-bg-apply-patch", type: "apply", status: "queued" },
    });

    await handleToolCall("claude_apply", {
      cwd: "/repo/input",
      worktree_path: ".claude/worktrees/codex-delegated-x",
      background: true,
      include_patch: true,
      patch_max_bytes: 99999,
    });

    expect(startBackgroundApplyMock).toHaveBeenCalledWith(
      expect.objectContaining({ include_patch: true, patch_max_bytes: 99999 }),
    );
  });

  it("documents the five default tools and marks the rest as advanced", async () => {
    let listToolsHandler: (() => Promise<{ tools: Array<{ name: string; description?: string }> }>) | undefined;
    const fakeServer = {
      setRequestHandler: vi.fn((_schema: unknown, handler: () => Promise<{ tools: Array<{ name: string; description?: string }> }>) => {
        listToolsHandler = handler;
      }),
    };

    registerToolDefinitions(fakeServer as never);
    const result = await listToolsHandler!();
    const byName = new Map(result.tools.map((tool) => [tool.name, tool]));

    const defaultTools = [
      "claude_setup",
      "claude_task",
      "claude_result",
      "claude_apply",
      "claude_cleanup",
    ];
    const advancedTools = result.tools
      .map((tool) => tool.name)
      .filter((name) => !defaultTools.includes(name));

    expect(defaultTools.every((name) => byName.has(name))).toBe(true);
    for (const name of advancedTools) {
      expect(byName.get(name)?.description).toMatch(/^Advanced \/ (Debug|Recovery)\./);
    }
  });

  it("returns duplicate claude_task jobs without losing do-not-duplicate metadata", async () => {
    runClaudeTaskMock.mockResolvedValue({
      delegated_mode: "write",
      summary: "An equivalent implement job is already running: job-existing.",
      job: { job_id: "job-existing", type: "implement", status: "running" },
      deduped: true,
      do_not_start_duplicate_job: true,
      next_actions: [
        {
          tool: "claude_task",
          reason: "continue waiting",
          args: { cwd: "/repo/resolved", job_id: "job-existing", wait_strategy: "block", wait_timeout_sec: 540 },
        },
      ],
    });

    const result = await handleToolCall("claude_task", {
      cwd: "/repo/input",
      task: "Implement template rendering",
      mode: "write",
      dirty_policy: "committed",
    });
    const payload = parsePayload(result);

    expect(payload.deduped).toBe(true);
    expect(payload.do_not_start_duplicate_job).toBe(true);
    expect((payload.next_actions as Array<Record<string, unknown>>)[0]).toMatchObject({
      tool: "claude_task",
    });
  });

  // --- nested delegated worktree guard ---

  it("rejects claude_implement when cwd is inside a delegated worktree", async () => {
    isDelegatedWorktreePathMock.mockReturnValue(true);

    const result = await handleToolCall("claude_implement", {
      cwd: "/repo/.claude/worktrees/codex-delegated-abc123",
      task: "implement this",
    });
    const payload = parsePayload(result);

    expect(result.isError).toBe(true);
    expect(String(payload.error)).toContain("Refusing to start delegated write work from inside an existing delegated worktree");
    expect(startBackgroundImplementMock).not.toHaveBeenCalled();
  });

  it("rejects claude_task mode=write when cwd is inside a delegated worktree", async () => {
    isDelegatedWorktreePathMock.mockReturnValue(true);

    const result = await handleToolCall("claude_task", {
      cwd: "/repo/.claude/worktrees/codex-delegated-abc123",
      task: "do something",
      mode: "write",
    });
    const payload = parsePayload(result);

    expect(result.isError).toBe(true);
    expect(String(payload.error)).toContain("Refusing to start delegated write work from inside an existing delegated worktree");
    expect(runClaudeTaskMock).not.toHaveBeenCalled();
  });

  it("rejects claude_task mode omitted with write-keyword task when cwd is inside a delegated worktree", async () => {
    isDelegatedWorktreePathMock.mockReturnValue(true);

    const result = await handleToolCall("claude_task", {
      cwd: "/repo/.claude/worktrees/codex-delegated-abc123",
      task: "implement this feature",
    });
    const payload = parsePayload(result);

    expect(result.isError).toBe(true);
    expect(String(payload.error)).toContain("Refusing to start delegated write work from inside an existing delegated worktree");
    expect(runClaudeTaskMock).not.toHaveBeenCalled();
  });

  it("rejects claude_task mode omitted with Chinese write-keyword task when cwd is inside a delegated worktree", async () => {
    isDelegatedWorktreePathMock.mockReturnValue(true);

    const result = await handleToolCall("claude_task", {
      cwd: "/repo/.claude/worktrees/codex-delegated-abc123",
      task: "修复这个 bug",
    });
    const payload = parsePayload(result);

    expect(result.isError).toBe(true);
    expect(String(payload.error)).toContain("Refusing to start delegated write work from inside an existing delegated worktree");
    expect(runClaudeTaskMock).not.toHaveBeenCalled();
  });

  it("allows claude_task mode=auto with diff when cwd is inside a delegated worktree (review, not write)", async () => {
    isDelegatedWorktreePathMock.mockReturnValue(true);
    runClaudeTaskMock.mockResolvedValue({
      delegated_mode: "review",
      summary: "review ok",
      status: "success",
      completed_inline: true,
      next_actions: [],
    });

    const result = await handleToolCall("claude_task", {
      cwd: "/repo/.claude/worktrees/codex-delegated-abc123",
      task: "review this change",
      mode: "auto",
      diff: "diff --git a/file.txt b/file.txt",
    });
    const payload = parsePayload(result);

    expect(result.isError).toBeUndefined();
    expect(payload.delegated_mode).toBe("review");
    expect(runClaudeTaskMock).toHaveBeenCalled();
  });

  it("allows claude_task mode=read when cwd is inside a delegated worktree", async () => {
    isDelegatedWorktreePathMock.mockReturnValue(true);
    runClaudeTaskMock.mockResolvedValue({
      delegated_mode: "read",
      summary: "read ok",
      status: "success",
      completed_inline: true,
      next_actions: [],
    });

    const result = await handleToolCall("claude_task", {
      cwd: "/repo/.claude/worktrees/codex-delegated-abc123",
      task: "explain this",
      mode: "read",
    });
    const payload = parsePayload(result);

    expect(result.isError).toBeUndefined();
    expect(payload.delegated_mode).toBe("read");
    expect(runClaudeTaskMock).toHaveBeenCalled();
  });

  it("allows claude_task mode=write from a normal repo cwd", async () => {
    isDelegatedWorktreePathMock.mockReturnValue(false);
    runClaudeTaskMock.mockResolvedValue({
      delegated_mode: "write",
      summary: "write ok",
      status: "success",
      completed_inline: true,
      next_actions: [],
    });

    const result = await handleToolCall("claude_task", {
      cwd: "/repo/normal",
      task: "implement this",
      mode: "write",
    });
    const payload = parsePayload(result);

    expect(result.isError).toBeUndefined();
    expect(payload.delegated_mode).toBe("write");
    expect(runClaudeTaskMock).toHaveBeenCalled();
  });
});

describe("buildTaskInteraction", () => {
  it("routes claude_task write partial with session and worktree through buildTaskInteraction", () => {
    const interaction = buildTaskInteraction({
      delegated_mode: "write",
      summary: "Implement partial: hit max turns.",
      status: "partial",
      completed_inline: true,
      waiting: false,
      job: { job_id: "job-partial", type: "implement", status: "succeeded" } as Record<string, unknown>,
      session: { session_id: "sess-1" },
      server_observed: { worktree_path: ".claude/worktrees/codex-delegated-1" },
      next_actions: [],
    });

    expect(interaction.state).toBe("result_ready");
    expect(interaction.next_step).toContain("Preview");
    expect(interaction.next_step).toContain("resume");
    expect(interaction.next_step).toContain("discard");
    expect(interaction.next_step).toContain("Do not auto-resume");
  });

  it("routes claude_task write failed with session through buildTaskInteraction", () => {
    const interaction = buildTaskInteraction({
      delegated_mode: "write",
      summary: "Implement failed.",
      status: "failed",
      completed_inline: true,
      waiting: false,
      job: { job_id: "job-failed", type: "implement", status: "failed" } as Record<string, unknown>,
      session: { session_id: "sess-2" },
      next_actions: [],
    });

    expect(interaction.state).toBe("failed");
    expect(interaction.next_step).toContain("resume");
    expect(interaction.next_step).toContain("discard");
    expect(interaction.next_step).toContain("Do not auto-resume");
  });

  it("routes claude_task write needs_user with session through buildTaskInteraction", () => {
    const interaction = buildTaskInteraction({
      delegated_mode: "write",
      summary: "Claude needs input.",
      status: "needs_user",
      completed_inline: true,
      waiting: false,
      job: { job_id: "job-nu", type: "implement", status: "failed" } as Record<string, unknown>,
      session: { session_id: "sess-3" },
      next_actions: [],
    });

    expect(interaction.state).toBe("needs_user");
    expect(interaction.next_step).toContain("provide input");
    expect(interaction.next_step).toContain("resume");
    expect(interaction.next_step).toContain("start fresh");
    expect(interaction.next_step).toContain("discard");
    expect(interaction.next_step).toContain("Do not auto-resume");
  });

  it("routes claude_task write failed without session or worktree through generic next_step", () => {
    const interaction = buildTaskInteraction({
      delegated_mode: "write",
      summary: "Implement failed.",
      status: "failed",
      completed_inline: true,
      waiting: false,
      job: { job_id: "job-failed2", type: "implement", status: "failed" } as Record<string, unknown>,
      next_actions: [],
    });

    expect(interaction.state).toBe("failed");
    expect(interaction.next_step).toContain("Inspect the error");
    expect(interaction.next_step).not.toContain("Do not auto-resume");
  });

  it("routes claude_task write failed with worktree but no session through user-choice next_step", () => {
    const interaction = buildTaskInteraction({
      delegated_mode: "write",
      summary: "Implement failed with worktree changes.",
      status: "failed",
      completed_inline: true,
      waiting: false,
      job: { job_id: "job-failed-worktree", type: "implement", status: "failed" } as Record<string, unknown>,
      server_observed: { worktree_path: ".claude/worktrees/codex-delegated-failed" },
      next_actions: [],
    });

    expect(interaction.state).toBe("failed");
    expect(interaction.next_step).toContain("Preview");
    expect(interaction.next_step).toContain("apply");
    expect(interaction.next_step).toContain("start fresh");
    expect(interaction.next_step).toContain("discard");
    expect(interaction.next_step).not.toContain("resume");
    expect(interaction.next_step).not.toContain("auto-resume");
  });

  it("routes claude_task write needs_user with worktree but no session through user-choice next_step", () => {
    const interaction = buildTaskInteraction({
      delegated_mode: "write",
      summary: "Claude needs input with worktree changes.",
      status: "needs_user",
      completed_inline: true,
      waiting: false,
      job: { job_id: "job-nu-worktree", type: "implement", status: "failed" } as Record<string, unknown>,
      server_observed: { worktree_path: ".claude/worktrees/codex-delegated-needs-user" },
      next_actions: [],
    });

    expect(interaction.state).toBe("needs_user");
    expect(interaction.next_step).toContain("preview");
    expect(interaction.next_step).toContain("provide input");
    expect(interaction.next_step).toContain("start fresh");
    expect(interaction.next_step).toContain("discard");
    expect(interaction.next_step).not.toContain("resume");
    expect(interaction.next_step).not.toContain("auto-resume");
  });

  it("routes claude_task read partial without write-mode guard through generic next_step", () => {
    const interaction = buildTaskInteraction({
      delegated_mode: "read",
      summary: "Read partial.",
      status: "partial",
      completed_inline: true,
      waiting: false,
      session: { session_id: "sess-read" },
      next_actions: [],
    });

    expect(interaction.state).toBe("result_ready");
    expect(interaction.next_step).not.toContain("resume");
    expect(interaction.next_step).not.toContain("discard");
    expect(interaction.next_step).not.toContain("Do not auto-resume");
  });
});
