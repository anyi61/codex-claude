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

  // Phase 2 workspace status tests

  it("workspace status includes Phase 2 environment_config summary when present", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-p2-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    const configDir = path.join(repo, ".codex-claude-delegate");
    await mkdir(repo, { recursive: true });
    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "environment.json"),
      JSON.stringify({
        test: "npx vitest run",
        verification: {
          allowedScripts: ["test:unit", "lint"],
          timeoutSec: 180,
        },
        artifacts: { retentionDays: 30 },
        environment: { passthrough: ["MY_VAR"] },
      }),
    );

    const { getWorkspaceStatus } = await import("../src/workflow-results.js");
    const result = await getWorkspaceStatus({ cwd: repo });

    expect(result.environment_config).toBeDefined();
    expect(result.environment_config!.ok).toBe(true);
    expect(result.environment_config!.verification_allowed_scripts_count).toBe(2);
    expect(result.environment_config!.verification_allowed_scripts).toEqual(["test:unit", "lint"]);
    expect(result.environment_config!.verification_timeout_sec).toBe(180);
    expect(result.environment_config!.artifacts_retention_days).toBe(30);
    expect(result.environment_config!.environment_passthrough_count).toBe(1);
    expect(result.environment_config!.environment_passthrough).toEqual(["MY_VAR"]);
    // Must not leak command values
    const jsonStr = JSON.stringify(result.environment_config);
    expect(jsonStr).not.toContain("vitest");
  });

  it("attention items work for Phase 2 errors", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-p2bad-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    const configDir = path.join(repo, ".codex-claude-delegate");
    await mkdir(repo, { recursive: true });
    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "environment.json"),
      JSON.stringify({
        verification: { allowedScripts: ["install"] },
      }),
    );

    const { getWorkspaceStatus } = await import("../src/workflow-results.js");
    const result = await getWorkspaceStatus({ cwd: repo });

    expect(result.environment_config).toBeDefined();
    expect(result.environment_config!.ok).toBe(false);
    expect(result.attention_items.some((item) =>
      item.kind === "environment_config" && item.message.includes("error"),
    )).toBe(true);
  });

  it("attention items work for Phase 2 warnings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-p2warn-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    const configDir = path.join(repo, ".codex-claude-delegate");
    await mkdir(repo, { recursive: true });
    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "environment.json"),
      JSON.stringify({
        unknown_field: "value",
      }),
    );

    const { getWorkspaceStatus } = await import("../src/workflow-results.js");
    const result = await getWorkspaceStatus({ cwd: repo });

    expect(result.environment_config).toBeDefined();
    expect(result.environment_config!.warnings.length).toBeGreaterThan(0);
    expect(result.attention_items.some((item) =>
      item.kind === "environment_config" && item.message.includes("warning"),
    )).toBe(true);
  });

  // ---- UX/RUN-GROUP-001: result and workspace grouping tests ----

  it("getClaudeResult includes run_group for grouped run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-group-result-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    const logDir = path.join(repo, ".codex-claude-delegate", "runs");
    await mkdir(repo, { recursive: true });
    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;

    await writeRunLogEntry(logDir, "run-a", {
      type: "implement",
      input: { cwd: repo },
      report: { status: "success", summary: "First attempt" },
      goal_item_id: "UX/RUN-GROUP-001",
    });
    await writeRunLogEntry(logDir, "run-b", {
      type: "implement",
      input: { cwd: repo },
      report: { status: "success", summary: "Second attempt" },
      goal_item_id: "UX/RUN-GROUP-001",
      supersedes_run_id: "run-a",
    });

    const { getClaudeResult } = await import("../src/workflow-results.js");
    const result = await getClaudeResult({ cwd: repo, run_id: "run-b" });

    expect(result.run?.goal_item_id).toBe("UX/RUN-GROUP-001");
    expect(result.run_group).toBeDefined();
    expect(result.run_group!.goal_item_id).toBe("UX/RUN-GROUP-001");
    expect(result.run_group!.run_count).toBe(2);
    expect(result.run_group!.superseded_run_ids).toContain("run-a");
  });

  it("getClaudeResult omits run_group for ungrouped run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-no-group-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    const logDir = path.join(repo, ".codex-claude-delegate", "runs");
    await mkdir(repo, { recursive: true });
    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;

    await writeRunLogEntry(logDir, "run-old", {
      type: "query",
      input: { cwd: repo },
      report: { status: "success", summary: "Old run" },
    });

    const { getClaudeResult } = await import("../src/workflow-results.js");
    const result = await getClaudeResult({ cwd: repo, run_id: "run-old" });

    expect(result.run_group).toBeUndefined();
  });

  it("workspace status includes recent run groups", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-groups-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    const logDir = path.join(repo, ".codex-claude-delegate", "runs");
    await mkdir(repo, { recursive: true });
    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;

    await writeRunLogEntry(logDir, "run-g1", {
      type: "implement",
      input: { cwd: repo },
      report: { status: "success", summary: "G1" },
      goal_item_id: "UX/RUN-GROUP-001",
    });
    await writeRunLogEntry(logDir, "run-g2", {
      type: "implement",
      input: { cwd: repo },
      report: { status: "success", summary: "G2" },
      goal_item_id: "UX/RUN-GROUP-001",
      supersedes_run_id: "run-g1",
    });
    await writeRunLogEntry(logDir, "run-audit", {
      type: "implement",
      input: { cwd: repo },
      report: { status: "success", summary: "Audit" },
      goal_item_id: "AUDIT-DOCS-003",
    });

    const { getWorkspaceStatus } = await import("../src/workflow-results.js");
    const result = await getWorkspaceStatus({ cwd: repo });

    expect(result.run_groups.length).toBe(2);
    expect(result.counts.run_groups).toBe(2);
    const group1 = result.run_groups.find((g) => g.goal_item_id === "UX/RUN-GROUP-001");
    expect(group1).toBeDefined();
    expect(group1!.run_count).toBe(2);
    expect(group1!.latest_lifecycle).toBeDefined();
    expect(result.recent_runs.length).toBe(3);
  });

  it("workspace status remains compatible without grouped runs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-no-groups-"));
    cleanupPaths.push(root);
    const repo = path.join(root, "repo");
    const stateDir = path.join(root, ".codex-claude-delegate");
    const logDir = path.join(repo, ".codex-claude-delegate", "runs");
    await mkdir(repo, { recursive: true });
    process.env.CODEX_CLAUDE_BACKGROUND_STATE_DIR = stateDir;

    await writeRunLogEntry(logDir, "run-plain", {
      type: "query",
      input: { cwd: repo },
      report: { status: "success" },
    });

    const { getWorkspaceStatus } = await import("../src/workflow-results.js");
    const result = await getWorkspaceStatus({ cwd: repo });

    expect(result.run_groups).toEqual([]);
    expect(result.counts.run_groups).toBe(0);
    expect(result.recent_runs.length).toBe(1);
  });
});
