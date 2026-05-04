import { spawn } from "node:child_process";
import { writeFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execCapture, sanitizeEnv } from "./guard.js";
import { SessionStore, computeRepoKey, RECENT_WINDOW_MINUTES } from "./session.js";
import type {
  ClaudeApplyInput,
  ClaudeApplyResult,
  ClaudeCleanupInput,
  ClaudeCleanupResult,
  ClaudeImplementInput,
  ClaudeQueryInput,
  ClaudeReviewInput,
  ClaudeResult,
  ClaudeStatusResult,
  CleanupEntry,
  EnvironmentDiagnostics,
  EnvStatus,
  ExecutionMetadata,
  ServerObserved,
  SessionLog,
  ToolEnvelope,
} from "./schema.js";
import {
  QUERY_SCHEMA,
  REVIEW_SCHEMA,
  IMPLEMENT_SCHEMA,
  buildImplementPrompt,
  buildQueryPrompt,
  buildReviewPrompt,
} from "./schema.js";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const LOG_DIR = process.env.CODEX_CLAUDE_RUN_LOG_DIR
  ? path.resolve(process.env.CODEX_CLAUDE_RUN_LOG_DIR)
  : path.join(process.cwd(), ".codex-claude-delegate", "runs");
const SESSION_DIR = path.join(process.cwd(), ".codex-claude-delegate");

// ---- Session store (lazy init) ----

let store: SessionStore | null = null;

async function getStore(): Promise<SessionStore> {
  if (!store) {
    store = new SessionStore(SESSION_DIR);
    await store.init();
  }
  return store;
}

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

interface ImplementRunLog {
  type?: unknown;
  input?: {
    files?: unknown;
  };
  observed?: {
    worktree_path?: unknown;
    base_commit?: unknown;
    changed_files?: unknown;
    resource_limits?: {
      changed_files_exceeded?: unknown;
      warnings?: unknown;
    };
    scope?: {
      scope_exceeded?: unknown;
      warnings?: unknown;
    };
  };
}

function normalizeRepoPath(cwd: string, file: string): string {
  const repoRelative = path.isAbsolute(file) ? path.relative(cwd, file) : file;
  return repoRelative.replaceAll(path.sep, "/").replace(/^\.\//, "");
}

function isUnderRequestedFile(file: string, requested: string): boolean {
  return file === requested || file.startsWith(`${requested.replace(/\/$/, "")}/`);
}

function normalizeRequestedFiles(cwd: string, files?: string[]): string[] {
  if (!files?.length) return [];
  const normalized = new Set<string>();
  for (const file of files) {
    const repoPath = normalizeRepoPath(cwd, file).replace(/\/+$/g, "");
    if (repoPath) normalized.add(repoPath);
  }
  return [...normalized].sort();
}

async function findImplementLogForWorktree(worktreePath: string): Promise<ImplementRunLog | null> {
  try {
    const entries = await readdir(LOG_DIR);
    const candidates = await Promise.all(
      entries
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          const file = path.join(LOG_DIR, name);
          try {
            return { file, mtimeMs: (await stat(file)).mtimeMs };
          } catch {
            return null;
          }
        })
    );

    for (const entry of candidates
      .filter((item): item is { file: string; mtimeMs: number } => item !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)) {
      try {
        const parsed = JSON.parse(await readFile(entry.file, "utf8")) as ImplementRunLog;
        if (parsed.type === "implement" && parsed.observed?.worktree_path === worktreePath) {
          return parsed;
        }
      } catch {
        // Ignore malformed or concurrently written logs.
      }
    }
  } catch {
    // Missing logs should not block legacy/manual apply flows.
  }
  return null;
}

async function findDirtyFiles(cwd: string, requestedFiles: string[]): Promise<string[]> {
  if (requestedFiles.length === 0) return [];
  const output = await execCapture(
    "git",
    ["status", "--short", "--", ...requestedFiles],
    { cwd }
  ).catch(() => "");
  const dirty = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const file = trimmed.replace(/^[ MADRCU?!]{1,2}\s+/, "");
    if (file) dirty.add(file);
  }
  return [...dirty].sort();
}

// ---- Sensitive data redaction for stderr ----

function redactSensitive(input: string): string {
  return input
    .replace(/(ANTHROPIC_AUTH_TOKEN=)[^\s]+/gi, "$1***")
    .replace(/(ANTHROPIC_API_KEY=)[^\s]+/gi, "$1***")
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, "$1***")
    .replace(/\b(sk-ant-[a-zA-Z0-9]{20,})\b/g, "sk-ant-***")
    .replace(/\b(sk-[a-zA-Z0-9]{20,})\b/g, "sk-***");
}

// ---- Git status/diff parsing helpers ----

export function parseStatusPorcelainZ(output: string): Array<{ status: string; file: string }> {
  const entries = output.split("\0");
  const parsed: Array<{ status: string; file: string }> = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const match = entry.match(/^(.{2}) (.+)$/s) ?? entry.match(/^([ MADRCU?!]) (.+)$/s);
    if (!match) continue;
    const xy = match[1].length === 1 ? `${match[1]} ` : match[1];
    const firstPath = match[2];
    if (!firstPath) continue;

    let status = "?";
    if (xy === "??") {
      status = "A";
    } else if (xy.includes("R") || xy.includes("C")) {
      status = "unsupported";
      const nextPath = entries[i + 1];
      const file = nextPath || firstPath;
      if (nextPath) i++;
      parsed.push({ status, file });
      continue;
    } else if (xy.includes("D")) {
      status = "D";
    } else if (xy.includes("A")) {
      status = "A";
    } else if (xy.includes("M")) {
      status = "M";
    } else {
      status = xy.trim() || "?";
    }

    parsed.push({ status, file: firstPath });
  }

  return parsed;
}

export function parseNameStatusPorcelainZ(output: string): Array<{ status: string; file: string }> {
  const entries = output.split("\0");
  const parsed: Array<{ status: string; file: string }> = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    let rawStatus = "";
    let firstPath = "";
    let consumedExtraPath = false;

    const tabIndex = entry.indexOf("\t");
    if (tabIndex > 0) {
      rawStatus = entry.slice(0, tabIndex);
      firstPath = entry.slice(tabIndex + 1);
    } else if (/^[A-Z?][0-9]*$/.test(entry)) {
      rawStatus = entry;
      firstPath = entries[i + 1] ?? "";
      consumedExtraPath = true;
    } else {
      continue;
    }
    if (!firstPath) continue;

    const statusCode = rawStatus[0] ?? "?";
    if (statusCode === "R" || statusCode === "C") {
      const nextPath = entries[i + (consumedExtraPath ? 2 : 1)];
      const file = nextPath || firstPath;
      i += consumedExtraPath ? 1 : 0;
      if (nextPath) i++;
      parsed.push({ status: "unsupported", file });
      continue;
    }

    if (statusCode === "A" || statusCode === "M" || statusCode === "D") {
      if (consumedExtraPath) i++;
      parsed.push({ status: statusCode, file: firstPath });
      continue;
    }

    if (consumedExtraPath) i++;
    parsed.push({ status: statusCode, file: firstPath });
  }

  return parsed;
}

// ---- Spawn Claude with structured output ----

export interface ClaudeRunOptions {
  prompt: string;
  cwd: string;
  worktree?: string;
  tools: string;
  allowedTools: string[];
  disallowedTools: string[];
  maxTurns: number;
  timeoutSec: number;
  jsonSchema: object;
  maxBudgetUsd?: number;
  // Session options
  resumeSessionId?: string;
  forkSession?: boolean;
  noSessionPersistence?: boolean;
}

interface ClaudeSpawnResult {
  report: Record<string, unknown>;
  session_id: string | null;
  execution: ExecutionMetadata;
}

export const DANGEROUS_DISALLOWED_TOOLS = [
  "Bash(rm *)",
  "Bash(rm -rf *)",
  "Bash(rm -r *)",
  "Bash(sudo *)",
  "Bash(curl *)",
  "Bash(wget *)",
  "Bash(chmod *)",
  "Bash(chown *)",
  "Bash(git push *)",
  "Bash(ssh *)",
  "Bash(scp *)",
  "Bash(nc *)",
  "Bash(netcat *)",
];

export function truncateTail(input: string, maxChars = 4000): string {
  return input.length <= maxChars ? input : input.slice(-maxChars);
}

export function buildSafeEnv(): Record<string, string> {
  return sanitizeEnv();
}

export function buildClaudeArgs(opts: ClaudeRunOptions): string[] {
  const args: string[] = ["-p"];

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

  args.push(
    "--permission-mode", "dontAsk",
  );

  if (opts.maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", String(opts.maxBudgetUsd));
  }

  args.push(
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
  return args;
}

export function buildQueryArgs(input: ClaudeQueryInput): string[] {
  return buildClaudeArgs(createQueryOptions(input));
}

export function buildReviewArgs(input: ClaudeReviewInput): string[] {
  return buildClaudeArgs(createReviewOptions(input));
}

export function buildImplementArgs(input: ClaudeImplementInput, worktreeName = "codex-delegated-test"): string[] {
  return buildClaudeArgs(createImplementOptions(input, worktreeName));
}

function successExecution(durationMs = 0): ExecutionMetadata {
  return { exit_code: 0, duration_ms: durationMs, timed_out: false, stdout_tail: "", stderr_tail: "" };
}

function makeEnvelope<T>(
  status: ToolEnvelope<T>["status"],
  data: T | undefined,
  execution: ExecutionMetadata,
  warnings: string[] = [],
  extra: Pick<ToolEnvelope<T>, "claude_report" | "server_observed"> = {}
): ToolEnvelope<T> {
  return { status, data, execution, warnings, ...extra };
}

function spawnClaude(opts: ClaudeRunOptions): Promise<ClaudeSpawnResult> {
  const args = buildClaudeArgs(opts);
  const safeEnv = sanitizeEnv();
  const startTime = Date.now();

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

    child.on("close", async (code, signal) => {
      if (stderr) log(`claude stderr: ${redactSensitive(stderr.slice(0, 2000))}`);

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
          } catch {}
          reject(new Error(
            `Claude produced no output (exit ${code}, signal ${signal ?? "none"}, timeout_sec=${opts.timeoutSec}, stdoutLen=${stdout.length}, stderrLen=${stderr.length}, stderrTail=${JSON.stringify(stderrTail)})` +
            diagStr
          ));
          return;
        }

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          const lines = trimmed.split("\n").filter((l) => l.trim());
          if (lines.length === 0) {
            reject(new Error(`Claude produced unparseable output (exit ${code}): ${trimmed.slice(0, 500)}`));
            return;
          }
          const lastLine = lines[lines.length - 1];
          parsed = JSON.parse(lastLine);
        }

        // Extract structured_output if present, otherwise use the whole result
        const report = (parsed.structured_output ?? parsed) as Record<string, unknown>;

        // Extract session_id for session management
        const sessionId = (parsed.session_id as string) ?? null;

        // If Claude hit max_turns with partial results, still return what we have.
        // The subtype field signals whether this was a clean completion or an early exit.
        if (code !== 0 && code !== null) {
          log(`Claude exited ${code} (subtype=${parsed.subtype ?? "unknown"}), returning partial result`);
        }

        resolve({
          report,
          session_id: sessionId,
          execution: {
            exit_code: code,
            duration_ms: Date.now() - startTime,
            timed_out: signal === "SIGTERM",
            stdout_tail: truncateTail(stdout),
            stderr_tail: redactSensitive(truncateTail(stderr)),
          },
        });
      } catch (err) {
        const diag = `exit=${code}, signal=${signal ?? "none"}, timeout_sec=${opts.timeoutSec}, stdoutLen=${stdout.length}, stderrLen=${stderr.length}, stderr=${redactSensitive(stderr.slice(0, 200))}`;
        reject(new Error(`Failed to parse Claude output. ${diag}\n${(err as Error).message}`));
      }
    });
  });
}

// ---- Environment diagnostics ----

function redactEnvStatus(key: string, safeEnv: Record<string, string>): EnvStatus {
  if (safeEnv[key]) {
    return key.includes("TOKEN") || key.includes("API_KEY") ? "set-redacted" : "set";
  }
  if (process.env[key]) {
    return "present-in-parent-stripped";
  }
  return "unset";
}

function parseLocalProxy(raw?: string): { host: string; port: number } | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname;
    const port = Number.parseInt(url.port, 10);
    if (!host || !Number.isFinite(port)) return null;
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return null;
    return { host, port };
  } catch {
    return null;
  }
}

async function probeLocalPort(host: string, port: number, timeoutMs = 1000): Promise<{ reachable: boolean; error?: string }> {
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

    socket.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ reachable: false, error: err.code ?? err.message });
    });
  });
}

async function getEnvironmentDiagnostics(safeEnv: Record<string, string> = sanitizeEnv()): Promise<EnvironmentDiagnostics> {
  const proxyRaw = safeEnv.HTTPS_PROXY ?? safeEnv.HTTP_PROXY ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  const localProxy = parseLocalProxy(proxyRaw);

  let reachable: boolean | undefined;
  let proxyError: string | undefined;

  if (localProxy) {
    const probe = await probeLocalPort(localProxy.host, localProxy.port);
    reachable = probe.reachable;
    proxyError = probe.error;
  }

  const likelySandboxBlocked =
    !!localProxy &&
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

async function observeResult(
  cwd: string,
  worktree?: string,
  baseCommit?: string,
  requestedFiles?: string[]
): Promise<ServerObserved> {
  const obsCwd = worktree ? path.join(cwd, ".claude", "worktrees", worktree) : cwd;
  const warnings: string[] = [];
  const gitStatusShort = await execCapture("git", ["status", "--short"], { cwd: obsCwd }).catch((err) => {
    warnings.push(`Unable to read git status: ${err instanceof Error ? err.message : String(err)}`);
    return "";
  });
  const headCommit = await execCapture("git", ["rev-parse", "HEAD"], { cwd: obsCwd }).catch((err) => {
    warnings.push(`Unable to read HEAD commit: ${err instanceof Error ? err.message : String(err)}`);
    return "";
  });

  try {
    const trackedCommittedNameOnly = baseCommit
      ? await execCapture("git", ["diff", "--name-only", baseCommit, "HEAD"], { cwd: obsCwd }).catch(() => "")
      : "";
    const trackedCommittedStat = baseCommit
      ? await execCapture("git", ["diff", "--stat", baseCommit, "HEAD"], { cwd: obsCwd }).catch(() => "")
      : "";

    const [trackedUncommittedNameOnly, untrackedStatusPorcelainZ] = await Promise.all([
      execCapture("git", ["diff", "--name-only"], { cwd: obsCwd }).catch(() => ""),
      execCapture("git", ["status", "--porcelain=v1", "-z"], { cwd: obsCwd }).catch(() => ""),
    ]);

    const fileSet = new Set<string>();
    for (const source of [trackedCommittedNameOnly, trackedUncommittedNameOnly]) {
      for (const line of source.split("\n")) {
        const file = line.trim();
        if (file) fileSet.add(file);
      }
    }
    for (const entry of parseStatusPorcelainZ(untrackedStatusPorcelainZ)) {
      if (entry.file) fileSet.add(entry.file);
    }

    const changedFiles = [...fileSet].sort();
    const normalizedRequestedFiles = normalizeRequestedFiles(cwd, requestedFiles);
    const outOfScopeFiles = normalizedRequestedFiles.length === 0
      ? []
      : changedFiles.filter((file) => !normalizedRequestedFiles.some((requested) => isUnderRequestedFile(file, requested)));
    const scopeWarnings = outOfScopeFiles.map((file) =>
      `Changed ${file} outside requested files: ${normalizedRequestedFiles.join(", ")}`
    );

    const diffNameOnlySegments: string[] = [];
    if (trackedCommittedNameOnly.trim()) {
      diffNameOnlySegments.push(`[tracked_since_base ${baseCommit ?? "unknown"}..HEAD]\n${trackedCommittedNameOnly.trimEnd()}`);
    }
    if (trackedUncommittedNameOnly.trim()) {
      diffNameOnlySegments.push(`[uncommitted_tracked]\n${trackedUncommittedNameOnly.trimEnd()}`);
    }
    if (untrackedStatusPorcelainZ.trim()) {
      const untrackedLines = parseStatusPorcelainZ(untrackedStatusPorcelainZ)
        .map((entry) => `${entry.status}\t${entry.file}`)
        .join("\n");
      if (untrackedLines) {
        diffNameOnlySegments.push(`[status_porcelain_z]\n${untrackedLines}`);
      }
    }

    const diffStatSegments: string[] = [];
    if (trackedCommittedStat.trim()) {
      diffStatSegments.push(`[tracked_since_base ${baseCommit ?? "unknown"}..HEAD]\n${trackedCommittedStat.trimEnd()}`);
    }
    const fallbackStat = changedFiles.length > 0
      ? changedFiles.map((file) => `*\t${file}`).join("\n")
      : "(no changes)";
    const diffStat = diffStatSegments.join("\n\n") || fallbackStat;
    const diffNameOnly = diffNameOnlySegments.join("\n\n") || "(no changes)";

    return {
      repo_root: cwd,
      worktree_name: worktree,
      changed_files: changedFiles,
      diff_stat: diffStat,
      diff_name_only: diffNameOnly,
      base_commit: baseCommit,
      head_commit: headCommit.trim() || undefined,
      git_status_short: gitStatusShort,
      worktree_path: worktree ? `.claude/worktrees/${worktree}` : undefined,
      scope: {
        requested_files: normalizedRequestedFiles.length > 0 ? normalizedRequestedFiles : undefined,
        out_of_scope_files: outOfScopeFiles,
        scope_exceeded: outOfScopeFiles.length > 0,
        warnings: [...warnings, ...scopeWarnings],
      },
    };
  } catch {
    const normalizedRequestedFiles = normalizeRequestedFiles(cwd, requestedFiles);
    return {
      repo_root: cwd,
      worktree_name: worktree,
      changed_files: [],
      diff_stat: "(unable to observe)",
      diff_name_only: "(unable to observe)",
      base_commit: baseCommit,
      head_commit: headCommit.trim() || undefined,
      git_status_short: gitStatusShort,
      worktree_path: worktree ? `.claude/worktrees/${worktree}` : undefined,
      scope: {
        requested_files: normalizedRequestedFiles.length > 0 ? normalizedRequestedFiles : undefined,
        out_of_scope_files: [],
        scope_exceeded: false,
        warnings,
      },
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

function readOnlyDisallowedTools(): string[] {
  return DANGEROUS_DISALLOWED_TOOLS;
}

function createQueryOptions(input: ClaudeQueryInput): ClaudeRunOptions {
  return {
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
    disallowedTools: readOnlyDisallowedTools(),
    maxTurns: input.max_turns ?? 8,
    timeoutSec: input.timeout_sec ?? 120,
    jsonSchema: QUERY_SCHEMA,
  };
}

function createReviewOptions(input: ClaudeReviewInput): ClaudeRunOptions {
  return {
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
    disallowedTools: readOnlyDisallowedTools(),
    maxTurns: input.max_turns ?? 10,
    timeoutSec: input.timeout_sec ?? 180,
    jsonSchema: REVIEW_SCHEMA,
    noSessionPersistence: true,
  };
}

function createImplementOptions(
  input: ClaudeImplementInput,
  worktreeName: string,
  resumeSessionId?: string,
  forked?: boolean
): ClaudeRunOptions {
  return {
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
      ...DANGEROUS_DISALLOWED_TOOLS,
      "Bash(git push --force *)",
      "Bash(git branch -D *)",
      "Bash(git reset --hard *)",
      "Bash(git clean *)",
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
    maxTurns: input.max_turns ?? 15,
    timeoutSec: input.timeout_sec ?? 600,
    jsonSchema: IMPLEMENT_SCHEMA,
    resumeSessionId,
    forkSession: forked,
    maxBudgetUsd: input.max_cost_usd,
  };
}

export async function checkClaudeStatus(cwd: string): Promise<ClaudeStatusResult> {
  const result: ClaudeStatusResult = {
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
  } catch {
    result.errors.push("claude CLI not found in PATH");
  }

  // Check claude auth
  if (result.claude_available) {
    try {
      const authOutput = await execCapture(CLAUDE_BIN, ["auth", "status"], { cwd });
      try {
        const authJson = JSON.parse(authOutput);
        result.auth_status = authJson.loggedIn === true ? "authenticated" : "not authenticated";
      } catch {
        result.auth_status = authOutput.includes("Logged in") || authOutput.includes("loggedIn") ? "authenticated" : "unknown";
      }
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
        } catch { return false; }
      }).length;
    }
  } catch {
    // best-effort worktree scan
  }

  // Environment diagnostics (best-effort)
  try {
    result.environment_diagnostics = await getEnvironmentDiagnostics();
  } catch {
    // best-effort only
  }

  return result;
}

export async function runClaudeQuery(
  input: ClaudeQueryInput,
  runId: string
): Promise<ToolEnvelope<Record<string, unknown>>> {
  const store = await getStore();
  const repoKey = await computeRepoKey(input.cwd);

  // Auto-resume: find recent query session for the same repo
  const recent = store.getRecent(repoKey, "query", RECENT_WINDOW_MINUTES);
  const requestedSessionId = recent?.session_id ?? null;
  let resumed = false;
  let forked = false;

  const opts: ClaudeRunOptions = {
    ...createQueryOptions(input),
    resumeSessionId: requestedSessionId ?? undefined,
  };

  let returnedSessionId: string | null = null;

  try {
    const { report, session_id, execution } = await spawnClaude(opts);
    returnedSessionId = session_id;
    resumed = !!requestedSessionId;

    // Persist session
    if (session_id) {
      store.upsert(session_id, "query", repoKey, input.cwd, String((report.answer as string) ?? "").slice(0, 200));
    }

    const sessionLog: SessionLog = { requested_session_id: requestedSessionId, resumed, forked, returned_session_id: session_id };
    await logRun(runId, { type: "query", input, report, session: sessionLog });
    store.prune();
    return makeEnvelope("success", report, execution, [], { claude_report: report });
  } catch (err) {
    const errorMsg = (err as Error).message;

    // If resume failed (session not found / expired), mark expired and retry without resume
    if (requestedSessionId && isSessionNotFoundError(errorMsg)) {
      store.markExpired(requestedSessionId);
      log(`Session ${requestedSessionId} not found, falling back to new session`);

      // Retry without resume
      const retryOpts: ClaudeRunOptions = { ...opts, resumeSessionId: undefined };
      try {
        const { report, session_id, execution } = await spawnClaude(retryOpts);
        returnedSessionId = session_id;
        if (session_id) {
          store.upsert(session_id, "query", repoKey, input.cwd, String((report.answer as string) ?? "").slice(0, 200));
        }
        const sessionLog: SessionLog = { requested_session_id: requestedSessionId, resumed: false, forked: false, returned_session_id: session_id };
        await logRun(runId, { type: "query", input, report, session: sessionLog, retried_after_session_expired: true });
        return makeEnvelope("success", report, execution, [], { claude_report: report });
      } catch (retryErr) {
        await logRun(runId, { type: "query", input, error: (retryErr as Error).message, retried_after_session_expired: true });
        throw retryErr;
      }
    }

    await logRun(runId, { type: "query", input, error: errorMsg });
    throw err;
  }
}

// ---- Session failure detection ----

function isSessionNotFoundError(msg: string): boolean {
  const patterns = ["session not found", "not found", "session.*expired", "invalid session"];
  return patterns.some((p) => new RegExp(p, "i").test(msg));
}

export async function runClaudeReview(
  input: ClaudeReviewInput,
  runId: string
): Promise<ToolEnvelope<Record<string, unknown>>> {
  const opts = createReviewOptions(input);

  try {
    const { report, execution } = await spawnClaude(opts);
    await logRun(runId, { type: "review", input, report });
    return makeEnvelope("success", report, execution, [], { claude_report: report });
  } catch (err) {
    await logRun(runId, { type: "review", input, error: (err as Error).message });
    throw err;
  }
}

export async function runClaudeImplement(
  input: ClaudeImplementInput,
  runId: string
): Promise<ClaudeResult> {
  const store = await getStore();
  const repoKey = await computeRepoKey(input.cwd);
  const worktreeName = input.worktreeName ?? `codex-delegated-${runId.slice(0, 8)}`;
  const worktreeRelPath = path.join(".claude", "worktrees", worktreeName);
  const worktreePath = path.join(input.cwd, worktreeRelPath);
  const requestedFiles = normalizeRequestedFiles(input.cwd, input.files);
  let baseCommit: string | undefined;

  if (requestedFiles.length > 0) {
    const dirtyRequestedFiles = await findDirtyFiles(input.cwd, requestedFiles);
    if (dirtyRequestedFiles.length > 0) {
      const message =
        `Requested files contain uncommitted changes in main workspace: ${dirtyRequestedFiles.join(", ")}. ` +
        "Please commit/stash/clean them first, or use an explicit dirty-snapshot mode.";
      await logRun(runId, {
        type: "implement",
        input,
        error: message,
        requested_files: requestedFiles,
        dirty_requested_files: dirtyRequestedFiles,
        duration_ms: 0,
      });
      throw new Error(message);
    }
  }

  try {
    if (!existsSync(worktreePath)) {
      await mkdir(path.dirname(worktreePath), { recursive: true });
      await execCapture("git", ["worktree", "add", "--detach", worktreeRelPath, "HEAD"], {
        cwd: input.cwd,
        timeoutMs: 30000,
      });
    }
    const resolvedBase = await execCapture("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
    baseCommit = resolvedBase.trim() || undefined;
  } catch (err) {
    await logRun(runId, {
      type: "implement",
      input,
      error: `Failed to prepare worktree/base commit: ${err instanceof Error ? err.message : String(err)}`,
      duration_ms: 0,
    });
    throw err;
  }

  // implement only resumes when session_key is explicitly provided
  const resumeSessionId = input.session_key ?? undefined;
  const forked = input.fork_session ?? false;

  const opts = createImplementOptions(input, worktreeName, resumeSessionId, forked);

  let report: Record<string, unknown>;
  let returnedSessionId: string | null = null;
  let execution: ExecutionMetadata;
  const startTime = Date.now();

  try {
    const result = await spawnClaude(opts);
    report = result.report;
    returnedSessionId = result.session_id;
    execution = result.execution;
  } catch (err) {
    const errorMsg = (err as Error).message;

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
    store.upsert(returnedSessionId, "implement", repoKey, input.cwd, (report.summary as string) ?? "");
  }

  // Observe actual changes (don't trust Claude's self-report alone)
  const observed = await observeResult(input.cwd, worktreeName, baseCommit, requestedFiles);

  // Check resource limits
  if (input.max_changed_files !== undefined || input.max_cost_usd !== undefined) {
    const warnings: string[] = [];
    const exceeded =
      input.max_changed_files !== undefined &&
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
  if (observed.scope?.scope_exceeded) {
    for (const warning of observed.scope.warnings) {
      log(`Scope warning: ${warning}`);
    }
  }

  const sessionLog: SessionLog = {
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
  const warnings = [
    ...(observed.resource_limits?.warnings ?? []),
    ...(observed.scope?.warnings ?? []),
    "Worktree is retained for inspection. After applying results, call claude_cleanup to remove old delegated worktrees.",
  ];
  return makeEnvelope("success", undefined, execution, warnings, {
    claude_report: report,
    server_observed: observed,
  });
}

// ---- Apply worktree diff to main workspace ----

export async function runClaudeApply(input: ClaudeApplyInput, runId: string): Promise<ClaudeApplyResult> {
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

  const wtRelPath = path.join(".claude", "worktrees", path.basename(wtReal));
  const implementLog = await findImplementLogForWorktree(wtRelPath);
  const observedBaseCommit =
    typeof implementLog?.observed?.base_commit === "string" ? implementLog.observed.base_commit.trim() : "";
  const baseCommit = observedBaseCommit || undefined;
  const observedChangedFiles = Array.isArray(implementLog?.observed?.changed_files)
    ? implementLog.observed.changed_files.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  const hasObservedScope = baseCommit !== undefined && observedChangedFiles.length > 0;
  const pathspecs = hasObservedScope ? observedChangedFiles : ["src/"];

  let diffStat = "";
  if (baseCommit) {
    diffStat = await execCapture("git", ["diff", "--stat", baseCommit, "HEAD", "--", ...pathspecs], { cwd: wtReal, timeoutMs: 10000 }).catch(() => "");
  }

  const [trackedStatus, uncommittedStatus, untrackedStatus] = await Promise.all([
    baseCommit
      ? execCapture("git", ["diff", "--name-status", "-z", baseCommit, "HEAD", "--", ...pathspecs], { cwd: wtReal, timeoutMs: 10000 }).catch(() => "")
      : Promise.resolve(""),
    execCapture("git", ["diff", "--name-status", "-z", "--", ...pathspecs], { cwd: wtReal, timeoutMs: 10000 }).catch(() => ""),
    execCapture("git", ["status", "--porcelain=v1", "-z", "--", ...pathspecs], { cwd: wtReal, timeoutMs: 10000 }).catch(() => ""),
  ]);

  const changesByFile = new Map<string, { status: string; file: string }>();
  function addChange(change: { status: string; file: string }): void {
    if (hasObservedScope) {
      if (!observedChangedFiles.includes(change.file)) return;
    } else if (!change.file.startsWith("src/")) {
      return;
    }
    changesByFile.set(change.file, change);
  }

  for (const change of parseNameStatusPorcelainZ(trackedStatus)) addChange(change);
  for (const change of parseNameStatusPorcelainZ(uncommittedStatus)) addChange(change);
  for (const change of parseStatusPorcelainZ(untrackedStatus)) addChange(change);

  let usedFallback = false;
  if (!baseCommit) {
    usedFallback = true;
    const [legacyDiffStatus, legacyHeadStatus, legacyStatus] = await Promise.all([
      execCapture("git", ["diff", "--name-status", "-z", "--", "src/"], { cwd: wtReal, timeoutMs: 10000 }).catch(() => ""),
      execCapture("git", ["diff", "--name-status", "-z", "HEAD~1", "--", "src/"], { cwd: wtReal, timeoutMs: 10000 }).catch(() => ""),
      execCapture("git", ["status", "--porcelain=v1", "-z", "--", "src/"], { cwd: wtReal, timeoutMs: 10000 }).catch(() => ""),
    ]);
    for (const change of parseNameStatusPorcelainZ(legacyDiffStatus)) addChange(change);
    for (const change of parseNameStatusPorcelainZ(legacyHeadStatus)) addChange(change);
    for (const change of parseStatusPorcelainZ(legacyStatus)) addChange(change);
    if (!diffStat.trim()) {
      diffStat = await execCapture("git", ["diff", "--stat", "HEAD~1", "--", "src/"], { cwd: wtReal, timeoutMs: 10000 }).catch(() => "");
    }
  }

  const changes = [...changesByFile.values()].sort((a, b) => a.file.localeCompare(b.file));
  if (!diffStat.trim() && changes.length > 0) {
    diffStat = changes.map((c) => `${c.status}\t${c.file}`).join("\n");
  }
  if (usedFallback) {
    diffStat = `[fallback_without_base_commit]\n${diffStat || "(no stat)"}`;
  }
  if (changes.length === 0) {
    return { applied_files: [], diff_stat: diffStat, cleanup_performed: false, conflicts: [], error: "No changed files found in worktree" };
  }

  const resourceLimits = implementLog?.observed?.resource_limits;
  if (resourceLimits?.changed_files_exceeded === true) {
    const warnings = Array.isArray(resourceLimits.warnings)
      ? resourceLimits.warnings.filter((item): item is string => typeof item === "string")
      : [];
    return {
      applied_files: [],
      diff_stat: diffStat,
      cleanup_performed: false,
      conflicts: warnings,
      error: "Worktree exceeded implement resource limits; apply refused",
    };
  }

  const observedScope = implementLog?.observed?.scope;
  if (observedScope?.scope_exceeded === true) {
    const warnings = Array.isArray(observedScope.warnings)
      ? observedScope.warnings.filter((item): item is string => typeof item === "string")
      : [];
    return {
      applied_files: [],
      diff_stat: diffStat,
      cleanup_performed: false,
      conflicts: warnings,
      error: "Worktree contains changes outside requested files; apply refused",
    };
  }

  // Preflight: check for uncommitted changes in main workspace and
  // unsupported status codes. If any issues found, refuse the entire apply.
  const conflicts: string[] = [];
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
    } catch {}
  }

  if (conflicts.length > 0) {
    return { applied_files: [], diff_stat: diffStat, cleanup_performed: false, conflicts, error: "Main workspace has uncommitted or unsupported changes; apply refused" };
  }

  // Apply changes
  const copied: string[] = [];
  for (const c of changes) {
    const dest = path.join(input.cwd, c.file);
    const src = path.join(wtReal, c.file);
    try {
      if (c.status === "D") {
        // Deletion
        if (existsSync(dest)) {
          await import("node:fs/promises").then((m) => m.rm(dest).catch(() => {}));
        }
        copied.push(c.file);
      } else {
        // Modified or added — copy from worktree
        const content = await import("node:fs/promises").then((m) => m.readFile(src));
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, content);
        copied.push(c.file);
      }
    } catch (err) {
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
    } catch (err) {
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

export async function runClaudeCleanup(input: ClaudeCleanupInput, runId: string): Promise<ClaudeCleanupResult> {
  const startTime = Date.now();
  const dryRun = input.dry_run !== false; // default true
  const olderThanHours = input.older_than_hours ?? 0;

  const worktreeDir = path.join(input.cwd, ".claude", "worktrees");
  const entries: CleanupEntry[] = [];
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
        } catch {
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
      } catch (err) {
        failedCount++;
        entries.push({ worktree_name: name, removed: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (!dryRun) {
      await execCapture("git", ["worktree", "prune"], { cwd: input.cwd, timeoutMs: 10000 }).catch(() => {});
    }
  } catch (err) {
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
