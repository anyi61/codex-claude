import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const pluginServerDir = path.join(repoRoot, "plugins", "codex-claude-delegate", "server");

describe("plugin runtime artifacts", () => {
  it("ships both the MCP server and background job runner", () => {
    expect(existsSync(path.join(pluginServerDir, "server.js"))).toBe(true);
    expect(existsSync(path.join(pluginServerDir, "job-runner.js"))).toBe(true);
  });
});
