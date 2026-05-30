import { spawn } from "node:child_process";

import { sanitizeEnv } from "./guard.js";
import type {
  ServerVerified,
  ServerVerifiedCommand,
} from "./schema.js";

const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 300_000;
const TAIL_CHARS = 4000;
const FORBIDDEN_SCRIPT_NAMES = new Set([
  "add",
  "deploy",
  "install",
  "publish",
  "remove",
  "serve",
  "start",
  "uninstall",
]);
const ALLOWED_NPX_TOOLS = new Set(["vitest", "jest", "tsc", "eslint"]);
const FORBIDDEN_ARG_TOKENS = new Set(["&&", "||", ";", "|", ">", ">>", "<", "&"]);

export interface VerificationOptions {
  /** Restrictive: only these script names are allowed for run-script commands */
  allowedScripts?: string[];
  /** Override timeout (bounded to MAX_TIMEOUT_MS) */
  timeoutMs?: number;
}

export function clampVerificationTimeout(timeoutMs: number): number {
  return Math.min(timeoutMs, MAX_TIMEOUT_MS);
}

function truncateTail(value: string, maxChars = TAIL_CHARS): string {
  return value.length <= maxChars ? value : value.slice(-maxChars);
}

export function parseVerificationCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  let escaping = false;

  for (const ch of command) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (escaping) current += "\\";
  if (quote) {
    throw new Error("unterminated quoted argument");
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function scriptNameIsAllowed(scriptName: string | undefined, allowedScripts?: string[]): boolean {
  if (!scriptName) return false;
  if (FORBIDDEN_SCRIPT_NAMES.has(scriptName)) return false;
  // If an allowlist is provided, the script must be in it (restrictive only)
  if (allowedScripts !== undefined) {
    return allowedScripts.includes(scriptName);
  }
  return true;
}

function verificationArgvIsAllowed(argv: string[], allowedScripts?: string[]): boolean {
  const [bin, first, second] = argv;
  if (!bin) return false;
  if (argv.some((arg) => FORBIDDEN_ARG_TOKENS.has(arg))) return false;

  if (bin === "npm") {
    if (first === "test") return true;
    if (first === "run") return scriptNameIsAllowed(second, allowedScripts);
    return false;
  }
  if (bin === "npx") {
    return !!first && ALLOWED_NPX_TOOLS.has(first);
  }
  if (bin === "yarn" || bin === "pnpm") {
    if (first === "test") return true;
    if (first === "run") return scriptNameIsAllowed(second, allowedScripts);
    return false;
  }
  if (bin === "pytest" || bin === "tsc" || bin === "eslint") return true;
  if (bin === "go") return first === "test";
  if (bin === "cargo") return first === "test";
  return false;
}

function skippedResult(command: string, reason: string): ServerVerifiedCommand {
  return {
    command,
    status: "skipped",
    exit_code: null,
    duration_ms: 0,
    stdout_tail: "",
    stderr_tail: "",
    timed_out: false,
    skipped_reason: reason,
  };
}

async function runSingleVerificationCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  allowedScripts: string[] | undefined,
  env: Record<string, string>,
): Promise<ServerVerifiedCommand> {
  let argv: string[];
  try {
    argv = parseVerificationCommand(command);
  } catch (err) {
    return skippedResult(command, err instanceof Error ? err.message : String(err));
  }

  if (!verificationArgvIsAllowed(argv, allowedScripts)) {
    return skippedResult(command, "Command is not allowed by server verification policy.");
  }

  const [bin, ...args] = argv;
  const start = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    const finish = (result: Omit<ServerVerifiedCommand, "command" | "duration_ms" | "stdout_tail" | "stderr_tail" | "timed_out">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        command,
        duration_ms: Date.now() - start,
        stdout_tail: truncateTail(stdout),
        stderr_tail: truncateTail(stderr),
        timed_out: timedOut,
        ...result,
      });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      stderr += err.message;
      finish({
        status: "failed",
        exit_code: null,
        skipped_reason: undefined,
      });
    });
    child.on("close", (code) => {
      finish({
        status: code === 0 ? "passed" : "failed",
        exit_code: timedOut ? null : code,
        skipped_reason: undefined,
      });
    });
  });
}

export async function runVerificationCommands(
  commands: string[] | undefined,
  cwd: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  opts?: VerificationOptions,
): Promise<ServerVerified | undefined> {
  if (!commands || commands.length === 0) return undefined;

  const effectiveTimeout = opts?.timeoutMs !== undefined
    ? clampVerificationTimeout(opts.timeoutMs)
    : timeoutMs;
  const allowedScripts = opts?.allowedScripts;
  const sanitizedEnv = sanitizeEnv();

  const results: ServerVerifiedCommand[] = [];
  for (const command of commands) {
    results.push(await runSingleVerificationCommand(command, cwd, effectiveTimeout, allowedScripts, sanitizedEnv));
  }

  return {
    status: results.every((result) => result.status === "passed") ? "passed" : "failed",
    commands: results,
  };
}

export function buildVerificationWarnings(
  verification: ServerVerified | undefined,
): string[] {
  if (!verification || verification.status === "passed") return [];
  const failedCmds = verification.commands
    .filter((command) => command.status !== "passed")
    .map((command) => {
      const reason = command.status === "skipped"
        ? `skipped: ${command.skipped_reason ?? "unknown reason"}`
        : command.timed_out
          ? "timed out"
          : command.exit_code === null
            ? "failed to start"
            : `exit ${command.exit_code}`;
      return `"${command.command}" (${reason})`;
    });
  return [
    `Server-side verification failed: ${failedCmds.join("; ")}. Treat Claude self-reported results as incomplete.`,
  ];
}
