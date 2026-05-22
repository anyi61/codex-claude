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
  "",
].join("\n");

const placeholderDocs = [
  "docs/development-overview.md",
  "docs/onboarding-plan.md",
  "docs/uninstall-execution-checklist.md",
];

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

async function writeFixtureRepo(options: { productDoc: string; readme?: string }): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "audit-docs-test-"));
  tmpDirs.push(repo);

  await writeFile(path.join(repo, "README.md"), options.readme ?? validReadme, "utf8");

  for (const doc of placeholderDocs) {
    await mkdir(path.dirname(path.join(repo, doc)), { recursive: true });
    await writeFile(path.join(repo, doc), "# Current docs\n", "utf8");
  }

  await mkdir(path.join(repo, "docs", "product"), { recursive: true });
  await writeFile(path.join(repo, "docs", "product", "stale-prd.md"), options.productDoc, "utf8");

  await mkdir(path.join(repo, "plugins", "codex-claude-delegate", "skills"), { recursive: true });
  await mkdir(path.join(repo, "plugins", "codex-claude-delegate", ".codex-plugin"), { recursive: true });
  await writeFile(
    path.join(repo, "plugins", "codex-claude-delegate", ".codex-plugin", "plugin.json"),
    "{}\n",
    "utf8",
  );

  return repo;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("audit-docs.mjs", () => {
  it("fails product docs with stale default-tool and legacy polling claims", async () => {
    const repo = await writeFixtureRepo({
      productDoc: [
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
        "  \"claude_setup\",",
        "  \"claude_task\",",
        "  \"claude_job_wait\",",
        "  \"claude_result\",",
        "  \"claude_apply\",",
        "  \"claude_cleanup\"",
        "]",
        "```",
        "",
        "```json",
        "{",
        "  \"poll_too_soon\": true,",
        "  \"remaining_delay_ms\": 32000,",
        "  \"next_allowed_poll_at\": \"2026-05-09T12:00:45.000Z\",",
        "  \"interaction\": {",
        "    \"next_step\": \"Do not call claude_job_wait again before next_allowed_poll_at.\"",
        "  },",
        "  \"next_actions\": [",
        "    { \"tool\": \"claude_job_wait\", \"args\": { \"job_id\": \"job_xxx\" } }",
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
      productDoc: [
        "# Installation UX PRD",
        "",
        "```json",
        "{",
        "  \"checks\": {",
        "    \"default_tools\": { \"ok\": true, \"enabled_count\": 6 }",
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
      readme: validReadme.replace("Ready means", "Ready almost means"),
      productDoc: "# Current PRD\n",
    });

    const result = runAudit(repo);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('README.md: missing required phrase "Ready means"');
  });

  it("fails README advanced enabled_tools examples that omit default tools", async () => {
    const repo = await writeFixtureRepo({
      readme: [
        validReadme,
        "## 高级 / 调试工具",
        "```toml",
        "[mcp_servers.claude_delegate]",
        "enabled_tools = [\"claude_job_wait\", \"claude_query\", \"claude_review\"]",
        "```",
      ].join("\n"),
      productDoc: "# Current PRD\n",
    });

    const result = runAudit(repo);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("README.md: advanced enabled_tools example omits default tools");
  });
});
