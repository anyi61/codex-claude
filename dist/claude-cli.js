import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { execCapture, sanitizeEnv } from "./guard.js";
import { QUERY_SCHEMA, REVIEW_SCHEMA, IMPLEMENT_SCHEMA, buildImplementPrompt, buildQueryPrompt, buildReviewPrompt, } from "./schema.js";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const LOG_DIR = path.join(process.cwd(), ".codex-claude-delegate", "runs");
// ---- Logging (stderr only, never stdout) ----
function log(msg) {
    process.stderr.write(`[claude-delegate] ${msg}\n`);
}
async function logRun(runId, data) {
    try {
        await mkdir(LOG_DIR, { recursive: true });
        await writeFile(path.join(LOG_DIR, `${runId}.json`), JSON.stringify(data, null, 2));
    }
    catch {
        // best-effort logging
    }
}
function spawnClaude(opts) {
    const args = ["-p"];
    if (opts.worktree) {
        args.push("-w", opts.worktree);
    }
    args.push("--permission-mode", "dontAsk", "--tools", opts.tools, "--max-turns", String(opts.maxTurns), "--output-format", "json");
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
        child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("error", (err) => {
            if (err.code === "ENOENT") {
                reject(new Error(`Claude CLI not found. Ensure "claude" is in PATH or set CLAUDE_BIN env var.`));
            }
            else {
                reject(err);
            }
        });
        child.on("close", (code) => {
            if (stderr)
                log(`claude stderr: ${stderr.slice(0, 2000)}`);
            // Try to parse stdout even when exit code is non-zero.
            // Claude may exit with code 1 on max_turns but still produce
            // valid structured_output in the result payload.
            try {
                const trimmed = stdout.trim();
                if (!trimmed) {
                    reject(new Error(`Claude produced no output (exit ${code})`));
                    return;
                }
                let parsed;
                try {
                    parsed = JSON.parse(trimmed);
                }
                catch {
                    const lines = trimmed.split("\n").filter((l) => l.trim());
                    if (lines.length === 0) {
                        reject(new Error(`Claude produced unparseable output (exit ${code}): ${trimmed.slice(0, 500)}`));
                        return;
                    }
                    const lastLine = lines[lines.length - 1];
                    parsed = JSON.parse(lastLine);
                }
                // Extract structured_output if present, otherwise use the whole result
                const report = (parsed.structured_output ?? parsed);
                // If Claude hit max_turns with partial results, still return what we have.
                // The subtype field signals whether this was a clean completion or an early exit.
                if (code !== 0 && code !== null) {
                    log(`Claude exited ${code} (subtype=${parsed.subtype ?? "unknown"}), returning partial result`);
                }
                resolve(report);
            }
            catch (err) {
                const diag = `exit=${code}, stdoutLen=${stdout.length}, stderr=${stderr.slice(0, 200)}`;
                reject(new Error(`Failed to parse Claude output. ${diag}\n${err.message}`));
            }
        });
    });
}
// ---- Server-side observation ----
async function observeResult(cwd, worktree) {
    const obsCwd = worktree ? path.join(cwd, ".claude", "worktrees", worktree) : cwd;
    try {
        // Capture both unstaged AND staged/committed changes.
        // Claude may have committed in the worktree, so git diff alone misses changes.
        const [diffNameOnly, diffStat, statusShort, headDiffName] = await Promise.all([
            execCapture("git", ["diff", "--name-only"], { cwd: obsCwd }).catch(() => ""),
            execCapture("git", ["diff", "--stat"], { cwd: obsCwd }).catch(() => ""),
            execCapture("git", ["status", "--short"], { cwd: obsCwd }).catch(() => ""),
            execCapture("git", ["diff", "HEAD~1", "--name-only"], { cwd: obsCwd }).catch(() => ""),
        ]);
        // Collect unique changed files from all sources
        const fileSet = new Set();
        for (const source of [diffNameOnly, headDiffName, statusShort]) {
            for (const line of source.split("\n")) {
                const cleaned = line.replace(/^[MADRC? ]{1,3}/, "").trim();
                if (cleaned)
                    fileSet.add(cleaned);
            }
        }
        return {
            changed_files: [...fileSet],
            diff_stat: diffStat || "(no changes or unable to get diff)",
            diff_name_only: diffNameOnly || "(no changes)",
            worktree_path: worktree ? `.claude/worktrees/${worktree}` : undefined,
        };
    }
    catch {
        return {
            changed_files: [],
            diff_stat: "(unable to observe)",
            diff_name_only: "(unable to observe)",
            worktree_path: worktree ? `.claude/worktrees/${worktree}` : undefined,
        };
    }
}
// ---- Check git status in worktree ----
async function getWorktreeStatus(cwd, worktree) {
    const worktreePath = path.join(cwd, ".claude", "worktrees", worktree);
    try {
        return await execCapture("git", ["status", "--short"], { cwd: worktreePath });
    }
    catch {
        return "(unable to get worktree status)";
    }
}
// ---- Public API ----
export async function checkClaudeStatus(cwd) {
    const result = {
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
    }
    catch {
        result.errors.push("claude CLI not found in PATH");
    }
    // Check claude auth
    if (result.claude_available) {
        try {
            const authOutput = await execCapture(CLAUDE_BIN, ["auth", "status"], { cwd });
            try {
                const authJson = JSON.parse(authOutput);
                result.auth_status = authJson.loggedIn === true ? "authenticated" : "not authenticated";
            }
            catch {
                result.auth_status = authOutput.includes("Logged in") || authOutput.includes("loggedIn") ? "authenticated" : "unknown";
            }
        }
        catch {
            result.auth_status = "unauthenticated or unknown";
            result.errors.push("claude auth status could not be verified");
        }
    }
    // Check git
    try {
        await execCapture("git", ["--version"], { cwd });
        result.git_available = true;
    }
    catch {
        result.errors.push("git not found in PATH");
    }
    // Check worktree
    if (result.git_available) {
        try {
            const wl = await execCapture("git", ["worktree", "list"], { cwd });
            result.worktree_capable = wl.length >= 0;
        }
        catch {
            result.errors.push("git worktree not supported in this repo");
        }
    }
    // Check cwd
    try {
        const { execSync } = await import("node:child_process");
        const isRepo = execSync("git rev-parse --git-dir", { cwd, stdio: "pipe" });
        result.cwd_is_git_repo = isRepo.length > 0;
    }
    catch {
        result.cwd_is_git_repo = false;
    }
    result.cwd_valid = result.git_available && result.cwd_is_git_repo;
    return result;
}
export async function runClaudeQuery(input, runId) {
    const prompt = buildQueryPrompt(input);
    const opts = {
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
        jsonSchema: QUERY_SCHEMA,
    };
    try {
        const report = await spawnClaude(opts);
        await logRun(runId, { type: "query", input, report });
        return report;
    }
    catch (err) {
        await logRun(runId, { type: "query", input, error: err.message });
        throw err;
    }
}
export async function runClaudeReview(input, runId) {
    const prompt = buildReviewPrompt(input);
    const opts = {
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
        jsonSchema: REVIEW_SCHEMA,
    };
    try {
        const report = await spawnClaude(opts);
        await logRun(runId, { type: "review", input, report });
        return report;
    }
    catch (err) {
        await logRun(runId, { type: "review", input, error: err.message });
        throw err;
    }
}
export async function runClaudeImplement(input, runId) {
    const worktreeName = `codex-delegated-${runId.slice(0, 8)}`;
    const prompt = buildImplementPrompt(input);
    const opts = {
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
        maxTurns: 15,
        timeoutSec: input.timeout_sec ?? 600,
        jsonSchema: IMPLEMENT_SCHEMA,
    };
    let report;
    const startTime = Date.now();
    try {
        report = await spawnClaude(opts);
    }
    catch (err) {
        const errorMsg = err.message;
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
//# sourceMappingURL=claude-cli.js.map