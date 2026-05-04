import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(args[0], args.slice(1), { cwd, encoding: "utf8" }).trim();
}

async function createFixtureRepo(): Promise<{ repo: string; worktreeRel: string; baseCommit: string }> {
  const repo = await mkdtemp(path.join(tmpdir(), "codex-claude-apply-"));
  sh(repo, "git", "init");
  sh(repo, "git", "config", "user.name", "Test User");
  sh(repo, "git", "config", "user.email", "test@example.com");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "src", "server.ts"), "export const value = 1;\n");
  sh(repo, "git", "add", ".");
  sh(repo, "git", "commit", "-m", "init");

  const worktreeRel = path.join(".claude", "worktrees", "codex-delegated-test");
  sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
  const wt = path.join(repo, worktreeRel);
  const baseCommit = sh(wt, "git", "rev-parse", "HEAD");
  await writeFile(path.join(wt, "src", "server.ts"), "export const value = 2;\n");
  await writeFile(path.join(wt, "src", "extra.ts"), "export const extra = true;\n");

  return { repo, worktreeRel, baseCommit };
}

async function writeImplementLog(
  logDir: string,
  runName: string,
  worktreeRel: string,
  baseCommit: string,
  observed: Record<string, unknown>
): Promise<void> {
  await mkdir(logDir, { recursive: true });
  await writeFile(
    path.join(logDir, `${runName}.json`),
    JSON.stringify(
      {
        type: "implement",
        input: { files: ["src/server.ts"] },
        observed: {
          worktree_path: worktreeRel,
          base_commit: baseCommit,
          ...observed,
        },
      },
      null,
      2
    )
  );
}

async function main(): Promise<void> {
  const logRoot = await mkdtemp(path.join(tmpdir(), "codex-claude-logs-"));
  const logDir = path.join(logRoot, "runs");
  try {
    process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
    const { parseStatusPorcelainZ, runClaudeApply } = await import("../src/claude-cli.js");

    const parsed = parseStatusPorcelainZ("?? src/server.ts\u0000");
    if (parsed.length !== 1 || parsed[0].file !== "src/server.ts") {
      throw new Error(`porcelain parse path truncation: ${JSON.stringify(parsed)}`);
    }

    const fx1 = await createFixtureRepo();
    try {
      await writeImplementLog(logDir, "scope-exceeded", fx1.worktreeRel, fx1.baseCommit, {
        scope: {
          requested_files: ["src/server.ts"],
          out_of_scope_files: ["src/extra.ts"],
          scope_exceeded: true,
          warnings: ["Changed src/extra.ts outside requested files: src/server.ts"],
        },
        resource_limits: {
          actual_changed_files: 2,
          changed_files_exceeded: false,
          warnings: [],
        },
      });

      const result = await runClaudeApply(
        { cwd: fx1.repo, worktree_path: fx1.worktreeRel, cleanup: false },
        "apply-scope"
      );
      if (!result.error?.includes("outside requested files")) {
        throw new Error(`expected scope refusal, got: ${JSON.stringify(result)}`);
      }
    } finally {
      await rm(fx1.repo, { recursive: true, force: true });
    }

    const fx2 = await createFixtureRepo();
    try {
      await writeImplementLog(logDir, "changed-files-exceeded", fx2.worktreeRel, fx2.baseCommit, {
        scope: {
          requested_files: ["src/server.ts"],
          out_of_scope_files: [],
          scope_exceeded: false,
          warnings: [],
        },
        resource_limits: {
          max_changed_files: 1,
          actual_changed_files: 2,
          changed_files_exceeded: true,
          warnings: ["Changed 2 files, exceeds limit of 1"],
        },
      });

      const result = await runClaudeApply(
        { cwd: fx2.repo, worktree_path: fx2.worktreeRel, cleanup: false },
        "apply-limit"
      );
      if (!result.error?.includes("exceeded implement resource limits")) {
        throw new Error(`expected changed_files_exceeded refusal, got: ${JSON.stringify(result)}`);
      }
    } finally {
      await rm(fx2.repo, { recursive: true, force: true });
    }

    const currentFile = fileURLToPath(import.meta.url);
    const content = await readFile(currentFile, "utf8");
    if (!content.includes("scope_exceeded")) {
      throw new Error("self-check failed: script content mismatch");
    }
  } finally {
    await rm(logRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
