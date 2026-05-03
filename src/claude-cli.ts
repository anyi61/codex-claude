import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { execCapture, sanitizeEnv } from "./guard.js";
import type {
  ClaudeImplementInput,
  ClaudeQueryInput,
  ClaudeReviewInput,
  ClaudeReport,
  ClaudeResult,
  ClaudeStatusResult,
  ServerObserved,
} from "./schema.js";
import {
  RESULT_SCHEMA,
  buildImplementPrompt,
  buildQueryPrompt,
  buildReviewPrompt,
} from "./schema.js";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const LOG_DIR = path.join(process.cwd(), ".codex-claude-delegate", "runs");

// ---- Logging (stderr only, never stdout) ----

function log(msg: string): void {
  process.stderr.write(`[claude-delegate] ${msg}\n`);
}

async function logRun(runId: string, data: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    await writeFile(
      path.join(LOG_DIR, `${runId}.json`),
      JSON.stringify(data, null, 2)
    );
  } catch {
    // best-effort logging
  }
}

// ---- Spawn Claude with structured output ----

interface ClaudeRunOptions {
  prompt: string;
  cwd: string;
  worktree?: string;
  tools: string;
  allowedTools: string[];
  disallowedTools: string[];
  maxTurns: number;
  timeoutSec: number;
  jsonSchema: object;
}

function spawnClaude(opts: ClaudeRunOptions): Promise<ClaudeReport> {
  const args: string[] = ["-p"];

  if (opts.worktree) {
    args.push("-w", opts.worktree);
  }

  args.push(
    "--permission-mode", "dontAsk",
    "--tools", opts.tools,
    "--max-turns", String(opts.maxTurns),
    "--output-format", "json",
  );

  // --allowedTools / --disallowedTools must come before --json-schema.
  // --json-schema must be the last flag before the positional prompt.
  // If placed before --allowedTools/--disallowedTools, the CLI incorrectly
  // consumes subsequent flags as part of the schema value.
  if (opts.allowedTools.length > 0) {
    args.push("--allowedTools");
    for (const t of opts.allowedTools) {
      args.push(t);
    }
  }

  if (opts.disallowedTools.length > 0) {
    args.push("--disallowedTools");
    for (const t of opts.disallowedTools) {
      args.push(t);
    }
  }

  args.push("--json-schema", JSON.stringify(opts.jsonSchema));
  args.push(opts.prompt);

  const safeEnv = sanitizeEnv();

  log(`spawning: ${CLAUDE_BIN} -p (${args.length} args, worktree=${opts.worktree ?? "none"}, maxTurns=${opts.maxTurns})`);

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd: opts.cwd,
      env: safeEnv,
      timeout: opts.timeoutSec * 1000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new Error(`Claude CLI not found. Ensure "claude" is in PATH or set CLAUDE_BIN env var.`));
      } else {
        reject(err);
      }
    });

    child.on("close", (code) => {
      if (stderr) log(`claude stderr: ${stderr.slice(0, 2000)}`);

      if (code !== 0 && code !== null) {
        reject(new Error(`Claude exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }

      // Parse Claude's JSON output (may be JSON lines or single JSON object)
      try {
        const trimmed = stdout.trim();
        if (!trimmed) {
          reject(new Error("Claude produced no output"));
          return;
        }

        // Try parsing as a single JSON object first
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          // Fallback: try last JSON line (stream-json case)
          const lines = trimmed.split("\n").filter((l) => l.trim());
          const lastLine = lines[lines.length - 1];
          parsed = JSON.parse(lastLine);
        }

        // Extract structured_output field if present
        const report: ClaudeReport = (parsed.structured_output ?? parsed) as ClaudeReport;
        resolve(report);
      } catch (err) {
        reject(new Error(`Failed to parse Claude output: ${(err as Error).message}\nOutput (first 2000 chars): ${stdout.slice(0, 2000)}`));
      }
    });
  });
}

// ---- Server-side observation ----

async function observeResult(cwd: string, worktree?: string): Promise<ServerObserved> {
  const obsCwd = worktree ? path.join(cwd, ".claude", "worktrees", worktree) : cwd;

  try {
    const [diffNameOnly, diffStat] = await Promise.all([
      execCapture("git", ["diff", "--name-only"], { cwd: obsCwd }).catch(() => ""),
      execCapture("git", ["diff", "--stat"], { cwd: obsCwd }).catch(() => ""),
    ]);

    const changedFiles = diffNameOnly
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    return {
      changed_files: changedFiles,
      diff_stat: diffStat || "(no changes or unable to get diff)",
      diff_name_only: diffNameOnly || "(no changes)",
      worktree_path: worktree ? `.claude/worktrees/${worktree}` : undefined,
    };
  } catch {
    return {
      changed_files: [],
      diff_stat: "(unable to observe)",
      diff_name_only: "(unable to observe)",
      worktree_path: worktree ? `.claude/worktrees/${worktree}` : undefined,
    };
  }
}

// ---- Check git status in worktree ----

async function getWorktreeStatus(cwd: string, worktree: string): Promise<string> {
  const worktreePath = path.join(cwd, ".claude", "worktrees", worktree);
  try {
    return await execCapture("git", ["status", "--short"], { cwd: worktreePath });
  } catch {
    return "(unable to get worktree status)";
  }
}

// ---- Public API ----

export async function checkClaudeStatus(cwd: string): Promise<ClaudeStatusResult> {
  const result: ClaudeStatusResult = {
    claude_available: false,
    claude_version: null,
    auth_status: null,
    git_available: false,
    worktree_capable: false,
    cwd_valid: false,
    cwd_is_git_repo: false,
    errors: [],
  };

  // Check claude binary
  try {
    const version = await execCapture(CLAUDE_BIN, ["--version"], { cwd });
    result.claude_available = true;
    result.claude_version = version;
  } catch {
    result.errors.push("claude CLI not found in PATH");
  }

  // Check claude auth
  if (result.claude_available) {
    try {
      const authOutput = await execCapture(CLAUDE_BIN, ["auth", "status"], { cwd });
      result.auth_status = authOutput.includes("Logged in") ? "authenticated" : "unknown";
    } catch {
      result.auth_status = "unauthenticated or unknown";
      result.errors.push("claude auth status could not be verified");
    }
  }

  // Check git
  try {
    await execCapture("git", ["--version"], { cwd });
    result.git_available = true;
  } catch {
    result.errors.push("git not found in PATH");
  }

  // Check worktree
  if (result.git_available) {
    try {
      const wl = await execCapture("git", ["worktree", "list"], { cwd });
      result.worktree_capable = wl.length >= 0;
    } catch {
      result.errors.push("git worktree not supported in this repo");
    }
  }

  // Check cwd
  try {
    const { execSync } = await import("node:child_process");
    const isRepo = execSync("git rev-parse --git-dir", { cwd, stdio: "pipe" });
    result.cwd_is_git_repo = isRepo.length > 0;
  } catch {
    result.cwd_is_git_repo = false;
  }

  result.cwd_valid = result.git_available && result.cwd_is_git_repo;

  return result;
}

export async function runClaudeQuery(
  input: ClaudeQueryInput,
  runId: string
): Promise<ClaudeReport> {
  const prompt = buildQueryPrompt(input);
  const opts: ClaudeRunOptions = {
    prompt,
    cwd: input.cwd,
    tools: "Read,Glob,Grep,Bash",
    allowedTools: [
      "Read",
      "Glob",
      "Grep",
      "Bash(git diff *)",
      "Bash(git log *)",
      "Bash(git status)",
      "Bash(git show *)",
    ],
    disallowedTools: [
      "Bash(rm *)",
      "Bash(sudo *)",
      "Bash(curl *)",
      "Bash(wget *)",
      "Bash(chmod *)",
      "Bash(chown *)",
      "Bash(git push *)",
      "Bash(ssh *)",
      "Bash(scp *)",
    ],
    maxTurns: 4,
    timeoutSec: input.timeout_sec ?? 120,
    jsonSchema: RESULT_SCHEMA,
  };

  try {
    const report = await spawnClaude(opts);
    await logRun(runId, { type: "query", input, report });
    return report;
  } catch (err) {
    await logRun(runId, { type: "query", input, error: (err as Error).message });
    throw err;
  }
}

export async function runClaudeReview(
  input: ClaudeReviewInput,
  runId: string
): Promise<ClaudeReport> {
  const prompt = buildReviewPrompt(input);
  const opts: ClaudeRunOptions = {
    prompt,
    cwd: input.cwd,
    tools: "Read,Glob,Grep,Bash",
    allowedTools: [
      "Read",
      "Glob",
      "Grep",
      "Bash(git diff *)",
      "Bash(git log *)",
      "Bash(git status)",
      "Bash(git show *)",
      "Bash(git blame *)",
    ],
    disallowedTools: [
      "Bash(rm *)",
      "Bash(sudo *)",
      "Bash(curl *)",
      "Bash(wget *)",
      "Bash(chmod *)",
      "Bash(chown *)",
      "Bash(git push *)",
      "Bash(ssh *)",
      "Bash(scp *)",
    ],
    maxTurns: 6,
    timeoutSec: input.timeout_sec ?? 180,
    jsonSchema: RESULT_SCHEMA,
  };

  try {
    const report = await spawnClaude(opts);
    await logRun(runId, { type: "review", input, report });
    return report;
  } catch (err) {
    await logRun(runId, { type: "review", input, error: (err as Error).message });
    throw err;
  }
}

export async function runClaudeImplement(
  input: ClaudeImplementInput,
  runId: string
): Promise<ClaudeResult> {
  const worktreeName = `codex-delegated-${runId.slice(0, 8)}`;
  const prompt = buildImplementPrompt(input);
  const opts: ClaudeRunOptions = {
    prompt,
    cwd: input.cwd,
    worktree: worktreeName,
    tools: "Read,Glob,Grep,Edit,Write,Bash",
    allowedTools: [
      "Read",
      "Glob",
      "Grep",
      "Edit",
      "Write",
      "Bash(git status)",
      "Bash(git diff *)",
      "Bash(git add *)",
      "Bash(git log *)",
      "Bash(git show *)",
      "Bash(npm test *)",
      "Bash(npm run test *)",
      "Bash(npm run lint *)",
      "Bash(npx *)",
      "Bash(pytest *)",
      "Bash(go test *)",
      "Bash(cargo test *)",
      "Bash(yarn test *)",
      "Bash(pnpm test *)",
      "Bash(pnpm run lint *)",
      "Bash(ls *)",
      "Bash(cat *)",
      "Bash(wc *)",
      "Bash(find *)",
      "Bash(head *)",
      "Bash(tail *)",
      "Bash(sort *)",
      "Bash(uniq *)",
      "Bash(grep *)",
      "Bash(rg *)",
      "Bash(which *)",
      "Bash(echo *)",
      "Bash(date *)",
      "Bash(mkdir *)",
      "Bash(cp *)",
      "Bash(mv *)",
      "Bash(node *)",
      "Bash(python *)",
      "Bash(python3 *)",
      "Bash(tsc *)",
      "Bash(eslint *)",
    ],
    disallowedTools: [
      "Bash(rm -rf *)",
      "Bash(rm -r *)",
      "Bash(sudo *)",
      "Bash(curl *)",
      "Bash(wget *)",
      "Bash(chmod *)",
      "Bash(chown *)",
      "Bash(git push *)",
      "Bash(git push --force *)",
      "Bash(git branch -D *)",
      "Bash(git reset --hard *)",
      "Bash(git clean *)",
      "Bash(ssh *)",
      "Bash(scp *)",
      "Bash(shutdown *)",
      "Bash(reboot *)",
      "Bash(docker *)",
      "Bash(kubectl *)",
      "Bash(brew *)",
      "Bash(npm install *)",
      "Bash(npm uninstall *)",
      "Bash(npm publish *)",
      "Bash(pip install *)",
      "Bash(pip uninstall *)",
      "Bash(yarn add *)",
      "Bash(yarn remove *)",
      "Bash(pnpm add *)",
      "Bash(pnpm remove *)",
    ],
    maxTurns: 8,
    timeoutSec: input.timeout_sec ?? 600,
    jsonSchema: RESULT_SCHEMA,
  };

  let report: ClaudeReport;
  const startTime = Date.now();

  try {
    report = await spawnClaude(opts);
  } catch (err) {
    const errorMsg = (err as Error).message;
    await logRun(runId, { type: "implement", input, error: errorMsg, duration_ms: Date.now() - startTime });
    throw err;
  }

  // Observe actual changes (don't trust Claude's self-report alone)
  const observed = await observeResult(input.cwd, worktreeName);

  await logRun(runId, {
    type: "implement",
    input,
    report,
    observed,
    duration_ms: Date.now() - startTime,
  });

  return { claude_report: report, server_observed: observed };
}
