import { spawn } from "node:child_process";
import { writeFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
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
function normalizeRepoPath(cwd, file) {
    const repoRelative = path.isAbsolute(file) ? path.relative(cwd, file) : file;
    return repoRelative.replaceAll(path.sep, "/").replace(/^\.\//, "");
}
function isUnderRequestedFile(file, requested) {
    return file === requested || file.startsWith(`${requested.replace(/\/$/, "")}/`);
}
async function findImplementLogForWorktree(worktreePath) {
    try {
        const entries = await readdir(LOG_DIR);
        const candidates = await Promise.all(entries
            .filter((name) => name.endsWith(".json"))
            .map(async (name) => {
            const file = path.join(LOG_DIR, name);
            try {
                return { file, mtimeMs: (await stat(file)).mtimeMs };
            }
            catch {
                return null;
            }
        }));
        for (const entry of candidates
            .filter((item) => item !== null)
            .sort((a, b) => b.mtimeMs - a.mtimeMs)) {
            try {
                const parsed = JSON.parse(await readFile(entry.file, "utf8"));
                if (parsed.type === "implement" && parsed.observed?.worktree_path === worktreePath) {
                    return parsed;
                }
            }
            catch {
                // Ignore malformed or concurrently written logs.
            }
        }
    }
    catch {
        // Missing logs should not block legacy/manual apply flows.
    }
    return null;
}
// ---- Sensitive data redaction for stderr ----
function redactSensitive(input) {
    return input
        .replace(/(ANTHROPIC_AUTH_TOKEN=)[^\s]+/gi, "$1***")
        .replace(/(ANTHROPIC_API_KEY=)[^\s]+/gi, "$1***")
        .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, "$1***")
        .replace(/\b(sk-ant-[a-zA-Z0-9]{20,})\b/g, "sk-ant-***")
        .replace(/\b(sk-[a-zA-Z0-9]{20,})\b/g, "sk-***");
}
// ---- Git status/diff parsing helpers ----
function parseStatusShortLine(line) {
    if (!line.trim())
        return null;
    // git status --short / --porcelain=v1 format:
    // XY <path>
    // ?? <path>
    const xy = line.slice(0, 2);
    const file = line.slice(3).trim();
    if (!file)
        return null;
    if (xy === "??")
        return { status: "A", file };
    if (xy.includes("D"))
        return { status: "D", file };
    if (xy.includes("A"))
        return { status: "A", file };
    if (xy.includes("M"))
        return { status: "M", file };
    return { status: xy.trim() || "?", file };
}
function parseNameStatusLine(line) {
    const trimmed = line.trim();
    if (!trimmed)
        return null;
    const [status, ...rest] = trimmed.split(/\s+/);
    const file = rest.join(" ");
    if (!status || !file)
        return null;
    return { status, file };
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
    args.push("--permission-mode", "dontAsk");
    if (opts.maxBudgetUsd !== undefined) {
        args.push("--max-budget-usd", String(opts.maxBudgetUsd));
    }
    args.push("--tools", opts.tools, "--max-turns", String(opts.maxTurns), "--output-format", "json");
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
        child.on("close", async (code, signal) => {
            if (stderr)
                log(`claude stderr: ${redactSensitive(stderr.slice(0, 2000))}`);
            // Try to parse stdout even when exit code is non-zero.
            // Claude may exit with code 1 on max_turns but still produce
            // valid structured_output in the result payload.
            try {
                const trimmed = stdout.trim();
                if (!trimmed) {
                    const stderrTail = redactSensitive(stderr.slice(-1000));
                    let diagStr = "";
                    try {
                        const diags = await getEnvironmentDiagnostics(safeEnv);
                        diagStr = ` environment_diagnostics=${JSON.stringify(diags)}`;
                    }
                    catch { }
                    reject(new Error(`Claude produced no output (exit ${code}, signal ${signal ?? "none"}, timeout_sec=${opts.timeoutSec}, stdoutLen=${stdout.length}, stderrLen=${stderr.length}, stderrTail=${JSON.stringify(stderrTail)})` +
                        diagStr));
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
                const diag = `exit=${code}, signal=${signal ?? "none"}, timeout_sec=${opts.timeoutSec}, stdoutLen=${stdout.length}, stderrLen=${stderr.length}, stderr=${redactSensitive(stderr.slice(0, 200))}`;
                reject(new Error(`Failed to parse Claude output. ${diag}\n${err.message}`));
            }
        });
    });
}
// ---- Environment diagnostics ----
function redactEnvStatus(key, safeEnv) {
    if (safeEnv[key]) {
        return key.includes("TOKEN") || key.includes("API_KEY") ? "set-redacted" : "set";
    }
    if (process.env[key]) {
        return "present-in-parent-stripped";
    }
    return "unset";
}
function parseLocalProxy(raw) {
    if (!raw)
        return null;
    try {
        const url = new URL(raw);
        const host = url.hostname;
        const port = Number.parseInt(url.port, 10);
        if (!host || !Number.isFinite(port))
            return null;
        if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1")
            return null;
        return { host, port };
    }
    catch {
        return null;
    }
}
async function probeLocalPort(host, port, timeoutMs = 1000) {
    const net = await import("node:net");
    return await new Promise((resolve) => {
        const socket = net.createConnection({ host, port });
        const timer = setTimeout(() => {
            socket.destroy();
            resolve({ reachable: false, error: "timeout" });
        }, timeoutMs);
        socket.once("connect", () => {
            clearTimeout(timer);
            socket.destroy();
            resolve({ reachable: true });
        });
        socket.once("error", (err) => {
            clearTimeout(timer);
            resolve({ reachable: false, error: err.code ?? err.message });
        });
    });
}
async function getEnvironmentDiagnostics(safeEnv = sanitizeEnv()) {
    const proxyRaw = safeEnv.HTTPS_PROXY ?? safeEnv.HTTP_PROXY ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
    const localProxy = parseLocalProxy(proxyRaw);
    let reachable;
    let proxyError;
    if (localProxy) {
        const probe = await probeLocalPort(localProxy.host, localProxy.port);
        reachable = probe.reachable;
        proxyError = probe.error;
    }
    const likelySandboxBlocked = !!localProxy &&
        reachable === false &&
        (proxyError === "EPERM" || proxyError === "EACCES" || proxyError === "timeout");
    return {
        proxy_env_present: !!(safeEnv.HTTP_PROXY || safeEnv.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY),
        http_proxy: redactEnvStatus("HTTP_PROXY", safeEnv),
        https_proxy: redactEnvStatus("HTTPS_PROXY", safeEnv),
        no_proxy: redactEnvStatus("NO_PROXY", safeEnv),
        anthropic_base_url: redactEnvStatus("ANTHROPIC_BASE_URL", safeEnv),
        anthropic_auth_token: redactEnvStatus("ANTHROPIC_AUTH_TOKEN", safeEnv),
        anthropic_api_key: redactEnvStatus("ANTHROPIC_API_KEY", safeEnv),
        local_proxy_host: localProxy?.host,
        local_proxy_port: localProxy?.port,
        local_proxy_reachable: reachable,
        local_proxy_error: proxyError,
        likely_sandbox_blocked: likelySandboxBlocked,
        recommendation: likelySandboxBlocked
            ? "Claude CLI likely cannot reach its local proxy/API from this sandbox. Run the MCP server outside the restricted sandbox or approve the outer command execution."
            : undefined,
    };
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
        // Collect unique changed files from all sources.
        // diffNameOnly and headDiffName are plain file paths (name-only).
        // statusShort needs proper parsing of the XY <path> format.
        const fileSet = new Set();
        for (const source of [diffNameOnly, headDiffName]) {
            for (const line of source.split("\n")) {
                const file = line.trim();
                if (file)
                    fileSet.add(file);
            }
        }
        for (const line of statusShort.split("\n")) {
            const parsed = parseStatusShortLine(line);
            if (parsed?.file)
                fileSet.add(parsed.file);
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
    // Environment diagnostics (best-effort)
    try {
        result.environment_diagnostics = await getEnvironmentDiagnostics();
    }
    catch {
        // best-effort only
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
            "Bash(find *)",
            "Bash(rg *)",
            "Bash(wc *)",
            "Bash(ls *)",
            "Bash(head *)",
            "Bash(tail *)",
            "Bash(cat *)",
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
        maxTurns: 8,
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
        maxBudgetUsd: input.max_cost_usd,
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
    // Check resource limits
    if (input.max_changed_files !== undefined || input.max_cost_usd !== undefined) {
        const warnings = [];
        const exceeded = input.max_changed_files !== undefined &&
            observed.changed_files.length > input.max_changed_files;
        if (exceeded) {
            const msg = `Changed ${observed.changed_files.length} files, exceeds limit of ${input.max_changed_files}`;
            warnings.push(msg);
            log(`Resource warning: ${msg}`);
        }
        observed.resource_limits = {
            max_cost_usd: input.max_cost_usd,
            max_changed_files: input.max_changed_files,
            actual_changed_files: observed.changed_files.length,
            changed_files_exceeded: exceeded,
            warnings,
        };
    }
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
    // Check worktree diff stat for reporting (src/ only)
    let diffStat = "";
    try {
        diffStat = await execCapture("git", ["diff", "--stat", "--", "src/"], { cwd: wtReal, timeoutMs: 10000 });
    }
    catch { }
    if (!diffStat.trim()) {
        try {
            diffStat = await execCapture("git", ["diff", "HEAD~1", "--stat", "--", "src/"], { cwd: wtReal, timeoutMs: 10000 }).catch(() => "");
        }
        catch { }
    }
    // Collect changed files with status (M=modified, A=added, D=deleted).
    // Use three sources to capture tracked (staged/unstaged/committed) AND untracked files.
    const [diffStatus, headStatus, shortStatus] = await Promise.all([
        execCapture("git", ["diff", "--name-status", "--", "src/"], { cwd: wtReal, timeoutMs: 10000 }).catch(() => ""),
        execCapture("git", ["diff", "HEAD~1", "--name-status", "--", "src/"], { cwd: wtReal, timeoutMs: 10000 }).catch(() => ""),
        execCapture("git", ["status", "--short", "--", "src/"], { cwd: wtReal, timeoutMs: 10000 }).catch(() => ""),
    ]);
    const changesByFile = new Map();
    function addChange(change) {
        if (!change)
            return;
        if (!change.file.startsWith("src/"))
            return;
        changesByFile.set(change.file, change);
    }
    for (const line of diffStatus.split("\n"))
        addChange(parseNameStatusLine(line));
    for (const line of headStatus.split("\n"))
        addChange(parseNameStatusLine(line));
    for (const line of shortStatus.split("\n"))
        addChange(parseStatusShortLine(line));
    const changes = [...changesByFile.values()];
    // Provide fallback diffStat when git diff shows nothing (e.g. all untracked)
    if (!diffStat.trim() && changes.length > 0) {
        diffStat = changes.map((c) => `${c.status}\t${c.file}`).join("\n");
    }
    if (changes.length === 0) {
        return { applied_files: [], diff_stat: diffStat, cleanup_performed: false, conflicts: [], error: "No changed source files found in worktree" };
    }
    const wtRelPath = path.join(".claude", "worktrees", path.basename(wtReal));
    const implementLog = await findImplementLogForWorktree(wtRelPath);
    const resourceLimits = implementLog?.observed?.resource_limits;
    if (resourceLimits?.changed_files_exceeded === true) {
        const warnings = Array.isArray(resourceLimits.warnings)
            ? resourceLimits.warnings.filter((item) => typeof item === "string")
            : [];
        return {
            applied_files: [],
            diff_stat: diffStat,
            cleanup_performed: false,
            conflicts: warnings,
            error: "Worktree exceeded implement resource limits; apply refused",
        };
    }
    if (implementLog?.input && Array.isArray(implementLog.input.files) && implementLog.input.files.length > 0) {
        const requestedFiles = implementLog.input.files
            .filter((item) => typeof item === "string")
            .map((file) => normalizeRepoPath(input.cwd, file));
        const outOfScope = changes.filter((change) => !requestedFiles.some((requested) => isUnderRequestedFile(change.file, requested)));
        if (outOfScope.length > 0) {
            return {
                applied_files: [],
                diff_stat: diffStat,
                cleanup_performed: false,
                conflicts: outOfScope.map((change) => `${change.file}: outside requested files (${requestedFiles.join(", ")})`),
                error: "Worktree contains changes outside requested files; apply refused",
            };
        }
    }
    // Preflight: check for uncommitted changes in main workspace and
    // unsupported status codes. If any issues found, refuse the entire apply.
    const conflicts = [];
    const validStatuses = new Set(["A", "M", "D"]);
    for (const c of changes) {
        if (!validStatuses.has(c.status)) {
            conflicts.push(`${c.file}: unsupported status "${c.status}" (only A/M/D supported)`);
            continue;
        }
        try {
            const shortStat = await execCapture("git", ["status", "--short", "--", c.file], { cwd: input.cwd, timeoutMs: 10000 });
            if (shortStat.trim()) {
                conflicts.push(`${c.file}: main workspace has uncommitted changes (${shortStat.trim().slice(0, 80)})`);
            }
        }
        catch { }
    }
    if (conflicts.length > 0) {
        return { applied_files: [], diff_stat: diffStat, cleanup_performed: false, conflicts, error: "Main workspace has uncommitted or unsupported changes; apply refused" };
    }
    // Apply changes
    const copied = [];
    for (const c of changes) {
        const dest = path.join(input.cwd, c.file);
        const src = path.join(wtReal, c.file);
        try {
            if (c.status === "D") {
                // Deletion
                if (existsSync(dest)) {
                    await import("node:fs/promises").then((m) => m.rm(dest).catch(() => { }));
                }
                copied.push(c.file);
            }
            else {
                // Modified or added — copy from worktree
                const content = await import("node:fs/promises").then((m) => m.readFile(src));
                await mkdir(path.dirname(dest), { recursive: true });
                await writeFile(dest, content);
                copied.push(c.file);
            }
        }
        catch (err) {
            conflicts.push(`${c.file} (${c.status}): ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    if (copied.length === 0) {
        return { applied_files: [], diff_stat: diffStat, cleanup_performed: false, conflicts, error: "No changes could be applied" };
    }
    // Optional: cleanup worktree
    let cleanupPerformed = false;
    if (input.cleanup) {
        try {
            await execCapture("git", ["worktree", "remove", "--force", wtRelPath], { cwd: input.cwd, timeoutMs: 30000 });
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
        applied_files: copied,
        cleanup_performed: cleanupPerformed,
        duration_ms: Date.now() - startTime,
    });
    return { applied_files: copied, diff_stat: diffStat, cleanup_performed: cleanupPerformed, conflicts };
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
            // Actual remove — use relative path from repo root, not just basename
            try {
                const wtRelPath = path.join(".claude", "worktrees", name);
                await execCapture("git", ["worktree", "remove", "--force", wtRelPath], { cwd: input.cwd, timeoutMs: 30000 });
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