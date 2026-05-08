import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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
