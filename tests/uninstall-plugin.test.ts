import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const scriptPath = path.resolve(import.meta.dirname, "..", "scripts", "uninstall-plugin.mjs");

function runScript(extraArgs: string[], env?: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
  try {
    const cleanEnv: Record<string, string | undefined> = {
      ...process.env,
      // Prevent host environment allow roots from leaking into test
      CODEX_CLAUDE_ALLOW_ROOTS: "",
      ...env,
    };
    // Remove blank entries (ensuring unset rather than empty string)
    for (const k of Object.keys(cleanEnv)) {
      if (cleanEnv[k] === undefined || cleanEnv[k] === "") delete cleanEnv[k];
    }
    const stdout = execFileSync(
      process.execPath,
      [scriptPath, ...extraArgs],
      {
        encoding: "utf8",
        timeout: 30000,
        env: cleanEnv as NodeJS.ProcessEnv,
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

    it("ignores dangerous broad allow roots during workspace discovery", async () => {
      const configPath = path.join(codexHome, "config.toml");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, [
        "[mcp_servers.claude_delegate.env]",
        `CODEX_CLAUDE_ALLOW_ROOTS = "/:/tmp:/etc:${process.env.HOME ?? os.homedir()}:${repoRoot}"`,
        "",
      ].join("\n"), "utf8");

      const { stdout, exitCode } = runScript(["--dry-run"], {
        CODEX_HOME: codexHome,
        CODEX_UNINSTALL_REPO_ROOT: repoRoot,
        HOME: process.env.HOME ?? os.homedir(),
      });

      expect(exitCode).toBe(0);
      expect(stdout).toContain(repoRoot);
      expect(stdout).not.toContain("    - /");
      expect(stdout).not.toContain("    - /tmp");
      expect(stdout).not.toContain("    - /etc");
    });

    it("discovers direct child workspaces under configured allow roots", async () => {
      const projectsRoot = path.join(tmpDir, "projects");
      const childRepo = path.join(projectsRoot, "child-repo");
      await mkdir(path.join(childRepo, ".codex-claude-delegate", "runs"), { recursive: true });
      await writeFile(path.join(childRepo, ".codex-claude-delegate", "runs", "child.json"), JSON.stringify({ input: { cwd: childRepo } }), "utf8");

      const configPath = path.join(codexHome, "config.toml");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, [
        "[mcp_servers.claude_delegate.env]",
        `CODEX_CLAUDE_ALLOW_ROOTS = "${projectsRoot}"`,
        "",
      ].join("\n"), "utf8");

      const { stdout } = runScript(["--dry-run"], {
        CODEX_HOME: codexHome,
        CODEX_UNINSTALL_REPO_ROOT: repoRoot,
      });

      expect(stdout).toContain(childRepo);
      expect(stdout).toContain("child.json");
    });

    it("groups dry-run resources by global config and known workspaces", async () => {
      const repoA = repoRoot;
      const repoB = path.join(tmpDir, "repo-b");
      const repoC = path.join(tmpDir, "repo-c");

      await mkdir(path.join(repoA, ".claude", "worktrees", "codex-delegated-a"), { recursive: true });
      await mkdir(path.join(repoB, ".codex-claude-delegate", "runs"), { recursive: true });
      await writeFile(
        path.join(repoB, ".codex-claude-delegate", "runs", "run-b.json"),
        JSON.stringify({ type: "implement", input: { cwd: repoB }, observed: { worktree_path: ".claude/worktrees/codex-delegated-b" } }),
        "utf8",
      );
      await mkdir(path.join(repoB, ".claude", "worktrees", "codex-delegated-b"), { recursive: true });
      await mkdir(path.join(repoC, ".codex-claude-delegate"), { recursive: true });
      await writeFile(path.join(repoC, ".codex-claude-delegate", "review-gate.json"), JSON.stringify({ workspace_root: repoC, enabled: true }), "utf8");

      const configPath = path.join(codexHome, "config.toml");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, [
        "[mcp_servers.claude_delegate]",
        'command = "node"',
        'args = ["./server/server.js"]',
        "",
        "[mcp_servers.claude_delegate.env]",
        `CODEX_CLAUDE_ALLOW_ROOTS = "${repoA}:${repoB}:${repoC}"`,
        "",
      ].join("\n"), "utf8");

      const { stdout, exitCode } = runScript(["--dry-run"], {
        CODEX_HOME: codexHome,
        CODEX_UNINSTALL_REPO_ROOT: repoA,
      });

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Global resources:");
      expect(stdout).toContain("Workspace resources:");
      expect(stdout).toContain(repoA);
      expect(stdout).toContain(repoB);
      expect(stdout).toContain(repoC);
      expect(stdout).toContain(path.join(repoA, ".claude", "worktrees", "codex-delegated-a"));
      expect(stdout).toContain(path.join(repoB, ".claude", "worktrees", "codex-delegated-b"));
    });

    it("reports state directories for every known workspace in dry-run", async () => {
      const repoB = path.join(tmpDir, "repo-b");
      await mkdir(path.join(repoB, ".codex-claude-delegate", "jobs"), { recursive: true });
      await writeFile(path.join(repoB, ".codex-claude-delegate", "jobs", "job-b.json"), JSON.stringify({ cwd: repoB }), "utf8");

      const configPath = path.join(codexHome, "config.toml");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, [
        "[mcp_servers.claude_delegate.env]",
        `CODEX_CLAUDE_ALLOW_ROOTS = "${repoRoot}:${repoB}"`,
        "",
      ].join("\n"), "utf8");

      const { stdout } = runScript(["--dry-run"], {
        CODEX_HOME: codexHome,
        CODEX_UNINSTALL_REPO_ROOT: repoRoot,
      });

      expect(stdout).toContain(path.join(repoRoot, ".codex-claude-delegate"));
      expect(stdout).toContain(path.join(repoB, ".codex-claude-delegate"));
      expect(stdout).toContain("job-b.json");
    });
  });

  describe("non-dry-run", () => {
    it("removes all discovered workspace roots from MCP env CODEX_CLAUDE_ALLOW_ROOTS", async () => {
      const repoA = repoRoot;
      const repoB = path.join(tmpDir, "repo-b");
      await mkdir(repoB, { recursive: true });

      const configPath = path.join(codexHome, "config.toml");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, [
        "[mcp_servers.claude_delegate]",
        'command = "node"',
        'args = ["./server/server.js"]',
        "",
        "[mcp_servers.claude_delegate.env]",
        `CODEX_CLAUDE_ALLOW_ROOTS = "${repoA}:${repoB}:/keep-me"`,
        "",
      ].join("\n"), "utf8");

      const { exitCode } = runScript(["--yes"], {
        CODEX_HOME: codexHome,
        CODEX_UNINSTALL_REPO_ROOT: repoA,
      });

      expect(exitCode).toBe(0);
      const after = await readFile(configPath, "utf8");
      // codex mcp remove claude_delegate removes the entire MCP section including .env,
      // which nukes the allow roots. No per-root "Removed" messages are emitted because
      // the section-level removal handles it before per-root iteration runs.
      expect(after).not.toContain(repoA);
      expect(after).not.toContain(repoB);
    });

    it("removes npm global codex-claude MCP config under --yes", async () => {
      const configPath = path.join(codexHome, "config.toml");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, [
        "[mcp_servers.claude_delegate]",
        'command = "codex-claude"',
        'startup_timeout_sec = 20',
        'tool_timeout_sec = 600',
        "",
        "[mcp_servers.claude_delegate.env]",
        `CODEX_CLAUDE_ALLOW_ROOTS = "${repoRoot}"`,
        "",
      ].join("\n"), "utf8");

      const { exitCode } = runScript(["--yes"], {
        CODEX_HOME: codexHome,
        CODEX_UNINSTALL_REPO_ROOT: repoRoot,
      });

      expect(exitCode).toBe(0);
      const after = await readFile(configPath, "utf8");
      expect(after).not.toContain("[mcp_servers.claude_delegate]");
    expect(after).not.toContain("codex-claude");
  });

  it("removes all discovered workspace roots from shell env CODEX_CLAUDE_ALLOW_ROOTS", async () => {
      const repoA = repoRoot;
      const repoB = path.join(tmpDir, "repo-b");
      await mkdir(repoB, { recursive: true });

      const configPath = path.join(codexHome, "config.toml");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, [
        "[shell_environment_policy.set]",
        `CODEX_CLAUDE_ALLOW_ROOTS = "${repoA}:${repoB}:/keep-me"`,
        "",
      ].join("\n"), "utf8");

      const { exitCode } = runScript(["--yes"], {
        CODEX_HOME: codexHome,
        CODEX_UNINSTALL_REPO_ROOT: repoA,
      });

      expect(exitCode).toBe(0);
      const after = await readFile(configPath, "utf8");
      expect(after).not.toContain(repoA);
      expect(after).not.toContain(repoB);
      expect(after).toContain("/keep-me");
    });

    it("cleans state directories for every known workspace when keep-state is none", async () => {
      const repoB = path.join(tmpDir, "repo-b");
      await mkdir(path.join(repoB, ".codex-claude-delegate", "jobs"), { recursive: true });
      await writeFile(path.join(repoB, ".codex-claude-delegate", "jobs", "job-b.json"), JSON.stringify({ cwd: repoB }), "utf8");

      const configPath = path.join(codexHome, "config.toml");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, [
        "[mcp_servers.claude_delegate.env]",
        `CODEX_CLAUDE_ALLOW_ROOTS = "${repoRoot}:${repoB}"`,
        "",
      ].join("\n"), "utf8");

      const { exitCode } = runScript(["--yes", "--keep-state=none"], {
        CODEX_HOME: codexHome,
        CODEX_UNINSTALL_REPO_ROOT: repoRoot,
      });

      expect(exitCode).toBe(0);
      expect(existsSync(path.join(repoRoot, ".codex-claude-delegate"))).toBe(false);
      expect(existsSync(path.join(repoB, ".codex-claude-delegate"))).toBe(false);
    });

    it("does not delete delegated worktrees during non-dry-run uninstall", async () => {
      const worktreePath = path.join(repoRoot, ".claude", "worktrees", "codex-delegated-keep");
      await mkdir(worktreePath, { recursive: true });

      const { stdout, exitCode } = runScript(["--yes", "--keep-state=all"], {
        CODEX_HOME: codexHome,
        CODEX_UNINSTALL_REPO_ROOT: repoRoot,
      });

      expect(exitCode).toBe(0);
      expect(stdout).toContain(worktreePath);
      expect(existsSync(worktreePath)).toBe(true);
    });
  });
});
