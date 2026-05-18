import { realpath, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

// Dangerous system directories that tools must never operate within.
// Subdirectories of these roots are also blocked (e.g. /var/log, /usr/local/bin).
const DANGEROUS_ROOTS: ReadonlySet<string> = new Set([
  "/",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib64",
  "/opt",
  "/proc",
  "/root",
  "/sbin",
  "/sys",
  "/tmp",
  "/usr",
  "/var",
]);

// Allowlist of directories that MCP tools may operate within.
// Override via CODEX_CLAUDE_ALLOW_ROOTS (colon-separated paths on macOS/Linux).
export function dangerousRoot(raw: string): boolean {
  const resolved = path.resolve(raw);
  const home = process.env.HOME ? path.resolve(process.env.HOME) : "";

  // Home directory itself is dangerous (operating on the entire home).
  if (!!home && resolved === home) return true;

  // If the path is inside HOME, it is safe — the user's own data is not
  // a system dangerous root, even if HOME happens to live under /var, /tmp, etc.
  if (!!home && resolved.startsWith(home + path.sep)) return false;

  // Exact match against dangerous system roots
  if (DANGEROUS_ROOTS.has(resolved)) return true;

  // Subdirectory of any dangerous system directory
  for (const root of DANGEROUS_ROOTS) {
    if (root === "/") continue; // "/" prefix-matches everything, handle exactly only
    if (resolved.startsWith(root + path.sep)) return true;
  }

  return false;
}

function splitAllowRootsEnv(raw: string): string[] {
  const delimiterPattern = path.delimiter === ";" ? /[;,]/g : /[:,]/g;
  return raw.split(delimiterPattern).map((part) => part.trim()).filter(Boolean);
}

export function getAllowRoots(): string[] {
  const normalizeRoot = (p: string): string => {
    const resolved = path.resolve(p);
    try {
      return realpathSync(resolved);
    } catch {
      return resolved;
    }
  };
  const env = process.env.CODEX_CLAUDE_ALLOW_ROOTS;
  if (env) {
    return splitAllowRootsEnv(env).map(normalizeRoot);
  }
  const home = process.env.HOME;
  return [
    home ? `${home}/projects` : null,
    home ? `${home}/work` : null,
    home ? `${home}/codex-claude` : null,
  ].filter(Boolean) as string[];
}

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

  const allowRoots = getAllowRoots();
  const isWithinAllowed = allowRoots.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep)
  );

  // Allow-roots override: if path is within an allowed root, skip dangerous-root checks.
  if (!isWithinAllowed) {
    if (dangerousRoot(raw)) {
      return { ok: false, resolved: path.resolve(raw), error: `Refusing dangerous root path: ${path.resolve(raw)}` };
    }
    if (dangerousRoot(resolved)) {
      return { ok: false, resolved, error: `Refusing dangerous root path: ${resolved}` };
    }
    return {
      ok: false,
      resolved,
      error: `Path "${resolved}" is outside allowed roots: ${allowRoots.join(", ")}`,
    };
  }

  // Must be a directory
  const s = await stat(resolved);
  if (!s.isDirectory()) {
    return { ok: false, resolved, error: `Path is not a directory: ${resolved}` };
  }

  return { ok: true, resolved };
}

export async function validateFilesWithinCwd(cwd: string, files?: string[]): Promise<CwdCheck> {
  const cwdReal = await realpath(cwd);
  for (const file of files ?? []) {
    const candidate = path.resolve(cwdReal, file);
    let resolved = candidate;
    try {
      resolved = await realpath(candidate);
    } catch {
      resolved = candidate;
    }
    if (resolved !== cwdReal && !resolved.startsWith(cwdReal + path.sep)) {
      return { ok: false, resolved, error: `File path escapes cwd: ${file}` };
    }
  }
  return { ok: true, resolved: cwdReal };
}

export function resolveRepoLocalPath(cwd: string, relativePath: string): CwdCheck {
  const resolved = path.resolve(cwd, relativePath);
  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
    return { ok: false, resolved, error: `Path escapes cwd: ${relativePath}` };
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
    await execCapture("git", ["worktree", "list"], { cwd });
    return true;
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

export function assertCanDelegate(): void {
  const depth = checkRecursion();
  if (depth >= MAX_BRIDGE_DEPTH) {
    throw new Error(`BRIDGE_DEPTH=${depth} >= ${MAX_BRIDGE_DEPTH}; refusing recursive delegation`);
  }
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

  safe.BRIDGE_DEPTH = String(Math.min(checkRecursion() + 1, MAX_BRIDGE_DEPTH));

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
