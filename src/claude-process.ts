import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { sanitizeEnv } from "./guard.js";
import { StructuredToolError } from "./schema.js";
import type {
  EnvironmentDiagnostics,
  EnvStatus,
  ExecutionMetadata,
  ServerObserved,
  ToolEnvelope,
} from "./schema.js";

function log(msg: string): void {
  process.stderr.write(`[claude-delegate] ${msg}\n`);
}
export const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

let activeClaudeChild: ChildProcess | null = null;

// ---- Sensitive data redaction for stderr ----

function redactSensitive(input: string): string {
  return input
    .replace(/(ANTHROPIC_AUTH_TOKEN=)[^\s]+/gi, "$1***")
    .replace(/(ANTHROPIC_API_KEY=)[^\s]+/gi, "$1***")
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, "$1***")
    .replace(/\b(sk-ant-[a-zA-Z0-9]{20,})\b/g, "sk-ant-***")
    .replace(/\b(sk-[a-zA-Z0-9]{20,})\b/g, "sk-***");
}

export interface ClaudeRunOptions {
  prompt: string;
  cwd: string;
  worktree?: string;
  tools: string;
  allowedTools: string[];
  disallowedTools: string[];
  maxTurns?: number;
  timeoutSec: number;
  jsonSchema: object;
  maxBudgetUsd?: number;
  // Session options
  resumeSessionId?: string;
  forkSession?: boolean;
  noSessionPersistence?: boolean;
}

export interface ClaudeSpawnResult {
  report: Record<string, unknown>;
  session_id: string | null;
  execution: ExecutionMetadata;
}

export function truncateTail(input: string, maxChars = 4000): string {
  return input.length <= maxChars ? input : input.slice(-maxChars);
}

export function buildSafeEnv(): Record<string, string> {
  return sanitizeEnv();
}

export function abortActiveClaudeRun(signal: NodeJS.Signals = "SIGTERM"): boolean {
  if (!activeClaudeChild?.pid) return false;
  try {
    process.kill(activeClaudeChild.pid, signal);
    return true;
  } catch {
    return false;
  }
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

  args.push("--tools", opts.tools);

  if (opts.maxTurns !== undefined) {
    args.push("--max-turns", String(opts.maxTurns));
  }

  args.push("--output-format", "json");

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

export function successExecution(durationMs = 0): ExecutionMetadata {
  return { exit_code: 0, duration_ms: durationMs, timed_out: false, stdout_tail: "", stderr_tail: "" };
}

export function makeEnvelope<T>(
  status: ToolEnvelope<T>["status"],
  data: T | undefined,
  execution: ExecutionMetadata,
  warnings: string[] = [],
  extra: Pick<ToolEnvelope<T>, "claude_report" | "server_observed"> = {}
): ToolEnvelope<T> {
  return { status, data, execution, warnings, ...extra };
}

export function reportIndicatesFailure(report: Record<string, unknown>, execution: ExecutionMetadata): boolean {
  return (
    (execution.exit_code !== null && execution.exit_code !== 0) ||
    execution.timed_out ||
    report.is_error === true ||
    report.status === "failed"
  );
}

export function implementEnvelopeStatus(
  report: Record<string, unknown>,
  execution: ExecutionMetadata,
  observed: ServerObserved
): ToolEnvelope<undefined>["status"] {
  if (!reportIndicatesFailure(report, execution)) {
    if (report.status === "partial" || report.status === "needs_user") return report.status;
    return "success";
  }
  return observed.changed_files.length > 0 ? "partial" : "failed";
}

function noOutputPayload(
  message: string,
  opts: ClaudeRunOptions,
  code: number | null,
  signal: NodeJS.Signals | null,
  stdout: string,
  stderr: string,
  stderrTail: string,
  environmentDiagnostics?: EnvironmentDiagnostics
): Record<string, unknown> {
  return {
    error: message,
    diagnostics: {
      exit_code: code,
      signal: signal ?? "none",
      timeout_sec: opts.timeoutSec,
      stdout_len: stdout.length,
      stderr_len: stderr.length,
      stderr_tail: stderrTail,
      environment_diagnostics: environmentDiagnostics,
    },
    next_actions: [
      {
        tool: "claude_review",
        reason: "Retry with a higher timeout_sec if the review scope is broad or Claude was still starting.",
      },
      {
        tool: "claude_review",
        args: { background: true },
        reason: "Run broad reviews in the background so Codex can poll the job instead of timing out foreground execution.",
      },
      {
        tool: "claude_status",
        reason: "Check Claude CLI auth, PATH, proxy, and local environment diagnostics before retrying.",
      },
    ],
  };
}

export function spawnClaude(opts: ClaudeRunOptions): Promise<ClaudeSpawnResult> {
  const args = buildClaudeArgs(opts);
  const safeEnv = sanitizeEnv();
  const startTime = Date.now();

  log(`spawning: ${CLAUDE_BIN} -p (${args.length} args, worktree=${opts.worktree ?? "none"}, maxTurns=${opts.maxTurns ?? "unlimited"})`);

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd: opts.cwd,
      env: safeEnv,
      timeout: opts.timeoutSec * 1000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeClaudeChild = child;

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      activeClaudeChild = null;
      if (err.code === "ENOENT") {
        reject(new Error(`Claude CLI not found. Ensure "claude" is in PATH or set CLAUDE_BIN env var.`));
      } else {
        reject(err);
      }
    });

    child.on("close", async (code, signal) => {
      activeClaudeChild = null;
      if (stderr) log(`claude stderr: ${redactSensitive(stderr.slice(0, 2000))}`);

      // Try to parse stdout even when exit code is non-zero.
      // Claude may exit with code 1 on max_turns but still produce
      // valid structured_output in the result payload.
      try {
        const trimmed = stdout.trim();
        if (!trimmed) {
          const stderrTail = redactSensitive(stderr.slice(-1000));
          let environmentDiagnostics: EnvironmentDiagnostics | undefined;
          let diagStr = "";
          try {
            environmentDiagnostics = await getEnvironmentDiagnostics(safeEnv);
            diagStr = ` environment_diagnostics=${JSON.stringify(environmentDiagnostics)}`;
          } catch {}
          const message =
            `Claude produced no output (exit ${code}, signal ${signal ?? "none"}, timeout_sec=${opts.timeoutSec}, stdoutLen=${stdout.length}, stderrLen=${stderr.length}, stderrTail=${JSON.stringify(stderrTail)})` +
            diagStr;
          reject(new StructuredToolError(
            message,
            noOutputPayload(message, opts, code, signal, stdout, stderr, stderrTail, environmentDiagnostics)
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

export async function getEnvironmentDiagnostics(safeEnv: Record<string, string> = sanitizeEnv()): Promise<EnvironmentDiagnostics> {
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
