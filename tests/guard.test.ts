import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertCanDelegate,
  dangerousRoot,
  sanitizeEnv,
  validateCwd,
  validateFilesWithinCwd,
} from "../src/guard.js";

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

  it("strips sensitive environment variables", () => {
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
    ]) {
      process.env[key] = "secret";
    }

    const env = sanitizeEnv();
    expect(Object.keys(env).filter((key) => key.includes("CUSTOM"))).toEqual([]);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
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
