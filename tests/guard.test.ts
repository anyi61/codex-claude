import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertCanDelegate,
  dangerousRoot,
  getEnvSanitizationDiagnostics,
  isGitRepo,
  isDelegatedWorktreePath,
  sanitizeEnv,
  supportsWorktree,
  validateCwd,
  validateContextRoots,
  validateFilesWithinCwd,
} from "../src/guard.js";

const execFileAsync = promisify(execFile);

let root: string;
let repo: string;
let oldEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
  oldEnv = { ...process.env };
  root = await mkdtemp(path.join(os.tmpdir(), "codex-guard-"));
  repo = path.join(root, "repo");
  await import("node:fs/promises").then((fs) => fs.mkdir(repo));
  process.env.CODEX_CLAUDE_ALLOW_ROOTS = root;
});

afterEach(async () => {
  process.env = oldEnv;
  await rm(root, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]) {
  await execFileAsync("git", args, { cwd });
}

describe("guard safety checks", () => {
  it("allows cwd inside allow roots and rejects outside roots", async () => {
    await expect(validateCwd(repo)).resolves.toMatchObject({ ok: true });
    await expect(validateCwd(path.dirname(root))).resolves.toMatchObject({ ok: false });
  });

  it("accepts comma-separated allow roots from legacy Codex config edits", async () => {
    const secondRoot = await mkdtemp(path.join(os.tmpdir(), "codex-guard-second-"));
    const secondRepo = path.join(secondRoot, "repo");
    await import("node:fs/promises").then((fs) => fs.mkdir(secondRepo));
    process.env.CODEX_CLAUDE_ALLOW_ROOTS = `${root},${secondRoot}`;

    await expect(validateCwd(secondRepo)).resolves.toMatchObject({ ok: true });

    await rm(secondRoot, { recursive: true, force: true });
  });

  it("rejects traversal through symlinks", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "codex-outside-"));
    const link = path.join(repo, "escape");
    await symlink(outside, link);
    await expect(validateCwd(link)).resolves.toMatchObject({ ok: false });
    await rm(outside, { recursive: true, force: true });
  });

  it("rejects dangerous root paths", async () => {
    for (const target of ["/", "/etc", "/tmp", process.env.HOME].filter(Boolean) as string[]) {
      await expect(validateCwd(target)).resolves.toMatchObject({ ok: false });
    }
  });

  it("rejects files that escape cwd", async () => {
    await expect(validateFilesWithinCwd(repo, ["src/server.ts"])).resolves.toMatchObject({ ok: true });
    await expect(validateFilesWithinCwd(repo, ["../outside.ts"])).resolves.toMatchObject({ ok: false });
  });

  it("strips non-allowlisted environment variables by default", () => {
    for (const key of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "CLOUDFLARE_API_TOKEN",
      "SSH_AUTH_SOCK",
      "CUSTOM_TOKEN",
      "CUSTOM_SECRET",
      "CUSTOM_PASSWORD",
      "CUSTOM_API_KEY",
      "CUSTOM_CREDENTIAL",
      "DATABASE_URL",
      "MY_COOKIE",
    ]) {
      process.env[key] = "secret";
    }

    const env = sanitizeEnv();
    for (const key of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "CLOUDFLARE_API_TOKEN",
      "SSH_AUTH_SOCK",
      "CUSTOM_TOKEN",
      "CUSTOM_SECRET",
      "CUSTOM_PASSWORD",
      "CUSTOM_API_KEY",
      "CUSTOM_CREDENTIAL",
      "DATABASE_URL",
      "MY_COOKIE",
    ]) {
      expect(env[key]).toBeUndefined();
    }
  });

  it("guards recursive delegation and increments child depth", () => {
    process.env.BRIDGE_DEPTH = "2";
    expect(() => assertCanDelegate()).toThrow(/BRIDGE_DEPTH/);

    process.env.BRIDGE_DEPTH = "1";
    expect(sanitizeEnv().BRIDGE_DEPTH).toBe("2");
  });

  it("blocks all dangerous system directories and their subdirectories", () => {
    const blocked = [
      "/", "/etc", "/tmp",
      "/bin", "/sbin", "/lib", "/lib64",
      "/var", "/usr", "/root", "/opt",
      "/boot", "/sys", "/dev", "/proc",
    ];
    for (const target of blocked) {
      expect(dangerousRoot(target)).toBe(true);
    }

    // Subdirectories of dangerous roots are also blocked
    expect(dangerousRoot("/var/log")).toBe(true);
    expect(dangerousRoot("/usr/local/bin")).toBe(true);
    expect(dangerousRoot("/opt/homebrew")).toBe(true);
    expect(dangerousRoot("/tmp/my-app")).toBe(true);
    expect(dangerousRoot("/etc/ssl")).toBe(true);
  });

  it("blocks home directory but not subdirectories (which go through allow-roots)", () => {
    const home = process.env.HOME;
    if (home) {
      expect(dangerousRoot(home)).toBe(true);
      expect(dangerousRoot(`${home}/projects`)).toBe(false);
      expect(dangerousRoot(`${home}/work`)).toBe(false);
    }
  });

  it("allows non-dangerous paths", () => {
    expect(dangerousRoot("/Users/anyi/projects")).toBe(false);
    expect(dangerousRoot("/home/user/work")).toBe(false);
    expect(dangerousRoot("/srv/app")).toBe(false);
    expect(dangerousRoot("/mnt/data")).toBe(false);
  });

  it("CODEX_CLAUDE_ALLOW_ROOTS overrides dangerous root blocking", async () => {
    // Create a temp directory which may reside under /var/ or /tmp/ (both dangerous roots)
    const overrideRoot = await mkdtemp(path.join(os.tmpdir(), "codex-guard-override-"));
    const overrideRepo = path.join(overrideRoot, "repo");
    await import("node:fs/promises").then((fs) => fs.mkdir(overrideRepo));

    process.env.CODEX_CLAUDE_ALLOW_ROOTS = overrideRoot;

    // Should be allowed even though parent directories are dangerous roots
    await expect(validateCwd(overrideRepo)).resolves.toMatchObject({ ok: true });

    await rm(overrideRoot, { recursive: true, force: true });
  });

  it("CODEX_CLAUDE_ALLOW_ROOTS cannot override dangerous root itself (e.g., /etc)", async () => {
    process.env.CODEX_CLAUDE_ALLOW_ROOTS = "/etc";
    await expect(validateCwd("/etc")).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/dangerous root/),
    });
    delete process.env.CODEX_CLAUDE_ALLOW_ROOTS;
  });

  it("CODEX_CLAUDE_ALLOW_ROOTS cannot override dangerous root itself (e.g., /)", async () => {
    process.env.CODEX_CLAUDE_ALLOW_ROOTS = "/";
    await expect(validateCwd("/")).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/dangerous root/),
    });
    delete process.env.CODEX_CLAUDE_ALLOW_ROOTS;
  });
});

describe("isDelegatedWorktreePath", () => {
  it("returns true for a path inside a delegated worktree subdirectory", () => {
    expect(isDelegatedWorktreePath("/repo/.claude/worktrees/codex-delegated-abc123/src")).toBe(true);
  });

  it("returns true for the delegated worktree root itself", () => {
    expect(isDelegatedWorktreePath("/repo/.claude/worktrees/codex-delegated-abc123")).toBe(true);
  });

  it("returns false for a directory named codex-delegated-* outside .claude/worktrees/", () => {
    expect(isDelegatedWorktreePath("/repo/codex-delegated-demo/src")).toBe(false);
  });

  it("returns false when .claude is not followed by worktrees", () => {
    expect(isDelegatedWorktreePath("/repo/.claude/not-worktrees/codex-delegated-abc123")).toBe(false);
  });

  it("handles trailing slashes", () => {
    expect(isDelegatedWorktreePath("/repo/.claude/worktrees/codex-delegated-abc123/")).toBe(true);
  });

  it("handles relative paths by resolving them", () => {
    expect(isDelegatedWorktreePath(".claude/worktrees/codex-delegated-xyz")).toBe(true);
  });

  it("returns false for a normal repo path", () => {
    expect(isDelegatedWorktreePath("/home/user/projects/my-repo")).toBe(false);
  });

  it("returns false when codex-delegated-* appears but .claude is missing", () => {
    expect(isDelegatedWorktreePath("/tmp/worktrees/codex-delegated-abc123")).toBe(false);
  });

  it("returns false when .claude and worktrees appear but codex-delegated-* is missing", () => {
    expect(isDelegatedWorktreePath("/repo/.claude/worktrees/other-branch")).toBe(false);
  });
});

describe("git repository helpers", () => {
  it("detects git repositories and worktree-capable repositories", async () => {
    await git(repo, "init");

    await expect(isGitRepo(repo)).resolves.toBe(true);
    await expect(supportsWorktree(repo)).resolves.toBe(true);
  });

  it("returns false outside a git repository", async () => {
    await expect(isGitRepo(repo)).resolves.toBe(false);
    await expect(supportsWorktree(repo)).resolves.toBe(false);
  });
});

describe("env allowlist sanitization", () => {
  const DEFAULT_ALLOWLIST = [
    "PATH", "HOME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "USER",
    "TMPDIR", "TEMP", "TMP", "NODE_ENV",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ANTHROPIC_BASE_URL",
  ];

  it("only forwards allowlisted vars by default", () => {
    process.env.PATH = "/usr/bin";
    process.env.HOME = "/home/test";
    process.env.EXTRA_VAR = "should-be-stripped";
    process.env.NOT_IN_LIST = "also-stripped";

    const env = sanitizeEnv();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/test");
    expect(env.EXTRA_VAR).toBeUndefined();
    expect(env.NOT_IN_LIST).toBeUndefined();
  });

  it("includes all default allowlist entries when present", () => {
    for (const key of DEFAULT_ALLOWLIST) {
      process.env[key] = `val_${key}`;
    }
    const env = sanitizeEnv();
    for (const key of DEFAULT_ALLOWLIST) {
      expect(env[key]).toBe(`val_${key}`);
    }
  });

  it("forwards passthrough vars via CODEX_CLAUDE_ENV_PASSTHROUGH", () => {
    process.env.PATH = "/usr/bin";
    process.env.CODEX_CLAUDE_ENV_PASSTHROUGH = "MY_CUSTOM_VAR,ANOTHER_VAR";
    process.env.MY_CUSTOM_VAR = "value1";
    process.env.ANOTHER_VAR = "value2";

    const env = sanitizeEnv();
    expect(env.MY_CUSTOM_VAR).toBe("value1");
    expect(env.ANOTHER_VAR).toBe("value2");

    delete process.env.CODEX_CLAUDE_ENV_PASSTHROUGH;
    delete process.env.MY_CUSTOM_VAR;
    delete process.env.ANOTHER_VAR;
  });

  it("never forwards CODEX_CLAUDE_ENV_PASSTHROUGH itself", () => {
    process.env.PATH = "/usr/bin";
    process.env.CODEX_CLAUDE_ENV_PASSTHROUGH = "MY_VAR";
    process.env.MY_VAR = "val";

    const env = sanitizeEnv();
    expect(env.CODEX_CLAUDE_ENV_PASSTHROUGH).toBeUndefined();
    expect(env.MY_VAR).toBe("val");

    delete process.env.CODEX_CLAUDE_ENV_PASSTHROUGH;
    delete process.env.MY_VAR;
  });

  it("case-sensitive passthrough lookup", () => {
    process.env.PATH = "/usr/bin";
    process.env.CODEX_CLAUDE_ENV_PASSTHROUGH = "my_var";
    process.env.my_var = "lowercase";
    process.env.MY_VAR = "uppercase";

    const env = sanitizeEnv();
    expect(env.my_var).toBe("lowercase");
    expect(env.MY_VAR).toBeUndefined();

    delete process.env.CODEX_CLAUDE_ENV_PASSTHROUGH;
    delete process.env.my_var;
    delete process.env.MY_VAR;
  });

  it("deduplicates passthrough entries", () => {
    process.env.PATH = "/usr/bin";
    process.env.CODEX_CLAUDE_ENV_PASSTHROUGH = "MY_VAR,MY_VAR,MY_VAR";
    process.env.MY_VAR = "val";

    const env = sanitizeEnv();
    expect(env.MY_VAR).toBe("val");

    delete process.env.CODEX_CLAUDE_ENV_PASSTHROUGH;
    delete process.env.MY_VAR;
  });

  it("rejects passthrough names with invalid characters", () => {
    process.env.PATH = "/usr/bin";
    process.env.CODEX_CLAUDE_ENV_PASSTHROUGH = "VALID,has space,also-valid=,path/traversal";
    process.env.VALID = "ok";
    process.env["has space"] = "bad";
    process.env["also-valid="] = "bad";
    process.env["path/traversal"] = "bad";

    const env = sanitizeEnv();
    expect(env.VALID).toBe("ok");
    expect(env["has space"]).toBeUndefined();
    expect(env["also-valid="]).toBeUndefined();
    expect(env["path/traversal"]).toBeUndefined();

    delete process.env.CODEX_CLAUDE_ENV_PASSTHROUGH;
    delete process.env.VALID;
    delete process.env["has space"];
    delete process.env["also-valid="];
    delete process.env["path/traversal"];
  });

  it("blocks passthrough of exact sensitive names", () => {
    process.env.PATH = "/usr/bin";
    process.env.CODEX_CLAUDE_ENV_PASSTHROUGH = "DATABASE_URL,database_url,DSN,dsn,GITHUB_TOKEN,ANTHROPIC_API_KEY,CODEX_CLAUDE_ENV_PASSTHROUGH";
    process.env.DATABASE_URL = "postgres://...";
    process.env.database_url = "postgres://lower...";
    process.env.DSN = "mysql://...";
    process.env.dsn = "mysql://lower...";
    process.env.GITHUB_TOKEN = "ghp_...";
    process.env.ANTHROPIC_API_KEY = "sk-ant-...";

    const env = sanitizeEnv();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.database_url).toBeUndefined();
    expect(env.DSN).toBeUndefined();
    expect(env.dsn).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CODEX_CLAUDE_ENV_PASSTHROUGH).toBeUndefined();

    delete process.env.CODEX_CLAUDE_ENV_PASSTHROUGH;
    delete process.env.DATABASE_URL;
    delete process.env.database_url;
    delete process.env.DSN;
    delete process.env.dsn;
    delete process.env.GITHUB_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("blocks passthrough of names containing sensitive keywords", () => {
    process.env.PATH = "/usr/bin";
    process.env.CODEX_CLAUDE_ENV_PASSTHROUGH = [
      "MY_AUTH_HANDLER", "SESSION_STORE", "PRIVATE_CONFIG",
      "ENCRYPTION_KEY", "API_SECRET", "BEARER_TOKEN",
      "USER_CREDENTIAL", "DB_PASSWORD", "MY_API_KEY_CONFIG",
      "COOKIE_PREFS",
    ].join(",");
    for (const name of [
      "MY_AUTH_HANDLER", "SESSION_STORE", "PRIVATE_CONFIG",
      "ENCRYPTION_KEY", "API_SECRET", "BEARER_TOKEN",
      "USER_CREDENTIAL", "DB_PASSWORD", "MY_API_KEY_CONFIG",
      "COOKIE_PREFS",
    ]) {
      process.env[name] = "val";
    }

    const env = sanitizeEnv();
    for (const name of [
      "MY_AUTH_HANDLER", "SESSION_STORE", "PRIVATE_CONFIG",
      "ENCRYPTION_KEY", "API_SECRET", "BEARER_TOKEN",
      "USER_CREDENTIAL", "DB_PASSWORD", "MY_API_KEY_CONFIG",
      "COOKIE_PREFS",
    ]) {
      expect(env[name]).toBeUndefined();
    }

    delete process.env.CODEX_CLAUDE_ENV_PASSTHROUGH;
    for (const name of [
      "MY_AUTH_HANDLER", "SESSION_STORE", "PRIVATE_CONFIG",
      "ENCRYPTION_KEY", "API_SECRET", "BEARER_TOKEN",
      "USER_CREDENTIAL", "DB_PASSWORD", "MY_API_KEY_CONFIG",
      "COOKIE_PREFS",
    ]) {
      delete process.env[name];
    }
  });

  it("getEnvSanitizationDiagnostics reports categories without values", () => {
    process.env.PATH = "/usr/bin";
    process.env.HOME = "/home/test";
    process.env.SHELL = "/bin/bash";
    process.env.NODE_ENV = "test";
    process.env.HTTP_PROXY = "http://proxy:8080";
    process.env.CUSTOM_NON_SENSITIVE = "should-be-stripped";
    process.env.CODEX_CLAUDE_ENV_PASSTHROUGH = "MY_VAR,BLOCKED_TOKEN";
    process.env.MY_VAR = "my-value";
    process.env.BLOCKED_TOKEN = "secret";

    const diag = getEnvSanitizationDiagnostics();
    expect(diag.allowlisted_present).toBeGreaterThanOrEqual(4);
    expect(diag.allowlisted_names).toEqual(expect.arrayContaining(["PATH", "HOME", "SHELL", "NODE_ENV", "HTTP_PROXY"]));
    expect(diag.passthrough_present).toBe(1);
    expect(diag.passthrough_names).toEqual(["MY_VAR"]);
    expect(diag.blocked_passthrough_count).toBe(1);
    expect(diag.blocked_passthrough_names).toEqual(["BLOCKED_TOKEN"]);
    // Must not leak values
    const diagStr = JSON.stringify(diag);
    expect(diagStr).not.toContain("my-value");
    expect(diagStr).not.toContain("secret");
    expect(diagStr).not.toContain("/usr/bin");
    expect(diagStr).not.toContain("http://proxy");

    delete process.env.CODEX_CLAUDE_ENV_PASSTHROUGH;
    delete process.env.MY_VAR;
    delete process.env.BLOCKED_TOKEN;
    delete process.env.CUSTOM_NON_SENSITIVE;
  });

  it("getEnvSanitizationDiagnostics without passthrough", () => {
    process.env.PATH = "/usr/bin";
    process.env.SECRET = "123";

    const diag = getEnvSanitizationDiagnostics();
    expect(diag.passthrough_present).toBe(0);
    expect(diag.passthrough_names).toEqual([]);
    expect(diag.blocked_passthrough_count).toBe(0);
    expect(diag.blocked_passthrough_names).toEqual([]);

    delete process.env.SECRET;
  });
});

describe("validateContextRoots", () => {
  let ctxRoot: string;
  let primary: string;
  let sibling: string;
  let oldEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    oldEnv = { ...process.env };
    ctxRoot = await mkdtemp(path.join(os.tmpdir(), "codex-ctx-"));
    primary = path.join(ctxRoot, "primary-repo");
    sibling = path.join(ctxRoot, "sibling-repo");
    await mkdir(primary, { recursive: true });
    await mkdir(sibling, { recursive: true });
    process.env.CODEX_CLAUDE_ALLOW_ROOTS = ctxRoot;
  });

  afterEach(async () => {
    process.env = oldEnv;
    await rm(ctxRoot, { recursive: true, force: true });
  });

  it("accepts a sibling directory as context root", async () => {
    const result = await validateContextRoots(primary, [{ alias: "sibling", cwd: sibling }]);
    expect(result.ok).toBe(true);
    expect(result.roots).toHaveLength(1);
    expect(result.roots![0]!.alias).toBe("sibling");
  });

  it("rejects context root outside CODEX_CLAUDE_ALLOW_ROOTS", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "codex-ctx-outside-"));
    const result = await validateContextRoots(primary, [{ alias: "outside", cwd: outside }]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("outside");
    expect(result.error).toContain("outside allowed roots");
    await rm(outside, { recursive: true, force: true });
  });

  it("rejects primary cwd as context root", async () => {
    const result = await validateContextRoots(primary, [{ alias: "self", cwd: primary }]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("must not be the same as the primary cwd");
  });

  it("rejects child of primary cwd", async () => {
    const child = path.join(primary, "subdir");
    await mkdir(child, { recursive: true });
    const result = await validateContextRoots(primary, [{ alias: "child", cwd: child }]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("must not be a child of the primary cwd");
  });

  it("rejects parent of primary cwd", async () => {
    const parentOfPrimary = ctxRoot;
    const result = await validateContextRoots(primary, [{ alias: "parent", cwd: parentOfPrimary }]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("must not be a parent of the primary cwd");
  });

  it("rejects alias 'primary' (case insensitive)", async () => {
    const result = await validateContextRoots(primary, [{ alias: "Primary", cwd: sibling }]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("reserved");
  });

  it("rejects duplicate aliases", async () => {
    const other = path.join(ctxRoot, "other-repo");
    await mkdir(other, { recursive: true });
    const result = await validateContextRoots(primary, [
      { alias: "same", cwd: sibling },
      { alias: "same", cwd: other },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Duplicate context root alias");
  });

  it("rejects delegated worktree paths", async () => {
    const wtPath = path.join(primary, ".claude", "worktrees", "codex-delegated-abc123");
    await mkdir(wtPath, { recursive: true });
    const result = await validateContextRoots(primary, [{ alias: "wt", cwd: wtPath }]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("delegated worktree path");
  });

  it("rejects overlapping context roots", async () => {
    const parent = path.join(ctxRoot, "overlap-parent");
    const child = path.join(parent, "child");
    await mkdir(child, { recursive: true });
    const result = await validateContextRoots(primary, [
      { alias: "p", cwd: parent },
      { alias: "c", cwd: child },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("overlap");
  });

  it("resolves relative cwd against primary", async () => {
    const relativePath = path.relative(primary, sibling);
    const result = await validateContextRoots(primary, [{ alias: "sib", cwd: relativePath }]);
    expect(result.ok).toBe(true);
    expect(result.roots![0]!.cwd).toBe(await import("node:fs/promises").then((fs) => fs.realpath(sibling)));
  });

  it("resolves macOS /var vs /private/var via realpath", async () => {
    // This test ensures realpath normalization works correctly.
    // On macOS, /var is a symlink to /private/var, so realpath resolves them to the same path.
    const result = await validateContextRoots(primary, [{ alias: "sib", cwd: sibling }]);
    expect(result.ok).toBe(true);
    // The resolved cwd should be the realpath of sibling
    const expectedReal = await import("node:fs/promises").then((fs) => fs.realpath(sibling));
    expect(result.roots![0]!.cwd).toBe(expectedReal);
  });
});
