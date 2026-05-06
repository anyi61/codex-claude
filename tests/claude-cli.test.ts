import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
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
const originalCwd = process.cwd();

afterEach(async () => {
  process.chdir(originalCwd);
  delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
  delete process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR;
  vi.doUnmock("node:child_process");
  vi.resetModules();
  while (cleanupPaths.length > 0) {
    await rm(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(args[0], args.slice(1), { cwd, encoding: "utf8" }).trim();
}

async function createJobFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-jobs-"));
  cleanupPaths.push(root);
  const repo = path.join(root, "repo-a");
  const stateDir = path.join(root, ".codex-claude-delegate");
  await mkdir(repo, { recursive: true });
  process.env.CODEX_CLAUDE_RUN_LOG_DIR = path.join(stateDir, "runs");
  vi.resetModules();
  const jobs = await import("../src/jobs.js");
  const store = new jobs.JobStore(stateDir);
  await store.init();
  return { root, repo, stateDir, store };
}

async function createWorkflowFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-"));
  cleanupPaths.push(root);
  const repo = path.join(root, "repo-a");
  const stateDir = path.join(root, ".codex-claude-delegate");
  const logDir = path.join(stateDir, "runs");
  const jobsDir = path.join(stateDir, "jobs");
  await mkdir(repo, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await mkdir(jobsDir, { recursive: true });
  process.chdir(root);
  process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
  process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;
  vi.resetModules();
  const jobs = await import("../src/jobs.js");
  const session = await import("../src/session.js");
  const jobStore = new jobs.JobStore(stateDir);
  const sessionStore = new session.SessionStore(stateDir);
  await jobStore.init();
  await sessionStore.init();
  const repoKey = await session.computeRepoKey(repo);
  return { root, repo, stateDir, logDir, jobsDir, jobStore, sessionStore, repoKey };
}

function createDetachedSpawnResult(pid = 4321) {
  const child = new EventEmitter() as EventEmitter & { pid: number; unref: ReturnType<typeof vi.fn> };
  child.pid = pid;
  child.unref = vi.fn();
  return child;
}

function createClaudeSpawnResult(stdout = "", stderr = "", code: number | null = 0, signal: NodeJS.Signals | null = null) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
  };
  child.pid = 9876;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", code, signal);
  });
  return child;
}

async function createGitRepoFixture(prefix = "codex-impl-status-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(root);
  const repo = path.join(root, "repo");
  const stateDir = path.join(root, ".codex-claude-delegate");
  const logDir = path.join(stateDir, "runs");
  await mkdir(repo, { recursive: true });
  await mkdir(logDir, { recursive: true });
  sh(root, "git", "init", repo);
  sh(repo, "git", "config", "user.name", "Test User");
  sh(repo, "git", "config", "user.email", "test@example.com");
  await writeFile(path.join(repo, "README.md"), "# main\n");
  sh(repo, "git", "add", ".");
  sh(repo, "git", "commit", "-m", "init");
  process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
  process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;
  return { root, repo, stateDir, logDir };
}

describe("claude cli argument construction", () => {
  it("builds spawn argument arrays for implement mode", () => {
    const args = buildImplementArgs({ cwd: "/repo/.claude/worktrees/codex-delegated-test", task: "change code" });

    expect(args).toContain("-p");
    expect(args).not.toContain("-w");
    expect(args).not.toContain("codex-delegated-test");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("dontAsk");
    expect(args).toContain("--tools");
    expect(args).toContain("--allowedTools");
    expect(args).toContain("--disallowedTools");
    expect(args).not.toContain("--max-turns");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).toContain("--json-schema");
    expect(args.join("\0")).toContain("Bash(mkdir -p *)");
  });

  it("keeps read-only modes from seeing Edit or Write", () => {
    expect(buildQueryArgs({ cwd: "/repo", task: "explain" }).join("\0")).not.toMatch(/\b(Edit|Write)\b/);
    expect(buildReviewArgs({ cwd: "/repo", task: "review" }).join("\0")).not.toMatch(/\b(Edit|Write)\b/);
    expect(buildImplementArgs({ cwd: "/repo", task: "change" }).join("\0")).toMatch(/\b(Edit|Write)\b/);
  });

  it("builds a lower-turn fast query prompt", () => {
    const args = buildQueryArgs({ cwd: "/repo", task: "explain", fast: true });
    const maxTurnsIndex = args.indexOf("--max-turns");

    expect(args[maxTurnsIndex + 1]).toBe("2");
    expect(args.join("\n")).toContain("Prefer a concise answer");
  });

  it("does not resume old query sessions when resume is explicitly false", async () => {
    const { repo } = await createGitRepoFixture("codex-query-no-resume-");
    const stateDir = path.join(path.dirname(repo), ".codex-claude-delegate");
    await mkdir(stateDir, { recursive: true });

    let capturedArgs: string[] = [];
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const spawnMock = vi.fn((bin: string, args: string[], options: unknown) => {
        if (bin !== "claude") return actual.spawn(bin, args, options as never);
        capturedArgs = args;
        const stdout = JSON.stringify({
          session_id: "sess-new-query",
          structured_output: { answer: "ok" },
        });
        return createClaudeSpawnResult(stdout, "", 0);
      });
      return { ...actual, spawn: spawnMock };
    });

    process.chdir(path.dirname(repo));
    process.env.CODEX_CLAUDE_RUN_LOG_DIR = path.join(stateDir, "runs");
    vi.resetModules();
    const session = await import("../src/session.js");
    const repoKey = await session.computeRepoKey(repo);
    await writeFile(path.join(stateDir, "sessions.json"), JSON.stringify({
      version: 1,
      sessions: [
        {
          session_id: "sess-old-query",
          type: "query",
          repo_key: repoKey,
          repo_path: repo,
          created_at: new Date().toISOString(),
          last_used: new Date().toISOString(),
          use_count: 3,
          summary: "old",
          expired: false,
        },
      ],
    }, null, 2));

    const reloaded = await import("../src/claude-cli.js");
    await reloaded.runClaudeQuery({
      cwd: repo,
      task: "quick summary",
      resume: false,
      max_turns: 2,
      timeout_sec: 45,
    }, "run-query-no-resume");

    expect(capturedArgs).not.toContain("-r");
    expect(capturedArgs).not.toContain("sess-old-query");

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("includes query timing breakdown in execution metadata", async () => {
    const { repo } = await createGitRepoFixture("codex-query-timing-");
    const stateDir = path.join(path.dirname(repo), ".codex-claude-delegate");
    process.chdir(path.dirname(repo));
    process.env.CODEX_CLAUDE_RUN_LOG_DIR = path.join(stateDir, "runs");

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const spawnMock = vi.fn((bin: string, args: string[], options: unknown) => {
        if (bin !== "claude") return actual.spawn(bin, args, options as never);
        const stdout = JSON.stringify({
          session_id: "sess-query-timing",
          structured_output: { answer: "ok" },
        });
        return createClaudeSpawnResult(stdout, "", 0);
      });
      return { ...actual, spawn: spawnMock };
    });

    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeQuery({
      cwd: repo,
      task: "quick summary",
      fast: true,
      resume: false,
    }, "run-query-timing");

    expect(result.execution.timings).toMatchObject({
      session_lookup_ms: expect.any(Number),
      claude_run_ms: expect.any(Number),
      log_write_ms: expect.any(Number),
      total_ms: expect.any(Number),
    });

    vi.doUnmock("node:child_process");
    vi.resetModules();
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

  it("recursively applies untracked directory entries from a worktree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-directory-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const logDir = path.join(root, "runs");
    await mkdir(repo, { recursive: true });
    await mkdir(logDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");
    await writeFile(path.join(repo, "package.json"), "{\"name\":\"fixture\"}\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");
    const worktreeRel = ".claude/worktrees/codex-delegated-directory";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    await mkdir(path.join(worktree, "src", "lib"), { recursive: true });
    await writeFile(path.join(worktree, "src", "index.js"), "export const value = 1;\n");
    await writeFile(path.join(worktree, "src", "lib", "helper.js"), "export const helper = true;\n");
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");
    await writeFile(path.join(logDir, "implement-directory.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repo },
      report: { status: "success", summary: "Added src directory" },
      observed: {
        worktree_path: worktreeRel,
        worktree_name: "codex-delegated-directory",
        base_commit: baseCommit,
        changed_files: ["src/"],
        scope: { requested_files: undefined, out_of_scope_files: [], scope_exceeded: false, warnings: [] },
        resource_limits: { actual_changed_files: 1, changed_files_exceeded: false, warnings: [] },
      },
    }));

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const applied = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
    }, "apply-directory");

    expect(applied.error).toBeUndefined();
    expect(applied.conflicts).toEqual([]);
    expect(applied.applied_files).toEqual(["src/index.js", "src/lib/helper.js"]);
    expect(await readFile(path.join(repo, "src", "index.js"), "utf8")).toBe("export const value = 1;\n");
    expect(await readFile(path.join(repo, "src", "lib", "helper.js"), "utf8")).toBe("export const helper = true;\n");
    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("marks non-zero implement results with observed file changes as partial", async () => {
    const { repo } = await createGitRepoFixture();
    const stdout = JSON.stringify({
      session_id: "sess-partial",
      subtype: "max_turns",
      structured_output: {
        status: "success",
        summary: "Hit max turns after editing README.",
        is_error: true,
        terminal_reason: "max_turns",
      },
    });
    let spawnMock: ReturnType<typeof vi.fn>;
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      spawnMock = vi.fn((bin: string, args: string[], options: { cwd?: string }) => {
        if (bin !== "claude") return actual.spawn(bin, args, options as never);
        const worktreeArgIndex = args.indexOf("-w");
        const worktreeName = worktreeArgIndex >= 0 ? args[worktreeArgIndex + 1] : undefined;
        const writeCwd = worktreeName ? path.join(options.cwd!, ".claude", "worktrees", worktreeName) : options.cwd!;
        writeFileSync(path.join(writeCwd, "README.md"), "# changed\n");
        return createClaudeSpawnResult(stdout, "", 1);
      });
      return { ...actual, spawn: spawnMock };
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeImplement({
      cwd: repo,
      task: "Change README.",
      worktreeName: "codex-delegated-partial",
      max_turns: 1,
    }, "run-partial");

    expect(result.status).toBe("partial");
    expect(result.execution.exit_code).toBe(1);
    expect((result.server_observed as { changed_files: string[] }).changed_files).toEqual(["README.md"]);
    expect(result.warnings.join("\n")).toContain("inspect");
    expect(spawnMock).toHaveBeenCalledWith(
      "claude",
      expect.not.arrayContaining(["-w"]),
      expect.objectContaining({
        cwd: path.join(repo, ".claude", "worktrees", "codex-delegated-partial"),
      })
    );
    expect(sh(repo, "git", "status", "--short", "--", "README.md")).toBe("");

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("marks non-zero implement results with no observed file changes as failed", async () => {
    const { repo } = await createGitRepoFixture();
    const stdout = JSON.stringify({
      session_id: "sess-failed",
      subtype: "max_turns",
      structured_output: {
        status: "success",
        summary: "Hit max turns before editing.",
        is_error: true,
        terminal_reason: "max_turns",
      },
    });

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const spawnMock = vi.fn((bin: string, args: string[], options: unknown) => {
        if (bin !== "claude") return actual.spawn(bin, args, options as never);
        return createClaudeSpawnResult(stdout, "", 1);
      });
      return { ...actual, spawn: spawnMock };
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeImplement({
      cwd: repo,
      task: "Try to change README.",
      worktreeName: "codex-delegated-failed",
      max_turns: 1,
    }, "run-failed");

    expect(result.status).toBe("failed");
    expect(result.execution.exit_code).toBe(1);
    expect((result.server_observed as { changed_files: string[] }).changed_files).toEqual([]);
    expect(result.claude_report).toMatchObject({ terminal_reason: "max_turns" });

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("precreates common project directories before handing an implement worktree to Claude", async () => {
    const { repo } = await createGitRepoFixture("codex-impl-scaffold-");
    const stdout = JSON.stringify({
      session_id: "sess-scaffold",
      structured_output: {
        status: "success",
        summary: "Inspected prepared workspace.",
        changed_files: [],
        commands_run: [],
        tests: { ran: false },
        risks: [],
        next_steps: [],
      },
    });

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        spawn: vi.fn((bin: string, args: string[], options: { cwd?: string }) => {
          if (bin !== "claude") return actual.spawn(bin, args, options as never);
          expect(options.cwd).toBe(path.join(repo, ".claude", "worktrees", "codex-delegated-scaffold"));
          expect(existsSync(path.join(options.cwd!, "src"))).toBe(true);
          expect(existsSync(path.join(options.cwd!, "tests"))).toBe(true);
          expect(existsSync(path.join(options.cwd!, ".github", "workflows"))).toBe(true);
          return createClaudeSpawnResult(stdout, "", 0);
        }),
      };
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeImplement({
      cwd: repo,
      task: "Prepare a project layout.",
      worktreeName: "codex-delegated-scaffold",
      max_turns: 1,
    }, "run-scaffold");

    expect(result.status).toBe("success");

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("asks for a dirty-workspace decision before broad implement tasks", async () => {
    const { repo } = await createGitRepoFixture("codex-impl-dirty-main-");
    await writeFile(path.join(repo, "README.md"), "# uncommitted\n");

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeImplement({
      cwd: repo,
      task: "Implement a new feature without file scoping.",
      worktreeName: "codex-delegated-dirty-main",
      max_turns: 1,
    }, "run-dirty-main");

    expect(result.status).toBe("needs_user");
    expect(result.claude_report).toMatchObject({
      status: "needs_user",
      next_steps: expect.arrayContaining([
        expect.stringContaining("dirty_policy=\"snapshot\""),
        expect.stringContaining("dirty_policy=\"committed\""),
      ]),
    });
    expect(existsSync(path.join(repo, ".claude", "worktrees", "codex-delegated-dirty-main"))).toBe(false);
  });

  it("can snapshot dirty main workspace files into an implement worktree", async () => {
    const { repo } = await createGitRepoFixture("codex-impl-dirty-snapshot-");
    await writeFile(path.join(repo, "README.md"), "# uncommitted\n");
    const stdout = JSON.stringify({
      session_id: "sess-snapshot",
      structured_output: {
        status: "success",
        summary: "Saw the snapshot.",
        changed_files: [],
        commands_run: [],
        tests: { ran: false },
        risks: [],
        next_steps: [],
      },
    });

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        spawn: vi.fn((bin: string, args: string[], options: { cwd?: string }) => {
          if (bin !== "claude") return actual.spawn(bin, args, options as never);
          expect(readFileSync(path.join(options.cwd!, "README.md"), "utf8")).toBe("# uncommitted\n");
          return createClaudeSpawnResult(stdout, "", 0);
        }),
      };
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeImplement({
      cwd: repo,
      task: "Inspect current README.",
      worktreeName: "codex-delegated-dirty-snapshot",
      dirty_policy: "snapshot",
      max_turns: 1,
    }, "run-dirty-snapshot");

    expect(result.status).toBe("success");

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("ignores delegate metadata directories when checking broad implement dirtiness", async () => {
    const { repo } = await createGitRepoFixture("codex-impl-dirty-internal-");
    await mkdir(path.join(repo, ".codex-claude-delegate", "runs"), { recursive: true });
    await mkdir(path.join(repo, ".claude"), { recursive: true });
    await writeFile(path.join(repo, ".codex-claude-delegate", "runs", "local.json"), "{}\n");
    await writeFile(path.join(repo, ".claude", "local"), "metadata\n");
    const stdout = JSON.stringify({
      session_id: "sess-internal-dirty",
      structured_output: {
        status: "success",
        summary: "No user changes were required.",
        changed_files: [],
        commands_run: [],
        tests: { ran: false },
        risks: [],
        next_steps: [],
      },
    });

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        spawn: vi.fn((bin: string, args: string[], options: unknown) => {
          if (bin !== "claude") return actual.spawn(bin, args, options as never);
          return createClaudeSpawnResult(stdout, "", 0);
        }),
      };
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeImplement({
      cwd: repo,
      task: "Inspect the project.",
      worktreeName: "codex-delegated-internal-dirty",
      max_turns: 1,
    }, "run-internal-dirty");

    expect(result.status).toBe("success");

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("returns a structured failed implement result when a resumed Claude session is unavailable", async () => {
    const { repo, logDir, stateDir } = await createGitRepoFixture("codex-impl-resume-missing-");
    await writeFile(path.join(logDir, "run-implement-prev.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repo },
      report: { status: "success", summary: "Previous implementation" },
      session: { returned_session_id: "sess-missing" },
    }));

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        spawn: vi.fn((bin: string, args: string[], options: unknown) => {
          if (bin !== "claude") return actual.spawn(bin, args, options as never);
          return createClaudeSpawnResult("", "No conversation found with session ID: sess-missing\n", 1);
        }),
      };
    });

    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeImplement({
      cwd: repo,
      task: "Continue latest implementation.",
      resume_latest: true,
      worktreeName: "codex-delegated-resume-missing",
      max_turns: 1,
    }, "run-resume-missing");

    expect(result.status).toBe("failed");
    expect(result.execution.exit_code).toBe(1);
    expect(result.warnings.join("\n")).toContain("session");
    expect(result.claude_report).toMatchObject({
      status: "failed",
      summary: expect.stringContaining("session"),
    });
    expect((result.server_observed as { worktree_name: string }).worktree_name).toBe("codex-delegated-resume-missing");

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("throws structured diagnostics and next actions when review produces no output", async () => {
    const { repo } = await createGitRepoFixture("codex-review-no-output-");

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: vi.fn(() => createClaudeSpawnResult("", "", 143)) };
    });

    const reloaded = await import("../src/claude-cli.js");
    await expect(
      reloaded.runClaudeReview({
        cwd: repo,
        task: "Review this repository.",
        timeout_sec: 90,
      }, "run-review-empty")
    ).rejects.toMatchObject({
      payload: {
        error: expect.stringContaining("Claude produced no output"),
        diagnostics: {
          timeout_sec: 90,
          stdout_len: 0,
          stderr_len: 0,
        },
        next_actions: [
          expect.objectContaining({ tool: "claude_review" }),
          expect.objectContaining({ tool: "claude_review", args: { background: true } }),
          expect.objectContaining({ tool: "claude_status" }),
        ],
      },
    });

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("stores and updates persisted background jobs", async () => {
    const { store } = await createJobFixture();

    await store.create({
      job_id: "job-1",
      type: "review",
      status: "queued",
      cwd: "/repo-a",
      created_at: "2026-05-05T00:00:00.000Z",
      updated_at: "2026-05-05T00:00:00.000Z",
      payload: { cwd: "/repo-a", task: "review this" },
    });

    const listed = await store.list({ cwd: "/repo-a", limit: 10 });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe("queued");

    await store.update("job-1", { status: "running", pid: 12345 });
    const job = await store.get("job-1");
    expect(job?.pid).toBe(12345);

    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("enqueues a detached background job and records launch metadata", async () => {
    const { repo, stateDir } = await createJobFixture();
    const spawned = createDetachedSpawnResult();
    const spawnMock = vi.fn(() => spawned);

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: spawnMock };
    });

    const reloaded = await import("../src/claude-cli.js");
    const created = await reloaded.enqueueBackgroundJob({
      cwd: repo,
      type: "review",
      payload: { cwd: repo, task: "review this" },
    });

    expect(created.job.status).toBe("queued");
    expect(created.job.job_id).toBeTruthy();
    expect(created.job.pid).toBe(4321);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const jobs = await import("../src/jobs.js");
    const store = new jobs.JobStore(stateDir);
    const persisted = await store.get(created.job.job_id);
    expect(persisted?.pid).toBe(4321);

    vi.doUnmock("node:child_process");
    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("routes background query, review, implement, apply, and cleanup requests through the job queue", async () => {
    const { repo } = await createJobFixture();
    const spawned = createDetachedSpawnResult(5555);

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: vi.fn(() => spawned) };
    });

    const reloaded = await import("../src/claude-cli.js");
    const query = await reloaded.startBackgroundQuery({
      cwd: repo,
      task: "explain this module",
      background: true,
    });
    expect(query.job.type).toBe("query");

    const review = await reloaded.startBackgroundReview({
      cwd: repo,
      task: "review this",
      background: true,
    });
    expect(review.job.status).toBe("queued");

    const implement = await reloaded.startBackgroundImplement({
      cwd: repo,
      task: "ship it",
      background: true,
      dirty_policy: "committed",
    });
    expect(implement.job.type).toBe("implement");

    const apply = await reloaded.startBackgroundApply({
      cwd: repo,
      worktree_path: ".claude/worktrees/codex-delegated-apply",
      background: true,
    });
    expect(apply.job.type).toBe("apply");

    const cleanup = await reloaded.startBackgroundCleanup({
      cwd: repo,
      older_than_hours: 24,
      dry_run: true,
      background: true,
    });
    expect(cleanup.job.type).toBe("cleanup");

    vi.doUnmock("node:child_process");
    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("lists, reads, and cancels background jobs", async () => {
    const { repo, store } = await createJobFixture();

    await store.create({
      job_id: "job-1",
      type: "review",
      status: "queued",
      cwd: repo,
      created_at: "2026-05-05T00:00:00.000Z",
      updated_at: "2026-05-05T00:00:00.000Z",
      payload: { cwd: repo, task: "review this" },
      result: { status: "success" },
    });
    await store.create({
      job_id: "job-running",
      type: "implement",
      status: "running",
      cwd: repo,
      created_at: "2026-05-05T00:01:00.000Z",
      updated_at: "2026-05-05T00:01:00.000Z",
      pid: 7777,
      payload: { cwd: repo, task: "ship it" },
    });

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const reloaded = await import("../src/claude-cli.js");

    const jobs = await reloaded.listBackgroundJobs({ cwd: repo, limit: 10 });
    expect(jobs.entries).toHaveLength(2);

    const result = await reloaded.getBackgroundJobResult({ cwd: repo, job_id: "job-1" });
    expect(result?.job.job_id).toBe("job-1");

    const cancel = await reloaded.cancelBackgroundJob({ cwd: repo, job_id: "job-running" });
    expect(cancel.cancelled).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(7777, "SIGTERM");

    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("waits for a background job that is already terminal", async () => {
    const { repo, store } = await createJobFixture();

    await store.create({
      job_id: "job-done",
      type: "implement",
      status: "succeeded",
      result_status: "partial",
      cwd: repo,
      created_at: "2026-05-05T00:00:00.000Z",
      updated_at: "2026-05-05T00:00:01.000Z",
      payload: { cwd: repo, task: "review this" },
      summary: "Implement partial: Hit max turns after editing README.",
      result: { status: "partial", claude_report: { status: "partial", summary: "Hit max turns after editing README." } },
    });

    const reloaded = await import("../src/claude-cli.js");
    const waitForBackgroundJob = (reloaded as {
      waitForBackgroundJob?: (input: {
        cwd: string;
        job_id: string;
      }) => Promise<{ job: { status: string; result_status?: string; summary?: string }; summary: string; waiting: boolean; timed_out: boolean; recommended_delay_ms?: number; result?: Record<string, unknown> }>;
    }).waitForBackgroundJob;

    const result = await waitForBackgroundJob!({
      cwd: repo,
      job_id: "job-done",
    });

    expect(result.job.status).toBe("succeeded");
    expect(result.job.result_status).toBe("partial");
    expect(result.job.summary).toContain("Implement partial");
    expect(result.summary).toContain("is succeeded");
    expect(result.waiting).toBe(false);
    expect(result.timed_out).toBe(false);
    expect(result.recommended_delay_ms).toBeUndefined();
    expect(result.result?.status).toBe("partial");

    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("records partial Claude outcomes separately from successful background process completion", async () => {
    const { repo, stateDir } = await createGitRepoFixture("codex-bg-partial-");
    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;
    const stdout = JSON.stringify({
      session_id: "sess-bg-partial",
      subtype: "max_turns",
      structured_output: {
        status: "success",
        summary: "Hit max turns after editing README.",
        is_error: true,
        terminal_reason: "max_turns",
      },
    });

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        spawn: vi.fn((bin: string, args: string[], options: { cwd?: string }) => {
          if (bin !== "claude") return actual.spawn(bin, args, options as never);
          writeFileSync(path.join(options.cwd!, "README.md"), "# changed\n");
          return createClaudeSpawnResult(stdout, "", 1);
        }),
      };
    });

    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const jobs = await import("../src/jobs.js");
    const store = new jobs.JobStore(stateDir);
    await store.init();
    await store.create({
      job_id: "job-bg-partial",
      status: "queued",
      cwd: repo,
      type: "implement",
      created_at: "2026-05-05T00:00:00.000Z",
      updated_at: "2026-05-05T00:00:00.000Z",
      payload: { cwd: repo, task: "Change README.", worktreeName: "codex-delegated-bg-partial", max_turns: 1 },
    });

    await reloaded.executeBackgroundJob("job-bg-partial");
    const result = await reloaded.getBackgroundJobResult({ cwd: repo, job_id: "job-bg-partial" });

    expect(result?.job.status).toBe("succeeded");
    expect(result?.job.result_status).toBe("partial");
    expect(result?.job.summary).toContain("Implement partial");
    expect(result?.result?.status).toBe("partial");

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("dry-runs and removes old terminal background jobs without touching running jobs", async () => {
    const { repo, store } = await createJobFixture();

    await store.create({
      job_id: "job-old-success",
      type: "review",
      status: "succeeded",
      cwd: repo,
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:00:00.000Z",
      payload: { cwd: repo, task: "review this" },
      result: { status: "success" },
    });
    await store.create({
      job_id: "job-old-cancelled",
      type: "implement",
      status: "cancelled",
      cwd: repo,
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:10:00.000Z",
      payload: { cwd: repo, task: "ship it" },
    });
    await store.create({
      job_id: "job-running",
      type: "implement",
      status: "running",
      cwd: repo,
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:20:00.000Z",
      payload: { cwd: repo, task: "still running" },
    });

    const reloaded = await import("../src/claude-cli.js");
    const dryRun = await reloaded.cleanupBackgroundJobs({
      cwd: repo,
      older_than_hours: 0,
      dry_run: true,
      limit: 10,
    });
    expect(dryRun.dry_run).toBe(true);
    expect(dryRun.matched_count).toBe(2);
    expect(dryRun.removed_count).toBe(0);
    expect((await store.get("job-old-success"))?.job_id).toBe("job-old-success");

    const removed = await reloaded.cleanupBackgroundJobs({
      cwd: repo,
      older_than_hours: 0,
      dry_run: false,
      limit: 1,
    });
    expect(removed.matched_count).toBe(1);
    expect(removed.removed_count).toBe(1);
    expect(await store.get("job-old-success")).toBeNull();
    expect((await store.get("job-old-cancelled"))?.job_id).toBe("job-old-cancelled");
    expect((await store.get("job-running"))?.job_id).toBe("job-running");

    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("returns a waiting status while a background job stays running", async () => {
    const { repo, store } = await createJobFixture();

    await store.create({
      job_id: "job-running",
      type: "implement",
      status: "running",
      cwd: repo,
      created_at: "2026-05-05T00:01:00.000Z",
      updated_at: "2026-05-05T00:01:00.000Z",
      payload: { cwd: repo, task: "ship it" },
    });

    const reloaded = await import("../src/claude-cli.js");
    const waitForBackgroundJob = (reloaded as {
      waitForBackgroundJob?: (input: {
        cwd: string;
        job_id: string;
      }) => Promise<unknown>;
    }).waitForBackgroundJob;

    const result = await waitForBackgroundJob!({
      cwd: repo,
      job_id: "job-running",
    });

    expect(result).toMatchObject({
      summary: expect.stringContaining("do not duplicate this task locally"),
      waiting: true,
      timed_out: false,
      recommended_delay_ms: 5000,
      job: {
        job_id: "job-running",
        status: "running",
      },
    });
    expect((result as { next_actions?: Array<{ reason: string }> }).next_actions?.[0]?.reason).toContain("do not duplicate this implementation locally");
    expect((result as { next_actions?: Array<{ tool: string }> }).next_actions?.map((action) => action.tool)).toEqual([
      "claude_job_wait",
      "claude_job_result",
      "claude_job_cancel",
    ]);
  });

  it("returns a waiting status while a background job stays queued", async () => {
    const { repo, store } = await createJobFixture();

    await store.create({
      job_id: "job-queued",
      type: "review",
      status: "queued",
      cwd: repo,
      created_at: "2026-05-05T00:01:00.000Z",
      updated_at: "2026-05-05T00:01:00.000Z",
      payload: { cwd: repo, task: "review it" },
    });

    const reloaded = await import("../src/claude-cli.js");
    const waitForBackgroundJob = (reloaded as {
      waitForBackgroundJob?: (input: {
        cwd: string;
        job_id: string;
      }) => Promise<unknown>;
    }).waitForBackgroundJob;

    const result = await waitForBackgroundJob!({
      cwd: repo,
      job_id: "job-queued",
    });

    expect(result).toMatchObject({
      summary: expect.stringContaining("do not duplicate this task locally"),
      waiting: true,
      timed_out: false,
      recommended_delay_ms: 5000,
      job: {
        job_id: "job-queued",
        status: "queued",
      },
    });
  });

  it("resolves claude_result from an explicit job id with run, session, and next actions", async () => {
    const { repo, logDir, jobStore, sessionStore, repoKey } = await createWorkflowFixture();
    await writeFile(path.join(logDir, "run-implement.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repo },
      report: { status: "success", summary: "Changed README" },
      observed: {
        worktree_path: ".claude/worktrees/codex-delegated-123",
        worktree_name: "codex-delegated-123",
      },
      session: {
        requested_session_id: "sess-prev",
        returned_session_id: "sess-impl",
      },
      downstream: {
        last_apply_run_id: "run-apply",
      },
    }));
    await jobStore.create({
      job_id: "job-implement",
      type: "implement",
      status: "succeeded",
      cwd: repo,
      created_at: "2026-05-05T00:00:00.000Z",
      updated_at: "2026-05-05T00:01:00.000Z",
      payload: { cwd: repo, task: "ship it" },
      run_id: "run-implement",
      summary: "Implement job completed",
      result: { status: "success", summary: "Changed README" },
      worktree_name: "codex-delegated-123",
    });
    sessionStore.upsert("sess-impl", "implement", repoKey, repo, "Changed README");

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.getClaudeResult({ cwd: repo, job_id: "job-implement" });

    expect(result.source_type).toBe("job");
    expect(result.summary).toBe("Implement job completed");
    expect(result.job?.job_id).toBe("job-implement");
    expect(result.run?.run_id).toBe("run-implement");
    expect(result.session?.session_id).toBe("sess-impl");
    expect(result.session?.source).toBe("run");
    expect(result.next_actions.map((action) => action.tool)).toEqual(
      expect.arrayContaining(["claude_apply", "claude_implement"])
    );
    expect(result.next_actions.find((action) => action.tool === "claude_apply")?.args).toEqual({
      cwd: repo,
      worktree_path: ".claude/worktrees/codex-delegated-123",
    });
  });

  it("resolves claude_result from an explicit run id", async () => {
    const { repo, logDir } = await createWorkflowFixture();
    await writeFile(path.join(logDir, "run-review.json"), JSON.stringify({
      type: "review",
      input: { cwd: repo },
      report: { severity: "medium", findings: ["n/a"], recommendations: ["tighten docs"] },
    }));

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.getClaudeResult({ cwd: repo, run_id: "run-review" });

    expect(result.source_type).toBe("run");
    expect(result.run?.run_id).toBe("run-review");
    expect(result.result).toMatchObject({
      type: "review",
      report: { severity: "medium" },
    });
    expect(result.next_actions.map((action) => action.tool)).toContain("claude_review");
  });

  it("exposes inspection and cleanup next actions for needs_user implement runs", async () => {
    const { repo, logDir } = await createWorkflowFixture();
    await writeFile(path.join(logDir, "run-needs-user.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repo },
      report: { status: "needs_user", summary: "Claude needs a directory created." },
      observed: {
        worktree_path: ".claude/worktrees/codex-delegated-needs-user",
        worktree_name: "codex-delegated-needs-user",
        changed_files: [],
      },
    }));

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.getClaudeResult({ cwd: repo, run_id: "run-needs-user" });

    expect(result.run?.status).toBe("needs_user");
    expect(result.next_actions.map((action) => action.tool)).toEqual(
      expect.arrayContaining(["claude_run_inspect", "claude_cleanup", "claude_implement"])
    );
    expect(result.next_actions.find((action) => action.tool === "claude_run_inspect")?.args).toEqual({
      cwd: repo,
      run_id: "run-needs-user",
    });
  });

  it("reports a shaped claude_result miss when no finished jobs or runs exist", async () => {
    const { repo } = await createWorkflowFixture();

    const reloaded = await import("../src/claude-cli.js");
    await expect(reloaded.getClaudeResult({ cwd: repo, prefer: "latest-job" })).rejects.toThrow(
      "No matching finished job or run found for this workspace."
    );
  });

  it("prefers the latest implement artifact and exposes resumable next actions", async () => {
    const { repo, logDir, jobStore, sessionStore, repoKey } = await createWorkflowFixture();
    await writeFile(path.join(logDir, "run-implement-new.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repo },
      report: { status: "success", summary: "Newest implement" },
      observed: { worktree_path: ".claude/worktrees/codex-delegated-new" },
      session: { returned_session_id: "sess-new" },
    }));
    await writeFile(path.join(logDir, "run-review-old.json"), JSON.stringify({
      type: "review",
      input: { cwd: repo },
      report: { severity: "low", findings: [], recommendations: [] },
    }));
    await jobStore.create({
      job_id: "job-implement-new",
      type: "implement",
      status: "succeeded",
      cwd: repo,
      created_at: "2026-05-05T00:00:00.000Z",
      updated_at: "2026-05-05T00:02:00.000Z",
      payload: { cwd: repo, task: "ship it" },
      run_id: "run-implement-new",
      summary: "Newest implement",
      result: { status: "success" },
    });
    sessionStore.upsert("sess-new", "implement", repoKey, repo, "Newest implement");

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.getClaudeResult({ cwd: repo, prefer: "latest-implement" });

    expect(result.run?.type).toBe("implement");
    expect(result.source_type === "job" || result.source_type === "run").toBe(true);
    if (result.job) {
      expect(result.job.job_id).toBe("job-implement-new");
    }
    expect(result.next_actions.map((action) => action.tool)).toEqual(
      expect.arrayContaining(["claude_apply", "claude_implement"])
    );
  });

  it("returns workspace status with jobs, sessions, worktrees, and attention items", async () => {
    const { repo, logDir, jobStore, sessionStore, repoKey } = await createWorkflowFixture();
    const worktreeRoot = path.join(repo, ".claude", "worktrees");
    const staleWorktree = path.join(worktreeRoot, "codex-delegated-stale");
    const freshWorktree = path.join(worktreeRoot, "codex-delegated-fresh");
    await mkdir(staleWorktree, { recursive: true });
    await mkdir(freshWorktree, { recursive: true });
    const staleDate = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(staleWorktree, staleDate, staleDate);
    await writeFile(path.join(logDir, "run-apply-blocked.json"), JSON.stringify({
      type: "apply",
      input: { cwd: repo, worktree_path: ".claude/worktrees/codex-delegated-stale" },
      error: "conflict",
    }));
    await jobStore.create({
      job_id: "job-running",
      type: "review",
      status: "running",
      cwd: repo,
      created_at: "2026-05-05T00:00:00.000Z",
      updated_at: "2026-05-05T00:01:00.000Z",
      payload: { cwd: repo, task: "review" },
    });
    await jobStore.create({
      job_id: "job-queued-old",
      type: "query",
      status: "queued",
      cwd: repo,
      created_at: "2026-05-05T00:00:00.000Z",
      updated_at: "2026-05-05T00:00:00.000Z",
      payload: { cwd: repo, task: "query" },
    });
    await jobStore.create({
      job_id: "job-succeeded",
      type: "implement",
      status: "succeeded",
      cwd: repo,
      created_at: "2026-05-05T00:00:00.000Z",
      updated_at: "2026-05-05T00:02:00.000Z",
      payload: { cwd: repo, task: "implement" },
      summary: "done",
    });
    sessionStore.upsert("sess-query", "query", repoKey, repo, "Explained workspace");

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.getWorkspaceStatus({ cwd: repo, limit: 10, include_terminal: true });

    expect(result.workspace_root).toBe(repo);
    expect(result.counts.running_jobs).toBe(1);
    expect(result.counts.queued_jobs).toBe(1);
    expect(result.counts.terminal_jobs).toBeGreaterThanOrEqual(1);
    expect(result.counts.apply_blocked_runs).toBe(1);
    expect(result.counts.orphan_worktrees).toBe(1);
    expect(result.latest_sessions[0]?.session_id).toBe("sess-query");
    expect(result.delegated_worktrees.map((worktree) => worktree.worktree_name)).toEqual(
      expect.arrayContaining(["codex-delegated-stale", "codex-delegated-fresh"])
    );
    expect(result.delegated_worktrees.find((worktree) => worktree.worktree_name === "codex-delegated-fresh")?.orphaned).toBe(true);
    expect(result.delegated_worktrees.find((worktree) => worktree.worktree_name === "codex-delegated-stale")?.orphaned).toBe(false);
    expect(result.attention_items.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["queued_job", "apply_blocked", "stale_worktree", "orphan_worktree"])
    );
  });

  it("returns an empty workspace status without attention items for a fresh workspace", async () => {
    const { repo } = await createWorkflowFixture();

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.getWorkspaceStatus({ cwd: repo, limit: 10, include_terminal: true });

    expect(result.workspace_root).toBe(repo);
    expect(result.running_jobs).toEqual([]);
    expect(result.queued_jobs).toEqual([]);
    expect(result.recent_terminal_jobs).toEqual([]);
    expect(result.recent_runs).toEqual([]);
    expect(result.latest_sessions).toEqual([]);
    expect(result.delegated_worktrees).toEqual([]);
    expect(result.counts).toEqual({
      running_jobs: 0,
      queued_jobs: 0,
      terminal_jobs: 0,
      recent_runs: 0,
      delegated_worktrees: 0,
      stale_worktrees: 0,
      orphan_worktrees: 0,
      apply_blocked_runs: 0,
    });
    expect(result.attention_items).toEqual([]);
  });

  it("routes claude_task read mode to a background query job", async () => {
    const { repo } = await createWorkflowFixture();
    const spawned = createDetachedSpawnResult(6001);

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: vi.fn(() => spawned) };
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeTask({
      cwd: repo,
      task: "Explain how background jobs work here.",
      mode: "read",
      background: true,
      timeout_sec: 90,
    }, "run-task-read");

    expect(result.delegated_mode).toBe("read");
    expect(result.job?.type).toBe("query");
    expect(result.job?.status).toBe("queued");
    expect(Array.isArray(result.next_actions)).toBe(true);
  });

  it("routes claude_task write mode to a background implement job", async () => {
    const { repo, jobStore } = await createWorkflowFixture();
    const spawned = createDetachedSpawnResult(6002);

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: vi.fn(() => spawned) };
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeTask({
      cwd: repo,
      task: "Implement input validation for README updates.",
      mode: "write",
      background: true,
      files: ["README.md"],
      constraints: ["Only change README.md"],
      resume_latest: true,
      dirty_policy: "committed",
    }, "run-task-write");

    expect(result.delegated_mode).toBe("write");
    expect(result.job?.type).toBe("implement");
    expect(result.job?.status).toBe("queued");
    const stored = await jobStore.get(result.job!.job_id);
    expect(stored?.payload.max_turns).toBeUndefined();
    expect(Array.isArray(result.next_actions)).toBe(true);
  });

  it("routes claude_task write mode to a background implement job by default", async () => {
    const { repo, jobStore } = await createWorkflowFixture();
    const spawned = createDetachedSpawnResult(6004);

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: vi.fn(() => spawned) };
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeTask({
      cwd: repo,
      task: "Implement input validation for README updates.",
      mode: "write",
      files: ["README.md"],
      constraints: ["Only change README.md"],
      dirty_policy: "committed",
    }, "run-task-write-default");

    expect(result.delegated_mode).toBe("write");
    expect(result.summary).toBe("Delegated write task as a background job.");
    expect(result.job?.type).toBe("implement");
    expect(result.job?.status).toBe("queued");
    const stored = await jobStore.get(result.job!.job_id);
    expect(stored?.payload).toMatchObject({
      cwd: repo,
      task: "Implement input validation for README updates.",
      background: true,
    });
    expect(stored?.payload.max_turns).toBeUndefined();
    expect(result.next_actions.map((action) => action.tool)).toEqual([
      "claude_job_wait",
      "claude_job_result",
      "claude_job_cancel",
    ]);
  });

  it("returns needs_user from claude_task write background jobs when unscoped user changes are dirty", async () => {
    const { repo } = await createGitRepoFixture("codex-task-dirty-main-");
    await writeFile(path.join(repo, "README.md"), "# dirty\n");

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeTask({
      cwd: repo,
      task: "Implement input validation.",
      mode: "write",
      background: true,
    }, "run-task-write-dirty");

    expect(result.delegated_mode).toBe("write");
    expect(result.job).toBeUndefined();
    expect(result.result?.status).toBe("needs_user");
  });

  it("routes claude_task auto mode to review when diff is provided", async () => {
    const { repo } = await createWorkflowFixture();
    const spawned = createDetachedSpawnResult(6003);

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: vi.fn(() => spawned) };
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeTask({
      cwd: repo,
      task: "Take a look at this patch.",
      mode: "auto",
      background: true,
      diff: "diff --git a/README.md b/README.md",
      files: ["README.md"],
    }, "run-task-auto-review");

    expect(result.delegated_mode).toBe("review");
    expect(result.job?.type).toBe("review");
    expect(result.next_actions.map((action) => action.tool)).toContain("claude_review");
  });
});
