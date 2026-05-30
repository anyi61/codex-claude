import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execCapture, sanitizeEnv } from "../src/guard.js";

let tmpDir: string;
let oldEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
  oldEnv = { ...process.env };
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "exec-capture-"));
});

afterEach(async () => {
  process.env = oldEnv;
  await rm(tmpDir, { recursive: true, force: true });
});

describe("execCapture environment semantics", () => {
  it("execCapture inherits env when opts env is omitted", async () => {
    process.env._EXEC_CAPTURE_TEST = "inherited-value";
    const output = await execCapture(
      "node",
      ["-e", "process.stdout.write(process.env._EXEC_CAPTURE_TEST ?? 'MISSING')"],
      { cwd: tmpDir },
    );
    expect(output).toBe("inherited-value");
  });

  it("execCapture merges process env when opts env is provided", async () => {
    process.env._EXEC_CAPTURE_EXISTING = "from-parent";
    const output = await execCapture(
      "node",
      [
        "-e",
        "process.stdout.write(JSON.stringify({ existing: process.env._EXEC_CAPTURE_EXISTING, extra: process.env._EXEC_CAPTURE_EXTRA }))",
      ],
      { cwd: tmpDir, env: { _EXEC_CAPTURE_EXTRA: "added" } },
    );
    expect(JSON.parse(output)).toEqual({ existing: "from-parent", extra: "added" });
  });

  it("execCapture opts env overrides process env in merge mode", async () => {
    process.env._EXEC_CAPTURE_KEY = "original";
    const output = await execCapture(
      "node",
      ["-e", "process.stdout.write(process.env._EXEC_CAPTURE_KEY ?? 'MISSING')"],
      { cwd: tmpDir, env: { _EXEC_CAPTURE_KEY: "overridden" } },
    );
    expect(output).toBe("overridden");
  });

  it("execCapture callers can pass sanitizeEnv for untrusted commands", async () => {
    process.env.GITHUB_TOKEN = "secret-token-value";
    process.env._EXEC_CAPTURE_CUSTOM = "should-not-appear";

    const output = await execCapture(
      "node",
      [
        "-e",
        "process.stdout.write(JSON.stringify({ gh: process.env.GITHUB_TOKEN ?? 'STRIPPED', custom: process.env._EXEC_CAPTURE_CUSTOM ?? 'STRIPPED', path: process.env.PATH !== undefined }))",
      ],
      { cwd: tmpDir, env: sanitizeEnv(), envMode: "replace" },
    );
    expect(JSON.parse(output)).toEqual({ gh: "STRIPPED", custom: "STRIPPED", path: true });
  });
});
