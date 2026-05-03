import { realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

// Allowlist of directories that MCP tools may operate within.
const ALLOW_ROOTS = [
  process.env.HOME ? `${process.env.HOME}/projects` : null,
  process.env.HOME ? `${process.env.HOME}/work` : null,
  process.env.HOME ? `${process.env.HOME}/codex-claude` : null,
].filter(Boolean) as string[];

// ---- cwd validation ----

export interface CwdCheck {
  ok: boolean;
  resolved: string;
  error?: string;
}

export async function validateCwd(raw: string): Promise<CwdCheck> {
  // Resolve symlinks and relative paths
  let resolved: string;
  try {
    resolved = await realpath(raw);
  } catch {
    return { ok: false, resolved: raw, error: `Path does not exist: ${raw}` };
  }

  // Must be within an allowed root
  const allowed = ALLOW_ROOTS.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep)
  );
  if (!allowed) {
    return {
      ok: false,
      resolved,
      error: `Path "${resolved}" is outside allowed roots: ${ALLOW_ROOTS.join(", ")}`,
    };
  }

  // Must be a directory
  const s = await stat(resolved);
  if (!s.isDirectory()) {
    return { ok: false, resolved, error: `Path is not a directory: ${resolved}` };
  }

  return { ok: true, resolved };
}

// ---- Git repo check ----

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execCapture("git", ["rev-parse", "--git-dir"], { cwd });
    return true;
  } catch {
    return false;
  }
}

// ---- Worktree capability check ----

export async function supportsWorktree(cwd: string): Promise<boolean> {
  try {
    const out = await execCapture("git", ["worktree", "list"], { cwd });
    return out.length > 0 || true; // command succeeded = worktree support exists
  } catch {
    return false;
  }
}

// ---- Recursion guard ----

export const MAX_BRIDGE_DEPTH = 2;

export function checkRecursion(): number {
  const raw = process.env.BRIDGE_DEPTH ?? "0";
  const depth = Number.parseInt(raw, 10);
  if (Number.isNaN(depth) || depth < 0) return 0;
  return depth;
}

// ---- Environment sanitization ----

const DANGEROUS_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "DOCKER_PASSWORD",
  "NPM_TOKEN",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
];

const ALLOWED_ENV_KEYS = [
  "PATH",
  "HOME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "USER",
  "TMPDIR",
  "TEMP",
  "TMP",
  "NODE_ENV",
];

export function sanitizeEnv(): Record<string, string> {
  const safe: Record<string, string> = {};

  // Keep known-safe vars
  for (const key of ALLOWED_ENV_KEYS) {
    if (process.env[key] !== undefined) {
      safe[key] = process.env[key];
    }
  }

  // Strip dangerous secrets
  for (const key of Object.keys(process.env)) {
    const upper = key.toUpperCase();
    if (
      DANGEROUS_ENV_KEYS.includes(upper) ||
      upper.includes("SECRET") ||
      upper.includes("TOKEN") ||
      upper.includes("CREDENTIAL") ||
      upper.includes("PASSWORD") ||
      upper.includes("API_KEY")
    ) {
      continue;
    }
    if (!(key in safe)) {
      safe[key] = process.env[key]!;
    }
  }

  safe.BRIDGE_DEPTH = String(1);

  return safe;
}

// ---- Cli execution helper ----

export function execCapture(
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 30_000,
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

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Command failed (exit ${code}): ${command} ${args.join(" ")}\n${stderr}`));
      }
    });
  });
}

export function execStream(
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number },
  onStdout?: (line: string) => void
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 300_000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      onStdout?.(chunk.toString());
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      resolve({ code, stderr });
    });
  });
}
