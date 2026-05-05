import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DANGEROUS_DISALLOWED_TOOLS,
  buildImplementArgs,
  buildQueryArgs,
  buildReviewArgs,
  buildSafeEnv,
  parseStatusPorcelainZ,
  truncateTail,
} from "../src/claude-cli.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    await rm(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(args[0], args.slice(1), { cwd, encoding: "utf8" }).trim();
}

describe("claude cli argument construction", () => {
  it("builds spawn argument arrays for implement mode", () => {
    const args = buildImplementArgs({ cwd: "/repo", task: "change code" }, "codex-delegated-test");

    expect(args).toContain("-p");
    expect(args).toContain("-w");
    expect(args).toContain("codex-delegated-test");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("dontAsk");
    expect(args).toContain("--tools");
    expect(args).toContain("--allowedTools");
    expect(args).toContain("--disallowedTools");
    expect(args).toContain("--max-turns");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).toContain("--json-schema");
  });

  it("keeps read-only modes from seeing Edit or Write", () => {
    expect(buildQueryArgs({ cwd: "/repo", task: "explain" }).join("\0")).not.toMatch(/\b(Edit|Write)\b/);
    expect(buildReviewArgs({ cwd: "/repo", task: "review" }).join("\0")).not.toMatch(/\b(Edit|Write)\b/);
    expect(buildImplementArgs({ cwd: "/repo", task: "change" }).join("\0")).toMatch(/\b(Edit|Write)\b/);
  });

  it("blocks dangerous bash patterns", () => {
    for (const tool of [
      "Bash(rm *)",
      "Bash(rm -rf *)",
      "Bash(sudo *)",
      "Bash(curl *)",
      "Bash(wget *)",
      "Bash(chmod *)",
      "Bash(chown *)",
      "Bash(git push *)",
      "Bash(ssh *)",
      "Bash(scp *)",
      "Bash(nc *)",
      "Bash(netcat *)",
    ]) {
      expect(DANGEROUS_DISALLOWED_TOOLS).toContain(tool);
      expect(buildImplementArgs({ cwd: "/repo", task: "change" })).toContain(tool);
    }
  });

  it("sanitizes env and truncates output tails", () => {
    process.env.OPENAI_API_KEY = "secret";
    process.env.MY_PASSWORD = "secret";
    const env = buildSafeEnv();

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.MY_PASSWORD).toBeUndefined();
    expect(env.BRIDGE_DEPTH).toBeDefined();
    expect(truncateTail("abcdef", 3)).toBe("def");
  });

  it("parses porcelain status even if leading spaces were trimmed", () => {
    expect(parseStatusPorcelainZ("M README.md")).toEqual([{ status: "M", file: "README.md" }]);
    expect(parseStatusPorcelainZ(" M README.md\0")).toEqual([{ status: "M", file: "README.md" }]);
  });

  it("lists recent run logs with filters", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-runs-"));
    cleanupPaths.push(root);
    const logDir = path.join(root, "runs");
    await mkdir(logDir, { recursive: true });
    await writeFile(path.join(logDir, "run-query.json"), JSON.stringify({
      type: "query",
      input: { cwd: "/repo-a" },
      report: { answer: "ok" },
      session: { requested_session_id: null, returned_session_id: "sess-1" },
    }));
    await writeFile(path.join(logDir, "run-implement.json"), JSON.stringify({
      type: "implement",
      input: { cwd: "/repo-a" },
      report: { status: "success", summary: "changed README" },
      observed: { worktree_path: ".claude/worktrees/codex-delegated-123" },
    }));
    await writeFile(path.join(logDir, "run-failed.json"), JSON.stringify({
      type: "apply",
      input: { cwd: "/repo-a", worktree_path: ".claude/worktrees/codex-delegated-123" },
      error: "apply refused",
    }));

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.listRunLogs({ cwd: "/repo-a", limit: 2 });
    expect(result.total_entries).toBe(2);
    expect(result.entries[0]?.cwd).toBe("/repo-a");
    expect(result.entries[0]?.lifecycle).toBeDefined();
    expect(result.entries[0]?.updated_at).toBeDefined();
    const failed = await reloaded.listRunLogs({ cwd: "/repo-a", status: "failed", limit: 10 });
    expect(failed.entries).toHaveLength(1);
    expect(failed.entries[0]?.type).toBe("apply");
    expect(failed.entries[0]?.error).toMatch(/apply refused/);
    expect(failed.entries[0]?.lifecycle).toBe("apply_blocked");
    const scoped = await reloaded.listRunLogs({ cwd: "/repo-a", type: "implement", worktree_name: "codex-delegated-123" });
    expect(scoped.entries).toHaveLength(1);
    expect(scoped.entries[0]?.lifecycle).toBe("success");
    const summary = await reloaded.getRecentRunsSummary("/repo-a", 10);
    expect(summary.lifecycle_counts.success).toBeGreaterThanOrEqual(1);
    expect(summary.lifecycle_counts.apply_blocked).toBe(1);
    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("inspects a single run log by id with related downstream runs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-run-inspect-"));
    cleanupPaths.push(root);
    const logDir = path.join(root, "runs");
    await mkdir(logDir, { recursive: true });
    await writeFile(path.join(logDir, "run-implement.json"), JSON.stringify({
      type: "implement",
      input: { cwd: "/repo-a" },
      report: { status: "success", summary: "changed README" },
      downstream: {
        current_lifecycle: "applied",
        last_apply_run_id: "apply-1",
        last_cleanup_run_id: "cleanup-1",
      },
      observed: { worktree_path: ".claude/worktrees/codex-delegated-123" },
    }));

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.getRunLogById({ cwd: "/repo-a", run_id: "run-implement" });
    expect(result?.entry.run_id).toBe("run-implement");
    expect(result?.entry.lifecycle).toBe("applied");
    expect(result?.related_runs).toEqual({ apply_run_id: "apply-1", cleanup_run_id: "cleanup-1" });
    expect(result?.raw.downstream).toBeDefined();
    await expect(
      reloaded.getRunLogById({ cwd: "/repo-a", run_id: "missing-run" })
    ).resolves.toBeNull();
    await expect(
      reloaded.getRunLogById({ cwd: "/repo-b", run_id: "run-implement" })
    ).resolves.toBeNull();
    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("resolves the latest implement session for a repo", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-resume-latest-"));
    cleanupPaths.push(root);
    const logDir = path.join(root, "runs");
    await mkdir(logDir, { recursive: true });
    const repo = path.join(root, "repo-a");
    await mkdir(repo, { recursive: true });
    await writeFile(path.join(logDir, "implement-old.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repo },
      report: { status: "success", summary: "old" },
      session: { returned_session_id: "sess-old" },
    }));
    await writeFile(path.join(logDir, "implement-newest.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repo },
      report: { status: "success", summary: "new" },
      session: { returned_session_id: "sess-latest" },
    }));
    await writeFile(path.join(logDir, "implement-no-session.json"), JSON.stringify({
      type: "implement",
      input: { cwd: path.join(root, "repo-b") },
      report: { status: "success", summary: "missing session" },
    }));

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const resolved = await reloaded.resolveLatestImplementSession({ cwd: repo });
    expect(resolved?.run_id).toBe("implement-newest");
    expect(resolved?.session_id).toBe("sess-latest");
    await expect(
      reloaded.resolveLatestImplementSession({ cwd: path.join(root, "repo-b") })
    ).resolves.toBeNull();
    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("previews apply changes without mutating the main workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-preview-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const logDir = path.join(root, "runs");
    await mkdir(repo, { recursive: true });
    await mkdir(logDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");
    await writeFile(path.join(repo, "README.md"), "# main\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");
    const worktreeRel = ".claude/worktrees/codex-delegated-preview";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    await writeFile(path.join(worktree, "README.md"), "# changed\n");
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");
    await writeFile(path.join(logDir, "preview-run.json"), JSON.stringify({
      type: "implement",
      observed: {
        worktree_path: worktreeRel,
        base_commit: baseCommit,
        changed_files: ["README.md"],
        scope: { requested_files: ["README.md"], out_of_scope_files: [], scope_exceeded: false, warnings: [] },
        resource_limits: { actual_changed_files: 1, changed_files_exceeded: false, warnings: [] },
      },
    }));

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const preview = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      preview: true,
    }, "test-run");
    expect(preview.preview).toBe(true);
    expect(preview.planned_changes).toEqual([{ status: "M", file: "README.md" }]);
    expect(preview.applied_files).toEqual([]);
    expect(await readFile(path.join(repo, "README.md"), "utf8")).toBe("# main\n");
    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("updates implement lifecycle after apply and cleanup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-lifecycle-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const logDir = path.join(root, "runs");
    await mkdir(repo, { recursive: true });
    await mkdir(logDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");
    await writeFile(path.join(repo, "README.md"), "# main\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");
    const worktreeRel = ".claude/worktrees/codex-delegated-lifecycle";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    await writeFile(path.join(worktree, "README.md"), "# changed\n");
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");
    await writeFile(path.join(logDir, "implement-run.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repo },
      report: { status: "success", summary: "Changed README" },
      observed: {
        worktree_path: worktreeRel,
        worktree_name: "codex-delegated-lifecycle",
        base_commit: baseCommit,
        changed_files: ["README.md"],
        scope: { requested_files: ["README.md"], out_of_scope_files: [], scope_exceeded: false, warnings: [] },
        resource_limits: { actual_changed_files: 1, changed_files_exceeded: false, warnings: [] },
      },
    }));

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const applied = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
    }, "apply-run");
    expect(applied.applied_files).toEqual(["README.md"]);
    let runs = await reloaded.listRunLogs({ cwd: repo, type: "implement" });
    expect(runs.entries[0]?.lifecycle).toBe("applied");

    const cleaned = await reloaded.runClaudeCleanup({
      cwd: repo,
      dry_run: false,
      older_than_hours: 0,
    }, "cleanup-run");
    expect(cleaned.removed_count).toBe(1);
    runs = await reloaded.listRunLogs({ cwd: repo, type: "implement" });
    expect(runs.entries[0]?.lifecycle).toBe("cleaned");
    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });
});
