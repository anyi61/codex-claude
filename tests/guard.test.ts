import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertCanDelegate,
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
});
