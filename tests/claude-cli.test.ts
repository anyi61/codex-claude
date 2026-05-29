import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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
  inferClaudeTaskMode,
  parseStatusPorcelainZ,
  runClaudeTask,
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
  const sessionStore = new session.SessionStore(path.join(repo, ".codex-claude-delegate"));
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

  it("excludes npx from the default implement security profile", () => {
    const args = buildImplementArgs({ cwd: "/repo", task: "change code" });

    expect(args).not.toContain("Bash(npx *)");
  });

  it("allows npx only in the permissive implement security profile", () => {
    const defaultArgs = buildImplementArgs({ cwd: "/repo", task: "change code", security_profile: "default" });
    const permissiveArgs = buildImplementArgs({ cwd: "/repo", task: "change code", security_profile: "permissive" });
    const strictArgs = buildImplementArgs({ cwd: "/repo", task: "change code", security_profile: "strict" });

    expect(defaultArgs).not.toContain("Bash(npx *)");
    expect(strictArgs).not.toContain("Bash(npx *)");
    expect(permissiveArgs).toContain("Bash(npx *)");
  });

  it("keeps read-only modes from seeing Edit or Write", () => {
    expect(buildQueryArgs({ cwd: "/repo", task: "explain" }).join("\0")).not.toMatch(/\b(Edit|Write)\b/);
    expect(buildReviewArgs({ cwd: "/repo", task: "review" }).join("\0")).not.toMatch(/\b(Edit|Write)\b/);
    expect(buildImplementArgs({ cwd: "/repo", task: "change" }).join("\0")).toMatch(/\b(Edit|Write)\b/);
  });

  it("query args include default sensitive file Read deny patterns", () => {
    const args = buildQueryArgs({ cwd: "/repo", task: "explain" });
    expect(args).toContain("Read(./.env)");
    expect(args).toContain("Read(./.env.*)");
    expect(args).toContain("Read(./secrets/**)");
  });

  it("query args include default sensitive file Bash read-command deny patterns", () => {
    const args = buildQueryArgs({ cwd: "/repo", task: "explain" });
    expect(args).toContain("Bash(cat ./.env)");
    expect(args).toContain("Bash(cat ./.env.*)");
    expect(args).toContain("Bash(cat ./secrets/**)");
    expect(args).toContain("Bash(head ./.env)");
    expect(args).toContain("Bash(tail ./.env.*)");
    expect(args).toContain("Bash(grep * ./.env)");
    expect(args).toContain("Bash(grep * ./secrets/**)");
  });

  it("query args with off policy remove sensitive file denies but keep dangerous bash denies", () => {
    const args = buildQueryArgs({ cwd: "/repo", task: "explain", sensitive_file_policy: "off" });
    expect(args).not.toContain("Read(./.env)");
    expect(args).not.toContain("Bash(cat ./.env)");
    // Dangerous bash denies still present
    expect(args).toContain("Bash(rm *)");
    expect(args).toContain("Bash(sudo *)");
  });

  it("review args include default sensitive file deny patterns", () => {
    const args = buildReviewArgs({ cwd: "/repo", task: "review this" });
    expect(args).toContain("Read(./.env)");
    expect(args).toContain("Read(./.env.*)");
    expect(args).toContain("Read(./secrets/**)");
    expect(args).toContain("Bash(cat ./.env)");
  });

  it("implement args include default sensitive file deny patterns", () => {
    const args = buildImplementArgs({ cwd: "/repo", task: "change code" });
    expect(args).toContain("Read(./.env)");
    expect(args).toContain("Read(./.env.*)");
    expect(args).toContain("Read(./secrets/**)");
    expect(args).toContain("Bash(cat ./.env)");
    expect(args).toContain("Bash(grep * ./.env.*)");
    // Dangerous bash denies still present
    expect(args).toContain("Bash(rm *)");
    expect(args).toContain("Bash(sudo *)");
  });

  it("implement args with strict policy include broader secret store deny patterns", () => {
    const args = buildImplementArgs({ cwd: "/repo", task: "change code", sensitive_file_policy: "strict" });
    expect(args).toContain("Read(./.env)");
    expect(args).toContain("Read(./**/*.pem)");
    expect(args).toContain("Read(./**/*.key)");
    expect(args).toContain("Read(./**/id_rsa*)");
    expect(args).toContain("Read(./**/id_ed25519*)");
    expect(args).toContain("Read(./.aws/**)");
    expect(args).toContain("Read(./.ssh/**)");
    expect(args).toContain("Read(./.gnupg/**)");
    expect(args).toContain("Read(./.netrc)");
    expect(args).toContain("Read(./.npmrc)");
    expect(args).toContain("Read(./credentials*)");
    // Dangerous bash denies still present
    expect(args).toContain("Bash(rm *)");
  });

  it("implement args with off policy remove sensitive file denies but keep dangerous bash denies", () => {
    const args = buildImplementArgs({ cwd: "/repo", task: "change code", sensitive_file_policy: "off" });
    expect(args).not.toContain("Read(./.env)");
    expect(args).not.toContain("Bash(cat ./.env)");
    // Dangerous bash denies still present
    expect(args).toContain("Bash(rm *)");
    expect(args).toContain("Bash(sudo *)");
    expect(args).toContain("Bash(git push --force *)");
    expect(args).toContain("Bash(npm install *)");
  });

  it("builds a lower-turn fast query prompt", () => {
    const args = buildQueryArgs({ cwd: "/repo", task: "explain", fast: true });
    const maxTurnsIndex = args.indexOf("--max-turns");

    expect(args[maxTurnsIndex + 1]).toBe("2");
    expect(args.join("\n")).toContain("Prefer a concise answer");
  });

  it("does not resume old query sessions when resume is explicitly false", async () => {
    const { repo } = await createGitRepoFixture("codex-query-no-resume-");
    const sessionDir = path.join(repo, ".codex-claude-delegate");
    await mkdir(sessionDir, { recursive: true });

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
    process.env.CODEX_CLAUDE_RUN_LOG_DIR = path.join(sessionDir, "runs");
    vi.resetModules();
    const session = await import("../src/session.js");
    const repoKey = await session.computeRepoKey(repo);
    await writeFile(path.join(sessionDir, "sessions.json"), JSON.stringify({
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

    // Session store entry so resolveLatestImplementSession can validate the session
    const sessionDir = path.join(repo, ".codex-claude-delegate");
    await mkdir(sessionDir, { recursive: true });
    const sessionMod = await import("../src/session.js");
    const repoKey = await sessionMod.computeRepoKey(repo);
    await writeFile(path.join(sessionDir, "sessions.json"), JSON.stringify({
      version: 1,
      sessions: [{
        session_id: "sess-latest",
        type: "implement",
        repo_key: repoKey,
        repo_path: repo,
        created_at: new Date().toISOString(),
        last_used: new Date().toISOString(),
        use_count: 1,
        summary: "new",
        expired: false,
      }],
    }, null, 2));

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

  // --- resolveLatestImplementSession with session store filtering ---

  it("resolveLatestImplementSession skips sessions marked expired in store", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-resolve-expired-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo-a");
    const logDir = path.join(root, "runs");
    await mkdir(repo, { recursive: true });
    await mkdir(logDir, { recursive: true });

    // Run log with a session that is expired in store
    await writeFile(path.join(logDir, "implement-expired.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repo },
      report: { status: "success" },
      session: { returned_session_id: "sess-expired" },
    }));

    // Session store: mark as expired
    const sessionDir = path.join(repo, ".codex-claude-delegate");
    await mkdir(sessionDir, { recursive: true });
    const sessionMod = await import("../src/session.js");
    const repoKey = await sessionMod.computeRepoKey(repo);
    await writeFile(path.join(sessionDir, "sessions.json"), JSON.stringify({
      version: 1,
      sessions: [{
        session_id: "sess-expired",
        type: "implement",
        repo_key: repoKey,
        repo_path: repo,
        created_at: new Date().toISOString(),
        last_used: new Date().toISOString(),
        use_count: 1,
        summary: "",
        expired: true,
      }],
    }, null, 2));

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const resolved = await reloaded.resolveLatestImplementSession({ cwd: repo });
    expect(resolved).toBeNull();

    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("resolveLatestImplementSession skips stale sessions older than RECENT_WINDOW_MINUTES", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-resolve-stale-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo-a");
    const logDir = path.join(root, "runs");
    await mkdir(repo, { recursive: true });
    await mkdir(logDir, { recursive: true });

    const staleDate = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    await writeFile(path.join(logDir, "implement-stale.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repo },
      report: { status: "success" },
      session: { returned_session_id: "sess-stale" },
    }));

    const sessionDir = path.join(repo, ".codex-claude-delegate");
    await mkdir(sessionDir, { recursive: true });
    const sessionMod = await import("../src/session.js");
    const repoKey = await sessionMod.computeRepoKey(repo);
    await writeFile(path.join(sessionDir, "sessions.json"), JSON.stringify({
      version: 1,
      sessions: [{
        session_id: "sess-stale",
        type: "implement",
        repo_key: repoKey,
        repo_path: repo,
        created_at: staleDate,
        last_used: staleDate,
        use_count: 1,
        summary: "",
        expired: false,
      }],
    }, null, 2));

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const resolved = await reloaded.resolveLatestImplementSession({ cwd: repo });
    expect(resolved).toBeNull();

    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("resolveLatestImplementSession returns recent valid session with store filtering", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-resolve-recent-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo-a");
    const logDir = path.join(root, "runs");
    await mkdir(repo, { recursive: true });
    await mkdir(logDir, { recursive: true });

    await writeFile(path.join(logDir, "implement-recent.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repo },
      report: { status: "success" },
      session: { returned_session_id: "sess-recent" },
    }));

    const sessionDir = path.join(repo, ".codex-claude-delegate");
    await mkdir(sessionDir, { recursive: true });
    const sessionMod = await import("../src/session.js");
    const repoKey = await sessionMod.computeRepoKey(repo);
    await writeFile(path.join(sessionDir, "sessions.json"), JSON.stringify({
      version: 1,
      sessions: [{
        session_id: "sess-recent",
        type: "implement",
        repo_key: repoKey,
        repo_path: repo,
        created_at: new Date().toISOString(),
        last_used: new Date().toISOString(),
        use_count: 1,
        summary: "recent work",
        expired: false,
      }],
    }, null, 2));

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const resolved = await reloaded.resolveLatestImplementSession({ cwd: repo });
    expect(resolved?.run_id).toBe("implement-recent");
    expect(resolved?.session_id).toBe("sess-recent");

    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  // --- SEC-009: bounded fresh retry on session-not-found ---

  it("session-not-found fallback: fresh retry succeeds with warning", async () => {
    const { repo, logDir, stateDir } = await createGitRepoFixture("codex-impl-fallback-");

    // Set up session store so resolveLatestImplementSession can find the session
    const sessionDir = path.join(repo, ".codex-claude-delegate");
    await mkdir(sessionDir, { recursive: true });
    const sessionMod = await import("../src/session.js");
    const repoKey = await sessionMod.computeRepoKey(repo);
    await writeFile(path.join(sessionDir, "sessions.json"), JSON.stringify({
      version: 1,
      sessions: [{
        session_id: "sess-resume",
        type: "implement",
        repo_key: repoKey,
        repo_path: repo,
        created_at: new Date().toISOString(),
        last_used: new Date().toISOString(),
        use_count: 1,
        summary: "Previous work",
        expired: false,
      }],
    }, null, 2));

    // Run log for resume_latest to discover the session_id
    await writeFile(path.join(logDir, "run-prev.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repo },
      report: { status: "success", summary: "Previous implementation" },
      session: { returned_session_id: "sess-resume" },
    }));

    let spawnCallCount = 0;
    const capturedClaudeArgs: string[][] = [];

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        spawn: vi.fn((bin: string, args: string[], options: Record<string, unknown>) => {
          if (bin !== "claude") return actual.spawn(bin, args, options);
          spawnCallCount++;
          capturedClaudeArgs.push([...args]);
          if (spawnCallCount === 1) {
            return createClaudeSpawnResult("", "No conversation found with session ID: sess-resume\n", 1);
          }
          const stdout = JSON.stringify({
            session_id: "sess-fresh",
            structured_output: {
              status: "success",
              summary: "Fresh implement succeeded",
              changed_files: ["README.md"],
              commands_run: ["git status"],
              tests: { ran: false },
              risks: [],
              next_steps: [],
            },
          });
          return createClaudeSpawnResult(stdout, "", 0);
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
      worktreeName: "codex-delegated-fallback",
      max_turns: 2,
      dirty_policy: "committed",
    }, "run-fallback-ok");

    expect(result.status).not.toBe("failed");
    expect(spawnCallCount).toBe(2);

    // First call: should include -r flag with session id
    expect(capturedClaudeArgs[0]).toContain("-r");
    expect(capturedClaudeArgs[0]).toContain("sess-resume");

    // Second call (fresh retry): should NOT include -r flag
    expect(capturedClaudeArgs[1]).not.toContain("-r");

    // Result warnings should mention fallback / resume_latest
    expect(result.warnings.some(
      (w: string) => /session.*unavailable|fell back|resume.*fail/i.test(w)
    )).toBe(true);

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("session-not-found fallback: does not create a second worktree", async () => {
    const { repo, logDir, stateDir } = await createGitRepoFixture("codex-impl-fallback-wt-");

    const sessionDir = path.join(repo, ".codex-claude-delegate");
    await mkdir(sessionDir, { recursive: true });
    const sessionMod = await import("../src/session.js");
    const repoKey = await sessionMod.computeRepoKey(repo);
    await writeFile(path.join(sessionDir, "sessions.json"), JSON.stringify({
      version: 1,
      sessions: [{
        session_id: "sess-resume-wt",
        type: "implement",
        repo_key: repoKey,
        repo_path: repo,
        created_at: new Date().toISOString(),
        last_used: new Date().toISOString(),
        use_count: 1,
        summary: "Previous work",
        expired: false,
      }],
    }, null, 2));

    await writeFile(path.join(logDir, "run-prev-wt.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repo },
      report: { status: "success", summary: "Previous" },
      session: { returned_session_id: "sess-resume-wt" },
    }));

    let claudeSpawnCount = 0;

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        spawn: vi.fn((bin: string, args: string[], options: Record<string, unknown>) => {
          if (bin !== "claude") return actual.spawn(bin, args, options);
          claudeSpawnCount++;
          if (claudeSpawnCount === 1) {
            return createClaudeSpawnResult("", "No conversation found with session ID: sess-resume-wt\n", 1);
          }
          const stdout = JSON.stringify({
            session_id: "sess-fresh-wt",
            structured_output: {
              status: "success",
              summary: "Fresh retry ok",
              changed_files: ["README.md"],
              commands_run: [],
              tests: { ran: false },
              risks: [],
              next_steps: [],
            },
          });
          return createClaudeSpawnResult(stdout, "", 0);
        }),
      };
    });

    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");

    const wtName = "codex-delegated-fallback-wt";
    const result = await reloaded.runClaudeImplement({
      cwd: repo,
      task: "Continue.",
      resume_latest: true,
      worktreeName: wtName,
      max_turns: 2,
      dirty_policy: "committed",
    }, "run-fallback-wt");

    expect(result.status).not.toBe("failed");
    expect(claudeSpawnCount).toBe(2);

    // Only the single worktree should exist — no second worktree
    const worktreePath = path.join(repo, ".claude", "worktrees", wtName);
    expect(existsSync(worktreePath)).toBe(true);
    // Verify that only one codex-delegated worktree was created
    const wtDir = path.join(repo, ".claude", "worktrees");
    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(wtDir).filter((d) => d.startsWith("codex-delegated-"));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toBe(wtName);

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("session-not-found fallback: fresh retry fails without second retry", async () => {
    const { repo, logDir, stateDir } = await createGitRepoFixture("codex-impl-fallback-fail-");

    const sessionDir = path.join(repo, ".codex-claude-delegate");
    await mkdir(sessionDir, { recursive: true });
    const sessionMod = await import("../src/session.js");
    const repoKey = await sessionMod.computeRepoKey(repo);
    await writeFile(path.join(sessionDir, "sessions.json"), JSON.stringify({
      version: 1,
      sessions: [{
        session_id: "sess-double-fail",
        type: "implement",
        repo_key: repoKey,
        repo_path: repo,
        created_at: new Date().toISOString(),
        last_used: new Date().toISOString(),
        use_count: 1,
        summary: "Previous work",
        expired: false,
      }],
    }, null, 2));

    await writeFile(path.join(logDir, "run-prev-df.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repo },
      report: { status: "success", summary: "Previous" },
      session: { returned_session_id: "sess-double-fail" },
    }));

    let claudeSpawnCount = 0;

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        spawn: vi.fn((bin: string, args: string[], options: Record<string, unknown>) => {
          if (bin !== "claude") return actual.spawn(bin, args, options);
          claudeSpawnCount++;
          // Both calls fail with session not found
          return createClaudeSpawnResult("", "No conversation found with session ID: sess-double-fail\n", 1);
        }),
      };
    });

    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");

    const result = await reloaded.runClaudeImplement({
      cwd: repo,
      task: "Continue.",
      resume_latest: true,
      worktreeName: "codex-delegated-double-fail",
      max_turns: 2,
      dirty_policy: "committed",
    }, "run-double-fail");

    // Should NOT have retried more than once
    expect(claudeSpawnCount).toBe(2);
    expect(result.status).toBe("failed");

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("non-session-not-found error does not trigger fallback", async () => {
    const { repo, logDir, stateDir } = await createGitRepoFixture("codex-impl-no-fallback-");

    const sessionDir = path.join(repo, ".codex-claude-delegate");
    await mkdir(sessionDir, { recursive: true });
    const sessionMod = await import("../src/session.js");
    const repoKey = await sessionMod.computeRepoKey(repo);
    await writeFile(path.join(sessionDir, "sessions.json"), JSON.stringify({
      version: 1,
      sessions: [{
        session_id: "sess-other-err",
        type: "implement",
        repo_key: repoKey,
        repo_path: repo,
        created_at: new Date().toISOString(),
        last_used: new Date().toISOString(),
        use_count: 1,
        summary: "Previous work",
        expired: false,
      }],
    }, null, 2));

    await writeFile(path.join(logDir, "run-prev-other.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repo },
      report: { status: "success", summary: "Previous" },
      session: { returned_session_id: "sess-other-err" },
    }));

    let claudeSpawnCount = 0;

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        spawn: vi.fn((bin: string, args: string[], options: Record<string, unknown>) => {
          if (bin !== "claude") return actual.spawn(bin, args, options);
          claudeSpawnCount++;
          // Non session-not-found error: timeout / network issue
          return createClaudeSpawnResult("", "Connection timed out\n", 1);
        }),
      };
    });

    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");

    await expect(
      reloaded.runClaudeImplement({
        cwd: repo,
        task: "Continue.",
        resume_latest: true,
        worktreeName: "codex-delegated-no-fb",
        max_turns: 2,
        dirty_policy: "committed",
      }, "run-no-fallback")
    ).rejects.toThrow();

    // Only one spawn call — no fallback retry
    expect(claudeSpawnCount).toBe(1);

    vi.doUnmock("node:child_process");
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
    expect(preview.preview_token).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(path.join(repo, "README.md"), "utf8")).toBe("# main\n");
    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("refuses non-preview apply without explicit user approval", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-approval-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    const logDir = path.join(stateDir, "runs");
    await mkdir(logDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");
    await writeFile(path.join(repo, "README.md"), "# original\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");

    const worktreeRel = ".claude/worktrees/codex-delegated-approval";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");
    await writeFile(path.join(worktree, "README.md"), "# changed\n");

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    await writeFile(path.join(logDir, "approval-run.json"), JSON.stringify({
      type: "implement",
      observed: {
        worktree_path: worktreeRel,
        base_commit: baseCommit,
        changed_files: ["README.md"],
      },
    }, null, 2));

    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
    }, "apply-without-approval");

    expect(result.error).toContain("confirmed_by_user=true");
    expect(result.applied_files).toEqual([]);
    expect(await readFile(path.join(repo, "README.md"), "utf8")).toBe("# original\n");
  });

  it("refuses apply while the same delegated worktree is locked", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-locked-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    const logDir = path.join(stateDir, "runs");
    await mkdir(logDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");
    await writeFile(path.join(repo, "README.md"), "# original\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");

    const worktreeRel = ".claude/worktrees/codex-delegated-locked";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;
    vi.resetModules();
    const [{ acquireFileLock }, reloaded] = await Promise.all([
      import("../src/lock.js"),
      import("../src/claude-cli.js"),
    ]);
    const lock = await acquireFileLock({ cwd: repo, resource: `worktree:${path.basename(worktreeRel)}` });

    const result = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      preview: true,
    }, "apply-locked");

    expect(result.error).toContain("(implement/apply/cleanup)");
    expect(result.error).toContain("codex-delegated-locked");
    await lock.release();
  });

  it("refuses non-preview apply with confirmed_by_user=false", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-approval-false-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    const logDir = path.join(stateDir, "runs");
    await mkdir(logDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");
    await writeFile(path.join(repo, "README.md"), "# original\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");
    const worktreeRel = ".claude/worktrees/codex-delegated-approval-false";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");
    await writeFile(path.join(worktree, "README.md"), "# changed\n");
    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    await writeFile(path.join(logDir, "approval-false-run.json"), JSON.stringify({
      type: "implement",
      observed: {
        worktree_path: worktreeRel,
        base_commit: baseCommit,
        changed_files: ["README.md"],
      },
    }, null, 2));
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const explicitFalse = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      confirmed_by_user: false,
    }, "apply-with-false-approval");
    expect(explicitFalse.error).toContain("confirmed_by_user=true");
    expect(explicitFalse.applied_files).toEqual([]);
  });

  it("does not treat claude_task instruction files as apply scope", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-instruction-files-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const logDir = path.join(root, "runs");
    await mkdir(repo, { recursive: true });
    await mkdir(logDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");
    await writeFile(path.join(repo, "PROJECT_EXPANSION_PLAN.md"), "# plan\n");
    await writeFile(path.join(repo, "README.md"), "# main\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");
    const worktreeRel = ".claude/worktrees/codex-delegated-instruction-files";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    await mkdir(path.join(worktree, "src"), { recursive: true });
    await mkdir(path.join(worktree, "tests"), { recursive: true });
    await writeFile(path.join(worktree, "src", "arrays.js"), "export const unique = (items) => [...new Set(items)];\n");
    await writeFile(path.join(worktree, "tests", "arrays.test.js"), "import '../src/arrays.js';\n");
    await writeFile(path.join(worktree, "README.md"), "# main\n\nArray utilities.\n");
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");
    await writeFile(path.join(logDir, "implement-instruction-files.json"), JSON.stringify({
      type: "implement",
      input: {
        cwd: repo,
        task: "Execute PROJECT_EXPANSION_PLAN.md",
        instruction_files: ["PROJECT_EXPANSION_PLAN.md"],
      },
      report: { status: "success", summary: "Implemented plan" },
      observed: {
        worktree_path: worktreeRel,
        worktree_name: "codex-delegated-instruction-files",
        base_commit: baseCommit,
        changed_files: ["README.md", "src/arrays.js", "tests/arrays.test.js"],
        scope: { requested_files: undefined, out_of_scope_files: [], scope_exceeded: false, warnings: [] },
        resource_limits: { actual_changed_files: 3, changed_files_exceeded: false, warnings: [] },
      },
    }));

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const preview = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      preview: true,
    }, "preview-instruction-files");

    expect(preview.preview_token).toMatch(/^[a-f0-9]{64}$/);

    const applied = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      confirmed_by_user: true,
      preview_token: preview.preview_token,
    }, "apply-instruction-files");

    expect(applied.error).toBeUndefined();
    expect(applied.conflicts).toEqual([]);
    expect(applied.applied_files.sort()).toEqual(["README.md", "src/arrays.js", "tests/arrays.test.js"].sort());
    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("still refuses apply when an advanced implement run explicitly records scope violations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-explicit-scope-"));
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
    const worktreeRel = ".claude/worktrees/codex-delegated-explicit-scope";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    await mkdir(path.join(worktree, "src"), { recursive: true });
    await writeFile(path.join(worktree, "src", "arrays.js"), "export const unique = (items) => [...new Set(items)];\n");
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");
    await writeFile(path.join(logDir, "implement-explicit-scope.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repo, task: "Only change README.", files: ["README.md"] },
      report: { status: "success", summary: "Changed src instead" },
      observed: {
        worktree_path: worktreeRel,
        worktree_name: "codex-delegated-explicit-scope",
        base_commit: baseCommit,
        changed_files: ["src/arrays.js"],
        scope: {
          requested_files: ["README.md"],
          out_of_scope_files: ["src/arrays.js"],
          scope_exceeded: true,
          warnings: ["Changed src/arrays.js outside requested files: README.md"],
        },
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
    }, "preview-explicit-scope");

    const applied = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      confirmed_by_user: true,
    }, "apply-explicit-scope");

    expect(applied.error).toBe("Worktree contains changes outside requested files; apply refused");
    expect(applied.conflicts).toEqual(["Changed src/arrays.js outside requested files: README.md"]);
    expect(applied.applied_files).toEqual([]);
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
    const preview = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      preview: true,
    }, "preview-lifecycle-run");
    const applied = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      confirmed_by_user: true,
      preview_token: preview.preview_token,
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

  it("refuses cleanup while the workspace cleanup lock is held", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cleanup-locked-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    await mkdir(path.join(repo, ".claude", "worktrees", "codex-delegated-cleanup-locked"), { recursive: true });
    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;
    vi.resetModules();
    const [{ acquireFileLock }, reloaded] = await Promise.all([
      import("../src/lock.js"),
      import("../src/claude-cli.js"),
    ]);
    const lock = await acquireFileLock({ cwd: repo, resource: "workspace:cleanup" });

    const result = await reloaded.runClaudeCleanup({
      cwd: repo,
      dry_run: false,
      older_than_hours: 0,
    }, "cleanup-locked");

    expect(result.failed_count).toBe(1);
    expect(result.entries[0]?.error).toContain("Another cleanup operation is already running");
    await lock.release();
  });

  it("skips cleanup for a worktree with an active implement job and returns active_job_id", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cleanup-active-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    const jobsDir = path.join(stateDir, "jobs");
    await mkdir(repo, { recursive: true });
    await mkdir(jobsDir, { recursive: true });
    await mkdir(path.join(repo, ".claude", "worktrees", "codex-delegated-activejob"), { recursive: true });

    // Create a running implement job referencing this worktree
    const now = new Date().toISOString();
    await writeFile(path.join(jobsDir, "job-active-impl.json"), JSON.stringify({
      job_id: "job-active-impl",
      type: "implement",
      status: "running",
      cwd: repo,
      worktree_name: "codex-delegated-activejob",
      created_at: now,
      updated_at: now,
      payload: { cwd: repo, task: "implement feature" },
    }));

    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeCleanup({
      cwd: repo,
      dry_run: false,
      older_than_hours: 0,
    }, "cleanup-active");

    expect(result.removed_count).toBe(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.worktree_name).toBe("codex-delegated-activejob");
    expect(result.entries[0]?.removed).toBe(false);
    expect(result.entries[0]?.active_job_id).toBe("job-active-impl");
    expect(result.entries[0]?.safe_to_remove).toBe(false);
    expect(result.entries[0]?.error).toContain("active implement job");
  });

  it("cleanup dry_run returns active_job_id for worktree with active implement job", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cleanup-dryrun-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    const jobsDir = path.join(stateDir, "jobs");
    await mkdir(repo, { recursive: true });
    await mkdir(jobsDir, { recursive: true });
    await mkdir(path.join(repo, ".claude", "worktrees", "codex-delegated-dryrun-wt"), { recursive: true });

    const now = new Date().toISOString();
    await writeFile(path.join(jobsDir, "job-queued-impl.json"), JSON.stringify({
      job_id: "job-queued-impl",
      type: "implement",
      status: "queued",
      cwd: repo,
      worktree_name: "codex-delegated-dryrun-wt",
      created_at: now,
      updated_at: now,
      payload: { cwd: repo, task: "implement feature" },
    }));

    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeCleanup({
      cwd: repo,
      dry_run: true,
      older_than_hours: 0,
    }, "cleanup-dryrun");

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.active_job_id).toBe("job-queued-impl");
    expect(result.entries[0]?.safe_to_remove).toBe(false);
  });

  it("cleanup can remove a worktree whose implement job has succeeded", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cleanup-success-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    const jobsDir = path.join(stateDir, "jobs");
    await mkdir(repo, { recursive: true });
    await mkdir(jobsDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");
    await writeFile(path.join(repo, "README.md"), "# test\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");

    const worktreeRel = ".claude/worktrees/codex-delegated-succeeded";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");

    const now = new Date().toISOString();
    await writeFile(path.join(jobsDir, "job-succeeded-impl.json"), JSON.stringify({
      job_id: "job-succeeded-impl",
      type: "implement",
      status: "succeeded",
      cwd: repo,
      worktree_name: "codex-delegated-succeeded",
      created_at: now,
      updated_at: now,
      run_id: "run-succeeded-impl",
      payload: { cwd: repo, task: "implement feature" },
    }));

    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeCleanup({
      cwd: repo,
      dry_run: true,
      older_than_hours: 0,
    }, "cleanup-succeeded-dry");

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.safe_to_remove).toBe(true);
    expect(result.entries[0]?.active_job_id).toBeUndefined();

    // Actual removal
    const actualResult = await reloaded.runClaudeCleanup({
      cwd: repo,
      dry_run: false,
      older_than_hours: 0,
    }, "cleanup-succeeded");

    expect(actualResult.removed_count).toBe(1);
    expect(actualResult.entries[0]?.removed).toBe(true);
  });

  it("cleanup with active job and older_than_hours > 0 returns active_job_id, not skipped within time window", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cleanup-active-age-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    const jobsDir = path.join(stateDir, "jobs");
    await mkdir(repo, { recursive: true });
    await mkdir(jobsDir, { recursive: true });
    const wtPath = path.join(repo, ".claude", "worktrees", "codex-delegated-active-age");
    await mkdir(wtPath, { recursive: true });
    // Set directory mtime to now so it would be "within time window" if age
    // check ran before the active-job check.
    const now = new Date();
    await utimes(wtPath, now, now);

    const nowIso = now.toISOString();
    await writeFile(path.join(jobsDir, "job-active-age.json"), JSON.stringify({
      job_id: "job-active-age",
      type: "implement",
      status: "running",
      cwd: repo,
      worktree_name: "codex-delegated-active-age",
      created_at: nowIso,
      updated_at: nowIso,
      payload: { cwd: repo, task: "implement feature" },
    }));

    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeCleanup({
      cwd: repo,
      dry_run: false,
      older_than_hours: 24,
    }, "cleanup-active-age");

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.worktree_name).toBe("codex-delegated-active-age");
    expect(result.entries[0]?.removed).toBe(false);
    expect(result.entries[0]?.active_job_id).toBe("job-active-age");
    expect(result.entries[0]?.safe_to_remove).toBe(false);
    expect(result.entries[0]?.error).toContain("active implement job");
    expect(result.entries[0]?.error).not.toContain("within time window");
  });

  it("apply is blocked when another holder has the worktree lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-locked-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    await mkdir(repo, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");
    await writeFile(path.join(repo, "README.md"), "# test\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");

    const worktreeRel = ".claude/worktrees/codex-delegated-locked";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktreePath = path.join(repo, worktreeRel);
    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;

    const [{ acquireFileLock }, reloaded] = await Promise.all([
      import("../src/lock.js"),
      import("../src/claude-cli.js"),
    ]);
    const lock = await acquireFileLock({ cwd: repo, resource: "worktree:codex-delegated-locked" });

    const result = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreePath,
    }, "apply-locked");

    expect(result.error).toContain("already using");

    await lock.release();
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
    const preview = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      preview: true,
    }, "preview-apply-directory");
    const applied = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      confirmed_by_user: true,
      preview_token: preview.preview_token,
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
        expect.stringContaining("committed"),
        expect.stringContaining("snapshot"),
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

    // Session store entry so resolveLatestImplementSession can find it
    const sessionDir = path.join(repo, ".codex-claude-delegate");
    await mkdir(sessionDir, { recursive: true });
    const sessionMod = await import("../src/session.js");
    const repoKey = await sessionMod.computeRepoKey(repo);
    await writeFile(path.join(sessionDir, "sessions.json"), JSON.stringify({
      version: 1,
      sessions: [{
        session_id: "sess-missing",
        type: "implement",
        repo_key: repoKey,
        repo_path: repo,
        created_at: new Date().toISOString(),
        last_used: new Date().toISOString(),
        use_count: 1,
        summary: "Previous implementation",
        expired: false,
      }],
    }, null, 2));

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

  it("marks a background job failed when the detached runner exits during launch", async () => {
    const { repo, stateDir } = await createJobFixture();
    const spawned = createDetachedSpawnResult(8765);
    const spawnMock = vi.fn(() => {
      setImmediate(() => spawned.emit("exit", 1, null));
      return spawned;
    });

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

    expect(created.job.status).toBe("failed");
    expect(created.job.pid).toBe(8765);
    expect(created.job.error).toContain("exited during startup");
    expect(created.do_not_start_duplicate_job).toBe(false);

    const jobs = await import("../src/jobs.js");
    const store = new jobs.JobStore(stateDir);
    const persisted = await store.get(created.job.job_id);
    expect(persisted).toMatchObject({
      status: "failed",
      pid: 8765,
      error: expect.stringContaining("exited during startup"),
    });

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
      }) => Promise<{ job: { status: string; result_status?: string; summary?: string }; summary: string; waiting: boolean; timed_out: boolean; result?: Record<string, unknown> }>;
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

  it("marks background job failed when persisted payload fails schema validation", async () => {
    const { repo, stateDir } = await createGitRepoFixture("codex-bg-invalid-payload-");
    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;

    const spawnMock = vi.fn();
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: spawnMock };
    });

    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const jobs = await import("../src/jobs.js");
    const store = new jobs.JobStore(stateDir);
    await store.init();
    await store.create({
      job_id: "job-invalid-query-payload",
      status: "queued",
      cwd: repo,
      type: "query",
      created_at: "2026-05-05T00:00:00.000Z",
      updated_at: "2026-05-05T00:00:00.000Z",
      payload: { cwd: repo },
    });

    await expect(reloaded.executeBackgroundJob("job-invalid-query-payload")).rejects.toThrow(/payload|schema|validation/i);
    const record = await store.get("job-invalid-query-payload");
    expect(record?.status).toBe("failed");
    expect(record?.error).toMatch(/payload|schema|validation/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("accepts implement background payload with instruction_files during schema validation", async () => {
    const { repo, stateDir } = await createGitRepoFixture("codex-bg-implement-instruction-files-");
    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;
    const stdout = JSON.stringify({
      session_id: "sess-bg-impl-instruction",
      structured_output: {
        status: "success",
        summary: "Implemented with instruction files.",
      },
    });

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        spawn: vi.fn((bin: string, args: string[], options: { cwd?: string }) => {
          if (bin !== "claude") return actual.spawn(bin, args, options as never);
          writeFileSync(path.join(options.cwd!, "README.md"), "# implemented with instructions\n");
          return createClaudeSpawnResult(stdout, "", 0);
        }),
      };
    });

    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const jobs = await import("../src/jobs.js");
    const store = new jobs.JobStore(stateDir);
    await store.init();
    await store.create({
      job_id: "job-implement-with-instruction-files",
      status: "queued",
      cwd: repo,
      type: "implement",
      created_at: "2026-05-05T00:00:00.000Z",
      updated_at: "2026-05-05T00:00:00.000Z",
      payload: {
        cwd: repo,
        task: "Update README with architecture notes.",
        instruction_files: ["PROJECT_EXPANSION_PLAN.md"],
        worktreeName: "codex-delegated-instruction-files",
      },
    });

    await reloaded.executeBackgroundJob("job-implement-with-instruction-files");
    const result = await reloaded.getBackgroundJobResult({ cwd: repo, job_id: "job-implement-with-instruction-files" });

    expect(result?.job.status).toBe("succeeded");
    expect(result?.job.error).toBeUndefined();
    expect(result?.result?.status).toBe("success");
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

  it("dry-runs run log cleanup without selecting active job logs", async () => {
    const { repo, logDir, jobStore } = await createWorkflowFixture();
    await writeFile(path.join(logDir, "active-run.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repo },
    }));
    await writeFile(path.join(logDir, "old-run.json"), JSON.stringify({
      type: "review",
      input: { cwd: repo },
    }));
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(path.join(logDir, "active-run.json"), old, old);
    await utimes(path.join(logDir, "old-run.json"), old, old);
    await jobStore.create({
      job_id: "job-active",
      type: "implement",
      status: "running",
      cwd: repo,
      created_at: old.toISOString(),
      updated_at: old.toISOString(),
      run_id: "active-run",
      payload: { cwd: repo, task: "still running" },
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.cleanupDelegateArtifacts({
      cwd: repo,
      older_than_hours: 24,
      dry_run: true,
      limit: 20,
    });

    expect(result.run_logs.entries.map((entry) => entry.run_id)).toEqual(["old-run"]);
    expect(result.run_logs.entries[0]?.removed).toBe(false);
    expect(existsSync(path.join(logDir, "active-run.json"))).toBe(true);
    expect(existsSync(path.join(logDir, "old-run.json"))).toBe(true);
  });


  it("returns a waiting status while a background job stays running", async () => {
    const { repo, store } = await createJobFixture();
    const now = new Date().toISOString();

    await store.create({
      job_id: "job-running",
      type: "implement",
      status: "running",
      cwd: repo,
      created_at: now,
      updated_at: now,
      heartbeat_at: now,
      payload: { cwd: repo, task: "ship it" },
    });

    const reloaded = await import("../src/claude-cli.js");
    reloaded.__test.inlineWaitPollIntervalMs = 5;
    reloaded.__test.inlineWaitTimeoutMs = 50;
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
      job: {
        job_id: "job-running",
        status: "running",
      },
    });
    expect((result as { next_actions?: Array<{ tool: string }> }).next_actions?.map((action) => action.tool)).toEqual([
      "claude_task",
    ]);
  });

  it("returns a waiting status while a background job stays queued", async () => {
    const { repo, store } = await createJobFixture();
    const now = new Date().toISOString();

    await store.create({
      job_id: "job-queued",
      type: "review",
      status: "queued",
      cwd: repo,
      created_at: now,
      updated_at: now,
      heartbeat_at: now,
      payload: { cwd: repo, task: "review it" },
    });

    const reloaded = await import("../src/claude-cli.js");
    reloaded.__test.inlineWaitPollIntervalMs = 5;
    reloaded.__test.inlineWaitTimeoutMs = 50;
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
    await sessionStore.upsert("sess-impl", "implement", repoKey, repo, "Changed README");

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.getClaudeResult({ cwd: repo, job_id: "job-implement" });

    expect(result.source_type).toBe("job");
    expect(result.summary).toBe("Implement job completed");
    expect(result.job?.job_id).toBe("job-implement");
    expect(result.run?.run_id).toBe("run-implement");
    expect(result.session?.session_id).toBe("sess-impl");
    expect(result.session?.source).toBe("run");
    const applyActions = result.next_actions.filter(
      (a: { tool: string }) => a.tool === "claude_apply"
    );
    expect(applyActions).toHaveLength(1);
    expect(applyActions[0]).toMatchObject({
      tool: "claude_apply",
      reason: expect.stringContaining("ask the user for explicit approval"),
      args: { cwd: repo, worktree_path: ".claude/worktrees/codex-delegated-123", preview: true },
    });
    expect(result.next_actions.map((action) => action.tool)).toEqual(
      ["claude_apply"]
    );
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
    await sessionStore.upsert("sess-new", "implement", repoKey, repo, "Newest implement");

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.getClaudeResult({ cwd: repo, prefer: "latest-implement" });

    expect(result.run?.type).toBe("implement");
    expect(result.source_type === "job" || result.source_type === "run").toBe(true);
    if (result.job) {
      expect(result.job.job_id).toBe("job-implement-new");
    }
    const applyActions = result.next_actions.filter(
      (a: { tool: string }) => a.tool === "claude_apply"
    );
    expect(applyActions).toHaveLength(1);
    expect(applyActions[0]?.args?.preview).toBe(true);
    expect(result.next_actions.map((action) => action.tool)).toEqual(
      ["claude_apply"]
    );
  });

  it("does not return session or resume_latest action when run references a session the store does not have, even if store has other sessions", async () => {
    const { repo, logDir, sessionStore, repoKey } = await createWorkflowFixture();

    // Write a run log that references sess-missing, which is NOT in the session store
    await writeFile(path.join(logDir, "run-impl-phantom.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repo },
      report: { status: "partial", summary: "Partial with phantom session" },
      observed: {
        worktree_path: ".claude/worktrees/codex-delegated-phantom",
        worktree_name: "codex-delegated-phantom",
        changed_files: ["src/x.ts"],
      },
      session: { returned_session_id: "sess-missing" },
    }));

    // Put an unrelated session in the store to verify fallback does NOT happen
    await sessionStore.upsert("sess-other", "implement", repoKey, repo, "Some other session");

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.getClaudeResult({ cwd: repo, run_id: "run-impl-phantom" });

    // Session store has no entry for sess-missing, so no session summary should be fabricated
    expect(result.session).toBeUndefined();

    // No resume_latest action should be generated
    const resumeActions = result.next_actions.filter(
      (a: { tool: string; args?: Record<string, unknown> }) =>
        a.tool === "claude_task" && a.args?.resume_latest === true
    );
    expect(resumeActions).toHaveLength(0);
  });

  it("does not generate resume_latest action when run has no session field even if session store has a recent implement session", async () => {
    const { repo, logDir, sessionStore, repoKey } = await createWorkflowFixture();

    await writeFile(path.join(logDir, "run-no-session.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repo },
      report: { status: "partial", summary: "Partial, no session in run log" },
      observed: {
        worktree_path: ".claude/worktrees/codex-delegated-nosess",
        worktree_name: "codex-delegated-nosess",
        changed_files: ["src/bar.ts"],
      },
    }));

    // Add a recent implement session to the store — must NOT be used as fallback
    await sessionStore.upsert("sess-recent", "implement", repoKey, repo, "Recent unrelated session");

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.getClaudeResult({ cwd: repo, run_id: "run-no-session" });

    // The run has no session field, so session should be undefined
    expect(result.session).toBeUndefined();

    // No resume_latest action should be generated despite the store having a session
    const resumeActions = result.next_actions.filter(
      (a: { tool: string; args?: Record<string, unknown> }) =>
        a.tool === "claude_task" && a.args?.resume_latest === true
    );
    expect(resumeActions).toHaveLength(0);
  });

  it("does not use query session as implement resume action", async () => {
    const { repo, logDir, sessionStore, repoKey } = await createWorkflowFixture();

    await writeFile(path.join(logDir, "run-implement-no-session-query-store.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repo },
      report: { status: "partial", summary: "Partial implement without returned session" },
      observed: {
        worktree_path: ".claude/worktrees/codex-delegated-query-store",
        worktree_name: "codex-delegated-query-store",
        changed_files: ["src/query-store.ts"],
      },
    }));
    await sessionStore.upsert("sess-query-only", "query", repoKey, repo, "Recent query session");

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.getClaudeResult({ cwd: repo, run_id: "run-implement-no-session-query-store" });

    expect(result.session).toBeUndefined();
    expect(result.next_actions.filter(
      (action: { tool: string; args?: Record<string, unknown> }) =>
        action.tool === "claude_task" && action.args?.resume_latest === true
    )).toHaveLength(0);
  });

  it("does not resume an implement session from another repository", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-cross-repo-resume-"));
    cleanupPaths.push(root);
    const repoA = path.join(root, "repo-a");
    const repoB = path.join(root, "repo-b");
    const logDir = path.join(root, "runs");
    await mkdir(repoA, { recursive: true });
    await mkdir(repoB, { recursive: true });
    await mkdir(logDir, { recursive: true });

    // Session store for repoA so resolveLatestImplementSession can validate
    const sessionDirA = path.join(repoA, ".codex-claude-delegate");
    await mkdir(sessionDirA, { recursive: true });
    const sessionMod = await import("../src/session.js");
    const repoKeyA = await sessionMod.computeRepoKey(repoA);
    await writeFile(path.join(sessionDirA, "sessions.json"), JSON.stringify({
      version: 1,
      sessions: [{
        session_id: "sess-repo-a",
        type: "implement",
        repo_key: repoKeyA,
        repo_path: repoA,
        created_at: new Date().toISOString(),
        last_used: new Date().toISOString(),
        use_count: 1,
        summary: "Repo A partial",
        expired: false,
      }],
    }, null, 2));

    await writeFile(path.join(logDir, "run-repo-a.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repoA },
      report: { status: "partial", summary: "Repo A partial" },
      observed: {
        worktree_path: ".claude/worktrees/codex-delegated-a",
        worktree_name: "codex-delegated-a",
        changed_files: ["src/a.ts"],
      },
      session: { returned_session_id: "sess-repo-a" },
    }));

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");

    expect(await reloaded.resolveLatestImplementSession({ cwd: repoA })).toMatchObject({
      run_id: "run-repo-a",
      session_id: "sess-repo-a",
    });
    await expect(reloaded.resolveLatestImplementSession({ cwd: repoB })).resolves.toBeNull();

    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("runClaudeImplement resume_latest fails fast when no local implement session exists", async () => {
    const { repo } = await createWorkflowFixture();
    const reloaded = await import("../src/claude-cli.js");

    await expect(reloaded.runClaudeImplement({
      cwd: repo,
      task: "Continue previous implementation.",
      resume_latest: true,
      dirty_policy: "committed",
    }, "run-resume-missing-local")).rejects.toThrow(
      "No resumable implement session found for this repository."
    );
  });

  it("returns claude_apply preview and claude_task resume action for partial implement run with store-verified session and non-empty changed_files", async () => {
    const { repo, logDir, sessionStore, repoKey } = await createWorkflowFixture();

    await writeFile(path.join(logDir, "run-partial-resumable.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repo },
      report: { status: "partial", summary: "Partial implement with changes" },
      observed: {
        worktree_path: ".claude/worktrees/codex-delegated-partial-resume",
        worktree_name: "codex-delegated-partial-resume",
        changed_files: ["README.md", "src/main.ts"],
      },
      session: { returned_session_id: "sess-partial-resume" },
    }));

    await sessionStore.upsert("sess-partial-resume", "implement", repoKey, repo, "Partial implement session");

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.getClaudeResult({ cwd: repo, run_id: "run-partial-resumable" });

    expect(result.run?.status).toBe("partial");
    expect(result.session?.session_id).toBe("sess-partial-resume");

    // Should contain claude_apply preview action
    const applyActions = result.next_actions.filter(
      (a: { tool: string }) => a.tool === "claude_apply"
    );
    expect(applyActions).toHaveLength(1);
    expect(applyActions[0]?.args).toMatchObject({
      cwd: repo,
      worktree_path: ".claude/worktrees/codex-delegated-partial-resume",
      preview: true,
    });

    // Should contain claude_task resume action
    const resumeActions = result.next_actions.filter(
      (a: { tool: string; args?: Record<string, unknown> }) =>
        a.tool === "claude_task" && a.args?.resume_latest === true
    );
    expect(resumeActions).toHaveLength(1);
    expect(resumeActions[0]?.args).toMatchObject({
      cwd: repo,
      mode: "write",
      task: "Continue the previous implementation task and finish incomplete work.",
      resume_latest: true,
    });
  });

  it("excludes claude_apply preview but includes claude_task resume action for failed implement run with store-verified session and empty changed_files", async () => {
    const { repo, logDir, sessionStore, repoKey } = await createWorkflowFixture();

    await writeFile(path.join(logDir, "run-failed-resumable.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repo },
      report: { status: "failed", summary: "Failed implement without changes" },
      observed: {
        worktree_path: ".claude/worktrees/codex-delegated-failed-resume",
        worktree_name: "codex-delegated-failed-resume",
        changed_files: [],
      },
      session: { returned_session_id: "sess-failed-resume" },
    }));

    await sessionStore.upsert("sess-failed-resume", "implement", repoKey, repo, "Failed implement session");

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.getClaudeResult({ cwd: repo, run_id: "run-failed-resumable" });

    expect(result.run?.status).toBe("failed");
    expect(result.session?.session_id).toBe("sess-failed-resume");

    // Should NOT contain claude_apply preview (no changes)
    const applyActions = result.next_actions.filter(
      (a: { tool: string }) => a.tool === "claude_apply"
    );
    expect(applyActions).toHaveLength(0);

    // Should contain claude_task resume action
    const resumeActions = result.next_actions.filter(
      (a: { tool: string; args?: Record<string, unknown> }) =>
        a.tool === "claude_task" && a.args?.resume_latest === true
    );
    expect(resumeActions).toHaveLength(1);
    expect(resumeActions[0]?.args).toMatchObject({
      cwd: repo,
      mode: "write",
      task: "Continue the previous implementation task and finish incomplete work.",
      resume_latest: true,
    });
  });

  it("returns workspace status with jobs, sessions, worktrees, and attention items", async () => {
    const { repo, logDir, jobStore, sessionStore, repoKey } = await createWorkflowFixture();
    const worktreeRoot = path.join(repo, ".claude", "worktrees");
    const staleWorktree = path.join(worktreeRoot, "codex-delegated-stale");
    const freshWorktree = path.join(worktreeRoot, "codex-delegated-fresh");
    const crashedWorktree = path.join(worktreeRoot, "codex-delegated-crashed");
    await mkdir(staleWorktree, { recursive: true });
    await mkdir(freshWorktree, { recursive: true });
    await mkdir(crashedWorktree, { recursive: true });
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
    await jobStore.create({
      job_id: "job-crashed",
      type: "implement",
      status: "crashed",
      cwd: repo,
      created_at: "2026-05-05T00:00:00.000Z",
      updated_at: "2026-05-05T00:03:00.000Z",
      payload: { cwd: repo, task: "implement" },
      worktree_name: "codex-delegated-crashed",
      summary: "Recovered crashed job",
    });
    await sessionStore.upsert("sess-query", "query", repoKey, repo, "Explained workspace");

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.getWorkspaceStatus({ cwd: repo, limit: 10, include_terminal: true });

    expect(result.workspace_root).toBe(repo);
    expect(result.counts.running_jobs).toBe(1);
    expect(result.counts.queued_jobs).toBe(1);
    expect(result.counts.crashed_jobs).toBe(1);
    expect(result.crashed_jobs[0]?.job_id).toBe("job-crashed");
    expect(result.counts.terminal_jobs).toBeGreaterThanOrEqual(1);
    expect(result.counts.apply_blocked_runs).toBe(1);
    expect(result.counts.orphan_worktrees).toBe(1);
    expect(result.latest_sessions[0]?.session_id).toBe("sess-query");
    expect(result.delegated_worktrees.map((worktree) => worktree.worktree_name)).toEqual(
      expect.arrayContaining(["codex-delegated-stale", "codex-delegated-fresh"])
    );
    expect(result.delegated_worktrees.find((worktree) => worktree.worktree_name === "codex-delegated-fresh")?.orphaned).toBe(true);
    expect(result.delegated_worktrees.find((worktree) => worktree.worktree_name === "codex-delegated-stale")?.orphaned).toBe(false);
    expect(result.delegated_worktrees.find((worktree) => worktree.worktree_name === "codex-delegated-crashed")?.orphaned).toBe(false);
    expect(result.attention_items.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["queued_job", "apply_blocked", "stale_worktree", "orphan_worktree", "crashed_job"])
    );
    expect(result.next_actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "claude_task",
          args: expect.objectContaining({ job_id: "job-running" }),
        }),
      ])
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
      crashed_jobs: 0,
      terminal_jobs: 0,
      recent_runs: 0,
      delegated_worktrees: 0,
      stale_worktrees: 0,
      orphan_worktrees: 0,
      apply_blocked_runs: 0,
      active_implement_jobs: 0,
      active_claude_processes: 0,
    });
    expect(result.attention_items).toEqual([]);
  });

  it("returns crashed job next actions when no active jobs block the workspace", async () => {
    const { repo, jobStore } = await createWorkflowFixture();
    await jobStore.create({
      job_id: "job-crashed",
      type: "implement",
      status: "crashed",
      cwd: repo,
      created_at: "2026-05-05T00:00:00.000Z",
      updated_at: "2026-05-05T00:03:00.000Z",
      payload: { cwd: repo, task: "implement" },
      worktree_name: "codex-delegated-crashed",
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.getWorkspaceStatus({ cwd: repo, limit: 10, include_terminal: true });

    expect(result.do_not_start_duplicate_job).toBeUndefined();
    expect(result.next_actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "claude_job_result",
          args: expect.objectContaining({ job_id: "job-crashed" }),
        }),
        expect.objectContaining({
          tool: "claude_apply",
          args: expect.objectContaining({
            worktree_path: ".claude/worktrees/codex-delegated-crashed",
            preview: true,
          }),
        }),
      ])
    );
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
      verification_commands: ["npm test"],
    }, "run-task-write");

    expect(result.delegated_mode).toBe("write");
    expect(result.job?.type).toBe("implement");
    expect(result.job?.status).toBe("queued");
    const stored = await jobStore.get(result.job!.job_id);
    expect(stored?.payload.max_turns).toBeUndefined();
    expect(stored?.payload.files).toBeUndefined();
    expect(stored?.payload.instruction_files).toEqual(["README.md"]);
    expect(stored?.payload.verification_commands).toEqual(["npm test"]);
    expect(result.warnings).toEqual([
      "claude_task.files is deprecated and treated as instruction_files, not apply scope. Use claude_task.allowed_files for hard file limits, or claude_implement.files for advanced use.",
    ]);
    expect(Array.isArray(result.next_actions)).toBe(true);
  });

  it("passes claude_task auto write verification_commands to implement", async () => {
    const { repo, jobStore } = await createWorkflowFixture();
    const spawned = createDetachedSpawnResult(6012);

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: vi.fn(() => spawned) };
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeTask({
      cwd: repo,
      task: "Fix README typo.",
      mode: "auto",
      verification_commands: ["npm test"],
      dirty_policy: "committed",
      wait_strategy: "background",
    }, "run-task-auto-verify");

    expect(result.delegated_mode).toBe("write");
    expect(result.job?.type).toBe("implement");
    const stored = await jobStore.get(result.job!.job_id);
    expect(stored?.payload.verification_commands).toEqual(["npm test"]);
  });

  it("passes claude_task allowed_files to implement files for write mode", async () => {
    const { repo, jobStore } = await createWorkflowFixture();
    const spawned = createDetachedSpawnResult(6010);

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: vi.fn(() => spawned) };
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeTask({
      cwd: repo,
      task: "Implement feature in src/a.ts.",
      mode: "write",
      allowed_files: ["src/a.ts", "src/b.ts"],
      dirty_policy: "committed",
      wait_strategy: "background",
    }, "run-task-allowed-files");

    expect(result.delegated_mode).toBe("write");
    expect(result.job?.type).toBe("implement");
    const stored = await jobStore.get(result.job!.job_id);
    expect(stored?.payload.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("passes claude_task max_changed_files to implement", async () => {
    const { repo, jobStore } = await createWorkflowFixture();
    const spawned = createDetachedSpawnResult(6011);

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: vi.fn(() => spawned) };
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeTask({
      cwd: repo,
      task: "Implement feature.",
      mode: "write",
      max_changed_files: 10,
      dirty_policy: "committed",
      wait_strategy: "background",
    }, "run-task-max-changed");

    expect(result.delegated_mode).toBe("write");
    const stored = await jobStore.get(result.job!.job_id);
    expect(stored?.payload.max_changed_files).toBe(10);
  });

  it("keeps claude_task files as instruction files, not implement scope, when allowed_files is absent", async () => {
    const { repo, jobStore } = await createWorkflowFixture();
    const spawned = createDetachedSpawnResult(6012);

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: vi.fn(() => spawned) };
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeTask({
      cwd: repo,
      task: "Execute plan.",
      mode: "write",
      files: ["PLAN.md"],
      dirty_policy: "committed",
      wait_strategy: "background",
    }, "run-task-files-instruction");

    const stored = await jobStore.get(result.job!.job_id);
    expect(stored?.payload.files).toBeUndefined();
    expect(stored?.payload.instruction_files).toEqual(["PLAN.md"]);
  });

  it("keeps deprecated files separate from allowed_files when both are provided", async () => {
    const { repo, jobStore } = await createWorkflowFixture();
    const spawned = createDetachedSpawnResult(6013);

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: vi.fn(() => spawned) };
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeTask({
      cwd: repo,
      task: "Execute plan.",
      mode: "write",
      files: ["PLAN.md"],
      allowed_files: ["src/a.ts"],
      dirty_policy: "committed",
      wait_strategy: "background",
    }, "run-task-both-files");

    const stored = await jobStore.get(result.job!.job_id);
    expect(stored?.payload.files).toEqual(["src/a.ts"]);
    expect(stored?.payload.instruction_files).toEqual(["PLAN.md"]);
    expect(result.warnings).toEqual([
      "claude_task.files is deprecated and treated as instruction_files, not apply scope. Use claude_task.allowed_files for hard file limits, or claude_implement.files for advanced use.",
    ]);
  });

  it("does not warn when read mode receives allowed_files", async () => {
    const { repo } = await createWorkflowFixture();
    const spawned = createDetachedSpawnResult(6014);

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: vi.fn(() => spawned) };
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeTask({
      cwd: repo,
      task: "Explain src/a.ts.",
      mode: "read",
      allowed_files: ["src/a.ts"],
      wait_strategy: "background",
    }, "run-task-read-allowed");

    expect(result.delegated_mode).toBe("read");
    expect(result.warnings).toEqual([]);
  });

  it("routes claude_task write mode to a background implement job with explicit background", async () => {
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
      wait_strategy: "background",
    }, "run-task-write-default");

    expect(result.delegated_mode).toBe("write");
    expect(result.summary).toBe("Delegated write task as a background job.");
    expect(result.job?.type).toBe("implement");
    expect(result.job?.status).toBe("queued");
    const stored = await jobStore.get(result.job!.job_id);
    expect(stored?.payload).toMatchObject({
      cwd: repo,
      task: "Implement input validation for README updates.",
      instruction_files: ["README.md"],
    });
    expect(stored?.payload.files).toBeUndefined();
    expect(stored?.payload.max_turns).toBeUndefined();
    expect(result.next_actions.map((action) => action.tool)).toEqual([
      "claude_task",
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
    const { repo, jobStore } = await createWorkflowFixture();
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
      wait_strategy: "background",
      diff: "diff --git a/README.md b/README.md",
      files: ["README.md"],
    }, "run-task-auto-review");

    expect(result.delegated_mode).toBe("review");
    expect(result.job?.type).toBe("review");
    const stored = await jobStore.get(result.job!.job_id);
    expect(stored?.payload.files).toBeUndefined();
    expect(stored?.payload.instruction_files).toEqual(["README.md"]);
    expect(result.next_actions.map((action) => action.tool)).toEqual(["claude_task"]);
  });

  it("wait_strategy takes precedence over legacy background alias when both provided", async () => {
    const { repo } = await createWorkflowFixture();
    const spawned = createDetachedSpawnResult(process.pid);

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: vi.fn(() => spawned) };
    });

    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const jobs = await import("../src/jobs.js");
    reloaded.__test.inlineWaitPollIntervalMs = 5;
    reloaded.__test.inlineWaitTimeoutMs = 500;

    // Both wait_strategy="block" and background=true — wait_strategy must win
    const resultPromise = reloaded.runClaudeTask({
      cwd: repo,
      task: "Explain the system.",
      mode: "read",
      wait_strategy: "block",
      background: true,
    }, "run-conflict");

    // Wait for job creation
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Find and complete the job
    const store = new jobs.JobStore(path.join(repo, "..", ".codex-claude-delegate"));
    await store.init();
    const jobList = await store.list({ cwd: repo, limit: 5 });
    expect(jobList.length).toBeGreaterThanOrEqual(1);
    const jobId = jobList[0]!.job_id;
    await store.update(jobId, {
      status: "succeeded",
      result: { status: "success", data: { answer: "ok" } },
      summary: "Query completed",
    });

    const result = await resultPromise;

    // Must NOT be background immediate-return despite background=true
    expect(result.completed_inline).toBe(true);
    expect(result.wait).toMatchObject({
      mode: "block",
      timeout_sec: 540,
      completed_inline: true,
      waiting: false,
      do_not_start_duplicate_job: false,
    });
    expect(result.status).toBe("success");

    vi.doUnmock("node:child_process");
    vi.resetModules();
  }, 15000);

  it("default block mode claude_task returns completed_inline=true for terminal job via job_id continuation", async () => {
    const { repo, logDir, jobStore, sessionStore, repoKey } = await createWorkflowFixture();
    await writeFile(path.join(logDir, "run-impl.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repo },
      report: { status: "success", summary: "Fixed bug" },
      observed: { worktree_path: ".claude/worktrees/codex-delegated-abc", worktree_name: "codex-delegated-abc" },
      session: { requested_session_id: null, returned_session_id: "sess-impl-1" },
    }));
    await jobStore.create({
      job_id: "job-impl-done",
      type: "implement",
      status: "succeeded",
      cwd: repo,
      created_at: "2026-05-05T00:00:00.000Z",
      updated_at: "2026-05-05T00:01:00.000Z",
      payload: { cwd: repo, task: "fix bug" },
      run_id: "run-impl",
      summary: "Fixed bug",
      result: { status: "success", summary: "Fixed bug", server_observed: { worktree_path: ".claude/worktrees/codex-delegated-abc", worktree_name: "codex-delegated-abc" } },
      worktree_name: "codex-delegated-abc",
    });
    await sessionStore.upsert("sess-impl-1", "implement", repoKey, repo, "Fixed bug");

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeTask({
      cwd: repo,
      job_id: "job-impl-done",
    }, "run-default-block");

    expect(result.completed_inline).toBe(true);
    expect(result.status).toBe("success");
    expect(result.job?.job_id).toBe("job-impl-done");
    expect(result.summary).toBe("Fixed bug");
    expect(result.next_actions.some((a) => a.tool === "claude_apply")).toBe(true);

    // Verify equivalence with getClaudeResult
    const claudeResult = await reloaded.getClaudeResult({ cwd: repo, job_id: "job-impl-done" });
    expect(result.summary).toBe(claudeResult.summary);
    expect(result.job?.job_id).toBe(claudeResult.job?.job_id);
  });

  it("default block mode claude_task returns completed_inline=true with failed result_status", async () => {
    const { repo, logDir, jobStore } = await createWorkflowFixture();
    await writeFile(path.join(logDir, "run-fail.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repo },
      report: { status: "failed", summary: "Failed to implement" },
    }));
    await jobStore.create({
      job_id: "job-fail",
      type: "implement",
      status: "succeeded",
      cwd: repo,
      created_at: "2026-05-05T00:00:00.000Z",
      updated_at: "2026-05-05T00:01:00.000Z",
      payload: { cwd: repo, task: "broken" },
      run_id: "run-fail",
      summary: "Implement failed: Failed to implement",
      result: { status: "failed", claude_report: { status: "failed", summary: "Failed to implement" } },
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeTask({
      cwd: repo,
      job_id: "job-fail",
    }, "run-fail-block");

    expect(result.completed_inline).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.do_not_start_duplicate_job).toBe(false);
  });

  it("default block mode claude_task returns completed_inline=true for cancelled job", async () => {
    const { repo, jobStore } = await createWorkflowFixture();
    await jobStore.create({
      job_id: "job-cancelled",
      type: "review",
      status: "cancelled",
      cwd: repo,
      created_at: "2026-05-05T00:00:00.000Z",
      updated_at: "2026-05-05T00:01:00.000Z",
      payload: { cwd: repo, task: "review" },
      summary: "Cancelled by user",
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeTask({
      cwd: repo,
      job_id: "job-cancelled",
    }, "run-cancelled");

    expect(result.completed_inline).toBe(true);
    expect(result.status).toBe("cancelled");
    expect(result.do_not_start_duplicate_job).toBe(false);
  });

  it("default new-task claude_task(mode=read) creates job and returns completed_inline=true when job finishes during inline wait", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-task-inline-read-"));
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

    // Use process.pid so isPidAlive returns true and job doesn't appear stale
    const spawned = createDetachedSpawnResult(process.pid);
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: vi.fn(() => spawned) };
    });

    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const jobs = await import("../src/jobs.js");
    // Very fast poll so test completes quickly
    reloaded.__test.inlineWaitPollIntervalMs = 5;
    reloaded.__test.inlineWaitTimeoutMs = 500;

    // Start the task (default block mode — will create job then wait)
    const resultPromise = reloaded.runClaudeTask({
      cwd: repo,
      task: "Explain this project.",
      mode: "read",
      wait_timeout_sec: 10,
    }, "run-task-inline-read");

    // Wait for the job to be created
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Find the job and make it terminal while inline wait is polling
    const store = new jobs.JobStore(stateDir);
    await store.init();
    const jobList = await store.list({ cwd: repo, limit: 5 });
    expect(jobList.length).toBeGreaterThanOrEqual(1);
    const jobId = jobList[0]!.job_id;

    await store.update(jobId, {
      status: "succeeded",
      result: { status: "success", data: { answer: "This project is an MCP server." } },
      summary: "Query completed",
    });

    const result = await resultPromise;

    expect(result.completed_inline).toBe(true);
    expect(result.status).toBe("success");
    expect(result.job?.job_id).toBe(jobId);
    // Not a background immediate-return — must have waited
    expect(result.completed_inline).toBe(true);
    // Next actions should come from getClaudeResult aggregation (not empty)
    expect(Array.isArray(result.next_actions)).toBe(true);

    // Verify through getClaudeResult that output is equivalent
    const claudeResult = await reloaded.getClaudeResult({ cwd: repo, job_id: jobId });
    expect(result.summary).toBe(claudeResult.summary);

    vi.doUnmock("node:child_process");
    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    delete process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR;
    vi.resetModules();
  }, 15000);

  it("runClaudeTask(job_id=...) returns running with do_not_start_duplicate_job for a fresh-heartbeat job", async () => {
    const { repo, jobStore } = await createWorkflowFixture();
    const now = new Date().toISOString();

    await jobStore.create({
      job_id: "job-fresh-hb",
      type: "implement",
      status: "running",
      cwd: repo,
      pid: process.pid,
      created_at: now,
      updated_at: now,
      heartbeat_at: now,
      payload: { cwd: repo, task: "implement feature" },
    });

    const reloaded = await import("../src/claude-cli.js");
    reloaded.__test.inlineWaitPollIntervalMs = 5;

    const result = await reloaded.runClaudeTask({
      cwd: repo,
      job_id: "job-fresh-hb",
      wait_timeout_sec: 1,
    }, "run-fresh-hb");

    expect(result.status).toBe("running");
    expect(result.waiting).toBe(true);
    expect(result.wait).toMatchObject({
      mode: "block",
      timeout_sec: 1,
      completed_inline: false,
      waiting: true,
      timed_out: true,
      do_not_start_duplicate_job: true,
      continuation_tool: "claude_task",
    });
    expect(result.do_not_start_duplicate_job).toBe(true);
    expect(result.completed_inline).toBeFalsy();
    expect(result.next_actions.map((a) => a.tool)).toContain("claude_task");
    expect(result.next_actions.find((a) => a.tool === "claude_task")?.args).toMatchObject({
      cwd: repo,
      job_id: "job-fresh-hb",
    });
    expect(result.summary).toContain("job-fresh-hb");
  });

  it("runClaudeTask(wait_strategy=background) is non-waiting and not timed out", async () => {
    const { repo } = await createWorkflowFixture();
    const detached = createDetachedSpawnResult(42111);
    const spawnMock = vi.fn(() => detached);
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: spawnMock };
    });
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");

    const result = await reloaded.runClaudeTask({
      cwd: repo,
      task: "review this",
      mode: "review",
      wait_strategy: "background",
      wait_timeout_sec: 3,
    }, "run-bg-wait-meta");

    expect(result.status).toBe("running");
    expect(result.wait).toMatchObject({
      mode: "background",
      timeout_sec: 3,
      waiting: false,
      timed_out: false,
      completed_inline: false,
    });
    expect(detached.unref).toHaveBeenCalled();
  });

  it("runClaudeTask(job_id=...) returns needs_attention for a stale heartbeat job", async () => {
    const { repo, jobStore } = await createWorkflowFixture();
    const oldDate = new Date(Date.now() - 400_000).toISOString();

    await jobStore.create({
      job_id: "job-stale-hb",
      type: "implement",
      status: "running",
      cwd: repo,
      pid: Number.MAX_SAFE_INTEGER, // guaranteed nonexistent PID triggers pidAlive===false → stale
      created_at: oldDate,
      updated_at: oldDate,
      heartbeat_at: oldDate,
      payload: { cwd: repo, task: "stale task" },
    });

    const reloaded = await import("../src/claude-cli.js");
    reloaded.__test.inlineWaitPollIntervalMs = 5;

    const result = await reloaded.runClaudeTask({
      cwd: repo,
      job_id: "job-stale-hb",
      wait_timeout_sec: 1,
    }, "run-stale-hb");

    expect(result.status).toBe("needs_attention");
    expect(result.completed_inline).toBeFalsy();
    expect(result.do_not_start_duplicate_job).toBe(true);
    expect(result.job?.job_id).toBe("job-stale-hb");
  });

  it("runClaudeTask(job_id=...) returns failed for cwd mismatch without leaking cross-repo data", async () => {
    const { repo: repoA, jobStore } = await createWorkflowFixture();

    await jobStore.create({
      job_id: "job-cwd-mismatch",
      type: "implement",
      status: "succeeded",
      cwd: "/tmp/other-repo",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      payload: { cwd: "/tmp/other-repo", task: "secret task" },
      summary: "secret result from repo B",
    });

    const reloaded = await import("../src/claude-cli.js");

    const result = await reloaded.runClaudeTask({
      cwd: repoA,
      job_id: "job-cwd-mismatch",
    }, "run-cwd-mismatch");

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("not found");
    expect(result.do_not_start_duplicate_job).toBe(true);
    // Must not leak repo B data
    expect(result.summary).not.toContain("secret");
    expect(result.job).toBeUndefined();
    expect(result.result).toBeUndefined();
  });

  it("fails apply closed when implement metadata is missing (no run log, no job record)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-no-meta-"));
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
    const worktreeRel = ".claude/worktrees/codex-delegated-no-meta";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    await writeFile(path.join(worktree, "README.md"), "# changed\n");

    // No implement run log or job record written — metadata is missing.
    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const preview = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      preview: true,
    }, "run-no-meta");

    expect(preview.error).toContain("No implement metadata found");
    expect(preview.error).toContain("codex-delegated-no-meta");
    expect(preview.applied_files).toEqual([]);
    expect(preview.preview).toBe(true);
    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("finds apply metadata through job-based lookup before falling back to run log scan", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-job-lookup-"));
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
    await writeFile(path.join(repo, "package.json"), '{"name":"test"}\n');
    await mkdir(path.join(repo, "tests"), { recursive: true });
    await writeFile(path.join(repo, "tests", "test.js"), "// test\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");

    const worktreeRel = ".claude/worktrees/codex-delegated-job-lookup";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    await writeFile(path.join(worktree, "README.md"), "# changed\n");
    await writeFile(path.join(worktree, "package.json"), '{"name":"test","version":"2"}\n');
    await mkdir(path.join(worktree, "tests"), { recursive: true });
    await writeFile(path.join(worktree, "tests", "test.js"), '// updated test\n');

    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");

    // Write run log
    const runId = "run-job-lookup";
    await writeFile(path.join(logDir, `${runId}.json`), JSON.stringify({
      type: "implement",
      input: { cwd: repo },
      report: { status: "success", summary: "Changed multiple files" },
      observed: {
        worktree_path: worktreeRel,
        worktree_name: "codex-delegated-job-lookup",
        base_commit: baseCommit,
        changed_files: ["README.md", "package.json", "tests/test.js"],
        scope: { requested_files: undefined, out_of_scope_files: [], scope_exceeded: false, warnings: [] },
        resource_limits: { actual_changed_files: 3, changed_files_exceeded: false, warnings: [] },
      },
    }));

    // Create job record linking to the run via worktree_name
    const jobs = await import("../src/jobs.js");
    const jobStore = new jobs.JobStore(stateDir);
    await jobStore.init();
    await jobStore.create({
      job_id: "job-impl-lookup",
      type: "implement",
      status: "succeeded",
      cwd: repo,
      created_at: "2026-05-05T00:00:00.000Z",
      updated_at: "2026-05-05T00:01:00.000Z",
      payload: { cwd: repo, task: "Multiple changes" },
      run_id: runId,
      worktree_name: "codex-delegated-job-lookup",
      summary: "Implement job completed",
      result: { status: "success" },
    });

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const preview = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      preview: true,
    }, "run-job-lookup-apply");

    expect(preview.error).toBeUndefined();
    expect(preview.preview).toBe(true);
    const changedFiles = (preview.planned_changes ?? []).map((c) => c.file).sort();
    expect(changedFiles).toEqual(["README.md", "package.json", "tests/test.js"]);
    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    delete process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR;
    vi.resetModules();
  });

  it("includes non-src file changes (README, package.json, tests) in apply preview", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-non-src-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const logDir = path.join(root, "runs");
    await mkdir(repo, { recursive: true });
    await mkdir(logDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");
    await writeFile(path.join(repo, "README.md"), "# main\n");
    await writeFile(path.join(repo, "package.json"), '{"name":"test"}\n');
    await mkdir(path.join(repo, "tests"), { recursive: true });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src", "index.js"), "// original\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");
    const worktreeRel = ".claude/worktrees/codex-delegated-non-src";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    await writeFile(path.join(worktree, "README.md"), "# changed\n");
    await writeFile(path.join(worktree, "package.json"), '{"name":"test","version":"2"}\n');
    await mkdir(path.join(worktree, "tests"), { recursive: true });
    await writeFile(path.join(worktree, "tests", "test.js"), '// new test\n');
    await writeFile(path.join(worktree, "src", "index.js"), "// updated\n");

    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");
    await writeFile(path.join(logDir, "implement-non-src.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repo },
      report: { status: "success", summary: "Changed everything" },
      observed: {
        worktree_path: worktreeRel,
        worktree_name: "codex-delegated-non-src",
        base_commit: baseCommit,
        changed_files: ["README.md", "package.json", "src/index.js", "tests/test.js"],
        scope: { requested_files: undefined, out_of_scope_files: [], scope_exceeded: false, warnings: [] },
        resource_limits: { actual_changed_files: 4, changed_files_exceeded: false, warnings: [] },
      },
    }));

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const preview = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      preview: true,
    }, "run-non-src");

    expect(preview.error).toBeUndefined();
    expect(preview.preview).toBe(true);
    const changedFiles = (preview.planned_changes ?? []).map((c) => c.file).sort();
    expect(changedFiles).toEqual(["README.md", "package.json", "src/index.js", "tests/test.js"]);
    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("transactional apply: rolls back first file when second write fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-tx-apply-rb-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    const logDir = path.join(stateDir, "runs");
    await mkdir(logDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");
    await writeFile(path.join(repo, "first.txt"), "original first\n");
    await writeFile(path.join(repo, "second.txt"), "original second\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");

    const worktreeRel = ".claude/worktrees/codex-delegated-tx-rb";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    // Modify both files in worktree to create real diff
    await writeFile(path.join(worktree, "first.txt"), "modified first\n");
    await writeFile(path.join(worktree, "second.txt"), "modified second\n");
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");

    await writeFile(path.join(logDir, "tx-rb.json"), JSON.stringify({
      type: "implement",
      observed: {
        worktree_path: worktreeRel,
        base_commit: baseCommit,
        changed_files: ["first.txt", "second.txt"],
        scope: { requested_files: undefined, out_of_scope_files: [], scope_exceeded: false, warnings: [] },
        resource_limits: { actual_changed_files: 2, changed_files_exceeded: false, warnings: [] },
      },
    }));

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();

    // Inject FS ops that fail on second write (but not during backup phase)
    const { __setTestFSOps, defaultFSOps } = await import("../src/transaction.js");
    let applyWrites = 0;
    __setTestFSOps({
      ...defaultFSOps,
      async writeFile(fp: string, data: Buffer): Promise<void> {
        if (!fp.includes(".codex-claude-delegate")) {
          applyWrites++;
          if (applyWrites === 2) {
            throw new Error("ENOSPC: no space");
          }
        }
        return defaultFSOps.writeFile(fp, data);
      },
    });

    const reloaded = await import("../src/claude-cli.js");
    const preview = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      preview: true,
    }, "preview-tx-apply-rb");
    const result = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      confirmed_by_user: true,
      preview_token: preview.preview_token,
    }, "tx-apply-rb");

    expect(result.error).toContain("ENOSPC");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    // first.txt should be rolled back
    expect(await readFile(path.join(repo, "first.txt"), "utf8")).toBe("original first\n");
    // second.txt should be unchanged
    expect(await readFile(path.join(repo, "second.txt"), "utf8")).toBe("original second\n");

    __setTestFSOps(undefined);
    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("transactional apply: rolls back written files when deletion fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-tx-apply-del-rb-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    const logDir = path.join(stateDir, "runs");
    await mkdir(logDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");
    await writeFile(path.join(repo, "write.txt"), "original write\n");
    await writeFile(path.join(repo, "remove.txt"), "will be removed\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");

    const worktreeRel = ".claude/worktrees/codex-delegated-tx-del-rb";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    await writeFile(path.join(worktree, "write.txt"), "modified write\n");
    // Simulate deletion by removing the file from worktree
    const { unlink } = await import("node:fs/promises");
    await unlink(path.join(worktree, "remove.txt"));
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");

    await writeFile(path.join(logDir, "tx-del-rb.json"), JSON.stringify({
      type: "implement",
      observed: {
        worktree_path: worktreeRel,
        base_commit: baseCommit,
        changed_files: ["write.txt", "remove.txt"],
        scope: { requested_files: undefined, out_of_scope_files: [], scope_exceeded: false, warnings: [] },
        resource_limits: { actual_changed_files: 2, changed_files_exceeded: false, warnings: [] },
      },
    }));

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();

    // Inject FS ops that fail on rm for remove.txt
    const { __setTestFSOps, defaultFSOps } = await import("../src/transaction.js");
    __setTestFSOps({
      ...defaultFSOps,
      async rm(target: string): Promise<void> {
        if (target.includes("remove.txt")) {
          throw new Error("EBUSY: resource busy");
        }
        return defaultFSOps.rm(target);
      },
    });

    const reloaded = await import("../src/claude-cli.js");
    const preview = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      preview: true,
    }, "preview-tx-apply-del-rb");
    const result = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      confirmed_by_user: true,
      preview_token: preview.preview_token,
    }, "tx-apply-del-rb");

    expect(result.error).toContain("EBUSY");
    expect(result.applied_files).toEqual([]);
    expect(result.dirty_recovery_needed).toBeUndefined();
    // write.txt should be rolled back to original
    expect(await readFile(path.join(repo, "write.txt"), "utf8")).toBe("original write\n");
    // remove.txt should still exist (delete was the one that failed)
    expect(existsSync(path.join(repo, "remove.txt"))).toBe(true);

    __setTestFSOps(undefined);
    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("transactional apply: dirty_recovery_needed when rollback itself fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-tx-apply-dirty-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    const logDir = path.join(stateDir, "runs");
    await mkdir(logDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");
    await writeFile(path.join(repo, "file1.txt"), "original 1\n");
    await writeFile(path.join(repo, "file2.txt"), "original 2\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");

    const worktreeRel = ".claude/worktrees/codex-delegated-tx-dirty";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    await writeFile(path.join(worktree, "file1.txt"), "modified 1\n");
    await writeFile(path.join(worktree, "file2.txt"), "modified 2\n");
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");

    await writeFile(path.join(logDir, "tx-dirty.json"), JSON.stringify({
      type: "implement",
      observed: {
        worktree_path: worktreeRel,
        base_commit: baseCommit,
        changed_files: ["file1.txt", "file2.txt"],
        scope: { requested_files: undefined, out_of_scope_files: [], scope_exceeded: false, warnings: [] },
        resource_limits: { actual_changed_files: 2, changed_files_exceeded: false, warnings: [] },
      },
    }));

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();

    // Inject FS ops that fail on second write AND on rollback write
    const { __setTestFSOps, defaultFSOps } = await import("../src/transaction.js");
    let applyWrites = 0;
    let rollbackActive = false;
    __setTestFSOps({
      ...defaultFSOps,
      async writeFile(fp: string, data: Buffer): Promise<void> {
        if (!fp.includes(".codex-claude-delegate")) {
          if (rollbackActive) {
            // Fail all rollback writes
            throw new Error("ENOSPC: disk full during rollback");
          }
          applyWrites++;
          if (applyWrites === 2) {
            rollbackActive = true;
            throw new Error("ENOSPC: disk full");
          }
        }
        return defaultFSOps.writeFile(fp, data);
      },
    });

    const reloaded = await import("../src/claude-cli.js");
    const preview = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      preview: true,
    }, "preview-tx-apply-dirty");
    const result = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      confirmed_by_user: true,
      preview_token: preview.preview_token,
    }, "tx-apply-dirty");

    expect(result.dirty_recovery_needed).toBe(true);
    expect(result.error).toContain("Rollback also failed");
    expect(result.applied_files).toEqual([]);
    expect(result.rollback_error).toBeDefined();
    expect(result.dirty_files).toBeDefined();
    expect(result.dirty_files!.length).toBeGreaterThan(0);
    // dirty_files should contain meaningful status
    for (const d of result.dirty_files!) {
      expect(d.file).toBeDefined();
      expect(d.status).toMatch(/rollback_restore_failed|rollback_remove_failed/);
    }

    __setTestFSOps(undefined);
    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("preview include_patch returns patch with diff --git, diff_sha256, patch_bytes, patch_truncated=false for tracked modification", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-patch-preview-"));
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
    const worktreeRel = ".claude/worktrees/codex-delegated-patch-preview";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    await writeFile(path.join(worktree, "README.md"), "# changed\n");
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");
    await writeFile(path.join(logDir, "implement-patch.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repo },
      report: { status: "success", summary: "Changed README" },
      observed: {
        worktree_path: worktreeRel,
        base_commit: baseCommit,
        changed_files: ["README.md"],
        scope: { requested_files: undefined, out_of_scope_files: [], scope_exceeded: false, warnings: [] },
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
      include_patch: true,
    }, "patch-preview-run");

    expect(preview.preview).toBe(true);
    expect(preview.planned_changes).toEqual([{ status: "M", file: "README.md" }]);
    expect(preview.applied_files).toEqual([]);
    expect(preview.patch).toBeDefined();
    expect(preview.patch).toContain("diff --git");
    expect(preview.patch).toContain("@@");
    expect(preview.diff_sha256).toBeDefined();
    expect(preview.diff_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.patch_bytes).toBeGreaterThan(0);
    expect(preview.patch_truncated).toBe(false);
    expect(preview.patch_path).toBeUndefined();
    // Main workspace not mutated
    expect(await readFile(path.join(repo, "README.md"), "utf8")).toBe("# main\n");
    // Try preview without include_patch
    const reloaded2 = await import("../src/claude-cli.js");
    const preview2 = await reloaded2.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      preview: true,
      include_patch: false,
    }, "patch-preview-no-patch");
    expect(preview2.patch).toBeUndefined();
    expect(preview2.diff_sha256).toBeUndefined();
    expect(preview2.patch_truncated).toBeUndefined();
    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("preview include_patch=false preserves legacy preview expectations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-patch-legacy-"));
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
    const worktreeRel = ".claude/worktrees/codex-delegated-patch-legacy";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    await writeFile(path.join(worktree, "README.md"), "# changed\n");
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");
    await writeFile(path.join(logDir, "implement-legacy.json"), JSON.stringify({
      type: "implement",
      observed: {
        worktree_path: worktreeRel,
        base_commit: baseCommit,
        changed_files: ["README.md"],
        scope: { requested_files: undefined, out_of_scope_files: [], scope_exceeded: false, warnings: [] },
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
    }, "patch-legacy-run");

    // Legacy behavior: standard preview fields, no patch fields
    expect(preview.preview).toBe(true);
    expect(preview.planned_changes).toBeDefined();
    expect(preview.applied_files).toEqual([]);
    expect(preview.patch).toBeUndefined();
    expect(preview.patch_truncated).toBeUndefined();
    expect(preview.patch_path).toBeUndefined();
    expect(preview.diff_sha256).toBeUndefined();
    expect(preview.patch_bytes).toBeUndefined();
    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("large patch writes .claude/patches artifact and returns patch_truncated=true", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-patch-large-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const logDir = path.join(root, "runs");
    await mkdir(repo, { recursive: true });
    await mkdir(logDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");

    // Create a large file so the patch exceeds patch_max_bytes
    const largeContent = "large content line " + "x".repeat(500) + "\n";
    await writeFile(path.join(repo, "big.txt"), largeContent.repeat(5));
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");

    const worktreeRel = ".claude/worktrees/codex-delegated-patch-large";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    await writeFile(path.join(worktree, "big.txt"), largeContent.repeat(10));
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");
    await writeFile(path.join(logDir, "implement-large.json"), JSON.stringify({
      type: "implement",
      observed: {
        worktree_path: worktreeRel,
        base_commit: baseCommit,
        changed_files: ["big.txt"],
        scope: { requested_files: undefined, out_of_scope_files: [], scope_exceeded: false, warnings: [] },
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
      include_patch: true,
      patch_max_bytes: 1024,
    }, "patch-large-run");

    expect(preview.patch_truncated).toBe(true);
    expect(preview.patch_bytes).toBeGreaterThan(1024);
    expect(preview.diff_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.patch_path).toBeDefined();
    expect(preview.patch_path).toContain(".claude/patches");
    expect(preview.patch_path).toContain("patch-large-run.patch");
    // Verify the file exists
    const patchFile = path.join(repo, preview.patch_path!);
    expect(existsSync(patchFile)).toBe(true);
    const fileContent = await readFile(patchFile, "utf8");
    expect(fileContent).toContain("diff --git");
    // Verify sha256 matches file content
    const { createHash } = await import("node:crypto");
    const expectedHash = createHash("sha256").update(fileContent).digest("hex");
    expect(preview.diff_sha256).toBe(expectedHash);
    // planned_changes unchanged
    expect(preview.planned_changes).toEqual([{ status: "M", file: "big.txt" }]);
    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("preview include_patch with untracked file sets untracked_not_in_patch=true", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-patch-untracked-"));
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
    const worktreeRel = ".claude/worktrees/codex-delegated-patch-untracked";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    await writeFile(path.join(worktree, "README.md"), "# changed\n");
    // Create an untracked file
    await writeFile(path.join(worktree, "untracked.txt"), "untracked content\n");
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");
    await writeFile(path.join(logDir, "implement-untracked.json"), JSON.stringify({
      type: "implement",
      observed: {
        worktree_path: worktreeRel,
        base_commit: baseCommit,
        changed_files: ["README.md", "untracked.txt"],
        scope: { requested_files: undefined, out_of_scope_files: [], scope_exceeded: false, warnings: [] },
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
      include_patch: true,
    }, "patch-untracked-run");

    expect(preview.preview).toBe(true);
    expect(preview.applied_files).toEqual([]);
    expect(preview.untracked_not_in_patch).toBe(true);
    // planned_changes includes the untracked file
    const files = (preview.planned_changes ?? []).map((c) => c.file);
    expect(files).toContain("untracked.txt");
    expect(files).toContain("README.md");
    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("preview include_patch returns a clear error when binary patch generation fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-patch-failure-"));
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

    const worktreeRel = ".claude/worktrees/codex-delegated-patch-failure";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    await writeFile(path.join(worktree, "README.md"), "# changed\n");
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");
    await writeFile(path.join(logDir, "implement-failure.json"), JSON.stringify({
      type: "implement",
      observed: {
        worktree_path: worktreeRel,
        base_commit: baseCommit,
        changed_files: ["README.md"],
        scope: { requested_files: undefined, out_of_scope_files: [], scope_exceeded: false, warnings: [] },
        resource_limits: { actual_changed_files: 1, changed_files_exceeded: false, warnings: [] },
      },
    }));

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.doMock("../src/guard.js", async () => {
      const actual = await vi.importActual<typeof import("../src/guard.js")>("../src/guard.js");
      return {
        ...actual,
        execCapture: vi.fn((bin: string, args: string[], options: Parameters<typeof actual.execCapture>[2]) => {
          if (bin === "git" && args[0] === "diff" && args.includes("--binary")) {
            throw new Error("simulated diff failure");
          }
          return actual.execCapture(bin, args, options);
        }),
      };
    });
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const preview = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      preview: true,
      include_patch: true,
    }, "patch-failure-run");

    expect(preview.preview).toBe(true);
    expect(preview.applied_files).toEqual([]);
    expect(preview.planned_changes).toEqual([{ status: "M", file: "README.md" }]);
    expect(preview.error).toContain("Patch generation failed");
    expect(preview.error).toContain("simulated diff failure");
    expect(preview.patch).toBeUndefined();
    expect(await readFile(path.join(repo, "README.md"), "utf8")).toBe("# main\n");
    vi.doUnmock("../src/guard.js");
    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("transactional apply: preview does not create backups or write files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-tx-apply-preview-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    const logDir = path.join(stateDir, "runs");
    await mkdir(logDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");
    await writeFile(path.join(repo, "README.md"), "# main\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");

    const worktreeRel = ".claude/worktrees/codex-delegated-tx-preview";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    await writeFile(path.join(worktree, "README.md"), "# changed\n");
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");

    await writeFile(path.join(logDir, "tx-preview.json"), JSON.stringify({
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
    }, "tx-apply-preview");

    expect(preview.preview).toBe(true);
    expect(preview.planned_changes).toEqual([{ status: "M", file: "README.md" }]);
    expect(preview.applied_files).toEqual([]);
    // File should NOT have been written
    expect(await readFile(path.join(repo, "README.md"), "utf8")).toBe("# main\n");
    // No backup dir should exist
    const backupDir = path.join(repo, ".codex-claude-delegate", "apply-backups");
    expect(existsSync(backupDir)).toBe(false);

    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("new read claude_task background result exposes dedup_policy and reuse_decision created", async () => {
    const { repo } = await createWorkflowFixture();
    const spawned = createDetachedSpawnResult(6101);

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
    }, "run-task-dedup-policy");

    expect(result.dedup_policy).toEqual({
      enabled: true,
      key: "task_fingerprint",
      applies_to: ["read", "review", "write"],
    });
    expect(result.reuse_decision).toBe("created");
    expect(result.deduped).toBe(false);
    expect(result.do_not_start_duplicate_job).toBe(true);
  });

  it("new write claude_task result dedup_policy mirrors read/review/write tasks", async () => {
    const { repo, jobStore } = await createWorkflowFixture();
    const spawned = createDetachedSpawnResult(6102);

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
      dirty_policy: "committed",
    }, "run-task-dedup-policy-write");

    expect(result.dedup_policy).toEqual({
      enabled: true,
      key: "task_fingerprint",
      applies_to: ["read", "review", "write"],
    });
    expect(result.reuse_decision).toBe("created");
  });

  it("duplicate fingerprint path exposes reuse_decision deduped", async () => {
    const { repo, jobStore } = await createWorkflowFixture();
    const spawned = createDetachedSpawnResult(6103);

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: vi.fn(() => spawned) };
    });

    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");

    // Compute the exact fingerprint that runClaudeTask will generate
    const dedupFingerprint = reloaded.createTaskFingerprint({
      cwd: repo,
      type: "query",
      payload: { cwd: repo, task: "Explain how background jobs work here." },
    });

    // Pre-create an active job with matching fingerprint
    await jobStore.create({
      job_id: "job-dedup-target",
      type: "query",
      status: "queued",
      cwd: repo,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      fingerprint: dedupFingerprint,
      payload: { cwd: repo, task: "Explain how background jobs work here." },
    });

    const result = await reloaded.runClaudeTask({
      cwd: repo,
      task: "Explain how background jobs work here.",
      mode: "read",
      background: true,
      timeout_sec: 90,
    }, "run-task-deduped");

    expect(result.reuse_decision).toBe("deduped");
    expect(result.dedup_policy).toEqual({
      enabled: true,
      key: "task_fingerprint",
      applies_to: ["read", "review", "write"],
    });
    expect(result.deduped).toBe(true);
    expect(result.do_not_start_duplicate_job).toBe(true);
    expect(result.summary).toContain("equivalent");

    vi.doUnmock("node:child_process");
  });

  it("busy same-repo implement path exposes reuse_decision busy_existing", async () => {
    const { repo, jobStore } = await createWorkflowFixture();

    // Pre-create a running implement job to trigger concurrency block
    await jobStore.create({
      job_id: "busy-impl",
      type: "implement",
      status: "running",
      cwd: repo,
      pid: process.pid,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      payload: { cwd: repo, task: "busy task" },
      worktree_name: "codex-delegated-busy",
    });

    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");

    const result = await reloaded.runClaudeTask({
      cwd: repo,
      task: "new implement task",
      mode: "write",
      dirty_policy: "committed",
      wait_strategy: "background",
    }, "run-task-busy");

    expect(result.reuse_decision).toBe("busy_existing");
    expect(result.dedup_policy).toEqual({
      enabled: true,
      key: "task_fingerprint",
      applies_to: ["read", "review", "write"],
    });
    expect(result.deduped).toBe(false);
    expect(result.do_not_start_duplicate_job).toBe(true);
  });

  it("job_id continuation for completed result exposes reuse_decision job_id", async () => {
    const { repo, logDir, jobStore } = await createWorkflowFixture();
    await writeFile(path.join(logDir, "run-impl-job-id.json"), JSON.stringify({
      type: "implement",
      input: { cwd: repo },
      report: { status: "success", summary: "Fixed bug" },
      observed: { worktree_path: ".claude/worktrees/codex-delegated-job-id", worktree_name: "codex-delegated-job-id" },
      session: { requested_session_id: null, returned_session_id: "sess-job-id" },
    }));
    await jobStore.create({
      job_id: "job-impl-job-id",
      type: "implement",
      status: "succeeded",
      cwd: repo,
      created_at: "2026-05-05T00:00:00.000Z",
      updated_at: "2026-05-05T00:01:00.000Z",
      payload: { cwd: repo, task: "fix bug" },
      run_id: "run-impl-job-id",
      summary: "Fixed bug",
      result: { status: "success", summary: "Fixed bug", server_observed: { worktree_path: ".claude/worktrees/codex-delegated-job-id", worktree_name: "codex-delegated-job-id" } },
      worktree_name: "codex-delegated-job-id",
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeTask({
      cwd: repo,
      job_id: "job-impl-job-id",
    }, "run-job-id-continuation");

    expect(result.reuse_decision).toBe("job_id");
    expect(result.dedup_policy).toEqual({
      enabled: true,
      key: "task_fingerprint",
      applies_to: ["read", "review", "write"],
    });
    expect(result.completed_inline).toBe(true);
  });

  it("job_id not found exposes reuse_decision not_found and omits dedup_policy", async () => {
    const { repo } = await createWorkflowFixture();

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeTask({
      cwd: repo,
      job_id: "nonexistent-job-id",
    }, "run-job-id-not-found");

    expect(result.reuse_decision).toBe("not_found");
    expect(result.dedup_policy).toBeUndefined();
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("not found");
  });
});

describe("review gate metadata integration", () => {
  it("runClaudeReview with reviewed_run_id clears matching pending state", async () => {
    const { repo } = await createGitRepoFixture("codex-review-clear-match-");
    const stateDir = path.join(path.dirname(repo), ".codex-claude-delegate");
    process.chdir(path.dirname(repo));
    process.env.CODEX_CLAUDE_RUN_LOG_DIR = path.join(stateDir, "runs");

    // Enable review gate and set pending metadata
    const { manageClaudeReviewGate, markReviewGatePending } = await import("../src/review-gate.js");
    await manageClaudeReviewGate({ cwd: repo, action: "enable" });
    await markReviewGatePending(repo, {
      activity: "write",
      run_id: "run-implement-123",
      worktree_path: ".claude/worktrees/codex-delegated-abc",
    });

    // Mock claude spawn to succeed
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const spawnMock = vi.fn((bin: string, args: string[], options: unknown) => {
        if (bin !== "claude") return actual.spawn(bin, args, options as never);
        const stdout = JSON.stringify({
          structured_output: { findings: "ok", recommendations: "none", severity: "none" },
        });
        return createClaudeSpawnResult(stdout, "", 0);
      });
      return { ...actual, spawn: spawnMock };
    });
    vi.resetModules();

    const reloaded = await import("../src/claude-cli.js");
    await reloaded.runClaudeReview({
      cwd: repo,
      task: "Review this.",
      reviewed_run_id: "run-implement-123",
    }, "review-run-match");

    const configRaw = await readFile(path.join(repo, ".codex-claude-delegate", "review-gate.json"), "utf8");
    const config = JSON.parse(configRaw);
    expect(config.pending_review).toBe(false);
    expect(config.pending_run_id).toBeUndefined();
    expect(config.last_cleared_by_review_run_id).toBe("review-run-match");

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("runClaudeReview without reviewed_run_id does not clear pending state", async () => {
    const { repo } = await createGitRepoFixture("codex-review-no-clear-");
    const stateDir = path.join(path.dirname(repo), ".codex-claude-delegate");
    process.chdir(path.dirname(repo));
    process.env.CODEX_CLAUDE_RUN_LOG_DIR = path.join(stateDir, "runs");

    const { manageClaudeReviewGate, markReviewGatePending } = await import("../src/review-gate.js");
    await manageClaudeReviewGate({ cwd: repo, action: "enable" });
    await markReviewGatePending(repo, {
      activity: "write",
      run_id: "run-implement-456",
    });

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const spawnMock = vi.fn((bin: string, args: string[], options: unknown) => {
        if (bin !== "claude") return actual.spawn(bin, args, options as never);
        const stdout = JSON.stringify({
          structured_output: { findings: "ok", recommendations: "none", severity: "none" },
        });
        return createClaudeSpawnResult(stdout, "", 0);
      });
      return { ...actual, spawn: spawnMock };
    });
    vi.resetModules();

    const reloaded = await import("../src/claude-cli.js");
    await reloaded.runClaudeReview({
      cwd: repo,
      task: "Review this.",
      // No reviewed_run_id
    }, "review-run-no-binding");

    const configRaw = await readFile(path.join(repo, ".codex-claude-delegate", "review-gate.json"), "utf8");
    const config = JSON.parse(configRaw);
    expect(config.pending_review).toBe(true);
    expect(config.pending_run_id).toBe("run-implement-456");

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("runClaudeReview with wrong reviewed_run_id does not clear pending state", async () => {
    const { repo } = await createGitRepoFixture("codex-review-wrong-id-");
    const stateDir = path.join(path.dirname(repo), ".codex-claude-delegate");
    process.chdir(path.dirname(repo));
    process.env.CODEX_CLAUDE_RUN_LOG_DIR = path.join(stateDir, "runs");

    const { manageClaudeReviewGate, markReviewGatePending } = await import("../src/review-gate.js");
    await manageClaudeReviewGate({ cwd: repo, action: "enable" });
    await markReviewGatePending(repo, {
      activity: "write",
      run_id: "run-implement-789",
    });

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const spawnMock = vi.fn((bin: string, args: string[], options: unknown) => {
        if (bin !== "claude") return actual.spawn(bin, args, options as never);
        const stdout = JSON.stringify({
          structured_output: { findings: "ok", recommendations: "none", severity: "none" },
        });
        return createClaudeSpawnResult(stdout, "", 0);
      });
      return { ...actual, spawn: spawnMock };
    });
    vi.resetModules();

    const reloaded = await import("../src/claude-cli.js");
    await reloaded.runClaudeReview({
      cwd: repo,
      task: "Review this.",
      reviewed_run_id: "wrong-run-id",
    }, "review-run-wrong");

    const configRaw = await readFile(path.join(repo, ".codex-claude-delegate", "review-gate.json"), "utf8");
    const config = JSON.parse(configRaw);
    expect(config.pending_review).toBe(true);
    expect(config.pending_run_id).toBe("run-implement-789");

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("successful non-preview apply with applied files sets pending_activity=apply and pending_run_id", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-pending-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    const logDir = path.join(stateDir, "runs");
    await mkdir(logDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");
    await writeFile(path.join(repo, "README.md"), "# main\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");
    const worktreeRel = ".claude/worktrees/codex-delegated-apply-pending";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    await writeFile(path.join(worktree, "README.md"), "# changed\n");
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");

    await writeFile(path.join(logDir, "apply-pending-run.json"), JSON.stringify({
      type: "implement",
      observed: {
        worktree_path: worktreeRel,
        base_commit: baseCommit,
        changed_files: ["README.md"],
        scope: { requested_files: ["README.md"], out_of_scope_files: [], scope_exceeded: false, warnings: [] },
        resource_limits: { actual_changed_files: 1, changed_files_exceeded: false, warnings: [] },
      },
    }));

    // Enable review gate
    const { manageClaudeReviewGate } = await import("../src/review-gate.js");
    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const { manageClaudeReviewGate: manageGate2 } = await import("../src/claude-cli.js");
    await manageGate2({ cwd: repo, action: "enable" });

    const reloaded = await import("../src/claude-cli.js");
    const preview = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      preview: true,
    }, "preview-apply-run-id-test");
    const result = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      confirmed_by_user: true,
      preview_token: preview.preview_token,
    }, "apply-run-id-test");

    expect(result.applied_files).toEqual(["README.md"]);
    expect(result.error).toBeUndefined();

    const configRaw = await readFile(path.join(repo, ".codex-claude-delegate", "review-gate.json"), "utf8");
    const config = JSON.parse(configRaw);
    expect(config.pending_review).toBe(true);
    expect(config.pending_activity).toBe("apply");
    expect(config.pending_run_id).toBe("apply-run-id-test");

    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("preview apply does not set pending_activity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-preview-no-pending-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    const logDir = path.join(stateDir, "runs");
    await mkdir(logDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");
    await writeFile(path.join(repo, "README.md"), "# main\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");
    const worktreeRel = ".claude/worktrees/codex-delegated-preview-no-pending";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    await writeFile(path.join(worktree, "README.md"), "# changed\n");
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");

    await writeFile(path.join(logDir, "preview-no-pending-run.json"), JSON.stringify({
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
    await reloaded.manageClaudeReviewGate({ cwd: repo, action: "enable" });

    const result = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      preview: true,
    }, "preview-no-pending-run");

    expect(result.preview).toBe(true);
    expect(result.applied_files).toEqual([]);

    const configRaw = await readFile(path.join(repo, ".codex-claude-delegate", "review-gate.json"), "utf8");
    const config = JSON.parse(configRaw);
    expect(config.pending_review).toBe(false);
    expect(config.pending_activity).toBeUndefined();

    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });
});

describe("runClaudeApply — ignored_changes in preview", () => {
  it("reports git-ignored files without adding them to planned_changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-ignored-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const logDir = path.join(root, "runs");
    await mkdir(logDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");
    await writeFile(path.join(repo, ".gitignore"), "*.log\n.claude/\n.codex-claude-delegate/\n");
    await writeFile(path.join(repo, "README.md"), "# main\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");

    const worktreeRel = ".claude/worktrees/codex-delegated-ignored";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    await writeFile(path.join(worktree, "README.md"), "# changed\n");
    await writeFile(path.join(worktree, "build.log"), "build output\n");
    await mkdir(path.join(worktree, ".claude"), { recursive: true });
    await writeFile(path.join(worktree, ".claude", "internal.log"), "internal\n");
    await mkdir(path.join(worktree, ".codex-claude-delegate"), { recursive: true });
    await writeFile(path.join(worktree, ".codex-claude-delegate", "state.log"), "state\n");

    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");
    await writeFile(path.join(logDir, "ignored-run.json"), JSON.stringify({
      type: "implement",
      observed: {
        worktree_path: worktreeRel,
        base_commit: baseCommit,
        changed_files: ["README.md"],
        scope: { requested_files: undefined, out_of_scope_files: [], scope_exceeded: false, warnings: [] },
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
    }, "ignored-preview-run");

    expect(preview.preview).toBe(true);
    expect(preview.planned_changes).toEqual([{ status: "M", file: "README.md" }]);
    expect(preview.ignored_changes).toEqual([
      { file: "build.log", rule: "*.log", source: ".gitignore", linenum: 1 },
    ]);

    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("returns ignored_changes for ignored-only preview errors", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-ignored-only-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const logDir = path.join(root, "runs");
    await mkdir(logDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");
    await writeFile(path.join(repo, ".gitignore"), "*.log\n");
    await writeFile(path.join(repo, "README.md"), "# main\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");

    const worktreeRel = ".claude/worktrees/codex-delegated-ignored-only";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    await writeFile(path.join(worktree, "build.log"), "build output\n");

    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");
    await writeFile(path.join(logDir, "ignored-only-run.json"), JSON.stringify({
      type: "implement",
      observed: {
        worktree_path: worktreeRel,
        base_commit: baseCommit,
        changed_files: [],
        scope: { requested_files: undefined, out_of_scope_files: [], scope_exceeded: false, warnings: [] },
        resource_limits: { actual_changed_files: 0, changed_files_exceeded: false, warnings: [] },
      },
    }));

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const preview = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      preview: true,
    }, "ignored-only-preview-run");

    expect(preview.preview).toBe(true);
    expect(preview.error).toContain("No changed files found");
    expect(preview.planned_changes).toEqual([]);
    expect(preview.ignored_changes).toEqual([
      { file: "build.log", rule: "*.log", source: ".gitignore", linenum: 1 },
    ]);

    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("omits ignored_changes for non-preview apply", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-ignored-non-preview-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const logDir = path.join(root, "runs");
    await mkdir(logDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");
    await writeFile(path.join(repo, ".gitignore"), "*.log\n");
    await writeFile(path.join(repo, "README.md"), "# main\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");

    const worktreeRel = ".claude/worktrees/codex-delegated-ignored-non-preview";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    await writeFile(path.join(worktree, "README.md"), "# changed\n");
    await writeFile(path.join(worktree, "build.log"), "build output\n");

    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");
    await writeFile(path.join(logDir, "ignored-non-preview-run.json"), JSON.stringify({
      type: "implement",
      observed: {
        worktree_path: worktreeRel,
        base_commit: baseCommit,
        changed_files: ["README.md"],
        scope: { requested_files: undefined, out_of_scope_files: [], scope_exceeded: false, warnings: [] },
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
    }, "preview-ignored-non-preview");
    const result = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      confirmed_by_user: true,
      preview_token: preview.preview_token,
    }, "ignored-non-preview-run");

    expect(result.error).toBeUndefined();
    expect(result.applied_files).toEqual(["README.md"]);
    expect(result.ignored_changes).toBeUndefined();

    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("preview returns 64-char hex preview_token", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-token-preview-"));
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
    const worktreeRel = ".claude/worktrees/codex-delegated-token-preview";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    await writeFile(path.join(worktree, "README.md"), "# changed\n");
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");
    await writeFile(path.join(logDir, "token-preview-run.json"), JSON.stringify({
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
    }, "token-preview-run");

    expect(preview.preview_token).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.preview).toBe(true);

    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("missing preview_token on non-preview apply fails closed with clear error", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-token-missing-"));
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
    const worktreeRel = ".claude/worktrees/codex-delegated-token-missing";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    await writeFile(path.join(worktree, "README.md"), "# changed\n");
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");
    await writeFile(path.join(logDir, "token-missing-run.json"), JSON.stringify({
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
    const result = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      confirmed_by_user: true,
    }, "token-missing-apply");

    expect(result.error).toContain("preview_token");
    expect(result.applied_files).toEqual([]);
    const mainContent = await readFile(path.join(repo, "README.md"), "utf8");
    expect(mainContent).toBe("# main\n");

    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("mismatched preview_token fails closed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-token-bad-"));
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
    const worktreeRel = ".claude/worktrees/codex-delegated-token-bad";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    await writeFile(path.join(worktree, "README.md"), "# changed\n");
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");
    await writeFile(path.join(logDir, "token-bad-run.json"), JSON.stringify({
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
    const result = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      confirmed_by_user: true,
      preview_token: "0000000000000000000000000000000000000000000000000000000000000000",
    }, "token-bad-apply");

    expect(result.error).toContain("token");
    expect(result.applied_files).toEqual([]);
    const mainContent = await readFile(path.join(repo, "README.md"), "utf8");
    expect(mainContent).toBe("# main\n");

    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("apply with stale token after tracked file content changed fails closed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-token-stale-"));
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
    const worktreeRel = ".claude/worktrees/codex-delegated-token-stale";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    await writeFile(path.join(worktree, "README.md"), "# changed\n");
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");
    await writeFile(path.join(logDir, "token-stale-run.json"), JSON.stringify({
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
    }, "preview-token-stale");

    expect(preview.preview_token).toMatch(/^[a-f0-9]{64}$/);

    // Modify worktree file content without changing path/status
    await writeFile(path.join(worktree, "README.md"), "# totally different content\n");

    const result = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      confirmed_by_user: true,
      preview_token: preview.preview_token,
    }, "token-stale-apply");

    expect(result.error).toContain("token");
    expect(result.applied_files).toEqual([]);
    const mainContent = await readFile(path.join(repo, "README.md"), "utf8");
    expect(mainContent).toBe("# main\n");

    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("apply with stale token after untracked file content changed fails closed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-token-untracked-"));
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
    const worktreeRel = ".claude/worktrees/codex-delegated-token-untracked";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    // Create an untracked file in the worktree
    await writeFile(path.join(worktree, "new-file.txt"), "initial untracked\n");
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");
    await writeFile(path.join(logDir, "token-untracked-run.json"), JSON.stringify({
      type: "implement",
      observed: {
        worktree_path: worktreeRel,
        base_commit: baseCommit,
        changed_files: ["new-file.txt"],
        scope: { requested_files: undefined, out_of_scope_files: [], scope_exceeded: false, warnings: [] },
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
    }, "preview-token-untracked");

    expect(preview.preview_token).toMatch(/^[a-f0-9]{64}$/);

    // Modify untracked file content without changing path/status
    await writeFile(path.join(worktree, "new-file.txt"), "modified after preview\n");

    const result = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      confirmed_by_user: true,
      preview_token: preview.preview_token,
    }, "token-untracked-apply");

    expect(result.error).toContain("token");
    expect(result.applied_files).toEqual([]);
    expect(existsSync(path.join(repo, "new-file.txt"))).toBe(false);

    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });

  it("preview=true with incoming stale token ignores it and returns current token", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-token-ignore-"));
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
    const worktreeRel = ".claude/worktrees/codex-delegated-token-ignore";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    await writeFile(path.join(worktree, "README.md"), "# changed\n");
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");
    await writeFile(path.join(logDir, "token-ignore-run.json"), JSON.stringify({
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

    // Call preview with a stale (random) preview_token — should be ignored
    const result = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      preview: true,
      preview_token: "deadbeef00000000000000000000000000000000000000000000000000000000",
    }, "token-ignore-preview");

    expect(result.preview_token).toMatch(/^[a-f0-9]{64}$/);
    expect(result.preview_token).not.toBe("deadbeef00000000000000000000000000000000000000000000000000000000");
    expect(result.preview).toBe(true);

    delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
    vi.resetModules();
  });
});

// ---- Mode inference unit tests ----

describe("inferClaudeTaskMode — Chinese/mixed-language keyword routing", () => {
  it("routes auto mode to write for Chinese write hints", () => {
    const cases = [
      "修复这个 bug",
      "实现登录功能",
      "修改 README",
      "添加测试",
      "重构 apply 流程",
      "补充文档",
      "提交更改",
      "更新配置",
    ];
    for (const task of cases) {
      const { mode, inference } = inferClaudeTaskMode({ cwd: "/repo", task });
      expect(mode, `task: ${task}`).toBe("write");
      expect(inference.reason).toBe("write_hints");
    }
  });

  it("routes auto mode to review for Chinese review hints", () => {
    const cases = ["审查这个补丁", "检查这段 diff", "找一下风险", "看看有没有问题"];
    for (const task of cases) {
      const { mode, inference } = inferClaudeTaskMode({ cwd: "/repo", task });
      expect(mode, `task: ${task}`).toBe("review");
      expect(inference.reason).toBe("review_hints");
    }
  });

  it("routes auto mode to read for Chinese read hints", () => {
    const cases = ["你能总结一下这个 PR 吗", "explain this module"];
    for (const task of cases) {
      const { mode, inference } = inferClaudeTaskMode({ cwd: "/repo", task });
      expect(mode, `task: ${task}`).toBe("read");
      expect(inference.reason).toBe("read_hints");
    }
  });

  it("routes Chinese query prefix tasks to read with query_prefix_override", () => {
    const cases = ["解释这个模块", "分析架构", "总结 README", "为什么这里失败", "怎么工作"];
    for (const task of cases) {
      const { mode, inference } = inferClaudeTaskMode({ cwd: "/repo", task });
      expect(mode, `task: ${task}`).toBe("read");
      expect(inference.reason).toBe("query_prefix_override");
    }
  });

  it("routes auto mode to review when diff is provided even with Chinese write hints", () => {
    const { mode, inference } = inferClaudeTaskMode({
      cwd: "/repo",
      task: "修复这个 bug",
      diff: "diff --git a/README.md b/README.md",
    });
    expect(mode).toBe("review");
    expect(inference.reason).toBe("diff");
    expect(inference.confidence).toBe("high");
  });

  it("returns mode inference metadata for auto and explicit modes", () => {
    const autoResult = inferClaudeTaskMode({ cwd: "/repo", task: "修复这个 bug" });
    expect(autoResult.inference).toEqual({
      requested_mode: "auto",
      delegated_mode: "write",
      reason: "write_hints",
      confidence: "high",
      matched_hints: expect.arrayContaining(["修复"]),
    });

    const explicitResult = inferClaudeTaskMode({ cwd: "/repo", task: "anything", mode: "read" });
    expect(explicitResult.inference).toEqual({
      requested_mode: "read",
      delegated_mode: "read",
      reason: "explicit",
      confidence: "high",
      matched_hints: ["explicit"],
    });
  });

  it("does not route explanatory Chinese repair question to write", () => {
    const { mode, inference } = inferClaudeTaskMode({ cwd: "/repo", task: "解释如何修复 bug" });
    expect(mode).toBe("read");
    expect(inference.reason).toBe("query_prefix_override");
  });

  it("routes Chinese write followed by explanation to write", () => {
    const { mode, inference } = inferClaudeTaskMode({ cwd: "/repo", task: "修复这个 bug 然后解释一下" });
    expect(mode).toBe("write");
    expect(inference.reason).toBe("write_hints");
  });

  it("routes mixed English Chinese write hint to write", () => {
    const { mode, inference } = inferClaudeTaskMode({ cwd: "/repo", task: "fix 这个 bug" });
    expect(mode).toBe("write");
    expect(inference.reason).toBe("write_hints");
  });

  it("routes auto mode to read when no hints match", () => {
    const { mode, inference } = inferClaudeTaskMode({ cwd: "/repo", task: "tell me about the codebase" });
    expect(mode).toBe("read");
    expect(inference.reason).toBe("default_read");
    expect(inference.confidence).toBe("low");
  });

  it("routes auto mode to write when constraints are provided", () => {
    const { mode, inference } = inferClaudeTaskMode({
      cwd: "/repo",
      task: "do something",
      constraints: ["do not modify tests"],
    });
    expect(mode).toBe("write");
    expect(inference.reason).toBe("constraints");
    expect(inference.confidence).toBe("high");
  });

  it("routes English write hints to write", () => {
    const { mode } = inferClaudeTaskMode({ cwd: "/repo", task: "fix the login bug" });
    expect(mode).toBe("write");
  });

  it("prefers write_hints over read_hints when both match", () => {
    const { mode, inference } = inferClaudeTaskMode({ cwd: "/repo", task: "修复这个 bug 然后解释一下" });
    expect(mode).toBe("write");
    expect(inference.reason).toBe("write_hints");
    expect(inference.matched_hints).toContain("修复");
  });

  it("returns matched_hints for Chinese keywords", () => {
    const { inference } = inferClaudeTaskMode({ cwd: "/repo", task: "实现登录功能" });
    expect(inference.matched_hints).toEqual(["实现"]);
  });

  it("returns matched_hints for review keywords", () => {
    const { inference } = inferClaudeTaskMode({ cwd: "/repo", task: "审查这个补丁" });
    expect(inference.matched_hints).toEqual(["审查"]);
  });

  it("returns empty matched_hints for default read", () => {
    const { inference } = inferClaudeTaskMode({ cwd: "/repo", task: "hello world" });
    expect(inference.matched_hints).toEqual([]);
  });
});

describe("runClaudeApply — nested delegated worktree path detection", () => {
  it("rejects nested delegated worktree paths with clear error", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-nested-apply-"));
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

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");

    const nestedPath = path.join(".claude", "worktrees", "codex-delegated-a", ".claude", "worktrees", "codex-delegated-b");
    const result = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: nestedPath,
      preview: true,
    }, "nested-test");

    expect(result.error).toBeDefined();
    expect(result.error).toContain("Nested delegated worktrees are not supported");
    expect(result.error).toContain("original repository");
    expect(result.applied_files).toEqual([]);
    expect(result.planned_changes).toEqual([]);
  });

  it("rejects absolute nested delegated worktree paths with clear error", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-nested-abs-apply-"));
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

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");

    const nestedAbs = path.join(repo, ".claude", "worktrees", "codex-delegated-a", ".claude", "worktrees", "codex-delegated-b");
    const result = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: nestedAbs,
      preview: true,
    }, "nested-abs-test");

    expect(result.error).toBeDefined();
    expect(result.error).toContain("Nested delegated worktrees are not supported");
    expect(result.applied_files).toEqual([]);
  });

  it("does not report nested error for single delegated worktree paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-single-apply-"));
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

    const worktreeRel = path.join(".claude", "worktrees", "codex-delegated-single");
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");

    await writeFile(path.join(logDir, "single-run.json"), JSON.stringify({
      type: "implement",
      observed: {
        worktree_path: worktreeRel,
        base_commit: baseCommit,
        changed_files: [],
        scope: { requested_files: undefined, out_of_scope_files: [], scope_exceeded: false, warnings: [] },
      },
    }));

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");

    const result = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      preview: true,
    }, "single-test");

    // Single-level worktree should NOT produce a nested-error.
    // It may produce a "no changed files" error or succeed — either is acceptable.
    expect(result.error).not.toContain("Nested delegated worktrees are not supported");
  });
});

async function createRepoWithSubmoduleFixture(prefix: string): Promise<{
  repo: string;
  subRepo: string;
  logDir: string;
  worktreeRel: string;
  worktree: string;
  baseCommit: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(root);
  const subRepo = path.join(root, "sub");
  await mkdir(subRepo, { recursive: true });
  sh(root, "git", "init", subRepo);
  sh(subRepo, "git", "config", "user.name", "Test User");
  sh(subRepo, "git", "config", "user.email", "test@example.com");
  await writeFile(path.join(subRepo, "sub-file.txt"), "sub content\n");
  sh(subRepo, "git", "add", ".");
  sh(subRepo, "git", "commit", "-m", "init sub");

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
  sh(repo, "git", "-c", "protocol.file.allow=always", "submodule", "add", subRepo, "my-sub");
  sh(repo, "git", "add", ".");
  sh(repo, "git", "commit", "-m", "add submodule");

  const worktreeRel = path.join(".claude", "worktrees", `codex-delegated-${prefix.replace(/[^a-z0-9-]/gi, "")}`);
  sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
  const worktree = path.join(repo, worktreeRel);
  const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");

  return { repo, subRepo, logDir, worktreeRel, worktree, baseCommit };
}

async function writeApplyLog(logDir: string, filename: string, worktreeRel: string, baseCommit: string, changedFiles: string[]): Promise<void> {
  await writeFile(path.join(logDir, filename), JSON.stringify({
    type: "implement",
    observed: {
      worktree_path: worktreeRel,
      base_commit: baseCommit,
      changed_files: changedFiles,
      scope: { requested_files: undefined, out_of_scope_files: [], scope_exceeded: false, warnings: [] },
      resource_limits: { actual_changed_files: changedFiles.length, changed_files_exceeded: false, warnings: [] },
    },
  }));
}

describe("runClaudeApply — submodule/gitlink detection", () => {
  it("preview refuses a modified submodule gitlink", async () => {
    const { repo, logDir, worktreeRel, worktree, baseCommit } = await createRepoWithSubmoduleFixture("codex-apply-submodule-gitlink-");
    sh(worktree, "git", "-c", "protocol.file.allow=always", "submodule", "update", "--init", "my-sub");
    sh(path.join(worktree, "my-sub"), "git", "config", "user.name", "Test User");
    sh(path.join(worktree, "my-sub"), "git", "config", "user.email", "test@example.com");
    await writeFile(path.join(worktree, "my-sub", "new-file.txt"), "new\n");
    sh(path.join(worktree, "my-sub"), "git", "add", ".");
    sh(path.join(worktree, "my-sub"), "git", "commit", "-m", "update submodule");
    sh(worktree, "git", "add", "my-sub");
    await writeApplyLog(logDir, "implement-submodule.json", worktreeRel, baseCommit, ["my-sub"]);

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const preview = await reloaded.runClaudeApply({ cwd: repo, worktree_path: worktreeRel, preview: true }, "run-submodule");

    expect(preview.error).toContain("apply refused");
    expect(preview.conflicts).toEqual([
      "my-sub: is a submodule (gitlink); submodule write/apply is not supported",
    ]);
    expect(preview.planned_changes).toEqual([{ status: "M", file: "my-sub" }]);
    expect(preview.applied_files).toEqual([]);
  });

  it("preview refuses a change inside a submodule path", async () => {
    const { repo, logDir, worktreeRel, worktree, baseCommit } = await createRepoWithSubmoduleFixture("codex-apply-submodule-inner-");
    sh(worktree, "git", "-c", "protocol.file.allow=always", "submodule", "update", "--init", "my-sub");
    sh(worktree, "git", "rm", "--cached", "my-sub");
    await rm(path.join(worktree, "my-sub", ".git"), { recursive: true, force: true });
    await writeFile(path.join(worktree, "my-sub", "inner-file.txt"), "inner\n");
    sh(worktree, "git", "add", "my-sub/inner-file.txt");
    await writeApplyLog(logDir, "implement-submodule-inner.json", worktreeRel, baseCommit, ["my-sub/inner-file.txt"]);

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const preview = await reloaded.runClaudeApply({ cwd: repo, worktree_path: worktreeRel, preview: true }, "run-submodule-inner");

    expect(preview.error).toContain("apply refused");
    expect(preview.conflicts).toEqual([
      "my-sub/inner-file.txt: lies inside submodule \"my-sub\"; submodule write/apply is not supported",
    ]);
    expect(preview.applied_files).toEqual([]);
  });

  it("normal file changes in a repo with a submodule still preview successfully", async () => {
    const { repo, logDir, worktreeRel, worktree, baseCommit } = await createRepoWithSubmoduleFixture("codex-apply-submodule-normal-");
    await writeFile(path.join(worktree, "README.md"), "# changed\n");
    await writeApplyLog(logDir, "implement-submodule-normal.json", worktreeRel, baseCommit, ["README.md"]);

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const preview = await reloaded.runClaudeApply({ cwd: repo, worktree_path: worktreeRel, preview: true }, "run-submodule-normal");

    expect(preview.error).toBeUndefined();
    expect(preview.preview).toBe(true);
    expect(preview.planned_changes).toEqual([{ status: "M", file: "README.md" }]);
    expect(preview.applied_files).toEqual([]);
  });
});

describe("runClaudeApply — rename/copy detection", () => {
  it("preview detects a rename (R) when both old and new paths are in observed scope", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-rename-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const logDir = path.join(root, "runs");
    await mkdir(logDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");
    await writeFile(path.join(repo, "old.txt"), "same content\n");
    await writeFile(path.join(repo, "README.md"), "# main\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");

    const worktreeRel = ".claude/worktrees/codex-delegated-rename-test";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);

    // Perform rename in worktree
    sh(worktree, "git", "rm", "old.txt");
    await writeFile(path.join(worktree, "new.txt"), "same content\n");
    sh(worktree, "git", "add", "new.txt");
    sh(worktree, "git", "commit", "-m", "rename old.txt -> new.txt");

    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD~1");
    // Both old and new paths must be in observed scope for rename detection
    await writeFile(path.join(logDir, "rename-run.json"), JSON.stringify({
      type: "implement",
      observed: {
        worktree_path: worktreeRel,
        base_commit: baseCommit,
        changed_files: ["old.txt", "new.txt"],
        scope: { requested_files: undefined, out_of_scope_files: [], scope_exceeded: false, warnings: [] },
        resource_limits: { actual_changed_files: 2, changed_files_exceeded: false, warnings: [] },
      },
    }));

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const preview = await reloaded.runClaudeApply({ cwd: repo, worktree_path: worktreeRel, preview: true }, "run-rename");

    expect(preview.preview).toBe(true);
    expect(preview.planned_changes).toEqual([
      { status: "R", file: "new.txt", old_file: "old.txt" },
    ]);
    expect(preview.error).toBeUndefined();
  });

  it("filters out rename when only destination is in observed scope", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-rename-scope-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const logDir = path.join(root, "runs");
    await mkdir(logDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");
    await writeFile(path.join(repo, "old.txt"), "same content\n");
    await writeFile(path.join(repo, "README.md"), "# main\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");

    const worktreeRel = ".claude/worktrees/codex-delegated-rename-scope";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);

    // Perform rename in worktree
    sh(worktree, "git", "rm", "old.txt");
    await writeFile(path.join(worktree, "new.txt"), "same content\n");
    sh(worktree, "git", "add", "new.txt");
    sh(worktree, "git", "commit", "-m", "rename old.txt -> new.txt");

    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD~1");
    // Only destination path in observed scope — rename should be filtered out
    await writeFile(path.join(logDir, "rename-scope-run.json"), JSON.stringify({
      type: "implement",
      observed: {
        worktree_path: worktreeRel,
        base_commit: baseCommit,
        changed_files: ["new.txt"],
        scope: { requested_files: ["new.txt"], out_of_scope_files: ["old.txt"], scope_exceeded: false, warnings: [] },
        resource_limits: { actual_changed_files: 1, changed_files_exceeded: false, warnings: [] },
      },
    }));

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const preview = await reloaded.runClaudeApply({ cwd: repo, worktree_path: worktreeRel, preview: true }, "run-rename-scope");

    // With only new.txt in scope, the rename should be filtered out (old.txt not in scope)
    expect(preview.error).toContain("No changed files found");
    expect(preview.planned_changes).toEqual([]);
  });
});

describe("runClaudeApply — symlink and mode change refusal", () => {
  const symlinksAvailable = (() => {
    try {
      const tmp = os.tmpdir();
      const testLink = path.join(tmp, `.codex-symlink-test-${process.pid}`);
      symlinkSync("/tmp", testLink);
      unlinkSync(testLink);
      return true;
    } catch {
      return false;
    }
  })();

  const skipIfNoSymlinks = symlinksAvailable ? it : it.skip;

  skipIfNoSymlinks("preview refuses symlink add with clear conflict", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-symlink-add-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const logDir = path.join(root, "runs");
    await mkdir(logDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");
    await writeFile(path.join(repo, "README.md"), "# main\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");

    const worktreeRel = ".claude/worktrees/codex-delegated-symlink-add";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");

    // Create a symlink in the worktree as a new file
    await symlink(path.join(worktree, "README.md"), path.join(worktree, "link-to-readme"));
    sh(worktree, "git", "add", "link-to-readme");

    await writeApplyLog(logDir, "implement-symlink-add.json", worktreeRel, baseCommit, ["link-to-readme"]);

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const preview = await reloaded.runClaudeApply({ cwd: repo, worktree_path: worktreeRel, preview: true }, "run-symlink-add");

    expect(preview.error).toContain("apply refused");
    expect(preview.conflicts).toContain("link-to-readme: symlink writes are not supported");
    expect(preview.applied_files).toEqual([]);
    // Main workspace must be unchanged
    expect(await readFile(path.join(repo, "README.md"), "utf8")).toBe("# main\n");
  });

  skipIfNoSymlinks("non-preview apply with preview_token refuses symlink and leaves main workspace unchanged", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-symlink-nonpreview-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    const logDir = path.join(stateDir, "runs");
    await mkdir(logDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");
    await writeFile(path.join(repo, "README.md"), "# original\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");

    const worktreeRel = ".claude/worktrees/codex-delegated-symlink-np";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");

    await symlink(path.join(worktree, "README.md"), path.join(worktree, "link-md"));
    sh(worktree, "git", "add", "link-md");

    // Also add a normal file change to get a valid preview_token
    await writeFile(path.join(worktree, "README.md"), "# changed\n");

    await writeApplyLog(logDir, "implement-symlink-np.json", worktreeRel, baseCommit, ["link-md", "README.md"]);

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");

    // Preview will be refused because of the symlink, but we can still attempt
    // non-preview apply. The preflight checks must refuse it before mutation.
    const result = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      confirmed_by_user: true,
      preview_token: "0000000000000000000000000000000000000000000000000000000000000000",
    }, "apply-symlink-np");

    expect(result.error).toContain("apply refused");
    expect(result.conflicts).toContain("link-md: symlink writes are not supported");
    expect(result.applied_files).toEqual([]);
    // Main workspace must be unchanged
    expect(await readFile(path.join(repo, "README.md"), "utf8")).toBe("# original\n");
  });

  skipIfNoSymlinks("symlink-to-directory is not expanded into children and is refused as symlink", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-symlink-dir-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const logDir = path.join(root, "runs");
    await mkdir(logDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");

    // Create a real directory with a child file
    await mkdir(path.join(repo, "real-dir"), { recursive: true });
    await writeFile(path.join(repo, "real-dir", "child.txt"), "child content\n");
    await writeFile(path.join(repo, "README.md"), "# main\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");

    const worktreeRel = ".claude/worktrees/codex-delegated-symlink-dir";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");

    // Create a symlink to the real-dir (appears as new directory in worktree)
    await symlink(path.join(worktree, "real-dir"), path.join(worktree, "link-dir"));
    sh(worktree, "git", "add", "link-dir");

    await writeApplyLog(logDir, "implement-symlink-dir.json", worktreeRel, baseCommit, ["link-dir"]);

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const preview = await reloaded.runClaudeApply({ cwd: repo, worktree_path: worktreeRel, preview: true }, "run-symlink-dir");

    expect(preview.error).toContain("apply refused");
    expect(preview.conflicts).toContain("link-dir: symlink writes are not supported");
    // The symlink dir should NOT have been expanded into child files (link-dir/child.txt)
    const childPlanned = preview.planned_changes.filter((c: { file: string }) => c.file.startsWith("link-dir/"));
    expect(childPlanned).toEqual([]);
  });

  it("preview refuses chmod/mode-only change with clear conflict", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-chmod-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const logDir = path.join(root, "runs");
    await mkdir(logDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");
    await writeFile(path.join(repo, "script.sh"), "#!/bin/sh\necho hi\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");

    const worktreeRel = ".claude/worktrees/codex-delegated-chmod";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");

    // Change mode only (no content change)
    sh(worktree, "chmod", "+x", "script.sh");
    sh(worktree, "git", "add", "script.sh");

    await writeApplyLog(logDir, "implement-chmod.json", worktreeRel, baseCommit, ["script.sh"]);

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const preview = await reloaded.runClaudeApply({ cwd: repo, worktree_path: worktreeRel, preview: true }, "run-chmod");

    expect(preview.error).toContain("apply refused");
    expect(preview.conflicts).toContain("script.sh: file mode change is not supported");
    expect(preview.applied_files).toEqual([]);
  });

  skipIfNoSymlinks("file -> symlink type change is refused with unsupported status T", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-type-swap-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const logDir = path.join(root, "runs");
    await mkdir(logDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");
    await writeFile(path.join(repo, "regular-file"), "some content\n");
    await writeFile(path.join(repo, "README.md"), "# main\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");

    const worktreeRel = ".claude/worktrees/codex-delegated-type-swap";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);

    // Replace regular file with symlink — git diff --name-status shows "T" for this
    sh(worktree, "git", "rm", "regular-file");
    await symlink("/dev/null", path.join(worktree, "regular-file"));
    sh(worktree, "git", "add", "regular-file");
    sh(worktree, "git", "commit", "-m", "file to symlink type change");
    const baseCommitForType = sh(worktree, "git", "rev-parse", "HEAD~1");

    await writeApplyLog(logDir, "implement-type-swap.json", worktreeRel, baseCommitForType, ["regular-file"]);

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");
    const preview = await reloaded.runClaudeApply({ cwd: repo, worktree_path: worktreeRel, preview: true }, "run-type-swap");

    expect(preview.error).toContain("apply refused");
    const hasUnsupported = preview.conflicts.some((c: string) =>
      c.includes("regular-file") && c.includes("unsupported status")
    );
    expect(hasUnsupported).toBe(true);
    expect(preview.applied_files).toEqual([]);
  });

  it("ordinary regular file apply still succeeds with preview_token", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-ordinary-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    const logDir = path.join(stateDir, "runs");
    await mkdir(logDir, { recursive: true });
    sh(root, "git", "init", repo);
    sh(repo, "git", "config", "user.name", "Test User");
    sh(repo, "git", "config", "user.email", "test@example.com");
    await writeFile(path.join(repo, "README.md"), "# original\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-m", "init");

    const worktreeRel = ".claude/worktrees/codex-delegated-ordinary";
    sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
    const worktree = path.join(repo, worktreeRel);
    const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");
    await writeFile(path.join(worktree, "README.md"), "# changed\n");

    await writeApplyLog(logDir, "implement-ordinary.json", worktreeRel, baseCommit, ["README.md"]);

    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    vi.resetModules();
    const reloaded = await import("../src/claude-cli.js");

    const preview = await reloaded.runClaudeApply({ cwd: repo, worktree_path: worktreeRel, preview: true }, "preview-ordinary");
    expect(preview.preview_token).toBeTruthy();
    expect(preview.planned_changes).toEqual([{ status: "M", file: "README.md" }]);
    expect(preview.error).toBeUndefined();

    const result = await reloaded.runClaudeApply({
      cwd: repo,
      worktree_path: worktreeRel,
      confirmed_by_user: true,
      preview_token: preview.preview_token,
    }, "apply-ordinary");

    expect(result.error).toBeUndefined();
    expect(result.applied_files).toEqual(["README.md"]);
    expect(await readFile(path.join(repo, "README.md"), "utf8")).toBe("# changed\n");
  });
});

describe("runClaudeImplement — permission_denials warnings", () => {
  it("records passed server verification", async () => {
    const { repo } = await createGitRepoFixture("codex-server-verify-pass-");
    const stdout = JSON.stringify({
      session_id: "sess-verify-pass",
      structured_output: {
        status: "success",
        summary: "Done.",
        changed_files: [],
        commands_run: [],
        tests: { ran: false },
      },
    });

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const spawnMock = vi.fn((bin: string, args: string[], options: { cwd?: string }) => {
        if (bin === "claude") return createClaudeSpawnResult(stdout, "", 0);
        if (bin === "npm") return createClaudeSpawnResult("ok", "", 0);
        return actual.spawn(bin, args, options as never);
      });
      return { ...actual, spawn: spawnMock };
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeImplement({
      cwd: repo,
      task: "test server verification",
      worktreeName: "codex-delegated-verify-pass",
      verification_commands: ["npm test"],
    }, "run-verify-pass");

    expect(result.status).toBe("success");
    expect(result.server_verified).toMatchObject({
      status: "passed",
      commands: [{ command: "npm test", status: "passed", exit_code: 0 }],
    });
    expect(result.warnings.join("\n")).not.toContain("Server-side verification failed");

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("downgrades successful Claude output to partial when server verification fails", async () => {
    const { repo } = await createGitRepoFixture("codex-server-verify-fail-");
    const stdout = JSON.stringify({
      session_id: "sess-verify-fail",
      structured_output: {
        status: "success",
        summary: "Done.",
        changed_files: [],
        commands_run: [],
        tests: { ran: true, passed: true },
      },
    });

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const spawnMock = vi.fn((bin: string, args: string[], options: { cwd?: string }) => {
        if (bin === "claude") return createClaudeSpawnResult(stdout, "", 0);
        if (bin === "npm") return createClaudeSpawnResult("", "failed tests", 1);
        return actual.spawn(bin, args, options as never);
      });
      return { ...actual, spawn: spawnMock };
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeImplement({
      cwd: repo,
      task: "test server verification failure",
      worktreeName: "codex-delegated-verify-fail",
      verification_commands: ["npm test"],
    }, "run-verify-fail");

    expect(result.status).toBe("partial");
    expect(result.server_verified).toMatchObject({
      status: "failed",
      commands: [{ command: "npm test", status: "failed", exit_code: 1 }],
    });
    expect(result.warnings.join("\n")).toContain("Server-side verification failed");

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("keeps permission denial warnings even when server verification passes", async () => {
    const { repo } = await createGitRepoFixture("codex-server-verify-perm-");
    const stdout = JSON.stringify({
      session_id: "sess-verify-perm",
      permission_denials: [
        { tool_name: "Bash", tool_input: { command: "npm test" } },
      ],
      structured_output: {
        status: "success",
        summary: "Done.",
        changed_files: [],
        commands_run: [],
        tests: { ran: true, passed: true },
      },
    });

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const spawnMock = vi.fn((bin: string, args: string[], options: { cwd?: string }) => {
        if (bin === "claude") return createClaudeSpawnResult(stdout, "", 0);
        if (bin === "npm") return createClaudeSpawnResult("ok", "", 0);
        return actual.spawn(bin, args, options as never);
      });
      return { ...actual, spawn: spawnMock };
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeImplement({
      cwd: repo,
      task: "test verification plus permission denial",
      worktreeName: "codex-delegated-verify-perm",
      verification_commands: ["npm test"],
    }, "run-verify-perm");

    const warningsText = result.warnings.join("\n");
    expect(result.status).toBe("success");
    expect(result.server_verified?.status).toBe("passed");
    expect(warningsText).toContain("rerun verification locally");

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("surfaces permission_denials as verification warning", async () => {
    const { repo } = await createGitRepoFixture("codex-perm-denial-");
    const stdout = JSON.stringify({
      session_id: "sess-perm",
      permission_denials: [
        { tool_name: "Bash", tool_input: { command: "rm -rf /tmp/target" } },
        { tool_name: "Bash", tool_input: { command: "sudo something" } },
        { tool_name: "Write", tool_input: { file_path: "/etc/passwd" } },
      ],
      structured_output: {
        status: "success",
        summary: "Done.",
        changed_files: [],
        commands_run: [],
        tests: { ran: true, passed: true },
      },
    });

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const spawnMock = vi.fn((bin: string, args: string[], options: { cwd?: string }) => {
        if (bin !== "claude") return actual.spawn(bin, args, options as never);
        return createClaudeSpawnResult(stdout, "", 0);
      });
      return { ...actual, spawn: spawnMock };
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeImplement({
      cwd: repo,
      task: "test permission denials",
      worktreeName: "codex-delegated-perm",
    }, "run-perm");

    const warningsText = result.warnings.join("\n");
    expect(warningsText).toContain("3 tool calls");
    expect(warningsText).toContain("Bash");
    expect(warningsText).toContain("Write");
    expect(warningsText).toContain("rerun verification locally");

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("does not add permission warning when permission_denials is empty or absent", async () => {
    const { repo } = await createGitRepoFixture("codex-no-perm-");
    const stdout = JSON.stringify({
      session_id: "sess-noperm",
      structured_output: {
        status: "success",
        summary: "Done.",
        changed_files: [],
        commands_run: [],
        tests: { ran: false },
      },
    });

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const spawnMock = vi.fn((bin: string, args: string[], options: { cwd?: string }) => {
        if (bin !== "claude") return actual.spawn(bin, args, options as never);
        return createClaudeSpawnResult(stdout, "", 0);
      });
      return { ...actual, spawn: spawnMock };
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeImplement({
      cwd: repo,
      task: "no permission denials",
      worktreeName: "codex-delegated-noperm",
    }, "run-noperm");

    const warningsText = result.warnings.join("\n");
    expect(warningsText).not.toContain("permission denied");
    expect(warningsText).not.toContain("rerun verification locally");

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("does not include denied tool input in warning", async () => {
    const { repo } = await createGitRepoFixture("codex-perm-noinput-");
    const stdout = JSON.stringify({
      session_id: "sess-perm-noinput",
      permission_denials: [
        { tool_name: "Bash", tool_input: { command: "rm -rf /tmp/sensitive-secret-data" } },
        { tool_name: "Write", tool_input: { file_path: "/etc/passwd", content: "malicious content" } },
      ],
      structured_output: {
        status: "success",
        summary: "Done.",
        changed_files: [],
        commands_run: [],
        tests: { ran: false },
      },
    });

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const spawnMock = vi.fn((bin: string, args: string[], options: { cwd?: string }) => {
        if (bin !== "claude") return actual.spawn(bin, args, options as never);
        return createClaudeSpawnResult(stdout, "", 0);
      });
      return { ...actual, spawn: spawnMock };
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeImplement({
      cwd: repo,
      task: "test no tool input leakage",
      worktreeName: "codex-delegated-noinput",
    }, "run-perm-noinput");

    const warningsText = result.warnings.join("\n");
    expect(warningsText).not.toContain("rm -rf");
    expect(warningsText).not.toContain("/tmp/sensitive-secret-data");
    expect(warningsText).not.toContain("/etc/passwd");
    expect(warningsText).not.toContain("malicious content");

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("status is unchanged by permission_denials", async () => {
    const { repo } = await createGitRepoFixture("codex-perm-status-");
    const stdout = JSON.stringify({
      session_id: "sess-perm-status",
      permission_denials: [
        { tool_name: "Bash", tool_input: { command: "some cmd" } },
      ],
      structured_output: {
        status: "success",
        summary: "Done.",
        changed_files: [],
        commands_run: [],
        tests: { ran: true, passed: true },
      },
    });

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const spawnMock = vi.fn((bin: string, args: string[], options: { cwd?: string }) => {
        if (bin !== "claude") return actual.spawn(bin, args, options as never);
        return createClaudeSpawnResult(stdout, "", 0);
      });
      return { ...actual, spawn: spawnMock };
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeImplement({
      cwd: repo,
      task: "test status unchanged by denials",
      worktreeName: "codex-delegated-permstatus",
    }, "run-perm-status");

    expect(result.status).toBe("success");

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("warns even when Claude self-reports tests.passed=true but Bash denial exists", async () => {
    const { repo } = await createGitRepoFixture("codex-perm-selfreport-");
    const stdout = JSON.stringify({
      session_id: "sess-selfreport",
      permission_denials: [
        { tool_name: "Bash", tool_input: { command: "npm test" } },
      ],
      structured_output: {
        status: "success",
        summary: "All tests pass.",
        changed_files: [],
        commands_run: ["npm test"],
        tests: { ran: true, passed: true, summary: "5/5 pass" },
      },
    });

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const spawnMock = vi.fn((bin: string, args: string[], options: { cwd?: string }) => {
        if (bin !== "claude") return actual.spawn(bin, args, options as never);
        return createClaudeSpawnResult(stdout, "", 0);
      });
      return { ...actual, spawn: spawnMock };
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeImplement({
      cwd: repo,
      task: "test self-report override",
      worktreeName: "codex-delegated-selfreport",
    }, "run-perm-selfreport");

    const warningsText = result.warnings.join("\n");
    expect(warningsText).toContain("rerun verification locally");
    expect(warningsText).toContain("Bash");

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("deduplicates tool names and limits to 5 in warning", async () => {
    const { repo } = await createGitRepoFixture("codex-perm-manytools-");
    const stdout = JSON.stringify({
      session_id: "sess-manytools",
      permission_denials: [
        { tool_name: "Bash", tool_input: { command: "cmd1" } },
        { tool_name: "Bash", tool_input: { command: "cmd2" } },
        { tool_name: "Write", tool_input: { file_path: "/a" } },
        { tool_name: "Edit", tool_input: { file_path: "/b" } },
        { tool_name: "Read", tool_input: { file_path: "/c" } },
        { tool_name: "Glob", tool_input: { pattern: "*" } },
        { tool_name: "Grep", tool_input: { pattern: "foo" } },
      ],
      structured_output: {
        status: "success",
        summary: "Done.",
        changed_files: [],
        commands_run: [],
        tests: { ran: false },
      },
    });

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const spawnMock = vi.fn((bin: string, args: string[], options: { cwd?: string }) => {
        if (bin !== "claude") return actual.spawn(bin, args, options as never);
        return createClaudeSpawnResult(stdout, "", 0);
      });
      return { ...actual, spawn: spawnMock };
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeImplement({
      cwd: repo,
      task: "test many tools",
      worktreeName: "codex-delegated-manytools",
    }, "run-perm-manytools");

    const warningsText = result.warnings.join("\n");
    expect(warningsText).toContain("7 tool calls");
    expect(warningsText).toContain("and 1 more");

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("uses unknown in permission warning when denied tool names are missing", async () => {
    const { repo } = await createGitRepoFixture("codex-perm-unknown-tool-");
    const stdout = JSON.stringify({
      session_id: "sess-unknown-tool",
      permission_denials: [
        { tool_input: { command: "npm test" } },
      ],
      structured_output: {
        status: "success",
        summary: "Done.",
        changed_files: [],
        commands_run: [],
        tests: { ran: false },
      },
    });

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const spawnMock = vi.fn((bin: string, args: string[], options: { cwd?: string }) => {
        if (bin !== "claude") return actual.spawn(bin, args, options as never);
        return createClaudeSpawnResult(stdout, "", 0);
      });
      return { ...actual, spawn: spawnMock };
    });

    const reloaded = await import("../src/claude-cli.js");
    const result = await reloaded.runClaudeImplement({
      cwd: repo,
      task: "test missing tool name",
      worktreeName: "codex-delegated-unknown-tool",
    }, "run-perm-unknown-tool");

    const warningsText = result.warnings.join("\n");
    expect(warningsText).toContain("denied: unknown");
    expect(warningsText).toContain("rerun verification locally");

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  // ---- claude_export ----

  describe("claude_export", () => {
    async function createExportFixture() {
      const root = await mkdtemp(path.join(os.tmpdir(), "codex-export-"));
      cleanupPaths.push(root);
      const repo = path.join(root, "repo");
      const stateDir = path.join(root, ".codex-claude-delegate");
      const logDir = path.join(stateDir, "runs");
      await mkdir(repo, { recursive: true });
      await mkdir(logDir, { recursive: true });

      // Init git repo
      sh(root, "git", "init", repo);
      sh(repo, "git", "config", "user.name", "Test User");
      sh(repo, "git", "config", "user.email", "test@example.com");

      const srcDir = path.join(repo, "src");
      await mkdir(srcDir, { recursive: true });
      await writeFile(path.join(repo, "README.md"), "# main\n");
      await writeFile(path.join(srcDir, "main.ts"), "// entry point\n");
      sh(repo, "git", "add", ".");
      sh(repo, "git", "commit", "-m", "init");

      const baseCommit = sh(repo, "git", "rev-parse", "HEAD");

      const wtName = "codex-delegated-test";
      const wtRelPath = ".claude/worktrees/" + wtName;
      const wtPath = path.join(repo, wtRelPath);
      await mkdir(path.dirname(wtPath), { recursive: true });
      sh(repo, "git", "worktree", "add", "--detach", wtRelPath, "HEAD");

      process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;

      return { root, repo, stateDir, logDir, baseCommit, wtName, wtRelPath, wtPath };
    }

    async function writeImplementLog(
      logDir: string,
      wtRelPath: string,
      baseCommit: string,
      changedFiles: string[],
      overrides?: Record<string, unknown>,
    ) {
      const logEntry = {
        type: "implement",
        input: { cwd: logDir },
        report: { status: "success", summary: "implemented" },
        observed: {
          worktree_path: wtRelPath,
          base_commit: baseCommit,
          changed_files: changedFiles,
          ...overrides,
        },
      };
      await writeFile(path.join(logDir, "run-export.json"), JSON.stringify(logEntry));
    }

    it("exports delegated worktree changes to a new branch without touching main workspace", async () => {
      const { repo, logDir, baseCommit, wtRelPath, wtPath } = await createExportFixture();

      // Make changes in worktree
      await writeFile(path.join(wtPath, "README.md"), "# main\n\nmodified\n");
      await writeFile(path.join(wtPath, "src", "newfile.ts"), "// new file\n");
      sh(wtPath, "git", "add", ".");

      const changedFiles = ["README.md", "src/newfile.ts"];
      await writeImplementLog(logDir, wtRelPath, baseCommit, changedFiles);

      const reloaded = await import("../src/claude-cli.js");
      const result = await reloaded.runClaudeExport({
        cwd: repo,
        worktree_path: wtRelPath,
        branch: "feature/my-export",
      });

      expect(result.error).toBeUndefined();
      expect(result.branch).toBe("feature/my-export");
      expect(result.commit_sha).toBeTruthy();
      expect(result.base_commit).toBe(baseCommit);
      expect(result.tree_sha).toBeTruthy();
      expect(result.file_count).toBe(2);
      expect(result.worktree_path).toBe(wtRelPath);

      // Verify branch exists and contains changes
      const branchList = sh(repo, "git", "branch", "--list", "feature/my-export");
      expect(branchList).toContain("feature/my-export");

      // Verify main workspace not affected
      const headBranch = sh(repo, "git", "rev-parse", "--abbrev-ref", "HEAD");
      expect(headBranch).toBe("main");
      const workspaceStatus = sh(repo, "git", "status", "--short", "--", "README.md", "src/main.ts");
      expect(workspaceStatus).toBe("");
      expect(await readFile(path.join(repo, "README.md"), "utf8")).toBe("# main\n");

      // Verify exported commit has the changes
      const exportedFiles = sh(repo, "git", "diff-tree", "--no-commit-id", "-r", "--name-only", result.commit_sha!);
      expect(exportedFiles).toContain("README.md");
      expect(exportedFiles).toContain("src/newfile.ts");

      // Verify commit message
      const commitMsg = sh(repo, "git", "log", "--format=%s", "-1", result.commit_sha!);
      expect(commitMsg).toContain("codex-delegated-test");

      vi.resetModules();
    });

    it("accepts custom commit message", async () => {
      const { repo, logDir, baseCommit, wtRelPath, wtPath } = await createExportFixture();

      await writeFile(path.join(wtPath, "README.md"), "# main\n\ncustom msg\n");
      sh(wtPath, "git", "add", ".");

      await writeImplementLog(logDir, wtRelPath, baseCommit, ["README.md"]);

      const reloaded = await import("../src/claude-cli.js");
      const result = await reloaded.runClaudeExport({
        cwd: repo,
        worktree_path: wtRelPath,
        branch: "feature/custom-msg",
        message: "My custom export message",
      });

      expect(result.error).toBeUndefined();
      const commitMsg = sh(repo, "git", "log", "--format=%s", "-1", result.commit_sha!);
      expect(commitMsg).toBe("My custom export message");

      vi.resetModules();
    });

    it("rejects invalid branch names", async () => {
      const { repo, logDir, baseCommit, wtRelPath } = await createExportFixture();
      await writeImplementLog(logDir, wtRelPath, baseCommit, ["README.md"]);

      const reloaded = await import("../src/claude-cli.js");
      const result = await reloaded.runClaudeExport({
        cwd: repo,
        worktree_path: wtRelPath,
        branch: "HEAD",  // invalid branch name
      });

      expect(result.error).toContain("Invalid branch name");

      vi.resetModules();
    });

    it("rejects existing branch without force", async () => {
      const { repo, logDir, baseCommit, wtRelPath, wtPath } = await createExportFixture();

      // Create an existing branch
      sh(repo, "git", "branch", "existing-branch");

      await writeFile(path.join(wtPath, "README.md"), "# main\n\nmodified\n");
      sh(wtPath, "git", "add", ".");
      await writeImplementLog(logDir, wtRelPath, baseCommit, ["README.md"]);

      const reloaded = await import("../src/claude-cli.js");
      const result = await reloaded.runClaudeExport({
        cwd: repo,
        worktree_path: wtRelPath,
        branch: "existing-branch",
      });

      expect(result.error).toContain("already exists");

      vi.resetModules();
    });

    it("force=true overwrites existing branch", async () => {
      const { repo, logDir, baseCommit, wtRelPath, wtPath } = await createExportFixture();

      // Create an existing branch
      sh(repo, "git", "branch", "overwrite-branch");

      await writeFile(path.join(wtPath, "README.md"), "# main\n\nexport content\n");
      sh(wtPath, "git", "add", ".");
      await writeImplementLog(logDir, wtRelPath, baseCommit, ["README.md"]);

      const reloaded = await import("../src/claude-cli.js");
      const result = await reloaded.runClaudeExport({
        cwd: repo,
        worktree_path: wtRelPath,
        branch: "overwrite-branch",
        force: true,
      });

      expect(result.error).toBeUndefined();
      expect(result.branch).toBe("overwrite-branch");

      // Verify branch now points to the new commit
      const branchSha = sh(repo, "git", "rev-parse", "overwrite-branch");
      expect(branchSha).toBe(result.commit_sha);

      vi.resetModules();
    });

    it("rejects missing implement metadata", async () => {
      const { repo, wtRelPath } = await createExportFixture();
      // Don't write implement log

      const reloaded = await import("../src/claude-cli.js");
      const result = await reloaded.runClaudeExport({
        cwd: repo,
        worktree_path: wtRelPath,
        branch: "feature/no-metadata",
      });

      expect(result.error).toContain("implement metadata");

      vi.resetModules();
    });

    it("rejects non-delegated worktree path", async () => {
      const { repo, logDir, baseCommit } = await createExportFixture();
      // Use a non-delegated path under worktrees
      const badPath = ".claude/worktrees/not-delegated";
      await writeImplementLog(logDir, badPath, baseCommit, ["README.md"]);

      const reloaded = await import("../src/claude-cli.js");
      const result = await reloaded.runClaudeExport({
        cwd: repo,
        worktree_path: badPath,
        branch: "feature/non-delegated",
      });

      expect(result.error).toContain("delegated worktree");

      vi.resetModules();
    });

    it("rejects nested delegated worktree path", async () => {
      const { repo } = await createExportFixture();
      const nestedPath = ".claude/worktrees/codex-delegated-a/.claude/worktrees/codex-delegated-b";

      const reloaded = await import("../src/claude-cli.js");
      const result = await reloaded.runClaudeExport({
        cwd: repo,
        worktree_path: nestedPath,
        branch: "feature/nested",
      });

      expect(result.error).toContain("Nested delegated worktrees");

      vi.resetModules();
    });

    it("rejects export with no changes", async () => {
      const { repo, logDir, baseCommit, wtRelPath } = await createExportFixture();
      // No changes in worktree
      await writeImplementLog(logDir, wtRelPath, baseCommit, ["README.md"]);

      const reloaded = await import("../src/claude-cli.js");
      const result = await reloaded.runClaudeExport({
        cwd: repo,
        worktree_path: wtRelPath,
        branch: "feature/no-changes",
      });

      expect(result.error).toContain("No changes detected");

      vi.resetModules();
    });

    it("stages only observed changed_files; unobserved file not in exported commit", async () => {
      const { repo, logDir, baseCommit, wtRelPath, wtPath } = await createExportFixture();

      // Change two files in worktree
      await writeFile(path.join(wtPath, "README.md"), "# main\n\nmodified\n");
      await writeFile(path.join(wtPath, "src", "main.ts"), "// modified entry\n");
      sh(wtPath, "git", "add", ".");

      // Only observe README.md changes
      await writeImplementLog(logDir, wtRelPath, baseCommit, ["README.md"]);

      const reloaded = await import("../src/claude-cli.js");
      const result = await reloaded.runClaudeExport({
        cwd: repo,
        worktree_path: wtRelPath,
        branch: "feature/selective",
      });

      expect(result.error).toBeUndefined();
      expect(result.file_count).toBe(1);

      // Verify only README.md is in the export
      const exportedFiles = sh(repo, "git", "diff-tree", "--no-commit-id", "-r", "--name-only", result.commit_sha!);
      expect(exportedFiles.split("\n")).toEqual(["README.md"]);

      vi.resetModules();
    });

    it("refuses export with scope_exceeded metadata", async () => {
      const { repo, logDir, baseCommit, wtRelPath } = await createExportFixture();

      await writeImplementLog(logDir, wtRelPath, baseCommit, ["README.md"], {
        scope: { scope_exceeded: true, warnings: ["Changed out-of-scope-file.txt"] },
      });

      const reloaded = await import("../src/claude-cli.js");
      const result = await reloaded.runClaudeExport({
        cwd: repo,
        worktree_path: wtRelPath,
        branch: "feature/scope-exceeded",
      });

      expect(result.error).toContain("outside requested files");

      vi.resetModules();
    });

    it("refuses export with resource_limits.changed_files_exceeded metadata", async () => {
      const { repo, logDir, baseCommit, wtRelPath } = await createExportFixture();

      await writeImplementLog(logDir, wtRelPath, baseCommit, ["README.md"], {
        resource_limits: { changed_files_exceeded: true, warnings: ["Changed 5 files, exceeds limit of 3"] },
      });

      const reloaded = await import("../src/claude-cli.js");
      const result = await reloaded.runClaudeExport({
        cwd: repo,
        worktree_path: wtRelPath,
        branch: "feature/limits-exceeded",
      });

      expect(result.error).toContain("resource limits");

      vi.resetModules();
    });
  });

  describe("runClaudeApply — main workspace collision matrix", () => {
    it("a. refuses apply when a tracked target is dirty in main workspace", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-dirty-"));
      cleanupPaths.push(root);
      const repo = path.join(root, "repo");
      const logDir = path.join(root, "runs");
      await mkdir(logDir, { recursive: true });
      sh(root, "git", "init", repo);
      sh(repo, "git", "config", "user.name", "Test User");
      sh(repo, "git", "config", "user.email", "test@example.com");
      await writeFile(path.join(repo, "target.txt"), "original\n");
      await writeFile(path.join(repo, "README.md"), "# main\n");
      sh(repo, "git", "add", ".");
      sh(repo, "git", "commit", "-m", "init");

      const worktreeRel = ".claude/worktrees/codex-delegated-dirty";
      sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
      const worktree = path.join(repo, worktreeRel);
      const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");

      // Modify target in worktree
      await writeFile(path.join(worktree, "target.txt"), "modified in worktree\n");
      sh(worktree, "git", "add", "target.txt");
      sh(worktree, "git", "commit", "-m", "modify target");

      // Dirty the same file in main workspace
      await writeFile(path.join(repo, "target.txt"), "dirty in main\n");

      await writeApplyLog(logDir, "implement-dirty.json", worktreeRel, baseCommit, ["target.txt"]);

      process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
      vi.resetModules();
      const reloaded = await import("../src/claude-cli.js");
      const preview = await reloaded.runClaudeApply({ cwd: repo, worktree_path: worktreeRel, preview: true }, "run-dirty");

      expect(preview.error).toContain("apply refused");
      expect(preview.conflicts.some((c: string) => c.includes("target.txt") && c.includes("uncommitted changes"))).toBe(true);
      expect(preview.applied_files).toEqual([]);
    });

    it("b. refuses apply when an untracked exact target exists in main workspace", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-untracked-"));
      cleanupPaths.push(root);
      const repo = path.join(root, "repo");
      const logDir = path.join(root, "runs");
      await mkdir(logDir, { recursive: true });
      sh(root, "git", "init", repo);
      sh(repo, "git", "config", "user.name", "Test User");
      sh(repo, "git", "config", "user.email", "test@example.com");
      await writeFile(path.join(repo, "README.md"), "# main\n");
      sh(repo, "git", "add", ".");
      sh(repo, "git", "commit", "-m", "init");

      const worktreeRel = ".claude/worktrees/codex-delegated-untracked";
      sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
      const worktree = path.join(repo, worktreeRel);
      const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");

      // Add a new file in worktree
      await writeFile(path.join(worktree, "newfile.txt"), "new content\n");
      sh(worktree, "git", "add", "newfile.txt");
      sh(worktree, "git", "commit", "-m", "add newfile");

      // Create same file as untracked in main workspace
      await writeFile(path.join(repo, "newfile.txt"), "untracked in main\n");

      await writeApplyLog(logDir, "implement-untracked.json", worktreeRel, baseCommit, ["newfile.txt"]);

      process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
      vi.resetModules();
      const reloaded = await import("../src/claude-cli.js");
      const preview = await reloaded.runClaudeApply({ cwd: repo, worktree_path: worktreeRel, preview: true }, "run-untracked");

      expect(preview.error).toContain("apply refused");
      expect(preview.conflicts.some((c: string) => c.includes("newfile.txt") && c.includes("untracked"))).toBe(true);
      expect(preview.applied_files).toEqual([]);
    });

    it("c. refuses apply when a gitignored exact target exists in main workspace", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-ignored-"));
      cleanupPaths.push(root);
      const repo = path.join(root, "repo");
      const logDir = path.join(root, "runs");
      await mkdir(logDir, { recursive: true });
      sh(root, "git", "init", repo);
      sh(repo, "git", "config", "user.name", "Test User");
      sh(repo, "git", "config", "user.email", "test@example.com");
      await writeFile(path.join(repo, "README.md"), "# main\n");
      await writeFile(path.join(repo, ".gitignore"), "ignored.txt\n");
      sh(repo, "git", "add", ".");
      sh(repo, "git", "commit", "-m", "init");

      const worktreeRel = ".claude/worktrees/codex-delegated-ignored";
      sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
      const worktree = path.join(repo, worktreeRel);
      const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");

      // Add ignored.txt in worktree (not ignored in worktree since it's committed)
      await writeFile(path.join(worktree, "ignored.txt"), "new content\n");
      sh(worktree, "git", "add", "-f", "ignored.txt");
      sh(worktree, "git", "commit", "-m", "add ignored file");

      // Create ignored.txt in main workspace (it IS ignored due to .gitignore)
      await writeFile(path.join(repo, "ignored.txt"), "ignored in main\n");

      await writeApplyLog(logDir, "implement-ignored.json", worktreeRel, baseCommit, ["ignored.txt"]);

      process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
      vi.resetModules();
      const reloaded = await import("../src/claude-cli.js");
      const preview = await reloaded.runClaudeApply({ cwd: repo, worktree_path: worktreeRel, preview: true }, "run-ignored");

      expect(preview.error).toContain("apply refused");
      expect(preview.conflicts.some((c: string) => c.includes("ignored.txt") && /gitignored|ignored/.test(c))).toBe(true);
      expect(preview.applied_files).toEqual([]);
    });

    it("d. refuses apply when target path is a directory in main workspace but worktree plans a file", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-dirfile-"));
      cleanupPaths.push(root);
      const repo = path.join(root, "repo");
      const logDir = path.join(root, "runs");
      await mkdir(logDir, { recursive: true });
      sh(root, "git", "init", repo);
      sh(repo, "git", "config", "user.name", "Test User");
      sh(repo, "git", "config", "user.email", "test@example.com");
      // Main repo has a directory "mydir" with a file inside
      await mkdir(path.join(repo, "mydir"), { recursive: true });
      await writeFile(path.join(repo, "mydir", "sub.txt"), "sub content\n");
      await writeFile(path.join(repo, "README.md"), "# main\n");
      sh(repo, "git", "add", ".");
      sh(repo, "git", "commit", "-m", "init with directory");

      const worktreeRel = ".claude/worktrees/codex-delegated-dirfile";
      sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
      const worktree = path.join(repo, worktreeRel);
      const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");

      // Replace directory with a file in worktree
      await rm(path.join(worktree, "mydir"), { recursive: true, force: true });
      await writeFile(path.join(worktree, "mydir"), "now a file\n");
      sh(worktree, "git", "add", "-A");
      sh(worktree, "git", "commit", "-m", "replace dir with file");

      await writeApplyLog(logDir, "implement-dirfile.json", worktreeRel, baseCommit, ["mydir"]);

      process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
      vi.resetModules();
      const reloaded = await import("../src/claude-cli.js");
      const preview = await reloaded.runClaudeApply({ cwd: repo, worktree_path: worktreeRel, preview: true }, "run-dirfile");

      expect(preview.error).toContain("apply refused");
      expect(preview.conflicts.some((c: string) => c.includes("mydir") && c.includes("directory"))).toBe(true);
      expect(preview.applied_files).toEqual([]);
    });

    it("e. refuses apply when a nested file target has a parent that is a file in main workspace", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-parent-"));
      cleanupPaths.push(root);
      const repo = path.join(root, "repo");
      const logDir = path.join(root, "runs");
      await mkdir(logDir, { recursive: true });
      sh(root, "git", "init", repo);
      sh(repo, "git", "config", "user.name", "Test User");
      sh(repo, "git", "config", "user.email", "test@example.com");
      await writeFile(path.join(repo, "parent"), "I am a file\n");
      await writeFile(path.join(repo, "README.md"), "# main\n");
      sh(repo, "git", "add", ".");
      sh(repo, "git", "commit", "-m", "init with parent file");

      const worktreeRel = ".claude/worktrees/codex-delegated-parent";
      sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
      const worktree = path.join(repo, worktreeRel);
      const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");

      // Replace file "parent" with a directory containing a nested file
      await rm(path.join(worktree, "parent"), { force: true });
      await mkdir(path.join(worktree, "parent"), { recursive: true });
      await writeFile(path.join(worktree, "parent", "child.txt"), "nested content\n");
      sh(worktree, "git", "add", "-A");
      sh(worktree, "git", "commit", "-m", "replace file with dir + nested file");

      await writeApplyLog(logDir, "implement-parent.json", worktreeRel, baseCommit, ["parent/child.txt"]);

      process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
      vi.resetModules();
      const reloaded = await import("../src/claude-cli.js");
      const preview = await reloaded.runClaudeApply({ cwd: repo, worktree_path: worktreeRel, preview: true }, "run-parent");

      expect(preview.error).toContain("apply refused");
      expect(preview.conflicts.some((c: string) => c.includes("parent") && c.includes("file in main"))).toBe(true);
      expect(preview.applied_files).toEqual([]);
    });

    it("f. refuses case-only sibling conflict and no self-conflict false positive", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-case-"));
      cleanupPaths.push(root);
      const repo = path.join(root, "repo");
      const logDir = path.join(root, "runs");
      await mkdir(logDir, { recursive: true });
      sh(root, "git", "init", repo);
      sh(repo, "git", "config", "user.name", "Test User");
      sh(repo, "git", "config", "user.email", "test@example.com");

      // Use distinctly-cased filenames
      await writeFile(path.join(repo, "MyFile.txt"), "original\n");
      await writeFile(path.join(repo, "README.md"), "# main\n");
      sh(repo, "git", "add", ".");
      sh(repo, "git", "commit", "-m", "init with MyFile.txt");

      const worktreeRel = ".claude/worktrees/codex-delegated-case";
      sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
      const worktree = path.join(repo, worktreeRel);
      const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");

      // Add a case-variant sibling in worktree. On case-insensitive filesystems
      // this cannot be represented as a distinct path, so the conflict case is
      // only asserted where the fixture can actually create the sibling.
      await writeFile(path.join(worktree, "myfile.txt"), "different case\n");
      sh(worktree, "git", "add", "myfile.txt");
      // Also modify the original file so we can test no self-conflict
      await writeFile(path.join(worktree, "README.md"), "# updated\n");
      sh(worktree, "git", "add", "README.md");
      let canRepresentCaseSibling = true;
      try {
        sh(worktree, "git", "commit", "-m", "add case variant");
      } catch {
        canRepresentCaseSibling = false;
      }
      const worktreeEntries = await readdir(worktree);
      canRepresentCaseSibling = canRepresentCaseSibling
        && worktreeEntries.includes("MyFile.txt")
        && worktreeEntries.includes("myfile.txt");

      await writeApplyLog(logDir, "implement-case.json", worktreeRel, baseCommit, ["myfile.txt", "MyFile.txt", "README.md"]);

      process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
      vi.resetModules();
      const reloaded = await import("../src/claude-cli.js");
      const preview = await reloaded.runClaudeApply({ cwd: repo, worktree_path: worktreeRel, preview: true }, "run-case");

      const caseConflicts = preview.conflicts.filter((c: string) => c.includes("case-only sibling conflict"));
      // No self-conflict false positive: README.md must not appear
      expect(caseConflicts.some((c: string) => c.includes("README.md"))).toBe(false);
      if (canRepresentCaseSibling) {
        expect(caseConflicts.some((c: string) => c.includes("myfile.txt") && c.includes("MyFile.txt"))).toBe(true);
        expect(preview.error).toContain("apply refused");
        expect(preview.applied_files).toEqual([]);
      }
    });

    it("g. refuses apply when rename old_file has a dirty collision in main workspace", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-rename-dirty-"));
      cleanupPaths.push(root);
      const repo = path.join(root, "repo");
      const logDir = path.join(root, "runs");
      await mkdir(logDir, { recursive: true });
      sh(root, "git", "init", repo);
      sh(repo, "git", "config", "user.name", "Test User");
      sh(repo, "git", "config", "user.email", "test@example.com");
      await writeFile(path.join(repo, "old.txt"), "old content\n");
      await writeFile(path.join(repo, "README.md"), "# main\n");
      sh(repo, "git", "add", ".");
      sh(repo, "git", "commit", "-m", "init");

      const worktreeRel = ".claude/worktrees/codex-delegated-rename-dirty";
      sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
      const worktree = path.join(repo, worktreeRel);
      const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");

      // Perform rename in worktree
      sh(worktree, "git", "mv", "old.txt", "new.txt");
      await writeFile(path.join(worktree, "new.txt"), "renamed content\n");
      sh(worktree, "git", "add", "new.txt");
      sh(worktree, "git", "commit", "-m", "rename old -> new");

      // Dirty the old_file path in main workspace
      await writeFile(path.join(repo, "old.txt"), "dirty old in main\n");

      await writeApplyLog(logDir, "implement-rename-dirty.json", worktreeRel, baseCommit, ["old.txt", "new.txt"]);

      process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
      vi.resetModules();
      const reloaded = await import("../src/claude-cli.js");
      const preview = await reloaded.runClaudeApply({ cwd: repo, worktree_path: worktreeRel, preview: true }, "run-rename-dirty");

      expect(preview.error).toContain("apply refused");
      expect(preview.conflicts.some((c: string) => c.includes("old.txt") && c.includes("uncommitted changes"))).toBe(true);
      expect(preview.applied_files).toEqual([]);
    });

    it("h. refuses apply when copy old_file has a dirty collision in main workspace", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-copy-dirty-"));
      cleanupPaths.push(root);
      const repo = path.join(root, "repo");
      const logDir = path.join(root, "runs");
      await mkdir(logDir, { recursive: true });
      sh(root, "git", "init", repo);
      sh(repo, "git", "config", "user.name", "Test User");
      sh(repo, "git", "config", "user.email", "test@example.com");
      await writeFile(path.join(repo, "source.txt"), "same content for copy detection\n");
      await writeFile(path.join(repo, "README.md"), "# main\n");
      sh(repo, "git", "add", ".");
      sh(repo, "git", "commit", "-m", "init");

      const worktreeRel = ".claude/worktrees/codex-delegated-copy-dirty";
      sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
      const worktree = path.join(repo, worktreeRel);
      const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");

      // Enable copy detection in the worktree
      sh(worktree, "git", "config", "diff.renames", "copies");

      // Copy source.txt to dest.txt in worktree with same content
      await writeFile(path.join(worktree, "dest.txt"), "same content for copy detection\n");
      sh(worktree, "git", "add", "dest.txt");
      sh(worktree, "git", "commit", "-m", "copy source -> dest");

      // Dirty the source (old_file) in main workspace
      await writeFile(path.join(repo, "source.txt"), "dirty source in main\n");

      await writeApplyLog(logDir, "implement-copy-dirty.json", worktreeRel, baseCommit, ["source.txt", "dest.txt"]);

      process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
      vi.resetModules();
      const reloaded = await import("../src/claude-cli.js");
      const preview = await reloaded.runClaudeApply({ cwd: repo, worktree_path: worktreeRel, preview: true }, "run-copy-dirty");

      // source.txt is a planned change old_file (copy source) and dirty in main
      expect(preview.error).toContain("apply refused");
      expect(preview.conflicts.some((c: string) => c.includes("source.txt") && c.includes("uncommitted changes"))).toBe(true);
      expect(preview.applied_files).toEqual([]);
    });

    it("i. refuses apply when delete target has a dirty collision in main workspace", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-delete-dirty-"));
      cleanupPaths.push(root);
      const repo = path.join(root, "repo");
      const logDir = path.join(root, "runs");
      await mkdir(logDir, { recursive: true });
      sh(root, "git", "init", repo);
      sh(repo, "git", "config", "user.name", "Test User");
      sh(repo, "git", "config", "user.email", "test@example.com");
      await writeFile(path.join(repo, "remove.txt"), "will be removed\n");
      await writeFile(path.join(repo, "README.md"), "# main\n");
      sh(repo, "git", "add", ".");
      sh(repo, "git", "commit", "-m", "init");

      const worktreeRel = ".claude/worktrees/codex-delegated-delete-dirty";
      sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
      const worktree = path.join(repo, worktreeRel);
      const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");

      // Delete file in worktree
      sh(worktree, "git", "rm", "remove.txt");
      sh(worktree, "git", "commit", "-m", "delete remove.txt");

      // Dirty the same file in main workspace
      await writeFile(path.join(repo, "remove.txt"), "dirty in main after delete\n");

      await writeApplyLog(logDir, "implement-delete-dirty.json", worktreeRel, baseCommit, ["remove.txt"]);

      process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
      vi.resetModules();
      const reloaded = await import("../src/claude-cli.js");
      const preview = await reloaded.runClaudeApply({ cwd: repo, worktree_path: worktreeRel, preview: true }, "run-delete-dirty");

      expect(preview.error).toContain("apply refused");
      expect(preview.conflicts.some((c: string) => c.includes("remove.txt") && c.includes("uncommitted changes"))).toBe(true);
      expect(preview.applied_files).toEqual([]);
    });

    it("j. clean valid apply succeeds with preview_token", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-clean-"));
      cleanupPaths.push(root);
      const repo = path.join(root, "repo");
      const stateDir = path.join(root, ".codex-claude-delegate");
      const logDir = path.join(stateDir, "runs");
      await mkdir(logDir, { recursive: true });
      sh(root, "git", "init", repo);
      sh(repo, "git", "config", "user.name", "Test User");
      sh(repo, "git", "config", "user.email", "test@example.com");
      await writeFile(path.join(repo, "README.md"), "# original\n");
      sh(repo, "git", "add", ".");
      sh(repo, "git", "commit", "-m", "init");

      const worktreeRel = ".claude/worktrees/codex-delegated-clean";
      sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
      const worktree = path.join(repo, worktreeRel);
      const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");

      await writeFile(path.join(worktree, "README.md"), "# changed\n");
      sh(worktree, "git", "add", "README.md");
      sh(worktree, "git", "commit", "-m", "modify");

      await writeApplyLog(logDir, "implement-clean.json", worktreeRel, baseCommit, ["README.md"]);

      process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
      vi.resetModules();
      const reloaded = await import("../src/claude-cli.js");

      const preview = await reloaded.runClaudeApply({ cwd: repo, worktree_path: worktreeRel, preview: true }, "preview-clean");
      expect(preview.preview_token).toBeTruthy();
      expect(preview.error).toBeUndefined();
      expect(preview.planned_changes).toEqual([{ status: "M", file: "README.md" }]);

      const result = await reloaded.runClaudeApply({
        cwd: repo,
        worktree_path: worktreeRel,
        confirmed_by_user: true,
        preview_token: preview.preview_token,
      }, "apply-clean");

      expect(result.error).toBeUndefined();
      expect(result.applied_files).toEqual(["README.md"]);
      expect(await readFile(path.join(repo, "README.md"), "utf8")).toBe("# changed\n");
    });

    it("k. preview_token mismatch when main workspace target content changes after preview", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-token-target-"));
      cleanupPaths.push(root);
      const repo = path.join(root, "repo");
      const stateDir = path.join(root, ".codex-claude-delegate");
      const logDir = path.join(stateDir, "runs");
      await mkdir(logDir, { recursive: true });
      sh(root, "git", "init", repo);
      sh(repo, "git", "config", "user.name", "Test User");
      sh(repo, "git", "config", "user.email", "test@example.com");
      await writeFile(path.join(repo, "data.txt"), "v1\n");
      await writeFile(path.join(repo, "README.md"), "# main\n");
      sh(repo, "git", "add", ".");
      sh(repo, "git", "commit", "-m", "init");

      const worktreeRel = ".claude/worktrees/codex-delegated-token-target";
      sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
      const worktree = path.join(repo, worktreeRel);
      const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");

      await writeFile(path.join(worktree, "data.txt"), "v2 from worktree\n");
      sh(worktree, "git", "add", "data.txt");
      sh(worktree, "git", "commit", "-m", "modify data");

      await writeApplyLog(logDir, "implement-token-target.json", worktreeRel, baseCommit, ["data.txt"]);

      process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
      vi.resetModules();
      const reloaded = await import("../src/claude-cli.js");

      // Preview when main workspace data.txt is "v1"
      const preview = await reloaded.runClaudeApply({ cwd: repo, worktree_path: worktreeRel, preview: true }, "preview-token-target");
      expect(preview.preview_token).toBeTruthy();
      expect(preview.error).toBeUndefined();

      // Change main workspace target content after preview and commit it
      // so the preflight passes (clean committed file) and token detects the mismatch
      await writeFile(path.join(repo, "data.txt"), "v1 modified in main after preview\n");
      sh(repo, "git", "add", "data.txt");
      sh(repo, "git", "commit", "-m", "modify data in main after preview");

      const result = await reloaded.runClaudeApply({
        cwd: repo,
        worktree_path: worktreeRel,
        confirmed_by_user: true,
        preview_token: preview.preview_token,
      }, "apply-token-target");

      expect(result.error).toContain("preview_token mismatch");
      expect(result.applied_files).toEqual([]);
      // Main workspace must be unchanged
      expect(await readFile(path.join(repo, "data.txt"), "utf8")).toBe("v1 modified in main after preview\n");
    });

    it("l. preview_token mismatch when ignored file appears after preview", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-token-ignored-"));
      cleanupPaths.push(root);
      const repo = path.join(root, "repo");
      const stateDir = path.join(root, ".codex-claude-delegate");
      const logDir = path.join(stateDir, "runs");
      await mkdir(logDir, { recursive: true });
      sh(root, "git", "init", repo);
      sh(repo, "git", "config", "user.name", "Test User");
      sh(repo, "git", "config", "user.email", "test@example.com");
      // No .gitignore — the file appears as a committed addition after preview
      await writeFile(path.join(repo, "README.md"), "# main\n");
      sh(repo, "git", "add", ".");
      sh(repo, "git", "commit", "-m", "init");

      const worktreeRel = ".claude/worktrees/codex-delegated-token-ignored";
      sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
      const worktree = path.join(repo, worktreeRel);
      const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");

      // Worktree creates a new file
      await writeFile(path.join(worktree, "new_target.txt"), "worktree content\n");
      sh(worktree, "git", "add", "new_target.txt");
      sh(worktree, "git", "commit", "-m", "add new_target");

      await writeApplyLog(logDir, "implement-token-ignored.json", worktreeRel, baseCommit, ["new_target.txt"]);

      process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
      vi.resetModules();
      const reloaded = await import("../src/claude-cli.js");

      // Preview when main workspace has no new_target.txt
      const preview = await reloaded.runClaudeApply({ cwd: repo, worktree_path: worktreeRel, preview: true }, "preview-token-ignored");
      expect(preview.preview_token).toBeTruthy();
      expect(preview.error).toBeUndefined();

      // Create new_target.txt in main workspace AND commit it so preflight passes
      // (clean committed file won't trigger dirty/untracked/gitignored checks)
      await writeFile(path.join(repo, "new_target.txt"), "appeared after preview\n");
      sh(repo, "git", "add", "new_target.txt");
      sh(repo, "git", "commit", "-m", "add new_target in main");

      const result = await reloaded.runClaudeApply({
        cwd: repo,
        worktree_path: worktreeRel,
        confirmed_by_user: true,
        preview_token: preview.preview_token,
      }, "apply-token-ignored");

      // Token must mismatch: main workspace target state went from missing to file
      expect(result.error).toContain("preview_token mismatch");
      expect(result.applied_files).toEqual([]);
    });

    it("m. unrelated dirty file does not invalidate preview_token and does not block preview/apply", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-unrelated-"));
      cleanupPaths.push(root);
      const repo = path.join(root, "repo");
      const stateDir = path.join(root, ".codex-claude-delegate");
      const logDir = path.join(stateDir, "runs");
      await mkdir(logDir, { recursive: true });
      sh(root, "git", "init", repo);
      sh(repo, "git", "config", "user.name", "Test User");
      sh(repo, "git", "config", "user.email", "test@example.com");
      await writeFile(path.join(repo, "target.txt"), "original target\n");
      await writeFile(path.join(repo, "unrelated.txt"), "original unrelated\n");
      await writeFile(path.join(repo, "README.md"), "# main\n");
      sh(repo, "git", "add", ".");
      sh(repo, "git", "commit", "-m", "init");

      const worktreeRel = ".claude/worktrees/codex-delegated-unrelated";
      sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
      const worktree = path.join(repo, worktreeRel);
      const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");

      await writeFile(path.join(worktree, "target.txt"), "modified target\n");
      sh(worktree, "git", "add", "target.txt");
      sh(worktree, "git", "commit", "-m", "modify target");

      // Dirty an unrelated file in main workspace
      await writeFile(path.join(repo, "unrelated.txt"), "dirty unrelated\n");

      await writeApplyLog(logDir, "implement-unrelated.json", worktreeRel, baseCommit, ["target.txt"]);

      process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
      vi.resetModules();
      const reloaded = await import("../src/claude-cli.js");

      // Preview should succeed (unrelated dirty file doesn't affect target)
      const preview = await reloaded.runClaudeApply({ cwd: repo, worktree_path: worktreeRel, preview: true }, "preview-unrelated");
      expect(preview.preview_token).toBeTruthy();
      expect(preview.error).toBeUndefined();

      // Apply should succeed with the preview_token
      const result = await reloaded.runClaudeApply({
        cwd: repo,
        worktree_path: worktreeRel,
        confirmed_by_user: true,
        preview_token: preview.preview_token,
      }, "apply-unrelated");

      expect(result.error).toBeUndefined();
      expect(result.applied_files).toEqual(["target.txt"]);
      expect(await readFile(path.join(repo, "target.txt"), "utf8")).toBe("modified target\n");
      // Unrelated file should still be dirty in main
      expect(await readFile(path.join(repo, "unrelated.txt"), "utf8")).toBe("dirty unrelated\n");
    });
  });

  // ---- FUNC-010: context_roots claude-cli tests ----

  describe("context_roots conditional allowlist and deny patterns", () => {
    it("query without context_roots keeps broad filesystem Bash allowlist", () => {
      const args = buildQueryArgs({ cwd: "/repo", task: "explain" });
      // Should include broad filesystem commands
      expect(args).toContain("Bash(find *)");
      expect(args).toContain("Bash(rg *)");
      expect(args).toContain("Bash(wc *)");
      expect(args).toContain("Bash(ls *)");
      expect(args).toContain("Bash(head *)");
      expect(args).toContain("Bash(tail *)");
      expect(args).toContain("Bash(cat *)");
    });

    it("query with context_roots removes broad filesystem Bash allowlist", () => {
      const args = buildQueryArgs({
        cwd: "/repo",
        task: "explain cross-repo",
        context_roots: [{ alias: "lib", cwd: "/other" }],
      });
      // Broad filesystem commands should be absent
      expect(args).not.toContain("Bash(find *)");
      expect(args).not.toContain("Bash(rg *)");
      expect(args).not.toContain("Bash(wc *)");
      expect(args).not.toContain("Bash(ls *)");
      expect(args).not.toContain("Bash(head *)");
      expect(args).not.toContain("Bash(tail *)");
      expect(args).not.toContain("Bash(cat *)");
      // Read-only git commands should still be present
      expect(args).toContain("Bash(git diff *)");
      expect(args).toContain("Bash(git log *)");
      expect(args).toContain("Bash(git status)");
      expect(args).toContain("Bash(git show *)");
    });

    it("query with context_roots includes context-root sensitive deny patterns", () => {
      const args = buildQueryArgs({
        cwd: "/repo",
        task: "explain cross-repo",
        context_roots: [{ alias: "lib", cwd: "/other/path" }],
      });
      // Context-root sensitive denies should be present
      expect(args).toContain("Read(/other/path/.env)");
      expect(args).toContain("Read(/other/path/.env.*)");
      expect(args).toContain("Read(/other/path/secrets/**)");
      expect(args).toContain("Bash(cat /other/path/.env)");
      expect(args).toContain("Bash(grep * /other/path/.env)");
      // Primary sensitive denies should also still be present
      expect(args).toContain("Read(./.env)");
    });

    it("review with context_roots includes context-root sensitive deny patterns", () => {
      const args = buildReviewArgs({
        cwd: "/repo",
        task: "review cross-repo",
        context_roots: [{ alias: "lib", cwd: "/other/path" }],
      });
      expect(args).toContain("Read(/other/path/.env)");
      expect(args).toContain("Read(/other/path/secrets/**)");
      expect(args).toContain("Bash(cat /other/path/.env)");
      // Primary sensitive denies still present
      expect(args).toContain("Read(./.env)");
    });

    it("query with context_roots and off policy removes only sensitive denies", () => {
      const args = buildQueryArgs({
        cwd: "/repo",
        task: "explain",
        context_roots: [{ alias: "lib", cwd: "/other" }],
        sensitive_file_policy: "off",
      });
      expect(args).not.toContain("Read(/other/.env)");
      expect(args).not.toContain("Read(./.env)");
      // Dangerous bash denies still present
      expect(args).toContain("Bash(rm *)");
      expect(args).toContain("Bash(sudo *)");
    });
  });
});
