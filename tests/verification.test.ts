import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  claudeImplementInputSchema,
  claudeTaskInputSchema,
} from "../src/schema.js";

const cleanupPaths: string[] = [];

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-verify-"));
  cleanupPaths.push(root);
  return root;
}

function mockSpawn(results: Array<{ code?: number | null; stdout?: string; stderr?: string; error?: Error; hang?: boolean }>) {
  const calls: Array<{ bin: string; args: string[]; cwd?: string; shell?: boolean; env?: Record<string, string> }> = [];
  vi.doMock("node:child_process", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const spawn = vi.fn((bin: string, args: string[], options: { cwd?: string; shell?: boolean; env?: Record<string, string> }) => {
      calls.push({ bin, args, cwd: options.cwd, shell: options.shell, env: options.env });
      const result = results.shift() ?? { code: 0 };
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn(() => {
        setTimeout(() => child.emit("close", null), 0);
        return true;
      });
      if (!result.hang) {
        setTimeout(() => {
          if (result.stdout) child.stdout.write(result.stdout);
          if (result.stderr) child.stderr.write(result.stderr);
          if (result.error) {
            child.emit("error", result.error);
          } else {
            child.emit("close", result.code ?? 0);
          }
        }, 0);
      }
      return child;
    });
    return { ...actual, spawn };
  });
  return calls;
}

afterEach(async () => {
  vi.doUnmock("node:child_process");
  vi.resetModules();
  vi.restoreAllMocks();
  while (cleanupPaths.length > 0) {
    await rm(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

describe("verification command parsing and execution", () => {
  it("parses quoted argv without invoking a shell", async () => {
    const calls = mockSpawn([{ code: 0, stdout: "ok" }]);
    const repo = await createFixture();
    const { runVerificationCommands } = await import("../src/verification.js");
    const result = await runVerificationCommands(["npx vitest run \"tests/foo bar.test.ts\""], repo, 5000);

    expect(result?.status).toBe("passed");
    expect(result?.commands[0]).toMatchObject({ command: "npx vitest run \"tests/foo bar.test.ts\"", status: "passed", exit_code: 0 });
    expect(result?.commands[0].stdout_tail).toBe("ok");
    expect(calls).toEqual([{ bin: "npx", args: ["vitest", "run", "tests/foo bar.test.ts"], cwd: repo, shell: undefined, env: expect.any(Object) }]);
  });

  it("reports mixed command results as failed", async () => {
    mockSpawn([{ code: 0 }, { code: 1, stderr: "nope" }]);
    const repo = await createFixture();
    const { runVerificationCommands } = await import("../src/verification.js");
    const result = await runVerificationCommands(["npm test", "npm run typecheck"], repo, 5000);

    expect(result?.status).toBe("failed");
    expect(result?.commands.map((command) => command.status)).toEqual(["passed", "failed"]);
    expect(result?.commands[1].stderr_tail).toContain("nope");
  });

  it("skips unsafe commands without spawning them", async () => {
    const calls = mockSpawn([{ hang: true }]);
    const repo = await createFixture();
    const { runVerificationCommands } = await import("../src/verification.js");
    const result = await runVerificationCommands(["rm -rf .", "npm install", "npm test && rm -rf ."], repo, 5000);

    expect(result?.status).toBe("failed");
    expect(result?.commands).toHaveLength(3);
    expect(result?.commands.every((command) => command.status === "skipped")).toBe(true);
    expect(calls).toEqual([]);
  });

  it("records binary startup failures as structured failed commands", async () => {
    mockSpawn([{ error: Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }) }]);
    const repo = await createFixture();
    const { runVerificationCommands } = await import("../src/verification.js");
    const result = await runVerificationCommands(["npm test"], repo, 5000);

    expect(result?.status).toBe("failed");
    expect(result?.commands[0]).toMatchObject({ status: "failed", exit_code: null, timed_out: false });
    expect(result?.commands[0].stderr_tail).toContain("ENOENT");
  });

  it("marks timed out commands as failed", async () => {
    const calls = mockSpawn([{ hang: true }]);
    const repo = await createFixture();
    const { runVerificationCommands } = await import("../src/verification.js");
    const result = await runVerificationCommands(["npm test"], repo, 10);

    expect(calls[0].bin).toBe("npm");
    expect(result?.status).toBe("failed");
    expect(result?.commands[0]).toMatchObject({ status: "failed", exit_code: null, timed_out: true });
  }, 1000);

  it("truncates large stdout and stderr tails", async () => {
    mockSpawn([{ code: 1, stdout: `a${"b".repeat(5000)}`, stderr: `c${"d".repeat(5000)}` }]);
    const repo = await createFixture();
    const { runVerificationCommands } = await import("../src/verification.js");
    const result = await runVerificationCommands(["npm test"], repo, 5000);

    expect(result?.commands[0].stdout_tail.length).toBeLessThanOrEqual(4000);
    expect(result?.commands[0].stderr_tail.length).toBeLessThanOrEqual(4000);
    expect(result?.commands[0].stdout_tail.startsWith("b")).toBe(true);
  });

  it("returns undefined when no commands are provided", async () => {
    const repo = await createFixture();
    const { runVerificationCommands } = await import("../src/verification.js");
    await expect(runVerificationCommands(undefined, repo, 5000)).resolves.toBeUndefined();
  });

  // ---- Phase 2 allowedScripts tests ----

  it("allowedScripts allows listed run script", async () => {
    const calls = mockSpawn([{ code: 0, stdout: "ok" }]);
    const repo = await createFixture();
    const { runVerificationCommands } = await import("../src/verification.js");
    const result = await runVerificationCommands(
      ["npm run test:unit"],
      repo,
      5000,
      { allowedScripts: ["test:unit", "lint"] },
    );

    expect(result?.status).toBe("passed");
    expect(result?.commands[0].status).toBe("passed");
    expect(calls.length).toBe(1);
    expect(calls[0].bin).toBe("npm");
    expect(calls[0].args).toEqual(["run", "test:unit"]);
  });

  it("allowedScripts skips unlisted run script", async () => {
    const calls = mockSpawn([{ code: 0 }]);
    const repo = await createFixture();
    const { runVerificationCommands } = await import("../src/verification.js");
    const result = await runVerificationCommands(
      ["npm run build"],
      repo,
      5000,
      { allowedScripts: ["test:unit", "lint"] },
    );

    expect(result?.status).toBe("failed");
    expect(result?.commands[0].status).toBe("skipped");
    expect(calls.length).toBe(0);
  });

  it("forbidden script names are still skipped even if listed in allowedScripts", async () => {
    const calls = mockSpawn([{ code: 0 }]);
    const repo = await createFixture();
    const { runVerificationCommands } = await import("../src/verification.js");
    const result = await runVerificationCommands(
      ["npm run install"],
      repo,
      5000,
      { allowedScripts: ["install", "test:unit"] },
    );

    expect(result?.status).toBe("failed");
    expect(result?.commands[0].status).toBe("skipped");
    expect(calls.length).toBe(0);
  });

  it("empty allowedScripts skips all run scripts", async () => {
    const calls = mockSpawn([{ code: 0 }]);
    const repo = await createFixture();
    const { runVerificationCommands } = await import("../src/verification.js");
    const result = await runVerificationCommands(
      ["npm run lint", "yarn run build"],
      repo,
      5000,
      { allowedScripts: [] },
    );

    expect(result?.status).toBe("failed");
    expect(result!.commands.every((c) => c.status === "skipped")).toBe(true);
    expect(calls.length).toBe(0);
  });

  it("allowedScripts restricts package-manager test shorthands as script names", async () => {
    const calls = mockSpawn([{ code: 0 }]);
    const repo = await createFixture();
    const { runVerificationCommands } = await import("../src/verification.js");
    const result = await runVerificationCommands(
      ["npm test", "yarn test", "pnpm test", "npx vitest run"],
      repo,
      5000,
      { allowedScripts: [] },
    );

    expect(result?.status).toBe("failed");
    expect(result!.commands.map((c) => c.status)).toEqual(["skipped", "skipped", "skipped", "passed"]);
    expect(calls.length).toBe(1);
    expect(calls[0].bin).toBe("npx");
  });

  it("allowedScripts allows package-manager test shorthands when test is listed", async () => {
    const calls = mockSpawn([{ code: 0 }, { code: 0 }, { code: 0 }]);
    const repo = await createFixture();
    const { runVerificationCommands } = await import("../src/verification.js");
    const result = await runVerificationCommands(
      ["npm test", "yarn test", "pnpm test"],
      repo,
      5000,
      { allowedScripts: ["test"] },
    );

    expect(result?.status).toBe("passed");
    expect(result!.commands.every((c) => c.status === "passed")).toBe(true);
    expect(calls.map((call) => call.bin)).toEqual(["npm", "yarn", "pnpm"]);
  });

  it("allows package-manager test shorthands when allowedScripts is not configured", async () => {
    const calls = mockSpawn([{ code: 0 }, { code: 0 }, { code: 0 }]);
    const repo = await createFixture();
    const { runVerificationCommands } = await import("../src/verification.js");
    const result = await runVerificationCommands(
      ["npm test", "yarn test", "pnpm test"],
      repo,
      5000,
    );

    expect(result?.status).toBe("passed");
    expect(result!.commands.every((c) => c.status === "passed")).toBe(true);
    expect(calls.map((call) => call.bin)).toEqual(["npm", "yarn", "pnpm"]);
  });

  it("yarn/pnpm run scripts are also restricted by allowedScripts", async () => {
    const calls = mockSpawn([{ code: 0 }, { code: 0 }]);
    const repo = await createFixture();
    const { runVerificationCommands } = await import("../src/verification.js");
    const result = await runVerificationCommands(
      ["yarn run lint", "pnpm run build"],
      repo,
      5000,
      { allowedScripts: ["lint"] },
    );

    // "lint" is in allowedScripts, "build" is not
    expect(result?.status).toBe("failed");
    expect(result!.commands[0].status).toBe("passed");
    expect(result!.commands[1].status).toBe("skipped");
  });

  it("timeout option from VerificationOptions works", async () => {
    const calls = mockSpawn([{ hang: true }]);
    const repo = await createFixture();
    const { runVerificationCommands } = await import("../src/verification.js");
    const result = await runVerificationCommands(
      ["npm test"],
      repo,
      5000,
      { timeoutMs: 10 },
    );

    expect(calls[0].bin).toBe("npm");
    expect(result?.status).toBe("failed");
    expect(result?.commands[0].timed_out).toBe(true);
  }, 1000);

  it("timeout option is bounded to MAX_TIMEOUT_MS", async () => {
    const { MAX_TIMEOUT_MS, clampVerificationTimeout } = await import("../src/verification.js");

    expect(clampVerificationTimeout(999_999_999)).toBe(MAX_TIMEOUT_MS);
    expect(clampVerificationTimeout(10_000)).toBe(10_000);
  });

  it("default timeout still works when VerificationOptions has no timeoutMs", async () => {
    const calls = mockSpawn([{ code: 0 }]);
    const repo = await createFixture();
    const { runVerificationCommands } = await import("../src/verification.js");
    const result = await runVerificationCommands(
      ["npm test"],
      repo,
      5000,
      { allowedScripts: undefined },
    );

    expect(result?.status).toBe("passed");
    expect(calls.length).toBe(1);
  });

  it("verification passes sanitized env to spawned commands", async () => {
    const calls = mockSpawn([{ code: 0, stdout: "ok" }]);
    const repo = await createFixture();
    const { runVerificationCommands } = await import("../src/verification.js");
    const result = await runVerificationCommands(["npm test"], repo, 5000);

    expect(result?.status).toBe("passed");
    expect(calls).toHaveLength(1);
    expect(calls[0].env).toBeDefined();
    expect(typeof calls[0].env).toBe("object");
  });

  it("verification removes secret-like parent env variables", async () => {
    const savedEnv = { ...process.env };
    try {
      process.env.GITHUB_TOKEN = "ghp_fake_secret_token";
      process.env.ANTHROPIC_API_KEY = "sk-ant-fake";
      process.env.OPENAI_API_KEY = "sk-fake";

      const calls = mockSpawn([{ code: 0 }]);
      const repo = await createFixture();
      const { runVerificationCommands } = await import("../src/verification.js");
      await runVerificationCommands(["npm test"], repo, 5000);

      expect(calls[0].env).toBeDefined();
      expect(calls[0].env!["GITHUB_TOKEN"]).toBeUndefined();
      expect(calls[0].env!["ANTHROPIC_API_KEY"]).toBeUndefined();
      expect(calls[0].env!["OPENAI_API_KEY"]).toBeUndefined();
    } finally {
      process.env = { ...savedEnv };
    }
  });

  it("verification keeps safe baseline env for command execution", async () => {
    const savedEnv = { ...process.env };
    try {
      process.env.PATH = "/usr/bin:/usr/local/bin";
      process.env.HOME = "/tmp/codex-home";
      process.env.GITHUB_TOKEN = "ghp_should_be_stripped";

      const calls = mockSpawn([{ code: 0 }]);
      const repo = await createFixture();
      const { runVerificationCommands } = await import("../src/verification.js");
      await runVerificationCommands(["npm test"], repo, 5000);

      expect(calls[0].env).toBeDefined();
      expect(calls[0].env!["PATH"]).toBe("/usr/bin:/usr/local/bin");
      expect(calls[0].env!["HOME"]).toBe("/tmp/codex-home");
      expect(calls[0].env!["GITHUB_TOKEN"]).toBeUndefined();
    } finally {
      process.env = { ...savedEnv };
    }
  });
});

describe("buildVerificationWarnings", () => {
  it("returns empty array when verification passed or is absent", async () => {
    const { buildVerificationWarnings } = await import("../src/verification.js");
    expect(buildVerificationWarnings(undefined)).toEqual([]);
    expect(buildVerificationWarnings({ status: "passed", commands: [] })).toEqual([]);
  });

  it("summarizes failed and skipped commands", async () => {
    const { buildVerificationWarnings } = await import("../src/verification.js");
    const warnings = buildVerificationWarnings({
      status: "failed",
      commands: [
        { command: "npm test", status: "failed", exit_code: 1, stdout_tail: "", stderr_tail: "", duration_ms: 10, timed_out: false },
        { command: "rm -rf .", status: "skipped", exit_code: null, stdout_tail: "", stderr_tail: "", duration_ms: 0, timed_out: false, skipped_reason: "blocked" },
      ],
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Server-side verification failed");
    expect(warnings[0]).toContain("npm test");
    expect(warnings[0]).toContain("rm -rf");
    expect(warnings[0]).toContain("skipped: blocked");
  });
});

describe("verification_commands schema validation", () => {
  it("accepts valid verification_commands on implement and task schemas", () => {
    expect(claudeImplementInputSchema.safeParse({
      task: "do something",
      cwd: "/tmp/test",
      verification_commands: ["npm test", "npm run typecheck", "npx vitest run tests/schema.test.ts"],
    }).success).toBe(true);

    expect(claudeTaskInputSchema.safeParse({
      cwd: "/tmp/test",
      task: "implement feature",
      mode: "write",
      verification_commands: ["npm test"],
    }).success).toBe(true);
  });

  it("rejects invalid verification_commands values", () => {
    const base = { task: "do something", cwd: "/tmp/test" };
    expect(claudeImplementInputSchema.safeParse({ ...base, verification_commands: [] }).success).toBe(false);
    expect(claudeImplementInputSchema.safeParse({ ...base, verification_commands: [""] }).success).toBe(false);
    expect(claudeImplementInputSchema.safeParse({ ...base, verification_commands: ["npm test\nrm -rf ."] }).success).toBe(false);
    expect(claudeImplementInputSchema.safeParse({ ...base, verification_commands: ["x".repeat(201)] }).success).toBe(false);
    expect(claudeImplementInputSchema.safeParse({ ...base, verification_commands: Array.from({ length: 11 }, (_, i) => `npm run test${i}`) }).success).toBe(false);
    expect(claudeImplementInputSchema.safeParse({ ...base, verification_commands: [42] }).success).toBe(false);
  });
});
