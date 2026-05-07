import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configureCodexAllowRoot } from "../src/codex-config.js";

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
