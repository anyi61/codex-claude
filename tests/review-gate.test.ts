import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const cleanupPaths: string[] = [];
const projectRoot = process.cwd();
const hookManifestPath = path.join(projectRoot, "plugins", "codex-claude-delegate", "hooks", "hooks.json");
const originalHookManifest = existsSync(hookManifestPath) ? readFileSync(hookManifestPath, "utf8") : null;

afterEach(async () => {
  if (originalHookManifest === null) {
    try {
      await rm(hookManifestPath, { force: true });
    } catch {
      // ignore
    }
  } else {
    writeFileSync(hookManifestPath, originalHookManifest, "utf8");
  }

  while (cleanupPaths.length > 0) {
    await rm(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

async function createFixtureRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-review-gate-"));
  cleanupPaths.push(root);
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  return { root, repo };
}

describe("review gate persistence", () => {
  it("persists enable/status/disable transitions and treats duplicate enable as unchanged", async () => {
    const { repo } = await createFixtureRepo();
    const reloaded = await import("../src/claude-cli.js");

    const statusBefore = await reloaded.manageClaudeReviewGate({ cwd: repo, action: "status" });
    expect(statusBefore.enabled).toBe(false);
    expect(statusBefore.changed).toBe(false);

    const enabled = await reloaded.manageClaudeReviewGate({ cwd: repo, action: "enable" });
    expect(enabled.enabled).toBe(true);
    expect(enabled.changed).toBe(true);
    expect(enabled.hook_installed).toBe(true);
    expect(enabled.summary).toMatch(/enabled/);

    const configRaw = await readFile(path.join(repo, ".codex-claude-delegate", "review-gate.json"), "utf8");
    const config = JSON.parse(configRaw) as { enabled?: boolean; pending_review?: boolean };
    expect(config.enabled).toBe(true);
    expect(config.pending_review).toBe(false);

    const statusEnabled = await reloaded.manageClaudeReviewGate({ cwd: repo, action: "status" });
    expect(statusEnabled.enabled).toBe(true);
    expect(statusEnabled.changed).toBe(false);

    const enabledAgain = await reloaded.manageClaudeReviewGate({ cwd: repo, action: "enable" });
    expect(enabledAgain.enabled).toBe(true);
    expect(enabledAgain.changed).toBe(false);

    const disabled = await reloaded.manageClaudeReviewGate({ cwd: repo, action: "disable" });
    expect(disabled.enabled).toBe(false);
    expect(disabled.changed).toBe(true);
    expect(disabled.summary).toMatch(/disabled/);

    const statusDisabled = await reloaded.manageClaudeReviewGate({ cwd: repo, action: "status" });
    expect(statusDisabled.enabled).toBe(false);
    expect(statusDisabled.changed).toBe(false);
  });

  it("review gate hook resolves workspace from CODEX_WORKSPACE_ROOT", async () => {
    const { repo } = await createFixtureRepo();
    const stateDir = path.join(repo, ".codex-claude-delegate");
    await mkdir(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "review-gate.json"), JSON.stringify({
      enabled: true,
      pending_review: true,
    }));

    const hookPath = path.join(projectRoot, "plugins", "codex-claude-delegate", "hooks", "review-gate-stop.mjs");
    const output = execFileSync(process.execPath, [hookPath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        CODEX_WORKSPACE_ROOT: repo,
        PWD: projectRoot,
      },
      encoding: "utf8",
    });
    const payload = JSON.parse(output);

    expect(payload.review_gate.enabled).toBe(true);
    expect(payload.review_gate.pending_review).toBe(true);
    expect(payload.review_gate.workspace_root).toBe(repo);
    expect(payload.systemMessage).toMatch(/Review gate is enabled/);
  });
});

describe("review gate pending metadata", () => {
  it("old state without new fields still reads/statuses", async () => {
    const { repo } = await createFixtureRepo();
    const stateDir = path.join(repo, ".codex-claude-delegate");
    await mkdir(stateDir, { recursive: true });
    // Write a legacy state file without the new fields
    writeFileSync(path.join(stateDir, "review-gate.json"), JSON.stringify({
      workspace_root: repo,
      enabled: true,
      pending_review: true,
      mode: "soft-stop",
    }));

    const reloaded = await import("../src/claude-cli.js");
    const status = await reloaded.manageClaudeReviewGate({ cwd: repo, action: "status" });

    expect(status.enabled).toBe(true);
    expect(status.pending_review).toBe(true);
    expect(status.pending_activity).toBeUndefined();
    expect(status.pending_run_id).toBeUndefined();
    expect(status.pending_worktree_path).toBeUndefined();
  });

  it("pending write metadata is persisted by markReviewGatePending", async () => {
    const { repo } = await createFixtureRepo();
    const reloaded = await import("../src/claude-cli.js");

    await reloaded.manageClaudeReviewGate({ cwd: repo, action: "enable" });

    const { markReviewGatePending } = await import("../src/review-gate.js");
    await markReviewGatePending(repo, {
      activity: "write",
      run_id: "run-implement-123",
      worktree_path: ".claude/worktrees/codex-delegated-abc",
    });

    const configRaw = await readFile(path.join(repo, ".codex-claude-delegate", "review-gate.json"), "utf8");
    const config = JSON.parse(configRaw);

    expect(config.pending_review).toBe(true);
    expect(config.pending_activity).toBe("write");
    expect(config.pending_run_id).toBe("run-implement-123");
    expect(config.pending_worktree_path).toBe(".claude/worktrees/codex-delegated-abc");

    const status = await reloaded.manageClaudeReviewGate({ cwd: repo, action: "status" });
    expect(status.pending_review).toBe(true);
    expect(status.pending_activity).toBe("write");
    expect(status.pending_run_id).toBe("run-implement-123");
    expect(status.pending_worktree_path).toBe(".claude/worktrees/codex-delegated-abc");
  });

  it("pending apply metadata is persisted by markReviewGatePending", async () => {
    const { repo } = await createFixtureRepo();
    const reloaded = await import("../src/claude-cli.js");

    await reloaded.manageClaudeReviewGate({ cwd: repo, action: "enable" });

    const { markReviewGatePending } = await import("../src/review-gate.js");
    await markReviewGatePending(repo, {
      activity: "apply",
      run_id: "run-apply-456",
      worktree_path: ".claude/worktrees/codex-delegated-def",
    });

    const configRaw = await readFile(path.join(repo, ".codex-claude-delegate", "review-gate.json"), "utf8");
    const config = JSON.parse(configRaw);

    expect(config.pending_review).toBe(true);
    expect(config.pending_activity).toBe("apply");
    expect(config.pending_run_id).toBe("run-apply-456");
    expect(config.pending_worktree_path).toBe(".claude/worktrees/codex-delegated-def");
  });

  it("clearReviewGatePendingIfMatches clears only when reviewed_run_id matches pending_run_id and records last_cleared_by_review_run_id", async () => {
    const { repo } = await createFixtureRepo();
    const reloaded = await import("../src/claude-cli.js");
    await reloaded.manageClaudeReviewGate({ cwd: repo, action: "enable" });

    const { markReviewGatePending, clearReviewGatePendingIfMatches } = await import("../src/review-gate.js");
    await markReviewGatePending(repo, {
      activity: "write",
      run_id: "run-implement-789",
      worktree_path: ".claude/worktrees/codex-delegated-ghi",
    });

    // Wrong run_id should not clear
    const wrongResult = await clearReviewGatePendingIfMatches(repo, {
      review_run_id: "review-run-1",
      reviewed_run_id: "wrong-run-id",
    });
    expect(wrongResult.cleared).toBe(false);
    expect(wrongResult.reason).toBe("run_id_mismatch");

    // Correct run_id should clear
    const correctResult = await clearReviewGatePendingIfMatches(repo, {
      review_run_id: "review-run-2",
      reviewed_run_id: "run-implement-789",
    });
    expect(correctResult.cleared).toBe(true);
    expect(correctResult.reason).toBe("cleared");

    const configRaw = await readFile(path.join(repo, ".codex-claude-delegate", "review-gate.json"), "utf8");
    const config = JSON.parse(configRaw);
    expect(config.pending_review).toBe(false);
    expect(config.pending_run_id).toBeUndefined();
    expect(config.pending_worktree_path).toBeUndefined();
    expect(config.last_cleared_by_review_run_id).toBe("review-run-2");
  });

  it("no binding does not clear", async () => {
    const { repo } = await createFixtureRepo();
    const reloaded = await import("../src/claude-cli.js");
    await reloaded.manageClaudeReviewGate({ cwd: repo, action: "enable" });

    const { markReviewGatePending, clearReviewGatePendingIfMatches } = await import("../src/review-gate.js");
    await markReviewGatePending(repo, {
      activity: "write",
      run_id: "run-implement-aaa",
    });

    // No binding at all should not clear
    const noBinding = await clearReviewGatePendingIfMatches(repo, {
      review_run_id: "review-run-x",
    });
    expect(noBinding.cleared).toBe(false);
    expect(noBinding.reason).toBe("no_binding");

    // Pending should still be true
    const configRaw = await readFile(path.join(repo, ".codex-claude-delegate", "review-gate.json"), "utf8");
    const config = JSON.parse(configRaw);
    expect(config.pending_review).toBe(true);
  });

  it("if reviewed_run_id and reviewed_worktree_path are both provided, both must match", async () => {
    const { repo } = await createFixtureRepo();
    const reloaded = await import("../src/claude-cli.js");
    await reloaded.manageClaudeReviewGate({ cwd: repo, action: "enable" });

    const { markReviewGatePending, clearReviewGatePendingIfMatches } = await import("../src/review-gate.js");
    await markReviewGatePending(repo, {
      activity: "write",
      run_id: "run-implement-bbb",
      worktree_path: ".claude/worktrees/codex-delegated-jkl",
    });

    // Matching run_id but wrong worktree_path should not clear
    const partialMatch = await clearReviewGatePendingIfMatches(repo, {
      review_run_id: "review-run-3",
      reviewed_run_id: "run-implement-bbb",
      reviewed_worktree_path: ".claude/worktrees/codex-delegated-wrong",
    });
    expect(partialMatch.cleared).toBe(false);
    expect(partialMatch.reason).toBe("worktree_path_mismatch");

    // Both matching should clear
    const fullMatch = await clearReviewGatePendingIfMatches(repo, {
      review_run_id: "review-run-4",
      reviewed_run_id: "run-implement-bbb",
      reviewed_worktree_path: ".claude/worktrees/codex-delegated-jkl",
    });
    expect(fullMatch.cleared).toBe(true);
    expect(fullMatch.reason).toBe("cleared");
  });

  it("clearReviewGatePendingIfMatches returns no_pending when nothing is pending", async () => {
    const { repo } = await createFixtureRepo();
    const reloaded = await import("../src/claude-cli.js");
    await reloaded.manageClaudeReviewGate({ cwd: repo, action: "enable" });

    const { clearReviewGatePendingIfMatches } = await import("../src/review-gate.js");

    const result = await clearReviewGatePendingIfMatches(repo, {
      review_run_id: "review-run-5",
      reviewed_run_id: "run-implement-ccc",
    });
    expect(result.cleared).toBe(false);
    expect(result.reason).toBe("no_pending");
  });

  it("clearReviewGatePendingIfMatches returns gate_not_enabled when gate is disabled", async () => {
    const { repo } = await createFixtureRepo();

    const { clearReviewGatePendingIfMatches } = await import("../src/review-gate.js");

    const result = await clearReviewGatePendingIfMatches(repo, {
      review_run_id: "review-run-6",
      reviewed_run_id: "run-implement-ddd",
    });
    expect(result.cleared).toBe(false);
    expect(result.reason).toBe("gate_not_enabled");
  });

  // ---- STATE-MACHINE-001: fault-injection coverage ----

  it("markReviewGatePending is no-op when gate is disabled", async () => {
    const { repo } = await createFixtureRepo();
    const statePath = path.join(repo, ".codex-claude-delegate", "review-gate.json");

    // Gate is not enabled (no state file at all)
    const { markReviewGatePending } = await import("../src/review-gate.js");
    await markReviewGatePending(repo, {
      activity: "write",
      run_id: "run-should-not-persist",
    });

    // State file should not be created
    expect(existsSync(statePath)).toBe(false);
  });

  it("markReviewGatePending is no-op when gate state file says enabled=false", async () => {
    const { repo } = await createFixtureRepo();
    const stateDir = path.join(repo, ".codex-claude-delegate");
    await mkdir(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "review-gate.json"), JSON.stringify({
      workspace_root: repo,
      enabled: false,
      pending_review: false,
      mode: "soft-stop",
    }));

    const { markReviewGatePending } = await import("../src/review-gate.js");
    await markReviewGatePending(repo, {
      activity: "write",
      run_id: "run-should-not-persist",
    });

    const configRaw = await readFile(path.join(stateDir, "review-gate.json"), "utf8");
    const config = JSON.parse(configRaw);
    expect(config.pending_review).toBe(false);
    expect(config.pending_run_id).toBeUndefined();
  });

  it("fingerprint match clears pending; mismatch does not clear", async () => {
    const { repo } = await createFixtureRepo();
    const reloaded = await import("../src/claude-cli.js");
    await reloaded.manageClaudeReviewGate({ cwd: repo, action: "enable" });

    const { markReviewGatePending, clearReviewGatePendingIfMatches } = await import("../src/review-gate.js");
    await markReviewGatePending(repo, {
      activity: "write",
      run_id: "run-fp-test",
      fingerprint: "fp-abc123",
    });

    // Mismatch fingerprint should not clear
    const mismatch = await clearReviewGatePendingIfMatches(repo, {
      review_run_id: "review-fp-1",
      reviewed_run_id: "run-fp-test",
      reviewed_fingerprint: "fp-wrong",
    });
    expect(mismatch.cleared).toBe(false);
    expect(mismatch.reason).toBe("fingerprint_mismatch");

    // Matching fingerprint should clear
    const match = await clearReviewGatePendingIfMatches(repo, {
      review_run_id: "review-fp-2",
      reviewed_run_id: "run-fp-test",
      reviewed_fingerprint: "fp-abc123",
    });
    expect(match.cleared).toBe(true);
    expect(match.reason).toBe("cleared");

    const configRaw = await readFile(path.join(repo, ".codex-claude-delegate", "review-gate.json"), "utf8");
    const config = JSON.parse(configRaw);
    expect(config.pending_review).toBe(false);
    expect(config.pending_fingerprint).toBeUndefined();
  });

  it("second pending mark overwrites first pending metadata", async () => {
    const { repo } = await createFixtureRepo();
    const reloaded = await import("../src/claude-cli.js");
    await reloaded.manageClaudeReviewGate({ cwd: repo, action: "enable" });

    const { markReviewGatePending } = await import("../src/review-gate.js");

    await markReviewGatePending(repo, {
      activity: "write",
      run_id: "run-first",
      worktree_path: ".claude/worktrees/codex-delegated-first",
      fingerprint: "fp-first",
    });

    await markReviewGatePending(repo, {
      activity: "apply",
      run_id: "run-second",
      worktree_path: ".claude/worktrees/codex-delegated-second",
      fingerprint: "fp-second",
    });

    const configRaw = await readFile(path.join(repo, ".codex-claude-delegate", "review-gate.json"), "utf8");
    const config = JSON.parse(configRaw);
    expect(config.pending_review).toBe(true);
    expect(config.pending_activity).toBe("apply");
    expect(config.pending_run_id).toBe("run-second");
    expect(config.pending_worktree_path).toBe(".claude/worktrees/codex-delegated-second");
    expect(config.pending_fingerprint).toBe("fp-second");
  });

  it("corrupt state file causes clearReviewGatePendingIfMatches to return gate_not_enabled (fail-closed)", async () => {
    const { repo } = await createFixtureRepo();
    const stateDir = path.join(repo, ".codex-claude-delegate");
    await mkdir(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "review-gate.json"), "NOT VALID JSON {{{");

    const { clearReviewGatePendingIfMatches } = await import("../src/review-gate.js");
    const result = await clearReviewGatePendingIfMatches(repo, {
      review_run_id: "review-corrupt",
      reviewed_run_id: "run-corrupt",
    });
    expect(result.cleared).toBe(false);
    expect(result.reason).toBe("gate_not_enabled");
  });

  it("deleted state file causes clearReviewGatePendingIfMatches to return gate_not_enabled (fail-closed)", async () => {
    const { repo } = await createFixtureRepo();
    const reloaded = await import("../src/claude-cli.js");
    await reloaded.manageClaudeReviewGate({ cwd: repo, action: "enable" });

    const { clearReviewGatePendingIfMatches } = await import("../src/review-gate.js");

    // Delete the state file
    await rm(path.join(repo, ".codex-claude-delegate", "review-gate.json"), { force: true });

    const result = await clearReviewGatePendingIfMatches(repo, {
      review_run_id: "review-deleted",
      reviewed_run_id: "run-deleted",
    });
    expect(result.cleared).toBe(false);
    expect(result.reason).toBe("gate_not_enabled");
  });

  // ---- STATE-MACHINE-002: fingerprint binding fault-injection coverage ----

  it("clearReviewGatePendingIfMatches clears when only reviewed_fingerprint matches (no run_id or worktree)", async () => {
    const { repo } = await createFixtureRepo();
    const reloaded = await import("../src/claude-cli.js");
    await reloaded.manageClaudeReviewGate({ cwd: repo, action: "enable" });

    const { markReviewGatePending, clearReviewGatePendingIfMatches } = await import("../src/review-gate.js");
    await markReviewGatePending(repo, {
      activity: "write",
      run_id: "run-fp-only",
      fingerprint: "fp-sole-binding",
    });

    // Only fingerprint provided — no run_id or worktree
    const result = await clearReviewGatePendingIfMatches(repo, {
      review_run_id: "review-fp-sole",
      reviewed_fingerprint: "fp-sole-binding",
    });
    expect(result.cleared).toBe(true);
    expect(result.reason).toBe("cleared");

    const configRaw = await readFile(path.join(repo, ".codex-claude-delegate", "review-gate.json"), "utf8");
    const config = JSON.parse(configRaw);
    expect(config.pending_review).toBe(false);
    expect(config.pending_fingerprint).toBeUndefined();
  });

  it("clearReviewGatePendingIfMatches returns fingerprint_mismatch when pending fingerprint is empty string and input is non-empty", async () => {
    const { repo } = await createFixtureRepo();
    const reloaded = await import("../src/claude-cli.js");
    await reloaded.manageClaudeReviewGate({ cwd: repo, action: "enable" });

    const { markReviewGatePending, clearReviewGatePendingIfMatches } = await import("../src/review-gate.js");
    await markReviewGatePending(repo, {
      activity: "write",
      run_id: "run-empty-fp",
      fingerprint: "",
    });

    const result = await clearReviewGatePendingIfMatches(repo, {
      review_run_id: "review-empty-fp",
      reviewed_run_id: "run-empty-fp",
      reviewed_fingerprint: "fp-non-empty",
    });
    expect(result.cleared).toBe(false);
    expect(result.reason).toBe("fingerprint_mismatch");
  });

  it("clearReviewGatePendingIfMatches rejects when all three matchers provided but fingerprint mismatches", async () => {
    const { repo } = await createFixtureRepo();
    const reloaded = await import("../src/claude-cli.js");
    await reloaded.manageClaudeReviewGate({ cwd: repo, action: "enable" });

    const { markReviewGatePending, clearReviewGatePendingIfMatches } = await import("../src/review-gate.js");
    await markReviewGatePending(repo, {
      activity: "write",
      run_id: "run-triple",
      worktree_path: ".claude/worktrees/codex-delegated-triple",
      fingerprint: "fp-triple-correct",
    });

    // run_id and worktree match, but fingerprint mismatches
    const result = await clearReviewGatePendingIfMatches(repo, {
      review_run_id: "review-triple",
      reviewed_run_id: "run-triple",
      reviewed_worktree_path: ".claude/worktrees/codex-delegated-triple",
      reviewed_fingerprint: "fp-triple-wrong",
    });
    expect(result.cleared).toBe(false);
    expect(result.reason).toBe("fingerprint_mismatch");

    // Pending should still be true
    const configRaw = await readFile(path.join(repo, ".codex-claude-delegate", "review-gate.json"), "utf8");
    const config = JSON.parse(configRaw);
    expect(config.pending_review).toBe(true);
    expect(config.pending_run_id).toBe("run-triple");
  });

  it("clearReviewGatePendingIfMatches treats empty string reviewed_fingerprint as stale fingerprint", async () => {
    const { repo } = await createFixtureRepo();
    const reloaded = await import("../src/claude-cli.js");
    await reloaded.manageClaudeReviewGate({ cwd: repo, action: "enable" });

    const { markReviewGatePending, clearReviewGatePendingIfMatches } = await import("../src/review-gate.js");
    await markReviewGatePending(repo, {
      activity: "apply",
      run_id: "run-str-fp",
      fingerprint: "fp-real",
    });

    const result = await clearReviewGatePendingIfMatches(repo, {
      review_run_id: "review-str-fp",
      reviewed_run_id: "run-str-fp",
      reviewed_fingerprint: "",
    });
    expect(result.cleared).toBe(false);
    expect(result.reason).toBe("fingerprint_mismatch");

    const configRaw = await readFile(path.join(repo, ".codex-claude-delegate", "review-gate.json"), "utf8");
    const config = JSON.parse(configRaw);
    expect(config.pending_review).toBe(true);
    expect(config.pending_fingerprint).toBe("fp-real");
  });
});
