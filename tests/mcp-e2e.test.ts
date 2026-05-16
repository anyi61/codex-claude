import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    await rm(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-mcp-e2e-"));
  cleanupPaths.push(root);
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  const fakeClaude = path.join(root, "fake-claude.mjs");
  await writeFile(fakeClaude, [
    "#!/usr/bin/env node",
    "if (process.argv.includes('--version')) { console.log('Claude Fake 1.0.0'); process.exit(0); }",
    "console.log(JSON.stringify({ structured_output: { answer: 'fake' }, session_id: 'sess-fake' }));",
    "",
  ].join("\n"), "utf8");
  chmodSync(fakeClaude, 0o755);
  return { root, repo: await realpath(repo), fakeClaude };
}

describe("MCP stdio smoke", () => {
  it("initializes, lists tools, and calls a default tool with fake Claude", async () => {
    const { root, repo, fakeClaude } = await createFixture();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/cli.ts", "mcp"],
      cwd: process.cwd(),
      stderr: "pipe",
      env: {
        ...process.env,
        CLAUDE_BIN: fakeClaude,
        CODEX_CLAUDE_ALLOW_ROOTS: repo,
        CODEX_CLAUDE_BACKGROUND_STATE_DIR: path.join(root, "state"),
        CODEX_CLAUDE_RUN_LOG_DIR: path.join(root, "state", "runs"),
      },
    });
    const client = new Client({ name: "codex-mcp-e2e", version: "1.0.0" }, { capabilities: {} });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toContain("claude_setup");
      expect(tools.tools.find((tool) => tool.name === "claude_task")?.outputSchema).toMatchObject({ type: "object" });

      const result = await client.callTool({
        name: "claude_setup",
        arguments: { cwd: repo },
      });

      expect(result.structuredContent).toMatchObject({
        workspace_root: repo,
      });
      expect(JSON.parse(result.content[0]!.type === "text" ? result.content[0].text : "{}")).toMatchObject({
        workspace_root: repo,
      });
    } finally {
      await client.close();
    }
  }, 15000);
});
