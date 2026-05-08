import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const scriptPath = path.resolve(import.meta.dirname, "..", "scripts", "uninstall-plugin.mjs");

function runScript(extraArgs: string[], env?: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync(
      process.execPath,
      [scriptPath, ...extraArgs],
      {
        encoding: "utf8",
        timeout: 30000,
        env: { ...process.env, ...env },
        stdio: "pipe",
      },
    );
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    if (err && typeof err === "object" && "stdout" in err && "stderr" in err) {
      return {
        stdout: String(err.stdout),
        stderr: String(err.stderr),
        exitCode: typeof err.code === "number" ? err.code : 1,
      };
    }
    throw err;
  }
}

describe("uninstall-plugin.mjs", () => {
  let tmpDir: string;
  let codexHome: string;
  let repoRoot: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "uninstall-test-"));
    codexHome = path.join(tmpDir, ".codex");
    repoRoot = path.join(tmpDir, "repo");
    await mkdir(path.join(codexHome), { recursive: true });
    await mkdir(repoRoot, { recursive: true });

    // Create a dummy state dir in the "repo"
    const stateDir = path.join(repoRoot, ".codex-claude-delegate");
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "sessions.json"), "{}", "utf8");
    await writeFile(path.join(stateDir, "review-gate.json"), '{"enabled":true}', "utf8");
    await mkdir(path.join(stateDir, "jobs"), { recursive: true });
    await writeFile(path.join(stateDir, "jobs", "test.json"), "{}", "utf8");
    await mkdir(path.join(stateDir, "runs"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    await rm(path.join(repoRoot, ".codex-claude-delegate"), { recursive: true, force: true });
  });

  describe("--dry-run", () => {
    it("does not write config and does not delete state dir", async () => {
      const configPath = path.join(codexHome, "config.toml");
      const configContent = [
        '[mcp_servers.claude_delegate]',
        'command = "node"',
        'args = ["./server/server.js"]',
        "",
        '[mcp_servers.claude_delegate.env]',
        `CODEX_CLAUDE_ALLOW_ROOTS = "${repoRoot}:/other"`,
        "",
      ].join("\n");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, configContent, "utf8");

      const { stdout, exitCode } = runScript(["--dry-run"], {
        CODEX_HOME: codexHome,
        CODEX_UNINSTALL_REPO_ROOT: repoRoot,
      });

      expect(exitCode).toBe(0);
      expect(stdout).toContain("(dry-run)");

      // Config unchanged
      const after = await readFile(configPath, "utf8");
      expect(after).toBe(configContent);

      // State dir untouched
      expect(existsSync(path.join(repoRoot, ".codex-claude-delegate", "sessions.json"))).toBe(true);
    });

    it("does not require pre-built dist/codex-config.js", async () => {
      // Remove the dist directory
      const distPath = path.join(repoRoot, "dist");
      if (existsSync(distPath)) {
        await rm(distPath, { recursive: true, force: true });
      }

      const { stdout, exitCode } = runScript(["--dry-run"], {
        CODEX_HOME: codexHome,
        CODEX_UNINSTALL_REPO_ROOT: repoRoot,
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain("(dry-run)");
    });
  });

  describe("output messages", () => {
    it("mentions dry-run mode in output", async () => {
      const { stdout } = runScript(["--dry-run"], {
        CODEX_HOME: codexHome,
        CODEX_UNINSTALL_REPO_ROOT: repoRoot,
      });
      expect(stdout).toContain("(dry-run)");
    });

    it("shows scan results for config", async () => {
      const configPath = path.join(codexHome, "config.toml");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, [
        '[mcp_servers.claude_delegate]',
        'command = "node"',
        'args = ["./server/server.js"]',
        "",
      ].join("\n"), "utf8");

      const { stdout } = runScript(["--dry-run"], {
        CODEX_HOME: codexHome,
        CODEX_UNINSTALL_REPO_ROOT: repoRoot,
      });
      expect(stdout).toContain("Config:");
      expect(stdout).toContain("auto");
    });

    it("does not classify arbitrary node server paths as auto", async () => {
      const configPath = path.join(codexHome, "config.toml");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, [
        '[mcp_servers.claude_delegate]',
        'command = "node"',
        'args = ["/tmp/other-plugin/server/server.js"]',
        "",
      ].join("\n"), "utf8");

      const { stdout } = runScript(["--dry-run"], {
        CODEX_HOME: codexHome,
        CODEX_UNINSTALL_REPO_ROOT: repoRoot,
      });
      expect(stdout).toContain("Config:");
      expect(stdout).toContain("manual");
      expect(stdout).not.toContain("MCP origin:  auto");
    });

    it("reports state directory items", async () => {
      const { stdout } = runScript(["--dry-run"], {
        CODEX_HOME: codexHome,
        CODEX_UNINSTALL_REPO_ROOT: repoRoot,
      });
      expect(stdout).toContain("sessions.json");
      expect(stdout).toContain("review-gate.json");
      expect(stdout).toContain("jobs");
      expect(stdout).toContain("runs");
    });

    it("reports worktrees when present", async () => {
      // Create a fake delegated worktree
      const worktreesDir = path.join(repoRoot, ".claude", "worktrees");
      await mkdir(worktreesDir, { recursive: true });
      await mkdir(path.join(worktreesDir, "codex-delegated-abc123"), { recursive: true });

      const { stdout } = runScript(["--dry-run"], {
        CODEX_HOME: codexHome,
        CODEX_UNINSTALL_REPO_ROOT: repoRoot,
      });
      expect(stdout).toContain("codex-delegated-");

      await rm(worktreesDir, { recursive: true, force: true });
    });

    it("reports delegated worktrees from configured workspaces outside the uninstall repo", async () => {
      const otherRepo = path.join(tmpDir, "other-repo");
      const otherWorktreesDir = path.join(otherRepo, ".claude", "worktrees");
      await mkdir(path.join(repoRoot, ".claude", "worktrees"), { recursive: true });
      await mkdir(otherWorktreesDir, { recursive: true });
      await mkdir(path.join(otherWorktreesDir, "codex-delegated-other"), { recursive: true });

      const configPath = path.join(codexHome, "config.toml");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, [
        '[mcp_servers.claude_delegate]',
        'command = "node"',
        'args = ["./server/server.js"]',
        "",
        '[mcp_servers.claude_delegate.env]',
        `CODEX_CLAUDE_ALLOW_ROOTS = "${repoRoot}:${otherRepo}"`,
        "",
      ].join("\n"), "utf8");

      const { stdout } = runScript(["--dry-run"], {
        CODEX_HOME: codexHome,
        CODEX_UNINSTALL_REPO_ROOT: repoRoot,
      });

      expect(stdout).toContain(path.join(otherWorktreesDir, "codex-delegated-other"));
    });

    it("handles config file not existing gracefully", async () => {
      const { stdout, exitCode } = runScript(["--dry-run"], {
        CODEX_HOME: codexHome,
        CODEX_UNINSTALL_REPO_ROOT: repoRoot,
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain("(not found)");
    });
  });
});
