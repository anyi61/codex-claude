import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_ENABLED_TOOLS,
  classifyMcpServerSection,
  configureCodexAllowRoot,
  deleteTomlTableKey,
  readTableKeys,
  removeAllowRoot,
  removeConfirmedMcpServerSection,
  removeOrFlagMcpServerSection,
  removePathFromAllowRootsValue,
  renderClaudeDelegateMcpConfig,
  scanClaudeDelegateConfig,
  setupWrite,
  upsertClaudeDelegateMcpServer,
} from "../src/codex-config.js";

let root: string;
let oldEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
  oldEnv = { ...process.env };
  root = await mkdtemp(path.join(os.tmpdir(), "codex-config-"));
  process.env.CODEX_HOME = path.join(root, ".codex");
  process.env.HOME = root;
  delete process.env.CODEX_CLAUDE_ALLOW_ROOTS;
});

afterEach(async () => {
  process.env = oldEnv;
  await rm(root, { recursive: true, force: true });
});

describe("Codex MCP config helpers", () => {
  it("adds cwd to claude_delegate allow roots and normalizes comma-separated values", async () => {
    const projectA = path.join(root, "project-a");
    const projectB = path.join(root, "project-b");
    await mkdir(projectA, { recursive: true });
    await mkdir(projectB, { recursive: true });
    const configPath = path.join(process.env.CODEX_HOME!, "config.toml");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, [
      "[mcp_servers.claude_delegate]",
      "command = \"node\"",
      "",
      "[mcp_servers.claude_delegate.env]",
      `CODEX_CLAUDE_ALLOW_ROOTS = "${projectA},${projectB}"`,
      "",
    ].join("\n"), "utf8");

    const projectC = path.join(root, "project-c");
    await mkdir(projectC);
    const projectCReal = await realpath(projectC);

    const result = await configureCodexAllowRoot(projectC);
    const config = await readFile(configPath, "utf8");

    expect(result.changed).toBe(true);
    expect(result.allow_roots).toEqual([projectA, projectB, projectCReal]);
    expect(result.env_value).toBe([projectA, projectB, projectCReal].join(path.delimiter));
    expect(process.env.CODEX_CLAUDE_ALLOW_ROOTS).toBe(result.env_value);
    expect(config).toContain(`CODEX_CLAUDE_ALLOW_ROOTS = "${result.env_value}"`);
  });

  it("writes plugin-mode allow roots to shell environment instead of creating an invalid MCP server", async () => {
    const projectA = path.join(root, "project-a");
    const projectB = path.join(root, "project-b");
    await mkdir(projectA, { recursive: true });
    await mkdir(projectB);
    const configPath = path.join(process.env.CODEX_HOME!, "config.toml");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, [
      "[plugins.\"codex-claude-delegate@codex-claude-local\"]",
      "enabled = true",
      "",
      "[mcp_servers.claude_delegate.env]",
      `CODEX_CLAUDE_ALLOW_ROOTS = "${projectA}"`,
      "",
    ].join("\n"), "utf8");

    const projectBReal = await realpath(projectB);

    const result = await configureCodexAllowRoot(projectB);
    const config = await readFile(configPath, "utf8");

    expect(result.env_value).toBe([projectA, projectBReal].join(path.delimiter));
    expect(config).not.toContain("[mcp_servers.claude_delegate.env]");
    expect(config).toContain("[shell_environment_policy.set]");
    expect(config).toContain(`CODEX_CLAUDE_ALLOW_ROOTS = "${result.env_value}"`);
  });

  it("updates existing shell environment allow roots in plugin mode", async () => {
    const projectA = path.join(root, "project-a");
    const projectB = path.join(root, "project-b");
    await mkdir(projectA, { recursive: true });
    await mkdir(projectB);
    const configPath = path.join(process.env.CODEX_HOME!, "config.toml");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, [
      "[shell_environment_policy.set]",
      "ANTHROPIC_BASE_URL = \"http://127.0.0.1:15721\"",
      `CODEX_CLAUDE_ALLOW_ROOTS = "${projectA}"`,
      "",
    ].join("\n"), "utf8");

    const projectBReal = await realpath(projectB);

    const result = await configureCodexAllowRoot(projectB);
    const config = await readFile(configPath, "utf8");

    expect(result.env_value).toBe([projectA, projectBReal].join(path.delimiter));
    expect(config).toContain("ANTHROPIC_BASE_URL = \"http://127.0.0.1:15721\"");
    expect(config).toContain(`CODEX_CLAUDE_ALLOW_ROOTS = "${result.env_value}"`);
  });

  it("refuses to add dangerous roots to Codex config", async () => {
    await expect(configureCodexAllowRoot(root)).rejects.toThrow("dangerous allow root");
  });
});

// =============== Uninstall support: pure function tests ===============

describe("removePathFromAllowRootsValue", () => {
  it("removes a path from a colon-separated list", () => {
    const result = removePathFromAllowRootsValue("/a:/b:/c", "/b", ":");
    expect(result).toBe("/a:/c");
  });

  it("returns unchanged value when path is not present", () => {
    const result = removePathFromAllowRootsValue("/a:/b:/c", "/x", ":");
    expect(result).toBe("/a:/b:/c");
  });

  it("returns null when removal empties the list", () => {
    const result = removePathFromAllowRootsValue("/a", "/a", ":");
    expect(result).toBeNull();
  });

  it("is case-sensitive (different case is not removed)", () => {
    const result = removePathFromAllowRootsValue("/A:/B", "/b", ":");
    expect(result).toBe("/A:/B");
  });
});

describe("deleteTomlTableKey", () => {
  const config = [
    '[mcp_servers.claude_delegate]',
    'command = "node"',
    'args = ["./server/server.js"]',
    "",
    '[mcp_servers.claude_delegate.env]',
    'CODEX_CLAUDE_ALLOW_ROOTS = "/a:/b"',
    'OTHER_KEY = "keep"',
    "",
  ].join("\n");

  it("deletes an existing key from a table", () => {
    const result = deleteTomlTableKey(config, "mcp_servers.claude_delegate.env", "CODEX_CLAUDE_ALLOW_ROOTS");
    expect(result).toContain("OTHER_KEY");
    expect(result).not.toContain("CODEX_CLAUDE_ALLOW_ROOTS");
  });

  it("leaves config unchanged when key does not exist", () => {
    const result = deleteTomlTableKey(config, "mcp_servers.claude_delegate.env", "NONEXISTENT");
    expect(result).toBe(config);
  });

  it("does not affect other tables when deleting a key", () => {
    const result = deleteTomlTableKey(config, "mcp_servers.claude_delegate.env", "CODEX_CLAUDE_ALLOW_ROOTS");
    expect(result).toContain("[mcp_servers.claude_delegate]");
    expect(result).toContain('command = "node"');
  });
});

describe("readTableKeys", () => {
  const config = [
    '[mcp_servers.claude_delegate]',
    'command = "node"',
    'args = ["./server/server.js"]',
    "",
    '[mcp_servers.claude_delegate.env]',
    'CODEX_CLAUDE_ALLOW_ROOTS = "/a"',
    "",
  ].join("\n");

  it("returns keys from an existing table", () => {
    const keys = readTableKeys(config, "mcp_servers.claude_delegate");
    expect(keys).toEqual(["command", "args"]);
  });

  it("returns empty array for a non-existing table", () => {
    const keys = readTableKeys(config, "nonexistent.table");
    expect(keys).toEqual([]);
  });
});

describe("classifyMcpServerSection", () => {
  it("classifies auto when command=node and args points to server.js", () => {
    const config = [
      '[mcp_servers.claude_delegate]',
      'command = "node"',
      'args = ["./server/server.js"]',
      "",
    ].join("\n");
    const result = classifyMcpServerSection(config);
    expect(result?.origin).toBe("auto");
  });

  it("classifies custom node server paths as manual", () => {
    const config = [
      '[mcp_servers.claude_delegate]',
      'command = "node"',
      'args = ["/tmp/other-plugin/server/server.js"]',
      "",
    ].join("\n");
    const result = classifyMcpServerSection(config);
    expect(result?.origin).toBe("manual");
  });

  it("classifies env_only when only .env subsection exists without command/args", () => {
    const config = [
      '[mcp_servers.claude_delegate.env]',
      'CODEX_CLAUDE_ALLOW_ROOTS = "/a"',
      "",
    ].join("\n");
    const result = classifyMcpServerSection(config);
    expect(result?.origin).toBe("env_only");
  });

  it("classifies manual for custom command", () => {
    const config = [
      '[mcp_servers.claude_delegate]',
      'command = "python"',
      'args = ["custom-server.py"]',
      "",
    ].join("\n");
    const result = classifyMcpServerSection(config);
    expect(result?.origin).toBe("manual");
  });

  it("returns null when no claude_delegate section exists", () => {
    const config = '[other_section]\nkey = "value"\n';
    const result = classifyMcpServerSection(config);
    expect(result).toBeNull();
  });

  it("classifies env_only when main table exists but is empty, only env subsection", () => {
    const config = [
      '[mcp_servers.claude_delegate]',
      "",
      '[mcp_servers.claude_delegate.env]',
      'CODEX_CLAUDE_ALLOW_ROOTS = "/a"',
      "",
    ].join("\n");
    const result = classifyMcpServerSection(config);
    expect(result?.origin).toBe("env_only");
  });
});

// =============== Uninstall support: IO function tests ===============

describe("scanClaudeDelegateConfig", () => {
  it("returns empty scan when config file does not exist", async () => {
    // Delete the config path created by parent beforeEach
    const configPath = path.join(process.env.CODEX_HOME!, "config.toml");
    const dirPath = path.dirname(configPath);
    if (existsSync(dirPath)) {
      await rm(dirPath, { recursive: true, force: true });
    }
    const scan = await scanClaudeDelegateConfig();
    expect(scan.exists).toBe(false);
    expect(scan.hasAllowRoots).toBe(false);
  });
});

describe("removeAllowRoot", () => {
  let envCwd: string;

  beforeEach(async () => {
    envCwd = await mkdtemp(path.join(root, "env-cwd-"));
  });

  it("removes allow root from .env subsection", async () => {
    const configPath = path.join(process.env.CODEX_HOME!, "config.toml");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, [
      '[mcp_servers.claude_delegate]',
      'command = "node"',
      "",
      '[mcp_servers.claude_delegate.env]',
      `CODEX_CLAUDE_ALLOW_ROOTS = "${envCwd}:/other"`,
      "",
    ].join("\n"), "utf8");

    const result = await removeAllowRoot(envCwd);
    expect(result.changed).toBe(true);

    const updated = await readFile(configPath, "utf8");
    expect(updated).toContain("/other");
    expect(updated).not.toContain(envCwd);
  });

  it("removes allow root from shell_environment_policy.set", async () => {
    const configPath = path.join(process.env.CODEX_HOME!, "config.toml");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, [
      '[shell_environment_policy.set]',
      `CODEX_CLAUDE_ALLOW_ROOTS = "${envCwd}:/other"`,
      "",
    ].join("\n"), "utf8");

    const result = await removeAllowRoot(envCwd);
    expect(result.changed).toBe(true);

    const updated = await readFile(configPath, "utf8");
    expect(updated).toContain("/other");
    expect(updated).not.toContain(envCwd);
  });

  it("preserves other env keys when removing allow root", async () => {
    const configPath = path.join(process.env.CODEX_HOME!, "config.toml");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, [
      '[mcp_servers.claude_delegate.env]',
      `CODEX_CLAUDE_ALLOW_ROOTS = "${envCwd}:/other"`,
      'ANTHROPIC_BASE_URL = "http://127.0.0.1:15721"',
      "",
    ].join("\n"), "utf8");

    const result = await removeAllowRoot(envCwd);
    expect(result.changed).toBe(true);

    const updated = await readFile(configPath, "utf8");
    expect(updated).toContain("ANTHROPIC_BASE_URL");
    expect(updated).not.toContain(envCwd);
  });

  it("is idempotent on repeated calls", async () => {
    const configPath = path.join(process.env.CODEX_HOME!, "config.toml");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, [
      '[mcp_servers.claude_delegate.env]',
      `CODEX_CLAUDE_ALLOW_ROOTS = "${envCwd}:/other"`,
      "",
    ].join("\n"), "utf8");

    const first = await removeAllowRoot(envCwd);
    expect(first.changed).toBe(true);

    const second = await removeAllowRoot(envCwd);
    expect(second.changed).toBe(false);
  });
});

describe("removeOrFlagMcpServerSection", () => {
  it("deletes auto section entirely", async () => {
    const configPath = path.join(process.env.CODEX_HOME!, "config.toml");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, [
      '[mcp_servers.claude_delegate]',
      'command = "node"',
      'args = ["./server/server.js"]',
      "",
      '[mcp_servers.claude_delegate.env]',
      'CODEX_CLAUDE_ALLOW_ROOTS = "/a:/b"',
      "",
    ].join("\n"), "utf8");

    const result = await removeOrFlagMcpServerSection();
    expect(result.changed).toBe(true);
    expect(result.action).toBe("deleted");

    const updated = await readFile(configPath, "utf8");
    expect(updated).not.toMatch(/\[mcp_servers\.claude_delegate\]/);
  });

  it("deletes env_only section but not other config", async () => {
    const configPath = path.join(process.env.CODEX_HOME!, "config.toml");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, [
      '[mcp_servers.claude_delegate]',
      "",
      '[mcp_servers.claude_delegate.env]',
      'CODEX_CLAUDE_ALLOW_ROOTS = "/a:/b"',
      "",
    ].join("\n"), "utf8");

    const result = await removeOrFlagMcpServerSection();
    expect(result.changed).toBe(true);
    expect(result.action).toBe("env_deleted");

    const updated = await readFile(configPath, "utf8");
    expect(updated).not.toContain("claude_delegate");
  });

  it("skips manual section", async () => {
    const configPath = path.join(process.env.CODEX_HOME!, "config.toml");
    await mkdir(path.dirname(configPath), { recursive: true });
    const original = [
      '[mcp_servers.claude_delegate]',
      'command = "python"',
      'args = ["custom-server.py"]',
      "",
    ].join("\n");
    await writeFile(configPath, original, "utf8");

    const result = await removeOrFlagMcpServerSection();
    expect(result.changed).toBe(false);
    expect(result.action).toBe("manual_skip");

    const updated = await readFile(configPath, "utf8");
    expect(updated).toBe(original);
  });

  it("removes manual section only through explicit confirmation helper", async () => {
    const configPath = path.join(process.env.CODEX_HOME!, "config.toml");
    await mkdir(path.dirname(configPath), { recursive: true });
    const original = [
      '[mcp_servers.claude_delegate]',
      'command = "python"',
      'args = ["custom-server.py"]',
      "",
      "[other]",
      'key = "value"',
      "",
    ].join("\n");
    await writeFile(configPath, original, "utf8");

    const result = await removeConfirmedMcpServerSection();
    expect(result.changed).toBe(true);
    expect(result.action).toBe("deleted");

    const updated = await readFile(configPath, "utf8");
    expect(updated).not.toContain("[mcp_servers.claude_delegate]");
    expect(updated).toContain("[other]");
    expect(updated).toContain('key = "value"');
  });
});

describe("npm global setup config", () => {
  it("renders only codex-claude command and default 6 tools", () => {
    const toml = renderClaudeDelegateMcpConfig();
    expect(toml).toContain("[mcp_servers.claude_delegate]");
    expect(toml).toContain('command = "codex-claude"');
    expect(toml).not.toContain('command = "npx"');
    expect(toml).not.toContain('@anyi61/codex-claude-delegate-mcp"]');
    for (const tool of DEFAULT_ENABLED_TOOLS) expect(toml).toContain(`"${tool}"`);
    expect(toml).not.toContain("claude_implement");
    expect(toml).not.toContain("claude_job_cancel");
  });

  it("does not overwrite an existing server unless force is true", () => {
    const existing = '[mcp_servers.claude_delegate]\ncommand = "custom"\n';
    const result = upsertClaudeDelegateMcpServer(existing, { force: false });
    expect(result.changed).toBe(false);
    expect(result.content).toBe(existing);
  });

  it("replaces an existing server when force is true", () => {
    const existing = '[mcp_servers.claude_delegate]\ncommand = "custom"\n';
    const result = upsertClaudeDelegateMcpServer(existing, { force: true });
    expect(result.changed).toBe(true);
    expect(result.content).toContain('command = "codex-claude"');
    expect(result.content).not.toContain('command = "custom"');
  });
});

describe("setupWrite", () => {
  it("runs allow-root even when upsert is no-op (existing config)", async () => {
    const configPath = path.join(process.env.CODEX_HOME!, "config.toml");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, renderClaudeDelegateMcpConfig(), "utf8");

    const projectDir = path.join(root, "my-project");
    await mkdir(projectDir, { recursive: true });

    const result = await setupWrite({ allowRoot: projectDir });

    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("Added");
    expect(result.message).toContain(projectDir);
  });

  it("returns non-zero exit code when allow-root fails (bad path)", async () => {
    const result = await setupWrite({ allowRoot: "/nonexistent-path-12345" });

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("Error");
    expect(result.message).toContain("does not exist");
  });
});

describe("scanClaudeDelegateConfig fields", () => {
  it("returns mcpCommand and mcpEnabledTools for codex-claude config", async () => {
    const configPath = path.join(process.env.CODEX_HOME!, "config.toml");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, renderClaudeDelegateMcpConfig(), "utf8");

    const scan = await scanClaudeDelegateConfig();
    expect(scan.mcpCommand).toBe("codex-claude");
    expect(scan.mcpEnabledTools).toEqual(["claude_setup", "claude_task", "claude_job_wait", "claude_result", "claude_apply", "claude_cleanup"]);
  });

  it("returns null mcpCommand for non-standard command", async () => {
    const configPath = path.join(process.env.CODEX_HOME!, "config.toml");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, [
      '[mcp_servers.claude_delegate]',
      'command = "npx"',
      'args = ["@anyi61/codex-claude-delegate-mcp"]',
      'enabled_tools = ["claude_setup"]',
      "",
    ].join("\n"), "utf8");

    const scan = await scanClaudeDelegateConfig();
    expect(scan.mcpCommand).toBe("npx");
    expect(scan.mcpEnabledTools).toEqual(["claude_setup"]);
  });
});
