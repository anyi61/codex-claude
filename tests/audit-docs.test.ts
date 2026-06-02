import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = path.resolve(import.meta.dirname, "..", "scripts", "audit-docs.mjs");

type AuditResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

const validReadme = [
  "# Fixture README",
  "非官方项目",
  "Ready means the setup checks passed.",
  "One Message To Codex",
  "instruction_files vs `files`",
  "npx` 不是推荐安装路径",
  "security_profile=\"default\"",
  "Continue with claude_task(job_id=...).",
  "`claude_setup`",
  "`claude_task`",
  "`claude_result`",
  "`claude_apply`",
  "`claude_cleanup`",
  "`claude_job_wait` Advanced / Recovery",
  "See docs/advanced-tools.md.",
  "",
].join("\n");

const placeholderDocs: Record<string, string> = {
  "docs/uninstall-execution-checklist.md": "# Current docs\n",
  "docs/advanced-tools.md": [
    "# Advanced Tools",
    "`claude_setup`",
    "`claude_task`",
    "`claude_result`",
    "`claude_apply`",
    "`claude_cleanup`",
    "`claude_job_wait` Advanced / Recovery",
    "`claude_export`",
    "",
  ].join("\n"),
};

const validSourceFiles: Record<string, string> = {
  "src/server.ts": [
    "const BASE_TOOL_DEFINITIONS = [",
    '  { name: "claude_setup", description: "Setup tool." },',
    '  { name: "claude_task", description: "Task tool." },',
    '  { name: "claude_result", description: "Result tool." },',
    '  { name: "claude_apply", description: "Apply tool." },',
    '  { name: "claude_cleanup", description: "Cleanup tool." },',
    '  { name: "claude_job_wait", description: "Wait tool." },',
    '  { name: "claude_export", description: "Export tool." },',
    "];",
    "",
    "const DEFAULT_TOOL_METADATA: Record<string, {",
    "  title: string;",
    "  annotations: Record<string, boolean>;",
    "}> = {",
    "  claude_apply: {",
    '    title: "Preview Or Apply Delegated Changes",',
    "    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },",
    "  },",
    "};",
    "",
  ].join("\n"),

  "src/codex-config.ts": [
    "export const DEFAULT_ENABLED_TOOLS = [",
    '  "claude_setup",',
    '  "claude_task",',
    '  "claude_result",',
    '  "claude_apply",',
    '  "claude_cleanup",',
    "] as const;",
    "",
  ].join("\n"),

  "src/schema.ts": [
    "preview_token: z.string().length(64).regex(/^[a-f0-9]{64}$/,",
    '  "preview_token must be a 64-char hex string").optional(),',
    "",
  ].join("\n"),
};

const validPackageFiles: Record<string, string> = {
  "package.json": '{ "name": "test-pkg", "version": "1.0.0" }\n',
  "plugins/codex-claude-delegate/.codex-plugin/plugin.json": '{ "name": "test-plugin", "version": "1.0.0" }\n',
  "plugins/codex-claude-delegate/.claude-plugin/plugin.json": '{ "name": "test-claude-plugin", "version": "1.0.0" }\n',
};

const tmpDirs: string[] = [];

function runAudit(cwd: string): AuditResult {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 30000,
    });

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

async function writeFixtureRepo(files: Record<string, string>): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "audit-docs-test-"));
  tmpDirs.push(repo);

  for (const [relative, content] of Object.entries(files)) {
    const fullPath = path.join(repo, relative);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }

  return repo;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("audit-docs.mjs", () => {
  it("fails product docs with stale default-tool and legacy polling claims", async () => {
    const repo = await writeFixtureRepo({
      ...placeholderDocs,
      ...validSourceFiles,
      ...validPackageFiles,
      "README.md": validReadme,
      "docs/product/stale-prd.md": [
        "# Installation UX PRD",
        "",
        "| 决策 | 结论 | 理由 |",
        "|---|---|---|",
        "| 默认工具数 | 6 个 | 降低误用概率 |",
        "",
        "`setup --write` 和 `print-config` 默认只启用以下 6 个工具：",
        "",
        "```toml",
        "enabled_tools = [",
        '  "claude_setup",',
        '  "claude_task",',
        '  "claude_job_wait",',
        '  "claude_result",',
        '  "claude_apply",',
        '  "claude_cleanup"',
        "]",
        "```",
        "",
        "```json",
        "{",
        '  "poll_too_soon": true,',
        '  "remaining_delay_ms": 32000,',
        '  "next_allowed_poll_at": "2026-05-09T12:00:45.000Z",',
        '  "interaction": {',
        '    "next_step": "Do not call claude_job_wait again before next_allowed_poll_at."',
        "  },",
        '  "next_actions": [',
        '    { "tool": "claude_job_wait", "args": { "job_id": "job_xxx" } }',
        "  ]",
        "}",
        "```",
        "",
        "Wait until next_allowed_poll_at, then poll this same job_id.",
        "",
      ].join("\n"),
    });

    const result = runAudit(repo);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("docs/product/stale-prd.md: mentions stale default 6 tools");
    expect(result.stderr).toContain("docs/product/stale-prd.md: default enabled_tools includes claude_job_wait");
    expect(result.stderr).toContain("docs/product/stale-prd.md: next_actions recommends claude_job_wait");
    expect(result.stderr).toContain("docs/product/stale-prd.md: contains legacy polling semantics");
  });

  it("fails product docs with stale doctor enabled_count examples", async () => {
    const repo = await writeFixtureRepo({
      ...placeholderDocs,
      ...validSourceFiles,
      ...validPackageFiles,
      "README.md": validReadme,
      "docs/product/stale-prd.md": [
        "# Installation UX PRD",
        "",
        "```json",
        "{",
        '  "checks": {',
        '    "default_tools": { "ok": true, "enabled_count": 6 }',
        "  }",
        "}",
        "```",
        "",
      ].join("\n"),
    });

    const result = runAudit(repo);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("docs/product/stale-prd.md: mentions stale default tool enabled_count 6");
  });

  it("preserves required README phrase checks", async () => {
    const repo = await writeFixtureRepo({
      ...placeholderDocs,
      ...validSourceFiles,
      ...validPackageFiles,
      "README.md": validReadme.replace("Ready means", "Ready almost means"),
      "docs/product/current.md": "# Current PRD\n",
    });

    const result = runAudit(repo);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('README.md: missing required phrase "Ready means"');
  });

  it("fails README advanced enabled_tools examples that omit default tools", async () => {
    const repo = await writeFixtureRepo({
      ...placeholderDocs,
      ...validSourceFiles,
      ...validPackageFiles,
      "README.md": [
        validReadme,
        "## 高级 / 调试工具",
        "```toml",
        "[mcp_servers.claude_delegate]",
        'enabled_tools = ["claude_job_wait", "claude_query", "claude_review"]',
        "```",
      ].join("\n"),
      "docs/product/current.md": "# Current PRD\n",
    });

    const result = runAudit(repo);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("README.md: advanced enabled_tools example omits default tools");
  });

  it("fails when doc enabled_count does not match source DEFAULT_ENABLED_TOOLS length", async () => {
    const repo = await writeFixtureRepo({
      ...placeholderDocs,
      ...validSourceFiles,
      ...validPackageFiles,
      "README.md": validReadme,
      "docs/product/bad-count.md": [
        "# PRD",
        "",
        "```json",
        "{",
        '  "default_tools": { "enabled_count": 4 }',
        "}",
        "```",
      ].join("\n"),
    });

    const result = runAudit(repo);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("doc claims enabled count 4 but source has 5");
  });

  it("fails when default-context enabled_tools block includes claude_job_wait", async () => {
    const repo = await writeFixtureRepo({
      ...placeholderDocs,
      ...validSourceFiles,
      ...validPackageFiles,
      "README.md": validReadme,
      "docs/product/default-context.md": [
        "# PRD",
        "",
        "默认工具配置如下：",
        "",
        "```toml",
        "enabled_tools = [",
        '  "claude_setup",',
        '  "claude_task",',
        '  "claude_job_wait",',
        '  "claude_result",',
        '  "claude_apply",',
        '  "claude_cleanup"',
        "]",
        "```",
      ].join("\n"),
    });

    const result = runAudit(repo);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("default-context enabled_tools includes claude_job_wait");
  });

  it("fails when default-context enabled_tools block is missing a required tool", async () => {
    const repo = await writeFixtureRepo({
      ...placeholderDocs,
      ...validSourceFiles,
      ...validPackageFiles,
      "README.md": validReadme,
      "docs/product/missing-tool.md": [
        "# PRD",
        "",
        "默认 enabled_tools 配置：",
        "",
        "```toml",
        "enabled_tools = [",
        '  "claude_setup",',
        '  "claude_task",',
        '  "claude_result",',
        '  "claude_apply"',
        "]",
        "```",
      ].join("\n"),
    });

    const result = runAudit(repo);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("default-context enabled_tools missing claude_cleanup");
  });

  it("fails when README mentions a tool not in BASE_TOOL_DEFINITIONS", async () => {
    const repo = await writeFixtureRepo({
      ...placeholderDocs,
      ...validSourceFiles,
      ...validPackageFiles,
      "README.md": validReadme + "\n`claude_nonexistent`\n",
      "docs/product/current.md": "# Current PRD\n",
    });

    const result = runAudit(repo);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("README.md: mentions unknown tool claude_nonexistent not in BASE_TOOL_DEFINITIONS");
  });

  it("does not flag claude_delegate server name as an unknown tool", async () => {
    const repo = await writeFixtureRepo({
      ...placeholderDocs,
      ...validSourceFiles,
      ...validPackageFiles,
      "README.md": validReadme + "\n```toml\n[mcp_servers.claude_delegate]\n```\n",
      "docs/product/current.md": "# Current PRD\n",
    });

    const result = runAudit(repo);

    expect(result.exitCode).toBe(0);
  });

  it("fails when claude_apply is described as read-only but metadata marks it destructive", async () => {
    const repo = await writeFixtureRepo({
      ...placeholderDocs,
      ...validSourceFiles,
      ...validPackageFiles,
      "README.md": validReadme,
      "docs/product/apply-contradiction.md": [
        "# PRD",
        "",
        "`claude_apply` is a read-only tool for safe previewing.",
      ].join("\n"),
    });

    const result = runAudit(repo);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("claude_apply described as read-only/safe but metadata marks it destructive");
  });

  it("does not flag claude_apply confirmation docs as contradictory", async () => {
    const repo = await writeFixtureRepo({
      ...placeholderDocs,
      ...validSourceFiles,
      ...validPackageFiles,
      "README.md": validReadme,
      "docs/product/apply-confirmation.md": [
        "# PRD",
        "",
        "`claude_apply` requires user confirmation before modifying files.",
      ].join("\n"),
    });

    const result = runAudit(repo);

    expect(result.exitCode).toBe(0);
  });

  it("fails when preview_token docs claim 64 bytes instead of 64 hex chars", async () => {
    const repo = await writeFixtureRepo({
      ...placeholderDocs,
      ...validSourceFiles,
      ...validPackageFiles,
      "README.md": validReadme,
      "docs/product/token-format.md": [
        "# PRD",
        "",
        "The preview_token is a 64 bytes random value.",
      ].join("\n"),
    });

    const result = runAudit(repo);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("preview_token claims 64 bytes or 32 chars");
  });

  it("fails when package and plugin versions mismatch", async () => {
    const repo = await writeFixtureRepo({
      ...placeholderDocs,
      ...validSourceFiles,
      "README.md": validReadme,
      "docs/product/current.md": "# Current PRD\n",
      "package.json": '{ "name": "test-pkg", "version": "1.0.0" }\n',
      "plugins/codex-claude-delegate/.codex-plugin/plugin.json": '{ "name": "test-plugin", "version": "1.1.0" }\n',
      "plugins/codex-claude-delegate/.claude-plugin/plugin.json": '{ "name": "test-claude-plugin", "version": "1.0.0" }\n',
    });

    const result = runAudit(repo);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("version mismatch:");
    expect(result.stderr).toContain("1.0.0");
    expect(result.stderr).toContain("1.1.0");
  });

  it("passes when all source-derived checks are valid", async () => {
    const repo = await writeFixtureRepo({
      ...placeholderDocs,
      ...validSourceFiles,
      ...validPackageFiles,
      "README.md": validReadme,
      "docs/product/current.md": [
        "# PRD",
        "",
        "`claude_apply` requires user confirmation before modifying files.",
        "The preview_token is a 64 lowercase hex character string.",
      ].join("\n"),
    });

    const result = runAudit(repo);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("doc audit ok");
  });

  it("fails when README does not link to advanced tool documentation", async () => {
    const repo = await writeFixtureRepo({
      ...placeholderDocs,
      ...validSourceFiles,
      ...validPackageFiles,
      "README.md": validReadme.replace("See docs/advanced-tools.md.", ""),
      "docs/product/current.md": "# Current PRD\n",
    });

    const result = runAudit(repo);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("README.md: missing link to advanced tool documentation");
  });

  it("fails when advanced tool reference is missing tools from source", async () => {
    const sourceWithExport = {
      ...validSourceFiles,
      "src/server.ts": [
        ...validSourceFiles["src/server.ts"].split("\n").slice(0, -1),
        "",
      ].join("\n"),
    };
    const advancedWithoutExport = placeholderDocs["docs/advanced-tools.md"].replace("`claude_export`\n", "");

    const repo = await writeFixtureRepo({
      ...placeholderDocs,
      ...sourceWithExport,
      ...validPackageFiles,
      "README.md": validReadme,
      "docs/advanced-tools.md": advancedWithoutExport,
      "docs/product/current.md": "# Current PRD\n",
    });

    const result = runAudit(repo);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("docs/advanced-tools.md: missing advanced tool documentation");
    expect(result.stderr).toContain("claude_export");
  });

  it("passes when advanced tool reference documents all tools from source", async () => {
    const repo = await writeFixtureRepo({
      ...placeholderDocs,
      ...validSourceFiles,
      ...validPackageFiles,
      "README.md": validReadme,
      "docs/product/current.md": [
        "# PRD",
        "",
        "`claude_apply` requires user confirmation before modifying files.",
        "The preview_token is a 64 lowercase hex character string.",
      ].join("\n"),
    });

    const result = runAudit(repo);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("doc audit ok");
  });

  it("passes when source files are absent (skips manifest checks)", async () => {
    const repo = await writeFixtureRepo({
      ...placeholderDocs,
      ...validPackageFiles,
      "README.md": validReadme,
      "docs/product/current.md": "# PRD\n",
    });

    const result = runAudit(repo);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("doc audit ok");
  });
});
