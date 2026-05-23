import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobStore } from "../src/jobs.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  delete process.env.CODEX_CLAUDE_RUN_LOG_DIR;
  delete process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR;
  vi.resetModules();
  while (cleanupPaths.length > 0) {
    await rm(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

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

describe("workflow results", () => {
  it("workspace status reports active implement jobs and background process count", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-status-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    await mkdir(repo, { recursive: true });
    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;

    const store = new JobStore(stateDir);
    await store.init();
    await store.create({
      job_id: "job-running-implement",
      type: "implement",
      status: "running",
      cwd: repo,
      created_at: "2026-05-20T00:00:00.000Z",
      updated_at: "2026-05-20T00:01:00.000Z",
      pid: 4242,
      payload: { cwd: repo, task: "implement" },
    });
    await store.create({
      job_id: "job-queued-query",
      type: "query",
      status: "queued",
      cwd: repo,
      created_at: "2026-05-20T00:00:00.000Z",
      updated_at: "2026-05-20T00:01:00.000Z",
      payload: { cwd: repo, task: "explain" },
    });

    const { getWorkspaceStatus } = await import("../src/workflow-results.js");
    const result = await getWorkspaceStatus({ cwd: repo });

    expect(result.counts.active_implement_jobs).toBe(1);
    expect(result.counts.active_claude_processes).toBe(1);
    expect(result.active_processes).toEqual([
      { job_id: "job-running-implement", type: "implement", pid: 4242 },
    ]);
  });

  it("includes recent_artifacts from verified run logs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-artifacts-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    const logDir = path.join(repo, ".codex-claude-delegate", "runs");
    await mkdir(repo, { recursive: true });
    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;

    await writeRunLogEntry(logDir, "run-verified-1", {
      type: "implement",
      input: { cwd: repo },
      report: { status: "success", summary: "Done" },
      server_verified: {
        status: "passed",
        commands: [
          { command: "npx tsc", status: "passed", exit_code: 0, duration_ms: 500, stdout_tail: "", stderr_tail: "", timed_out: false },
          { command: "npx vitest run", status: "passed", exit_code: 0, duration_ms: 1000, stdout_tail: "", stderr_tail: "", timed_out: false },
        ],
      },
    });

    const { getWorkspaceStatus } = await import("../src/workflow-results.js");
    const result = await getWorkspaceStatus({ cwd: repo });

    expect(result.recent_artifacts).toBeDefined();
    expect(result.recent_artifacts!.length).toBe(1);
    expect(result.recent_artifacts![0]).toMatchObject({
      run_id: "run-verified-1",
      run_type: "implement",
      status: "passed",
      command_count: 2,
      passed_count: 2,
      failed_count: 0,
      skipped_count: 0,
    });
  });

  it("omits recent_artifacts when no run logs have server_verified", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-no-artifacts-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    const logDir = path.join(repo, ".codex-claude-delegate", "runs");
    await mkdir(repo, { recursive: true });
    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;

    await writeRunLogEntry(logDir, "run-no-v-1", {
      type: "query",
      input: { cwd: repo },
      report: { status: "success" },
    });

    const { getWorkspaceStatus } = await import("../src/workflow-results.js");
    const result = await getWorkspaceStatus({ cwd: repo });

    expect(result.recent_artifacts).toBeUndefined();
  });

  it("includes recent_artifacts even when include_terminal is false", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-term-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    const logDir = path.join(repo, ".codex-claude-delegate", "runs");
    await mkdir(repo, { recursive: true });
    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;

    await writeRunLogEntry(logDir, "run-term-v", {
      type: "implement",
      input: { cwd: repo },
      report: { status: "success" },
      server_verified: {
        status: "failed",
        commands: [
          { command: "test", status: "failed", exit_code: 1, duration_ms: 100, stdout_tail: "", stderr_tail: "", timed_out: false },
        ],
      },
    });

    const { getWorkspaceStatus } = await import("../src/workflow-results.js");
    const result = await getWorkspaceStatus({ cwd: repo, include_terminal: false });

    expect(result.recent_artifacts).toBeDefined();
    expect(result.recent_artifacts!.length).toBe(1);
    expect(result.recent_runs.length).toBe(1);
  });

  it("includes environment_config when file exists and is valid", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-envcfg-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    const configDir = path.join(repo, ".codex-claude-delegate");
    await mkdir(repo, { recursive: true });
    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "environment.json"),
      JSON.stringify({ test: "npx vitest run", sparse_paths: ["src/"] }),
    );

    const { getWorkspaceStatus } = await import("../src/workflow-results.js");
    const result = await getWorkspaceStatus({ cwd: repo });

    expect(result.environment_config).toBeDefined();
    expect(result.environment_config!.exists).toBe(true);
    expect(result.environment_config!.ok).toBe(true);
    expect(result.environment_config!.test).toBe(true);
    expect(result.environment_config!.fields_present).toContain("test");
    expect(result.environment_config!.fields_present).toContain("sparse_paths");
  });

  it("omits environment_config when file is absent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-noenv-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    await mkdir(repo, { recursive: true });
    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;

    const { getWorkspaceStatus } = await import("../src/workflow-results.js");
    const result = await getWorkspaceStatus({ cwd: repo });

    expect(result.environment_config).toBeUndefined();
  });

  it("adds attention item when environment config has errors", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-envbad-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    const configDir = path.join(repo, ".codex-claude-delegate");
    await mkdir(repo, { recursive: true });
    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "environment.json"),
      JSON.stringify({ install: "" }),
    );

    const { getWorkspaceStatus } = await import("../src/workflow-results.js");
    const result = await getWorkspaceStatus({ cwd: repo });

    expect(result.environment_config).toBeDefined();
    expect(result.environment_config!.ok).toBe(false);
    expect(result.environment_config!.errors.length).toBeGreaterThan(0);
    expect(result.attention_items.some((item) => item.kind === "environment_config")).toBe(true);
  });
});
