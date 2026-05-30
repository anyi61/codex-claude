import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getRunLogDir,
  normalizeRepoPath,
  isUnderRequestedFile,
  normalizeRequestedFiles,
  logRun,
  findImplementLogForWorktree,
  updateImplementLifecycleForWorktree,
  parseRunStatus,
  parseRunLifecycle,
  summarizeRunLog,
  summarizeRecentRuns,
  summarizeServerVerified,
  summarizeToolCallAudit,
  readRunLogFile,
  listRunLogs,
  getRecentRunsSummary,
  getRunLogById,
  buildRunResultPayload,
  buildResultSummaryFromRun,
  buildRunGroupSummary,
} from "../src/run-logs.js";
import type { GenericRunLog, ImplementRunLog } from "../src/run-logs.js";
import type { RunLogEntrySummary } from "../src/schema.js";

const cleanupPaths: string[] = [];
const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
});

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    await rm(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

async function makeTempDir(prefix = "codex-runlogs-"): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(dir);
  return dir;
}

async function writeRunLogEntry(
  logDir: string,
  runId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await mkdir(logDir, { recursive: true });
  await writeFile(
    path.join(logDir, `${runId}.json`),
    JSON.stringify(
      {
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...data,
      },
      null,
      2,
    ),
  );
}

describe("getRunLogDir", () => {
  it("returns default path under .codex-claude-delegate/runs", () => {
    const cwd = "/tmp/test-repo";
    expect(getRunLogDir(cwd)).toBe(
      path.join(cwd, ".codex-claude-delegate", "runs"),
    );
  });

  it("uses process.cwd() when no cwd is provided", () => {
    expect(getRunLogDir()).toBe(
      path.join(process.cwd(), ".codex-claude-delegate", "runs"),
    );
  });

  it("respects CODEX_CLAUDE_RUN_LOG_DIR env override", () => {
    const custom = "/custom/log/dir";
    process.env.CODEX_CLAUDE_RUN_LOG_DIR = custom;
    expect(getRunLogDir()).toBe(path.resolve(custom));
  });
});

describe("normalizeRepoPath", () => {
  const cwd = "/tmp/repo";

  it("normalizes absolute path to repo-relative", () => {
    expect(normalizeRepoPath(cwd, "/tmp/repo/src/file.ts")).toBe("src/file.ts");
  });

  it("keeps relative paths unchanged", () => {
    expect(normalizeRepoPath(cwd, "src/file.ts")).toBe("src/file.ts");
  });

  it("strips leading ./", () => {
    expect(normalizeRepoPath(cwd, "./src/file.ts")).toBe("src/file.ts");
  });

  it("handles nested directories", () => {
    expect(normalizeRepoPath(cwd, "/tmp/repo/src/utils/helper.ts")).toBe(
      "src/utils/helper.ts",
    );
  });

  it("returns path relative to cwd even when outside repo", () => {
    expect(normalizeRepoPath(cwd, "/other/file.ts")).toBe("../../other/file.ts");
  });
});

describe("isUnderRequestedFile", () => {
  it("matches exact file", () => {
    expect(isUnderRequestedFile("src/a.ts", "src/a.ts")).toBe(true);
  });

  it("matches file under requested directory", () => {
    expect(isUnderRequestedFile("src/a.ts", "src/")).toBe(true);
    expect(isUnderRequestedFile("src/a.ts", "src")).toBe(true);
  });

  it("does not match file in different directory", () => {
    expect(isUnderRequestedFile("tests/a.ts", "src/a.ts")).toBe(false);
    expect(isUnderRequestedFile("tests/a.ts", "src/")).toBe(false);
  });

  it("handles trailing slash on requested path", () => {
    expect(isUnderRequestedFile("src/foo/bar.ts", "src/foo/")).toBe(true);
  });
});

describe("normalizeRequestedFiles", () => {
  const cwd = "/tmp/repo";

  it("returns empty array for empty input", () => {
    expect(normalizeRequestedFiles(cwd, [])).toEqual([]);
  });

  it("returns empty array for undefined input", () => {
    expect(normalizeRequestedFiles(cwd)).toEqual([]);
  });

  it("normalizes and deduplicates files", () => {
    expect(
      normalizeRequestedFiles(cwd, [
        "./src/a.ts",
        "src/a.ts",
        "/tmp/repo/src/b.ts",
      ]),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("sorts results", () => {
    expect(
      normalizeRequestedFiles(cwd, [
        "/tmp/repo/z.ts",
        "./a.ts",
        "m.ts",
      ]),
    ).toEqual(["a.ts", "m.ts", "z.ts"]);
  });

  it("filters out empty paths", () => {
    expect(normalizeRequestedFiles(cwd, ["/tmp/repo/"])).toEqual([]);
  });
});

describe("logRun", () => {
  it("creates a run log file in the correct directory with required fields", async () => {
    const root = await makeTempDir();
    const repo = path.join(root, "repo");
    await mkdir(repo, { recursive: true });
    const runId = "test-run-001";

    await logRun(runId, { type: "query" }, repo);

    const logFile = path.join(repo, ".codex-claude-delegate", "runs", `${runId}.json`);
    expect(existsSync(logFile)).toBe(true);
  });

  it("includes started_at and updated_at timestamps", async () => {
    const root = await makeTempDir();
    const repo = path.join(root, "repo");
    await mkdir(repo, { recursive: true });
    const runId = "test-run-002";

    await logRun(runId, { type: "review", custom: "value" }, repo);

    const logFile = path.join(repo, ".codex-claude-delegate", "runs", `${runId}.json`);
    const content = JSON.parse(
      await (await import("node:fs/promises")).readFile(logFile, "utf8"),
    );
    expect(content).toHaveProperty("started_at");
    expect(content).toHaveProperty("updated_at");
    expect(content.type).toBe("review");
    expect(content.custom).toBe("value");
  });

  it("uses env override when CODEX_CLAUDE_RUN_LOG_DIR is set", async () => {
    const root = await makeTempDir();
    const customLogDir = path.join(root, "custom-logs");
    process.env.CODEX_CLAUDE_RUN_LOG_DIR = customLogDir;
    const runId = "test-run-003";

    await logRun(runId, { type: "query" });

    expect(existsSync(path.join(customLogDir, `${runId}.json`))).toBe(true);
  });
});

describe("findImplementLogForWorktree", () => {
  it("returns null when no logs match", async () => {
    const root = await makeTempDir();
    const repo = path.join(root, "repo");
    await mkdir(repo, { recursive: true });

    const result = await findImplementLogForWorktree(
      ".claude/worktrees/codex-delegated-abc",
      repo,
    );
    expect(result).toBeNull();
  });

  it("finds matching implement log by worktree path", async () => {
    const root = await makeTempDir();
    const repo = path.join(root, "repo");
    const logDir = path.join(repo, ".codex-claude-delegate", "runs");
    await mkdir(logDir, { recursive: true });

    const worktreePath = ".claude/worktrees/codex-delegated-xyz";
    await writeRunLogEntry(logDir, "run-1", {
      type: "implement",
      observed: { worktree_path: worktreePath },
    });

    const result = await findImplementLogForWorktree(worktreePath, repo);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("implement");
    expect(result!.observed?.worktree_path).toBe(worktreePath);
  });

  it("ignores non-implement logs", async () => {
    const root = await makeTempDir();
    const repo = path.join(root, "repo");
    const logDir = path.join(repo, ".codex-claude-delegate", "runs");
    await mkdir(logDir, { recursive: true });

    await writeRunLogEntry(logDir, "run-2", {
      type: "query",
      observed: { worktree_path: ".claude/worktrees/test" },
    });

    const result = await findImplementLogForWorktree(
      ".claude/worktrees/test",
      repo,
    );
    expect(result).toBeNull();
  });
});

describe("updateImplementLifecycleForWorktree", () => {
  it("no-ops when no matching implement log exists", async () => {
    const root = await makeTempDir();
    const repo = path.join(root, "repo");
    await mkdir(repo, { recursive: true });

    // Should not throw
    await updateImplementLifecycleForWorktree(
      ".claude/worktrees/no-match",
      { applied_at: new Date().toISOString() },
      repo,
    );
  });

  it("updates downstream fields on matching implement log", async () => {
    const root = await makeTempDir();
    const repo = path.join(root, "repo");
    const logDir = path.join(repo, ".codex-claude-delegate", "runs");
    await mkdir(logDir, { recursive: true });

    const worktreePath = ".claude/worktrees/codex-delegated-update";
    await writeRunLogEntry(logDir, "run-update-1", {
      type: "implement",
      observed: { worktree_path: worktreePath },
    });

    await updateImplementLifecycleForWorktree(
      worktreePath,
      {
        applied_at: "2026-01-01T00:00:00.000Z",
        current_lifecycle: "applied",
      },
      repo,
    );

    const updated = await findImplementLogForWorktree(worktreePath, repo);
    expect(updated).not.toBeNull();
    expect((updated as GenericRunLog).downstream?.applied_at).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect((updated as GenericRunLog).downstream?.current_lifecycle).toBe("applied");
  });
});

describe("parseRunStatus", () => {
  it("returns 'failed' when error string is present", () => {
    expect(parseRunStatus({ error: "something went wrong" })).toBe("failed");
  });

  it("returns 'failed' on non-zero exit with no changed files", () => {
    expect(
      parseRunStatus({
        execution: { exit_code: 1 },
        observed: { changed_files: [] },
      }),
    ).toBe("failed");
  });

  it("returns 'partial' on non-zero exit with changed files", () => {
    expect(
      parseRunStatus({
        execution: { exit_code: 1 },
        observed: { changed_files: ["src/a.ts"] },
      }),
    ).toBe("partial");
  });

  it("returns 'partial' on timeout with changes", () => {
    expect(
      parseRunStatus({
        execution: { timed_out: true },
        observed: { changed_files: ["src/a.ts"] },
      }),
    ).toBe("partial");
  });

  it("returns report.status if present and valid", () => {
    expect(parseRunStatus({ report: { status: "success" } })).toBe("success");
    expect(parseRunStatus({ report: { status: "needs_user" } })).toBe(
      "needs_user",
    );
    expect(parseRunStatus({ report: { status: "partial" } })).toBe("partial");
    expect(parseRunStatus({ report: { status: "failed" } })).toBe("failed");
  });

  it("returns 'unknown' for missing or invalid data", () => {
    expect(parseRunStatus({})).toBe("unknown");
    expect(parseRunStatus({ report: {} })).toBe("unknown");
  });
});

describe("parseRunLifecycle", () => {
  it("returns downstream lifecycle when present and valid", () => {
    expect(
      parseRunLifecycle({ downstream: { current_lifecycle: "applied" } }),
    ).toBe("applied");
    expect(
      parseRunLifecycle({ downstream: { current_lifecycle: "cleaned" } }),
    ).toBe("cleaned");
    expect(
      parseRunLifecycle({ downstream: { current_lifecycle: "apply_blocked" } }),
    ).toBe("apply_blocked");
  });

  it("returns 'apply_blocked' for apply type with error", () => {
    expect(
      parseRunLifecycle({ type: "apply", error: "apply failed" }),
    ).toBe("apply_blocked");
  });

  it("returns 'applied' for apply type with applied files", () => {
    expect(
      parseRunLifecycle({ type: "apply", applied_files: ["a.ts"] }),
    ).toBe("applied");
  });

  it("returns 'success' for apply type with preview only", () => {
    expect(
      parseRunLifecycle({ type: "apply", preview: true }),
    ).toBe("success");
  });

  it("returns 'cleaned' for cleanup type with removals", () => {
    expect(
      parseRunLifecycle({ type: "cleanup", removed_count: 3, failed_count: 0 }),
    ).toBe("cleaned");
  });

  it("returns 'partial' for cleanup type with failures", () => {
    expect(
      parseRunLifecycle({
        type: "cleanup",
        removed_count: 3,
        failed_count: 2,
      }),
    ).toBe("partial");
  });

  it("returns 'success' for cleanup type with zero removals and failures", () => {
    expect(
      parseRunLifecycle({ type: "cleanup", removed_count: 0, failed_count: 0 }),
    ).toBe("success");
  });

  it("maps needs_user status to partial lifecycle", () => {
    expect(
      parseRunLifecycle({
        type: "implement",
        report: { status: "needs_user" },
      }),
    ).toBe("partial");
  });

  it("passes through success/failed/partial from parseRunStatus", () => {
    expect(
      parseRunLifecycle({ type: "query", report: { status: "success" } }),
    ).toBe("success");
    expect(
      parseRunLifecycle({ type: "query", report: { status: "failed" } }),
    ).toBe("failed");
    expect(
      parseRunLifecycle({ type: "query", report: { status: "partial" } }),
    ).toBe("partial");
  });
});

describe("summarizeRunLog", () => {
  it("produces correct summary shape from a valid raw log", () => {
    const raw: GenericRunLog = {
      type: "query",
      input: { cwd: "/tmp/repo" },
      report: { status: "success", summary: "Completed analysis" },
      observed: { worktree_path: "/tmp/repo/.claude/worktrees/wt1" },
      started_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T01:00:00.000Z",
      session: {
        requested_session_id: "sess-req",
        returned_session_id: "sess-ret",
      },
    };

    const summary = summarizeRunLog("run-abc", raw);
    expect(summary.run_id).toBe("run-abc");
    expect(summary.type).toBe("query");
    expect(summary.status).toBe("success");
    expect(summary.lifecycle).toBe("success");
    expect(summary.cwd).toBe("/tmp/repo");
    expect(summary.summary).toBe("Completed analysis");
    expect(summary.worktree_path).toContain("worktrees/wt1");
    expect(summary.worktree_name).toBe("wt1");
    expect(summary.requested_session_id).toBe("sess-req");
    expect(summary.returned_session_id).toBe("sess-ret");
    expect(summary.started_at).toBe("2026-01-01T00:00:00.000Z");
    expect(summary.updated_at).toBe("2026-01-01T01:00:00.000Z");
  });

  it("uses updatedAt fallback for started_at and updated_at", () => {
    const raw: GenericRunLog = { type: "implement" };
    const summary = summarizeRunLog("run-xyz", raw, "2026-05-01T00:00:00.000Z");
    expect(summary.started_at).toBe("2026-05-01T00:00:00.000Z");
    expect(summary.updated_at).toBe("2026-05-01T00:00:00.000Z");
  });

  it("resolves worktree_name from observed field", () => {
    const raw: GenericRunLog = {
      type: "implement",
      observed: { worktree_name: "codex-delegated-foo" },
    };
    const summary = summarizeRunLog("run-1", raw);
    expect(summary.worktree_name).toBe("codex-delegated-foo");
  });

  it("falls back to basename when no worktree_name in observed", () => {
    const raw: GenericRunLog = {
      type: "implement",
      observed: { worktree_path: "/repo/.claude/worktrees/wt1" },
    };
    const summary = summarizeRunLog("run-1", raw);
    expect(summary.worktree_name).toBe("wt1");
  });
});

describe("summarizeRecentRuns", () => {
  it("counts lifecycle distributions", () => {
    const entries = [
      { run_id: "1", type: "query", status: "success" as const, lifecycle: "success" as const },
      { run_id: "2", type: "query", status: "success" as const, lifecycle: "success" as const },
      { run_id: "3", type: "implement", status: "failed" as const, lifecycle: "failed" as const },
    ];
    const result = summarizeRecentRuns(entries as any);
    expect(result.lifecycle_counts).toEqual({ success: 2, failed: 1 });
    expect(result.entries).toEqual(entries);
  });
});

describe("summarizeServerVerified", () => {
  it("returns summary for valid server_verified with mixed results", () => {
    const result = summarizeServerVerified({
      status: "passed",
      commands: [
        { command: "test 1", status: "passed", exit_code: 0, duration_ms: 100, stdout_tail: "", stderr_tail: "", timed_out: false },
        { command: "test 2", status: "failed", exit_code: 1, duration_ms: 50, stdout_tail: "", stderr_tail: "", timed_out: false },
        { command: "test 3", status: "skipped", exit_code: null, duration_ms: 0, stdout_tail: "", stderr_tail: "", timed_out: false, skipped_reason: "not needed" },
      ],
    });
    expect(result).toEqual({
      status: "passed",
      command_count: 3,
      passed_count: 1,
      failed_count: 1,
      skipped_count: 1,
    });
  });

  it("returns undefined when server_verified is null", () => {
    expect(summarizeServerVerified(null)).toBeUndefined();
  });

  it("returns undefined when server_verified is not an object", () => {
    expect(summarizeServerVerified("invalid")).toBeUndefined();
    expect(summarizeServerVerified(42)).toBeUndefined();
  });

  it("returns undefined when status is invalid", () => {
    expect(summarizeServerVerified({ status: "invalid", commands: [] })).toBeUndefined();
  });

  it("returns undefined when commands is not an array", () => {
    expect(summarizeServerVerified({ status: "passed", commands: "not-array" })).toBeUndefined();
  });

  it("handles all passed commands", () => {
    const result = summarizeServerVerified({
      status: "passed",
      commands: [
        { command: "test 1", status: "passed", exit_code: 0, duration_ms: 100, stdout_tail: "", stderr_tail: "", timed_out: false },
        { command: "test 2", status: "passed", exit_code: 0, duration_ms: 50, stdout_tail: "", stderr_tail: "", timed_out: false },
      ],
    });
    expect(result).toEqual({
      status: "passed",
      command_count: 2,
      passed_count: 2,
      failed_count: 0,
      skipped_count: 0,
    });
  });

  it("handles all failed commands", () => {
    const result = summarizeServerVerified({
      status: "failed",
      commands: [
        { command: "test 1", status: "failed", exit_code: 1, duration_ms: 100, stdout_tail: "", stderr_tail: "", timed_out: false },
      ],
    });
    expect(result).toEqual({
      status: "failed",
      command_count: 1,
      passed_count: 0,
      failed_count: 1,
      skipped_count: 0,
    });
  });

  it("handles all skipped commands", () => {
    const result = summarizeServerVerified({
      status: "skipped",
      commands: [
        { command: "test 1", status: "skipped", exit_code: null, duration_ms: 0, stdout_tail: "", stderr_tail: "", timed_out: false, skipped_reason: "not needed" },
      ],
    });
    expect(result).toEqual({
      status: "skipped",
      command_count: 1,
      passed_count: 0,
      failed_count: 0,
      skipped_count: 1,
    });
  });

  it("ignores malformed command entries", () => {
    const result = summarizeServerVerified({
      status: "passed",
      commands: [
        { command: "test 1", status: "passed" },
        null,
        "not-an-object",
        42,
      ],
    });
    expect(result).toEqual({
      status: "passed",
      command_count: 4,
      passed_count: 1,
      failed_count: 0,
      skipped_count: 0,
    });
  });

  it("includes server_verified in summarizeRunLog when present", () => {
    const raw: GenericRunLog = {
      type: "implement",
      input: { cwd: "/tmp/repo" },
      report: { status: "success", summary: "Done" },
      server_verified: {
        status: "passed",
        commands: [
          { command: "test", status: "passed", exit_code: 0, duration_ms: 100, stdout_tail: "", stderr_tail: "", timed_out: false },
        ],
      },
    };
    const summary = summarizeRunLog("run-v", raw);
    expect(summary.server_verified).toBeDefined();
    expect(summary.server_verified!.status).toBe("passed");
    expect(summary.server_verified!.command_count).toBe(1);
    expect(summary.server_verified!.passed_count).toBe(1);
  });

  it("omits server_verified from summarizeRunLog when absent", () => {
    const raw: GenericRunLog = {
      type: "query",
      input: { cwd: "/tmp/repo" },
      report: { status: "success" },
    };
    const summary = summarizeRunLog("run-no-v", raw);
    expect(summary).not.toHaveProperty("server_verified");
  });

  it("omits server_verified from summarizeRunLog when malformed", () => {
    const raw: GenericRunLog = {
      type: "implement",
      input: { cwd: "/tmp/repo" },
      server_verified: { status: "nope", commands: [] },
    };
    const summary = summarizeRunLog("run-bad-v", raw);
    expect(summary).not.toHaveProperty("server_verified");
  });
});

describe("summarizeToolCallAudit", () => {
  it("returns summary from permission_denials with sorted unique tool names", () => {
    const report = {
      permission_denials: [
        { tool_name: "Bash", tool_input: { command: "rm -rf /" } },
        { tool_name: "Write", tool_input: { path: "/etc/passwd" } },
        { tool_name: "bash", tool_input: { command: "curl evil.com" } },
      ],
    };
    const result = summarizeToolCallAudit(report);
    expect(result).toEqual({
      total_denied: 3,
      unique_denied_tools: ["Bash", "Write", "bash"],
    });
  });

  it("returns commands_run_count from commands_run array", () => {
    const report = {
      commands_run: [
        "npx vitest run",
        "npx tsc --noEmit",
      ],
    };
    const result = summarizeToolCallAudit(report);
    expect(result).toEqual({
      total_denied: 0,
      unique_denied_tools: [],
      commands_run_count: 2,
    });
  });

  it("combines denials and commands count", () => {
    const report = {
      permission_denials: [
        { tool_name: "Bash" },
      ],
      commands_run: [
        "npm test",
      ],
    };
    const result = summarizeToolCallAudit(report);
    expect(result).toEqual({
      total_denied: 1,
      unique_denied_tools: ["Bash"],
      commands_run_count: 1,
    });
  });

  it("returns undefined for null input", () => {
    expect(summarizeToolCallAudit(null)).toBeUndefined();
  });

  it("returns undefined for non-object input", () => {
    expect(summarizeToolCallAudit("invalid")).toBeUndefined();
    expect(summarizeToolCallAudit(42)).toBeUndefined();
  });

  it("returns undefined when report has no permission_denials and no commands_run", () => {
    expect(summarizeToolCallAudit({ status: "success" })).toBeUndefined();
  });

  it("returns undefined when permission_denials is not an array", () => {
    expect(summarizeToolCallAudit({ permission_denials: "not-array" })).toBeUndefined();
  });

  it("handles missing and non-string tool_name values", () => {
    const report = {
      permission_denials: [
        { tool_name: "Bash" },
        {},
        { tool_name: 123 },
        { tool_name: "" },
        null,
        "string-entry",
        { tool_name: "Bash" },
        { tool_name: "Read" },
      ],
    };
    const result = summarizeToolCallAudit(report);
    expect(result).toEqual({
      total_denied: 8,
      unique_denied_tools: ["Bash", "Read"],
    });
  });

  it("truncates unique denied tools at 20 with truncated flag", () => {
    const denials: Array<{ tool_name: string }> = [];
    const toolNames = [
      "Tool01", "Tool02", "Tool03", "Tool04", "Tool05",
      "Tool06", "Tool07", "Tool08", "Tool09", "Tool10",
      "Tool11", "Tool12", "Tool13", "Tool14", "Tool15",
      "Tool16", "Tool17", "Tool18", "Tool19", "Tool20",
      "Tool21", "Tool22",
    ];
    for (const name of toolNames) {
      denials.push({ tool_name: name });
    }
    const report = { permission_denials: denials };
    const result = summarizeToolCallAudit(report);
    expect(result!.total_denied).toBe(22);
    expect(result!.unique_denied_tools).toHaveLength(20);
    expect(result!.unique_denied_tools_truncated).toBe(true);
    expect(result!.unique_denied_tools).toEqual(toolNames.slice(0, 20).sort());
  });

  it("summarizeRunLog includes tool_call_audit when audit data present", () => {
    const raw: GenericRunLog = {
      type: "implement",
      input: { cwd: "/tmp/repo" },
      report: {
        status: "success",
        summary: "Done",
        permission_denials: [
          { tool_name: "Bash" },
        ],
        commands_run: ["npm test"],
      },
    };
    const summary = summarizeRunLog("run-audit", raw);
    expect(summary.tool_call_audit).toBeDefined();
    expect(summary.tool_call_audit!.total_denied).toBe(1);
    expect(summary.tool_call_audit!.unique_denied_tools).toEqual(["Bash"]);
    expect(summary.tool_call_audit!.commands_run_count).toBe(1);
  });

  it("summarizeRunLog omits tool_call_audit when audit returns undefined", () => {
    const raw: GenericRunLog = {
      type: "query",
      input: { cwd: "/tmp/repo" },
      report: { status: "success" },
    };
    const summary = summarizeRunLog("run-no-audit", raw);
    expect(summary).not.toHaveProperty("tool_call_audit");
  });

  it("serialized tool_call_audit does not include sensitive strings", () => {
    const report = {
      permission_denials: [
        { tool_name: "Bash", tool_input: { command: "rm -rf /" }, tool_use_id: "call_abc123" },
        { tool_name: "Write", tool_input: { path: "/etc/secrets" }, args: ["--force"] },
      ],
      commands_run: [
        "npx vitest run --sensitive",
        "cat /etc/shadow",
      ],
    };
    const result = summarizeToolCallAudit(report);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("rm -rf /");
    expect(serialized).not.toContain("/etc/secrets");
    expect(serialized).not.toContain("call_abc123");
    expect(serialized).not.toContain("--force");
    expect(serialized).not.toContain("npx vitest");
    expect(serialized).not.toContain("cat /etc/shadow");
    expect(serialized).toContain("total_denied");
    expect(serialized).toContain("unique_denied_tools");
  });
});

describe("readRunLogFile", () => {
  it("reads a valid run log file", async () => {
    const root = await makeTempDir();
    const repo = path.join(root, "repo");
    const logDir = path.join(repo, ".codex-claude-delegate", "runs");
    await writeRunLogEntry(logDir, "run-read-1", {
      type: "query",
      report: { status: "success" },
    });

    const result = await readRunLogFile("run-read-1", repo);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("query");
  });

  it("returns null for missing file", async () => {
    const root = await makeTempDir();
    const repo = path.join(root, "repo");
    await mkdir(repo, { recursive: true });

    const result = await readRunLogFile("nonexistent", repo);
    expect(result).toBeNull();
  });

  it("returns null for corrupt JSON", async () => {
    const root = await makeTempDir();
    const repo = path.join(root, "repo");
    const logDir = path.join(repo, ".codex-claude-delegate", "runs");
    await mkdir(logDir, { recursive: true });
    await writeFile(
      path.join(logDir, "run-corrupt.json"),
      "not valid json",
      "utf8",
    );

    const result = await readRunLogFile("run-corrupt", repo);
    expect(result).toBeNull();
  });
});

describe("listRunLogs", () => {
  it("returns entries sorted by mtime descending", async () => {
    const root = await makeTempDir();
    const repo = path.join(root, "repo");
    const logDir = path.join(repo, ".codex-claude-delegate", "runs");
    await mkdir(logDir, { recursive: true });

    await writeRunLogEntry(logDir, "run-a", {
      type: "query",
      input: { cwd: repo },
      report: { status: "success" },
    });
    await writeRunLogEntry(logDir, "run-b", {
      type: "review",
      input: { cwd: repo },
      report: { status: "success" },
    });

    const result = await listRunLogs({ cwd: repo });
    expect(result.total_entries).toBeGreaterThanOrEqual(2);
    expect(result.entries.map((e) => e.run_id)).toContain("run-a");
    expect(result.entries.map((e) => e.run_id)).toContain("run-b");
  });

  it("filters by type", async () => {
    const root = await makeTempDir();
    const repo = path.join(root, "repo");
    const logDir = path.join(repo, ".codex-claude-delegate", "runs");
    await mkdir(logDir, { recursive: true });

    await writeRunLogEntry(logDir, "run-q", {
      type: "query",
      input: { cwd: repo },
    });
    await writeRunLogEntry(logDir, "run-r", {
      type: "review",
      input: { cwd: repo },
    });

    const result = await listRunLogs({ cwd: repo, type: "query" });
    expect(result.entries.every((e) => e.type === "query")).toBe(true);
  });

  it("respects limit parameter", async () => {
    const root = await makeTempDir();
    const repo = path.join(root, "repo");
    const logDir = path.join(repo, ".codex-claude-delegate", "runs");
    await mkdir(logDir, { recursive: true });

    for (let i = 0; i < 5; i++) {
      await writeRunLogEntry(logDir, `run-${i}`, {
        type: "query",
        input: { cwd: repo },
      });
    }

    const result = await listRunLogs({ cwd: repo, limit: 2 });
    expect(result.entries.length).toBeLessThanOrEqual(2);
  });

  it("returns empty result when log dir does not exist", async () => {
    const root = await makeTempDir();
    const repo = path.join(root, "repo");
    await mkdir(repo, { recursive: true });

    const result = await listRunLogs({ cwd: repo });
    expect(result.entries).toEqual([]);
    expect(result.total_entries).toBe(0);
  });

  it("filters by status", async () => {
    const root = await makeTempDir();
    const repo = path.join(root, "repo");
    const logDir = path.join(repo, ".codex-claude-delegate", "runs");
    await mkdir(logDir, { recursive: true });

    await writeRunLogEntry(logDir, "run-ok", {
      type: "query",
      input: { cwd: repo },
      report: { status: "success" },
    });
    await writeRunLogEntry(logDir, "run-fail", {
      type: "query",
      input: { cwd: repo },
      error: "failure",
    });

    const result = await listRunLogs({ cwd: repo, status: "failed" });
    expect(result.entries.every((e) => e.status === "failed")).toBe(true);
  });

  it("filters by worktree_name", async () => {
    const root = await makeTempDir();
    const repo = path.join(root, "repo");
    const logDir = path.join(repo, ".codex-claude-delegate", "runs");
    await mkdir(logDir, { recursive: true });

    await writeRunLogEntry(logDir, "run-wt1", {
      type: "implement",
      input: { cwd: repo },
      observed: { worktree_name: "wt-a" },
    });
    await writeRunLogEntry(logDir, "run-wt2", {
      type: "implement",
      input: { cwd: repo },
      observed: { worktree_name: "wt-b" },
    });

    const result = await listRunLogs({
      cwd: repo,
      worktree_name: "wt-a",
    });
    expect(result.entries.every((e) => e.worktree_name === "wt-a")).toBe(true);
  });

  it("skips entries from different cwd", async () => {
    const root = await makeTempDir();
    const repoA = path.join(root, "repoA");
    const repoB = path.join(root, "repoB");
    const logDir = path.join(repoA, ".codex-claude-delegate", "runs");
    await mkdir(logDir, { recursive: true });

    // Use env override so that repoB logs share the same logDir as repoA
    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    await writeRunLogEntry(logDir, "run-repoA", {
      type: "query",
      input: { cwd: repoA },
      report: { status: "success" },
    });
    await writeRunLogEntry(logDir, "run-repoB", {
      type: "query",
      input: { cwd: repoB },
      report: { status: "success" },
    });
    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;

    const result = await listRunLogs({ cwd: repoA });
    expect(result.entries.every((e) => e.cwd === repoA || e.cwd === undefined)).toBe(true);
  });
});

describe("getRunLogById", () => {
  it("returns entry and raw for existing run", async () => {
    const root = await makeTempDir();
    const repo = path.join(root, "repo");
    const logDir = path.join(repo, ".codex-claude-delegate", "runs");
    await mkdir(logDir, { recursive: true });

    await writeRunLogEntry(logDir, "run-detail", {
      type: "query",
      input: { cwd: repo },
      report: { status: "success", summary: "Done" },
    });

    const result = await getRunLogById({ cwd: repo, run_id: "run-detail" });
    expect(result).not.toBeNull();
    expect(result!.entry.run_id).toBe("run-detail");
    expect(result!.entry.type).toBe("query");
    expect(result!.entry.summary).toBe("Done");
    expect(result!.raw).toHaveProperty("type", "query");
  });

  it("returns null for missing run", async () => {
    const root = await makeTempDir();
    const repo = path.join(root, "repo");
    await mkdir(repo, { recursive: true });

    const result = await getRunLogById({
      cwd: repo,
      run_id: "missing-run",
    });
    expect(result).toBeNull();
  });

  it("returns related run links when downstream fields are present", async () => {
    const root = await makeTempDir();
    const repo = path.join(root, "repo");
    const logDir = path.join(repo, ".codex-claude-delegate", "runs");
    await mkdir(logDir, { recursive: true });

    await writeRunLogEntry(logDir, "run-linked", {
      type: "implement",
      input: { cwd: repo },
      downstream: {
        last_apply_run_id: "apply-123",
        last_cleanup_run_id: "cleanup-456",
      },
    });

    const result = await getRunLogById({ cwd: repo, run_id: "run-linked" });
    expect(result!.related_runs?.apply_run_id).toBe("apply-123");
    expect(result!.related_runs?.cleanup_run_id).toBe("cleanup-456");
  });
});

describe("getRecentRunsSummary", () => {
  it("returns entries and lifecycle counts", async () => {
    const root = await makeTempDir();
    const repo = path.join(root, "repo");
    const logDir = path.join(repo, ".codex-claude-delegate", "runs");
    await mkdir(logDir, { recursive: true });

    await writeRunLogEntry(logDir, "run-recent-1", {
      type: "query",
      input: { cwd: repo },
      report: { status: "success" },
    });

    const result = await getRecentRunsSummary(repo, 5);
    expect(result.entries.length).toBeGreaterThanOrEqual(1);
    expect(result.lifecycle_counts).toHaveProperty("success");
  });
});

describe("buildRunResultPayload", () => {
  it("extracts type field", () => {
    expect(buildRunResultPayload({ type: "query" })).toEqual({ type: "query" });
    expect(buildRunResultPayload({})).toEqual({ type: "unknown" });
  });

  it("includes report when present", () => {
    const payload = buildRunResultPayload({
      type: "query",
      report: { status: "success", summary: "ok" },
    });
    expect(payload.report).toEqual({ status: "success", summary: "ok" });
  });

  it("includes error when present and non-empty", () => {
    const payload = buildRunResultPayload({ type: "query", error: "boom" });
    expect(payload.error).toBe("boom");
  });

  it("excludes empty error string", () => {
    const payload = buildRunResultPayload({ type: "query", error: "" });
    expect(payload).not.toHaveProperty("error");
  });

  it("includes preview, applied_files, removed_count, failed_count", () => {
    const payload = buildRunResultPayload({
      type: "apply",
      preview: true,
      applied_files: ["a.ts"],
      removed_count: 3,
      failed_count: 1,
    });
    expect(payload.preview).toBe(true);
    expect(payload.applied_files).toEqual(["a.ts"]);
    expect(payload.removed_count).toBe(3);
    expect(payload.failed_count).toBe(1);
  });

  it("includes observed and downstream when present", () => {
    const payload = buildRunResultPayload({
      type: "implement",
      observed: { changed_files: ["a.ts"] },
      downstream: { applied_at: "now" },
    });
    expect(payload.observed).toEqual({ changed_files: ["a.ts"] });
    expect(payload.downstream).toEqual({ applied_at: "now" });
  });
});

describe("buildResultSummaryFromRun", () => {
  it("returns entry.summary when present", () => {
    expect(
      buildResultSummaryFromRun({
        run_id: "1",
        type: "query",
        status: "success",
        lifecycle: "success",
        summary: "Custom summary",
      }),
    ).toBe("Custom summary");
  });

  it("returns error message when summary is absent", () => {
    expect(
      buildResultSummaryFromRun({
        run_id: "2",
        type: "implement",
        status: "failed",
        lifecycle: "failed",
        error: "Something went wrong",
      }),
    ).toBe("implement failed: Something went wrong");
  });

  it("returns type + lifecycle as fallback", () => {
    expect(
      buildResultSummaryFromRun({
        run_id: "3",
        type: "review",
        status: "success",
        lifecycle: "success",
      }),
    ).toBe("review success");
  });
});

// ---- UX/RUN-GROUP-001: run grouping tests ----

describe("summarizeRunLog with grouping metadata", () => {
  it("includes run grouping metadata", () => {
    const raw: GenericRunLog = {
      type: "implement",
      input: { cwd: "/tmp/repo" },
      report: { status: "success", summary: "Done" },
      goal_item_id: "UX/RUN-GROUP-001",
      supersedes_run_id: "run-original",
      started_at: "2026-05-30T00:00:00.000Z",
      updated_at: "2026-05-30T01:00:00.000Z",
    };
    const summary = summarizeRunLog("run-grouped", raw);
    expect(summary.goal_item_id).toBe("UX/RUN-GROUP-001");
    expect(summary.supersedes_run_id).toBe("run-original");
  });

  it("keeps old logs ungrouped", () => {
    const raw: GenericRunLog = {
      type: "query",
      input: { cwd: "/tmp/repo" },
      report: { status: "success" },
    };
    const summary = summarizeRunLog("run-legacy", raw);
    expect(summary.goal_item_id).toBeUndefined();
    expect(summary.supersedes_run_id).toBeUndefined();
  });
});

describe("listRunLogs with goal_item_id filter", () => {
  it("filters by goal_item_id", async () => {
    const root = await makeTempDir();
    const repo = path.join(root, "repo");
    const logDir = path.join(repo, ".codex-claude-delegate", "runs");
    await mkdir(logDir, { recursive: true });

    await writeRunLogEntry(logDir, "run-g1", {
      type: "implement",
      input: { cwd: repo },
      goal_item_id: "UX/RUN-GROUP-001",
    });
    await writeRunLogEntry(logDir, "run-g2", {
      type: "implement",
      input: { cwd: repo },
      goal_item_id: "UX/RUN-GROUP-001",
    });
    await writeRunLogEntry(logDir, "run-other", {
      type: "implement",
      input: { cwd: repo },
      goal_item_id: "AUDIT-DOCS-003",
    });

    const result = await listRunLogs({ cwd: repo, goal_item_id: "UX/RUN-GROUP-001" });
    expect(result.entries.length).toBe(2);
    expect(result.entries.every((e) => e.goal_item_id === "UX/RUN-GROUP-001")).toBe(true);
  });
});

describe("buildRunGroupSummary", () => {
  it("summarizes bounded matching runs", () => {
    const entries: RunLogEntrySummary[] = [
      { run_id: "run-a", type: "implement", status: "success", lifecycle: "success", goal_item_id: "UX/RUN-GROUP-001", updated_at: "2026-05-30T00:00:00.000Z" },
      { run_id: "run-b", type: "implement", status: "partial", lifecycle: "partial", goal_item_id: "UX/RUN-GROUP-001", supersedes_run_id: "run-a", updated_at: "2026-05-30T01:00:00.000Z" },
      { run_id: "run-c", type: "implement", status: "success", lifecycle: "success", goal_item_id: "OTHER-GOAL", updated_at: "2026-05-30T02:00:00.000Z" },
    ];

    const group = buildRunGroupSummary("UX/RUN-GROUP-001", entries);
    expect(group).toBeDefined();
    expect(group!.goal_item_id).toBe("UX/RUN-GROUP-001");
    expect(group!.run_count).toBe(2);
    expect(group!.latest_run_id).toBe("run-b");
    expect(group!.latest_lifecycle).toBe("partial");
    expect(group!.superseded_run_ids).toEqual(["run-a"]);
    expect(group!.entries.length).toBe(2);
  });

  it("dedupes superseded_run_ids", () => {
    const entries: RunLogEntrySummary[] = [
      { run_id: "run-x", type: "implement", status: "success", lifecycle: "success", goal_item_id: "GOAL", supersedes_run_id: "run-old", updated_at: "2026-05-30T00:00:00.000Z" },
      { run_id: "run-y", type: "implement", status: "success", lifecycle: "success", goal_item_id: "GOAL", supersedes_run_id: "run-old", updated_at: "2026-05-30T01:00:00.000Z" },
    ];

    const group = buildRunGroupSummary("GOAL", entries);
    expect(group).toBeDefined();
    expect(group!.superseded_run_ids).toEqual(["run-old"]);
  });

  it("returns undefined for missing goal", () => {
    const entries: RunLogEntrySummary[] = [
      { run_id: "run-1", type: "implement", status: "success", lifecycle: "success", goal_item_id: "OTHER" },
    ];
    const group = buildRunGroupSummary("MISSING", entries);
    expect(group).toBeUndefined();
  });
});

describe("getRunLogById with grouping metadata", () => {
  it("returns grouping metadata in inspect entry", async () => {
    const root = await makeTempDir();
    const repo = path.join(root, "repo");
    const logDir = path.join(repo, ".codex-claude-delegate", "runs");
    await mkdir(logDir, { recursive: true });

    await writeRunLogEntry(logDir, "run-inspect-group", {
      type: "implement",
      input: { cwd: repo },
      report: { status: "success", summary: "Done" },
      goal_item_id: "UX/RUN-GROUP-001",
      supersedes_run_id: "run-original",
    });

    const result = await getRunLogById({ cwd: repo, run_id: "run-inspect-group" });
    expect(result).not.toBeNull();
    expect(result!.entry.goal_item_id).toBe("UX/RUN-GROUP-001");
    expect(result!.entry.supersedes_run_id).toBe("run-original");
    expect(result!.raw.goal_item_id).toBe("UX/RUN-GROUP-001");
    expect(result!.raw.supersedes_run_id).toBe("run-original");
  });
});
