import { realpath, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import type { ContextRoot } from "./schema.js";

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

/** Exact match against a dangerous root — always rejected, cannot be overridden. */
export function dangerousRootExact(raw: string): boolean {
  const resolved = path.resolve(raw);
  const home = process.env.HOME ? path.resolve(process.env.HOME) : "";
  if (!!home && resolved === home) return true;
  return DANGEROUS_ROOTS.has(resolved);
}

/** Subdirectory of a dangerous root — rejected unless overridden by allow-roots. */
export function dangerousRootPrefix(resolved: string): boolean {
  const home = process.env.HOME ? path.resolve(process.env.HOME) : "";

  // Inside HOME is always safe, even if HOME lives under a dangerous tree.
  if (!!home && resolved.startsWith(home + path.sep)) return false;

  for (const root of DANGEROUS_ROOTS) {
    if (root === "/") continue;
    if (resolved.startsWith(root + path.sep)) return true;
  }

  return false;
}

/** Combined check (for callers that want the original single-call behavior). */
export function dangerousRoot(raw: string): boolean {
  return dangerousRootExact(raw) || dangerousRootPrefix(path.resolve(raw));
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

  // Exact dangerous root match: always rejected, allow-roots cannot override.
  if (dangerousRootExact(raw)) {
    return { ok: false, resolved: path.resolve(raw), error: `Refusing dangerous root path: ${path.resolve(raw)}` };
  }
  if (dangerousRootExact(resolved)) {
    return { ok: false, resolved, error: `Refusing dangerous root path: ${resolved}` };
  }

  // Prefix dangerous root match: rejected unless overridden by allow-roots
  // (e.g., /var/folders/.../repo on macOS resides under /var but is safe).
  if (dangerousRootPrefix(resolved) && !isWithinAllowed) {
    return { ok: false, resolved, error: `Refusing dangerous root path: ${resolved}` };
  }

  if (!isWithinAllowed) {
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

export interface ContextRootCheck {
  ok: boolean;
  roots?: ContextRoot[];
  error?: string;
}

export async function validateContextRoots(
  primaryCwd: string,
  roots: ContextRoot[],
): Promise<ContextRootCheck> {
  const primaryCheck = await validateCwd(primaryCwd);
  if (!primaryCheck.ok) {
    return { ok: false, error: primaryCheck.error };
  }
  const primaryReal = primaryCheck.resolved;

  const resolvedRoots: ContextRoot[] = [];
  const seenAliases = new Set<string>();
  const seenCwds = new Set<string>();

  for (const root of roots) {
    const alias = root.alias.trim();
    if (alias.toLowerCase() === "primary") {
      return { ok: false, error: `Alias "primary" is reserved` };
    }
    if (seenAliases.has(alias)) {
      return { ok: false, error: `Duplicate context root alias: ${alias}` };
    }
    seenAliases.add(alias);

    const resolvedCwd = path.resolve(primaryCwd, root.cwd.trim());
    const rootCheck = await validateCwd(resolvedCwd);
    if (!rootCheck.ok) {
      return { ok: false, error: `Context root "${alias}" failed validation: ${rootCheck.error}` };
    }
    const rootReal = rootCheck.resolved;

    const rootStat = await stat(rootReal);
    if (!rootStat.isDirectory()) {
      return { ok: false, error: `Context root path is not a directory: ${root.cwd}` };
    }

    if (isDelegatedWorktreePath(rootReal)) {
      return { ok: false, error: `Context root must not be a delegated worktree path: ${root.cwd}` };
    }

    if (rootReal === primaryReal) {
      return { ok: false, error: `Context root "${alias}" must not be the same as the primary cwd` };
    }

    if (rootReal.startsWith(primaryReal + path.sep)) {
      return { ok: false, error: `Context root "${alias}" must not be a child of the primary cwd` };
    }

    if (primaryReal.startsWith(rootReal + path.sep)) {
      return { ok: false, error: `Context root "${alias}" must not be a parent of the primary cwd` };
    }

    if (seenCwds.has(rootReal)) {
      return { ok: false, error: `Duplicate context root path: ${rootReal}` };
    }
    seenCwds.add(rootReal);

    resolvedRoots.push({ alias, cwd: rootReal });
  }

  // Check for overlapping context roots
  for (let i = 0; i < resolvedRoots.length; i++) {
    for (let j = i + 1; j < resolvedRoots.length; j++) {
      const a = resolvedRoots[i]!.cwd;
      const b = resolvedRoots[j]!.cwd;
      if (a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) {
        return {
          ok: false,
          error: `Context roots "${resolvedRoots[i]!.alias}" and "${resolvedRoots[j]!.alias}" overlap`,
        };
      }
    }
  }

  return { ok: true, roots: resolvedRoots };
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

// ---- Delegated worktree path detection ----

/**
 * Returns true if cwd is inside a delegated worktree path
 * (i.e. contains consecutive segments .claude / worktrees / codex-delegated-*).
 * Uses path-segment matching so that a directory merely named codex-delegated-*
 * outside of .claude/worktrees/ is not falsely flagged.
 */
export function isDelegatedWorktreePath(cwd: string): boolean {
  const normalized = path.normalize(path.resolve(cwd));
  const segments = normalized.split(path.sep).filter(Boolean);

  for (let i = 0; i < segments.length - 2; i++) {
    if (
      segments[i] === ".claude" &&
      segments[i + 1] === "worktrees" &&
      segments[i + 2].startsWith("codex-delegated-")
    ) {
      return true;
    }
  }

  return false;
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

const DANGEROUS_ENV_KEYS: ReadonlyArray<string> = [
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

const ALLOWED_ENV_KEYS: ReadonlyArray<string> = [
  "PATH",
  "HOME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "USER",
  "TMPDIR",
  "TEMP",
  "TMP",
  "NODE_ENV",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ANTHROPIC_BASE_URL",
];

const SENSITIVE_KEYWORDS: ReadonlyArray<string> = [
  "AUTH",
  "COOKIE",
  "SESSION",
  "PRIVATE",
  "KEY",
  "SECRET",
  "TOKEN",
  "CREDENTIAL",
  "PASSWORD",
  "API_KEY",
];

const SENSITIVE_EXACT_NAMES: ReadonlySet<string> = new Set([
  "DATABASE_URL",
  "DSN",
  ...DANGEROUS_ENV_KEYS,
]);

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PASSTHROUGH_ENV_KEY = "CODEX_CLAUDE_ENV_PASSTHROUGH";

function parsePassthroughEnv(): string[] {
  const raw = process.env[PASSTHROUGH_ENV_KEY];
  if (!raw) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (!name || seen.has(name)) continue;
    const upper = name.toUpperCase();
    if (!ENV_NAME_RE.test(name)) continue;
    if (upper === PASSTHROUGH_ENV_KEY) continue;
    if (SENSITIVE_EXACT_NAMES.has(upper)) continue;
    if (SENSITIVE_KEYWORDS.some((kw) => upper.includes(kw))) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

export function sanitizeEnv(): Record<string, string> {
  const safe: Record<string, string> = {};
  const passthrough = parsePassthroughEnv();

  for (const key of ALLOWED_ENV_KEYS) {
    if (process.env[key] !== undefined) {
      safe[key] = process.env[key]!;
    }
  }

  for (const key of passthrough) {
    if (key !== PASSTHROUGH_ENV_KEY && process.env[key] !== undefined) {
      safe[key] = process.env[key]!;
    }
  }

  // Keep known-dangerous keys stripped even if someone added them to ALLOWED_ENV_KEYS
  for (const key of DANGEROUS_ENV_KEYS) {
    delete safe[key];
  }

  safe.BRIDGE_DEPTH = String(Math.min(checkRecursion() + 1, MAX_BRIDGE_DEPTH));

  return safe;
}

export interface EnvSanitizationDiagnostics {
  allowlisted_present: number;
  allowlisted_names: string[];
  passthrough_present: number;
  passthrough_names: string[];
  blocked_passthrough_count: number;
  blocked_passthrough_names: string[];
}

export function isSensitiveName(name: string): boolean {
  const upper = name.toUpperCase();
  if (SENSITIVE_EXACT_NAMES.has(upper)) return true;
  return SENSITIVE_KEYWORDS.some((kw) => upper.includes(kw));
}

export function getEnvSanitizationDiagnostics(): EnvSanitizationDiagnostics {
  const rawPassthrough = (process.env[PASSTHROUGH_ENV_KEY] ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  const allowlistedNames = ALLOWED_ENV_KEYS.filter((k) => process.env[k] !== undefined);
  const passthroughNames: string[] = [];
  const blockedNames: string[] = [];

  for (const name of rawPassthrough) {
    const upper = name.toUpperCase();
    if (!ENV_NAME_RE.test(name)) {
      blockedNames.push(name);
      continue;
    }
    if (upper === PASSTHROUGH_ENV_KEY || isSensitiveName(name)) {
      blockedNames.push(name);
      continue;
    }
    passthroughNames.push(name);
  }

  return {
    allowlisted_present: allowlistedNames.length,
    allowlisted_names: allowlistedNames,
    passthrough_present: passthroughNames.length,
    passthrough_names: passthroughNames,
    blocked_passthrough_count: blockedNames.length,
    blocked_passthrough_names: blockedNames,
  };
}

// ---- Cli execution helper ----

export function execCapture(
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number; env?: Record<string, string | undefined> }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 30_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env ? { ...process.env, ...opts.env } : undefined,
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
