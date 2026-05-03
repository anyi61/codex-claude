import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execCapture, sanitizeEnv } from "./guard.js";
import { SessionStore, computeRepoKey, RECENT_WINDOW_MINUTES } from "./session.js";
import { QUERY_SCHEMA, REVIEW_SCHEMA, IMPLEMENT_SCHEMA, buildImplementPrompt, buildQueryPrompt, buildReviewPrompt, } from "./schema.js";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const LOG_DIR = path.join(process.cwd(), ".codex-claude-delegate", "runs");
const SESSION_DIR = path.join(process.cwd(), ".codex-claude-delegate");
// ---- Session store (lazy init) ----
let store = null;
async function getStore() {
    if (!store) {
        store = new SessionStore(SESSION_DIR);
        await store.init();
    }
    return store;
}
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
    if (opts.resumeSessionId) {
        args.push("-r", opts.resumeSessionId);
    }
    if (opts.forkSession) {
        args.push("--fork-session");
    }
    if (opts.noSessionPersistence) {
        args.push("--no-session-persistence");
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
                // Extract session_id for session management
                const sessionId = parsed.session_id ?? null;
                // If Claude hit max_turns with partial results, still return what we have.
                // The subtype field signals whether this was a clean completion or an early exit.
                if (code !== 0 && code !== null) {
                    log(`Claude exited ${code} (subtype=${parsed.subtype ?? "unknown"}), returning partial result`);
                }
                resolve({ report, session_id: sessionId });
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
        delegated_worktrees_count: 0,
        delegated_worktrees: [],
        stale_worktrees_count: 0,
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
    // Scan for delegated worktrees
    const worktreeDir = path.join(cwd, ".claude", "worktrees");
    try {
        const { readdirSync, statSync } = await import("node:fs");
        if (existsSync(worktreeDir)) {
            const entries = readdirSync(worktreeDir, { withFileTypes: true })
                .filter((d) => d.isDirectory())
                .map((d) => d.name);
            result.delegated_worktrees = entries.filter((n) => n.startsWith("codex-delegated-")).sort();
            result.delegated_worktrees_count = result.delegated_worktrees.length;
            // Count worktrees older than 24h as stale
            const cutoff = Date.now() - 24 * 60 * 60 * 1000;
            result.stale_worktrees_count = result.delegated_worktrees.filter((n) => {
                try {
                    return statSync(path.join(worktreeDir, n)).mtimeMs < cutoff;
                }
                catch {
                    return false;
                }
            }).length;
        }
    }
    catch {
        // best-effort worktree scan
    }
    return result;
}
export async function runClaudeQuery(input, runId) {
    const store = await getStore();
    const repoKey = await computeRepoKey(input.cwd);
    // Auto-resume: find recent query session for the same repo
    const recent = store.getRecent(repoKey, "query", RECENT_WINDOW_MINUTES);
    const requestedSessionId = recent?.session_id ?? null;
    let resumed = false;
    let forked = false;
    const opts = {
        prompt: buildQueryPrompt(input),
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
        resumeSessionId: requestedSessionId ?? undefined,
    };
    let returnedSessionId = null;
    try {
        const { report, session_id } = await spawnClaude(opts);
        returnedSessionId = session_id;
        resumed = !!requestedSessionId;
        // Persist session
        if (session_id) {
            store.upsert(session_id, "query", repoKey, input.cwd, String(report.answer ?? "").slice(0, 200));
        }
        const sessionLog = { requested_session_id: requestedSessionId, resumed, forked, returned_session_id: session_id };
        await logRun(runId, { type: "query", input, report, session: sessionLog });
        store.prune();
        return report;
    }
    catch (err) {
        const errorMsg = err.message;
        // If resume failed (session not found / expired), mark expired and retry without resume
        if (requestedSessionId && isSessionNotFoundError(errorMsg)) {
            store.markExpired(requestedSessionId);
            log(`Session ${requestedSessionId} not found, falling back to new session`);
            // Retry without resume
            const retryOpts = { ...opts, resumeSessionId: undefined };
            try {
                const { report, session_id } = await spawnClaude(retryOpts);
                returnedSessionId = session_id;
                if (session_id) {
                    store.upsert(session_id, "query", repoKey, input.cwd, String(report.answer ?? "").slice(0, 200));
                }
                const sessionLog = { requested_session_id: requestedSessionId, resumed: false, forked: false, returned_session_id: session_id };
                await logRun(runId, { type: "query", input, report, session: sessionLog, retried_after_session_expired: true });
                return report;
            }
            catch (retryErr) {
                await logRun(runId, { type: "query", input, error: retryErr.message, retried_after_session_expired: true });
                throw retryErr;
            }
        }
        await logRun(runId, { type: "query", input, error: errorMsg });
        throw err;
    }
}
// ---- Session failure detection ----
function isSessionNotFoundError(msg) {
    const patterns = ["session not found", "not found", "session.*expired", "invalid session"];
    return patterns.some((p) => new RegExp(p, "i").test(msg));
}
export async function runClaudeReview(input, runId) {
    const opts = {
        prompt: buildReviewPrompt(input),
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
        maxTurns: 10,
        timeoutSec: input.timeout_sec ?? 180,
        jsonSchema: REVIEW_SCHEMA,
        noSessionPersistence: true,
    };
    try {
        const { report } = await spawnClaude(opts);
        await logRun(runId, { type: "review", input, report });
        return report;
    }
    catch (err) {
        await logRun(runId, { type: "review", input, error: err.message });
        throw err;
    }
}
export async function runClaudeImplement(input, runId) {
    const store = await getStore();
    const repoKey = await computeRepoKey(input.cwd);
    const worktreeName = `codex-delegated-${runId.slice(0, 8)}`;
    // implement only resumes when session_key is explicitly provided
    const resumeSessionId = input.session_key ?? undefined;
    const forked = input.fork_session ?? false;
    const opts = {
        prompt: buildImplementPrompt(input),
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
        resumeSessionId,
        forkSession: forked,
    };
    let report;
    let returnedSessionId = null;
    const startTime = Date.now();
    try {
        const result = await spawnClaude(opts);
        report = result.report;
        returnedSessionId = result.session_id;
    }
    catch (err) {
        const errorMsg = err.message;
        // If explicit resume failed, mark session expired
        if (resumeSessionId && isSessionNotFoundError(errorMsg)) {
            store.markExpired(resumeSessionId);
            log(`Session ${resumeSessionId} not found, marked expired`);
        }
        await logRun(runId, { type: "implement", input, error: errorMsg, duration_ms: Date.now() - startTime });
        throw err;
    }
    // Persist session (record only, never auto-resume implement)
    if (returnedSessionId) {
        store.upsert(returnedSessionId, "implement", repoKey, input.cwd, report.summary ?? "");
    }
    // Observe actual changes (don't trust Claude's self-report alone)
    const observed = await observeResult(input.cwd, worktreeName);
    const sessionLog = {
        requested_session_id: resumeSessionId ?? null,
        resumed: !!resumeSessionId,
        forked,
        returned_session_id: returnedSessionId,
    };
    await logRun(runId, {
        type: "implement",
        input,
        report,
        observed,
        session: sessionLog,
        duration_ms: Date.now() - startTime,
    });
    store.prune();
    return { claude_report: report, server_observed: observed };
}
// ---- Apply worktree diff to main workspace ----
export async function runClaudeApply(input, runId) {
    const startTime = Date.now();
    // Validate worktree path
    const wtReal = path.resolve(input.cwd, input.worktree_path);
    const wtDir = path.join(input.cwd, ".claude", "worktrees");
    if (!wtReal.startsWith(wtDir + path.sep)) {
        return { applied_files: [], diff_stat: "", cleanup_performed: false, conflicts: [], error: `worktree_path must be under ${wtDir}` };
    }
    if (!wtReal.startsWith(wtDir + path.sep + "codex-delegated-")) {
        return { applied_files: [], diff_stat: "", cleanup_performed: false, conflicts: [], error: "worktree_path must be a delegated worktree (codex-delegated-*)" };
    }
    if (!existsSync(wtReal)) {
        return { applied_files: [], diff_stat: "", cleanup_performed: false, conflicts: [], error: `worktree directory not found: ${wtReal}` };
    }
    // Generate patch from worktree (uncommitted + committed changes)
    let patch = "";
    try {
        patch += await execCapture("git", ["diff"], { cwd: wtReal }).catch(() => "");
    }
    catch { }
    try {
        patch += "\n" + await execCapture("git", ["diff", "HEAD~1"], { cwd: wtReal }).catch(() => "");
    }
    catch { }
    patch = patch.trim();
    if (!patch) {
        return { applied_files: [], diff_stat: "", cleanup_performed: false, conflicts: [], error: "No diff found in worktree" };
    }
    // Check worktree diff stat for reporting
    let diffStat = "";
    try {
        diffStat = await execCapture("git", ["diff", "--stat"], { cwd: wtReal }).catch(() => "");
    }
    catch { }
    // git apply --check on main workspace
    const patchFile = path.join(input.cwd, ".claude", `apply-${runId.slice(0, 8)}.patch`);
    try {
        await writeFile(patchFile, patch, "utf-8");
        await execCapture("git", ["apply", "--check", patchFile], { cwd: input.cwd, timeoutMs: 30000 });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try {
            await import("node:fs/promises").then((m) => m.rm(patchFile).catch(() => { }));
        }
        catch { }
        return { applied_files: [], diff_stat: diffStat, cleanup_performed: false, conflicts: [msg], error: "git apply --check failed" };
    }
    // Collect list of changed files from worktree
    const appliedFiles = [];
    try {
        const out = await execCapture("git", ["diff", "--name-only"], { cwd: wtReal, timeoutMs: 30000 });
        appliedFiles.push(...out.split("\n").map((l) => l.trim()).filter(Boolean));
    }
    catch { }
    try {
        const out = await execCapture("git", ["diff", "HEAD~1", "--name-only"], { cwd: wtReal, timeoutMs: 30000 }).catch(() => "");
        appliedFiles.push(...out.split("\n").map((l) => l.trim()).filter(Boolean));
    }
    catch { }
    const uniqueFiles = [...new Set(appliedFiles)];
    // git apply
    try {
        await execCapture("git", ["apply", patchFile], { cwd: input.cwd, timeoutMs: 30000 });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try {
            await import("node:fs/promises").then((m) => m.rm(patchFile).catch(() => { }));
        }
        catch { }
        return { applied_files: uniqueFiles, diff_stat: diffStat, cleanup_performed: false, conflicts: [msg], error: `git apply failed: ${msg}` };
    }
    // Cleanup patch file
    try {
        await import("node:fs/promises").then((m) => m.rm(patchFile).catch(() => { }));
    }
    catch { }
    // Optional: cleanup worktree
    let cleanupPerformed = false;
    if (input.cleanup) {
        try {
            const wtName = path.basename(wtReal);
            await execCapture("git", ["worktree", "remove", wtName], { cwd: input.cwd, timeoutMs: 30000 });
            await execCapture("git", ["worktree", "prune"], { cwd: input.cwd, timeoutMs: 10000 });
            cleanupPerformed = true;
        }
        catch (err) {
            log(`worktree remove failed for ${wtReal}: ${err}`);
        }
    }
    await logRun(runId, {
        type: "apply",
        input,
        applied_files: uniqueFiles,
        cleanup_performed: cleanupPerformed,
        duration_ms: Date.now() - startTime,
    });
    return { applied_files: uniqueFiles, diff_stat: diffStat, cleanup_performed: cleanupPerformed, conflicts: [] };
}
// ---- Cleanup delegated worktrees ----
export async function runClaudeCleanup(input, runId) {
    const startTime = Date.now();
    const dryRun = input.dry_run !== false; // default true
    const olderThanHours = input.older_than_hours ?? 0;
    const worktreeDir = path.join(input.cwd, ".claude", "worktrees");
    const entries = [];
    let removedCount = 0;
    let failedCount = 0;
    try {
        const { readdirSync } = await import("node:fs");
        const { statSync } = await import("node:fs");
        if (!existsSync(worktreeDir)) {
            return { dry_run: dryRun, removed_count: 0, failed_count: 0, entries: [] };
        }
        const dirs = readdirSync(worktreeDir, { withFileTypes: true })
            .filter((d) => d.isDirectory() && d.name.startsWith("codex-delegated-"))
            .map((d) => d.name);
        const cutoff = olderThanHours > 0 ? Date.now() - olderThanHours * 60 * 60 * 1000 : 0;
        for (const name of dirs) {
            const dirPath = path.join(worktreeDir, name);
            // Check age if filter set
            if (olderThanHours > 0) {
                try {
                    if (statSync(dirPath).mtimeMs > cutoff) {
                        entries.push({ worktree_name: name, removed: false, error: "skipped (within time window)" });
                        continue;
                    }
                }
                catch {
                    entries.push({ worktree_name: name, removed: false, error: "unable to stat" });
                    continue;
                }
            }
            if (dryRun) {
                entries.push({ worktree_name: name, removed: false });
                continue;
            }
            // Actual remove
            try {
                await execCapture("git", ["worktree", "remove", "--force", name], { cwd: input.cwd, timeoutMs: 30000 });
                removedCount++;
                entries.push({ worktree_name: name, removed: true });
            }
            catch (err) {
                failedCount++;
                entries.push({ worktree_name: name, removed: false, error: err instanceof Error ? err.message : String(err) });
            }
        }
        if (!dryRun) {
            await execCapture("git", ["worktree", "prune"], { cwd: input.cwd, timeoutMs: 10000 }).catch(() => { });
        }
    }
    catch (err) {
        log(`cleanup scan failed: ${err}`);
        return {
            dry_run: dryRun,
            removed_count: 0,
            failed_count: 1,
            entries: [{ worktree_name: "", removed: false, error: err instanceof Error ? err.message : String(err) }],
        };
    }
    await logRun(runId, {
        type: "cleanup",
        input,
        removed_count: removedCount,
        failed_count: failedCount,
        duration_ms: Date.now() - startTime,
    });
    return { dry_run: dryRun, removed_count: removedCount, failed_count: failedCount, entries };
}
//# sourceMappingURL=claude-cli.js.map