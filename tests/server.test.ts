import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  validateCwdMock,
  validateFilesWithinCwdMock,
  checkRecursionMock,
  supportsWorktreeMock,
  getClaudeResultMock,
  manageClaudeReviewGateMock,
  runClaudeSetupMock,
  runClaudeTaskMock,
  getWorkspaceStatusMock,
  listBackgroundJobsMock,
  getBackgroundJobResultMock,
  cancelBackgroundJobMock,
  cleanupBackgroundJobsMock,
  startBackgroundApplyMock,
  startBackgroundCleanupMock,
  startBackgroundQueryMock,
  waitForBackgroundJobMock,
} = vi.hoisted(() => ({
  validateCwdMock: vi.fn(),
  validateFilesWithinCwdMock: vi.fn(),
  checkRecursionMock: vi.fn(() => 0),
  supportsWorktreeMock: vi.fn(async () => true),
  getClaudeResultMock: vi.fn(),
  manageClaudeReviewGateMock: vi.fn(),
  runClaudeSetupMock: vi.fn(),
  runClaudeTaskMock: vi.fn(),
  getWorkspaceStatusMock: vi.fn(),
  listBackgroundJobsMock: vi.fn(),
  getBackgroundJobResultMock: vi.fn(),
  cancelBackgroundJobMock: vi.fn(),
  cleanupBackgroundJobsMock: vi.fn(),
  startBackgroundApplyMock: vi.fn(),
  startBackgroundCleanupMock: vi.fn(),
  startBackgroundQueryMock: vi.fn(),
  waitForBackgroundJobMock: vi.fn(),
}));

vi.mock("../src/guard.js", () => ({
  MAX_BRIDGE_DEPTH: 2,
  checkRecursion: checkRecursionMock,
  supportsWorktree: supportsWorktreeMock,
  validateCwd: validateCwdMock,
  validateFilesWithinCwd: validateFilesWithinCwdMock,
}));

vi.mock("../src/claude-cli.js", () => ({
  cancelBackgroundJob: cancelBackgroundJobMock,
  checkClaudeStatus: vi.fn(),
  cleanupBackgroundJobs: cleanupBackgroundJobsMock,
  getClaudeResult: getClaudeResultMock,
  getBackgroundJobResult: getBackgroundJobResultMock,
  getRunLogById: vi.fn(),
  getWorkspaceStatus: getWorkspaceStatusMock,
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
  startBackgroundImplement: vi.fn(),
  startBackgroundQuery: startBackgroundQueryMock,
  startBackgroundReview: vi.fn(),
  waitForBackgroundJob: waitForBackgroundJobMock,
}));

const { handleToolCall } = await import("../src/server.js");

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

  it("routes claude_workspace_status through getWorkspaceStatus with resolved cwd", async () => {
    getWorkspaceStatusMock.mockResolvedValue({
      workspace_root: "/repo/resolved",
      running_jobs: [],
      queued_jobs: [],
      recent_terminal_jobs: [],
      recent_runs: [],
      latest_sessions: [],
      delegated_worktrees: [],
      counts: {
        running_jobs: 0,
        queued_jobs: 0,
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
      job: { job_id: "job-read", type: "query", status: "queued" },
      next_actions: [],
    });

    const result = await handleToolCall("claude_task", {
      cwd: "/repo/input",
      task: "Explain auth flow",
      mode: "read",
      background: true,
    });
    const payload = parsePayload(result);

    expect(validateCwdMock).toHaveBeenCalledWith("/repo/input");
    expect(validateFilesWithinCwdMock).toHaveBeenCalledWith("/repo/resolved", undefined);
    expect(runClaudeTaskMock).toHaveBeenCalledWith({
      cwd: "/repo/resolved",
      task: "Explain auth flow",
      mode: "read",
      background: true,
    }, expect.any(String));
    expect(payload.delegated_mode).toBe("read");
    expect(result.isError).toBeUndefined();
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

  it("routes claude_query background requests through startBackgroundQuery", async () => {
    startBackgroundQueryMock.mockResolvedValue({
      job: { job_id: "job-query", type: "query", status: "queued" },
    });

    const result = await handleToolCall("claude_query", {
      cwd: "/repo/input",
      task: "explain this",
      background: true,
    });
    const payload = parsePayload(result);

    expect(validateCwdMock).toHaveBeenCalledWith("/repo/input");
    expect(startBackgroundQueryMock).toHaveBeenCalledWith({
      cwd: "/repo/resolved",
      task: "explain this",
      timeout_sec: 120,
      max_turns: 8,
      background: true,
    });
    expect((payload.job as Record<string, unknown>).type).toBe("query");
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
      job_id: "job-1",
      status: "succeeded",
      completed: true,
      result: { ok: true },
    });

    const result = await handleToolCall("claude_job_wait", {
      cwd: "/repo/input",
      job_id: "job-1",
      timeout_ms: 2000,
      poll_interval_ms: 100,
    });
    const payload = parsePayload(result);

    expect(validateCwdMock).toHaveBeenCalledWith("/repo/input");
    expect(waitForBackgroundJobMock).toHaveBeenCalledWith({
      cwd: "/repo/resolved",
      job_id: "job-1",
      timeout_ms: 2000,
      poll_interval_ms: 100,
    });
    expect(payload.status).toBe("succeeded");
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
});
