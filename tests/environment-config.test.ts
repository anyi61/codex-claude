import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildConfigSummaryFromFields, readEnvironmentConfig } from "../src/environment-config.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    await rm(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

function makeDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "env-config-test-"));
}

async function writeConfig(dir: string, data: unknown): Promise<void> {
  const configDir = path.join(dir, ".codex-claude-delegate");
  await mkdir(configDir, { recursive: true });
  cleanupPaths.push(dir);
  await writeFile(
    path.join(configDir, "environment.json"),
    JSON.stringify(data, null, 2),
  );
}

describe("readEnvironmentConfig", () => {
  it("builds safe summary from validated field presence only", () => {
    const summary = buildConfigSummaryFromFields(["install", "test", "verification", "environment"]);

    expect(summary).toMatchObject({
      exists: true,
      path: "",
      ok: true,
      fields_present: ["install", "test", "verification", "environment"],
      install: true,
      test: true,
      start: false,
      symlink_directories_count: 0,
      sparse_paths_count: 0,
      errors: [],
      warnings: [],
    });
  });

  it("returns null when file does not exist", async () => {
    const dir = await makeDir();
    cleanupPaths.push(dir);
    const result = await readEnvironmentConfig(dir);
    expect(result).toBeNull();
  });

  it("returns summary for valid config with all fields", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      install: "npm install",
      test: "npx vitest run",
      start: "npm start",
      symlink_directories: ["/absolute/path/one", "/absolute/path/two"],
      sparse_paths: ["src/foo", "bar/baz"],
    });

    const result = await readEnvironmentConfig(dir);
    expect(result).not.toBeNull();
    expect(result!.summary.exists).toBe(true);
    expect(result!.summary.ok).toBe(true);
    expect(result!.summary.fields_present).toEqual(
      expect.arrayContaining(["install", "test", "start", "symlink_directories", "sparse_paths"]),
    );
    expect(result!.summary.install).toBe(true);
    expect(result!.summary.test).toBe(true);
    expect(result!.summary.start).toBe(true);
    expect(result!.summary.symlink_directories_count).toBe(2);
    expect(result!.summary.sparse_paths_count).toBe(2);
    expect(result!.summary.errors).toEqual([]);
    expect(result!.summary.warnings).toEqual([]);
  });

  it("deduplicates arrays", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      symlink_directories: ["/path/a", "/path/b", "/path/a"],
      sparse_paths: ["src/a", "src/b", "src/a"],
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(true);
    expect(result!.summary.symlink_directories_count).toBe(2);
    expect(result!.summary.sparse_paths_count).toBe(2);
  });

  it("reports unknown keys as warnings", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      install: "npm install",
      unknown_field: "some_value",
      another_unknown: 42,
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(true);
    expect(result!.summary.warnings).toHaveLength(2);
    expect(result!.summary.warnings[0].field).toBe("unknown_field");
    expect(result!.summary.warnings[1].field).toBe("another_unknown");
    expect(result!.summary.errors).toEqual([]);
  });

  it("reports invalid JSON", async () => {
    const dir = await makeDir();
    const configDir = path.join(dir, ".codex-claude-delegate");
    await mkdir(configDir, { recursive: true });
    cleanupPaths.push(dir);
    await writeFile(path.join(configDir, "environment.json"), "not json");

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.exists).toBe(true);
    expect(result!.summary.ok).toBe(false);
    expect(result!.summary.errors).toHaveLength(1);
    expect(result!.summary.errors[0].message).toContain("valid JSON");
    expect(result!.summary.warnings).toEqual([]);
  });

  it("reports non-object JSON", async () => {
    const dir = await makeDir();
    await writeConfig(dir, ["array", "values"]);

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(false);
    expect(result!.summary.errors).toHaveLength(1);
    expect(result!.summary.errors[0].message).toContain("JSON object");
  });

  it("reports empty string commands", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      install: "",
      test: "npx vitest run",
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(false);
    expect(result!.summary.errors).toHaveLength(1);
    expect(result!.summary.errors[0].field).toBe("install");
    expect(result!.summary.errors[0].message).toContain("empty");
    // test should be ok
    expect(result!.summary.test).toBe(true);
  });

  it("reports commands that exceed max length", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      install: "x".repeat(1001),
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(false);
    expect(result!.summary.errors).toHaveLength(1);
    expect(result!.summary.errors[0].field).toBe("install");
    expect(result!.summary.errors[0].message).toContain("exceeds maximum length");
  });

  it("reports non-string command values", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      install: 123,
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(false);
    expect(result!.summary.errors).toHaveLength(1);
    expect(result!.summary.errors[0].field).toBe("install");
    expect(result!.summary.errors[0].message).toContain("must be a string");
  });

  it("reports invalid symlink_directories paths", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      symlink_directories: ["/absolute/path", "relative/path", "/another/absolute"],
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(false);
    expect(result!.summary.errors).toHaveLength(1);
    expect(result!.summary.errors[0].field).toBe("symlink_directories[1]");
    expect(result!.summary.errors[0].message).toContain("absolute");
  });

  it("reports invalid sparse_paths (absolute or .. segments)", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      sparse_paths: ["src/foo", "/absolute/path", "src/../bar", "src/baz"],
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(false);
    expect(result!.summary.errors).toHaveLength(2);
    const messages = result!.summary.errors.map((e) => `${e.field}: ${e.message}`);
    expect(messages.some((m) => m.includes("sparse_paths[1]") && m.includes("absolute"))).toBe(true);
    expect(messages.some((m) => m.includes("sparse_paths[2]") && m.includes(".."))).toBe(true);
  });

  it("reports non-array for array fields", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      symlink_directories: "not an array",
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(false);
    expect(result!.summary.errors).toHaveLength(1);
    expect(result!.summary.errors[0].field).toBe("symlink_directories");
    expect(result!.summary.errors[0].message).toContain("array");
  });

  it("reports non-string array items", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      sparse_paths: ["ok", 42, "also ok"],
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(false);
    expect(result!.summary.errors).toHaveLength(1);
    expect(result!.summary.errors[0].field).toBe("sparse_paths[1]");
    expect(result!.summary.errors[0].message).toContain("non-empty string");
  });

  it("handles null fields without error", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      install: null,
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(true);
    expect(result!.summary.errors).toEqual([]);
    expect(result!.summary.install).toBe(false);
  });

  it("does not leak command values in summary", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      install: "npx secret-command --token abc123",
      test: "npx vitest run",
    });

    const result = await readEnvironmentConfig(dir);
    const jsonStr = JSON.stringify(result!.summary);
    expect(jsonStr).not.toContain("secret-command");
    expect(jsonStr).not.toContain("abc123");
    expect(jsonStr).not.toContain("vitest");
    expect(jsonStr).not.toContain("token");
  });

  // ---- Phase 2 tests ----

  it("validates all Phase 2 fields together", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      install: "npm install",
      test: "npx vitest run",
      verification: {
        allowedScripts: ["test:unit", "lint", "build"],
        timeoutSec: 180,
      },
      artifacts: {
        retentionDays: 30,
      },
      environment: {
        passthrough: ["MY_VAR", "NODE_OPTIONS"],
      },
    });

    const result = await readEnvironmentConfig(dir);
    expect(result).not.toBeNull();
    expect(result!.summary.ok).toBe(true);
    expect(result!.summary.fields_present).toEqual(
      expect.arrayContaining(["install", "test"]),
    );
    // Phase 2 summary
    expect(result!.summary.verification_allowed_scripts_count).toBe(3);
    expect(result!.summary.verification_allowed_scripts).toEqual(["test:unit", "lint", "build"]);
    expect(result!.summary.verification_timeout_sec).toBe(180);
    expect(result!.summary.artifacts_retention_days).toBe(30);
    expect(result!.summary.environment_passthrough_count).toBe(2);
    expect(result!.summary.environment_passthrough).toEqual(["MY_VAR", "NODE_OPTIONS"]);
    // Phase 2 config for execution
    expect(result!.phase2).toBeDefined();
    expect(result!.phase2!.verification).toBeDefined();
    expect(result!.phase2!.verification!.allowedScripts).toEqual(["test:unit", "lint", "build"]);
    expect(result!.phase2!.verification!.timeoutSec).toBe(180);
    expect(result!.phase2!.artifacts).toBeDefined();
    expect(result!.phase2!.artifacts!.retentionDays).toBe(30);
    expect(result!.phase2!.environment).toBeDefined();
    expect(result!.phase2!.environment!.passthrough).toEqual(["MY_VAR", "NODE_OPTIONS"]);
  });

  it("Phase 1 and Phase 2 fields coexist without issues", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      install: "npm install",
      test: "npx vitest run",
      start: "npm start",
      symlink_directories: ["/path/a"],
      sparse_paths: ["src/"],
      verification: { allowedScripts: ["test:unit"] },
      artifacts: { retentionDays: 7 },
      environment: { passthrough: ["MY_VAR"] },
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(true);
    expect(result!.summary.fields_present).toEqual(
      expect.arrayContaining(["install", "test", "start", "symlink_directories", "sparse_paths"]),
    );
    expect(result!.summary.verification_allowed_scripts).toEqual(["test:unit"]);
    expect(result!.summary.artifacts_retention_days).toBe(7);
    expect(result!.summary.environment_passthrough).toEqual(["MY_VAR"]);
    expect(result!.phase2).toBeDefined();
  });

  it("absent Phase 2 fields are backward compatible", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      install: "npm install",
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(true);
    expect(result!.summary.verification_allowed_scripts).toBeUndefined();
    expect(result!.summary.verification_timeout_sec).toBeUndefined();
    expect(result!.summary.artifacts_retention_days).toBeUndefined();
    expect(result!.summary.environment_passthrough).toBeUndefined();
    expect(result!.phase2).toBeUndefined();
  });

  it("Phase 1-only config (no Phase 2 fields) is backward compatible", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      test: "npx vitest run",
      sparse_paths: ["src/"],
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(true);
    expect(result!.summary.test).toBe(true);
    expect(result!.summary.sparse_paths_count).toBe(1);
    expect(result!.summary.verification_allowed_scripts).toBeUndefined();
    expect(result!.phase2).toBeUndefined();
  });

  it("rejects allowedScripts forbidden names", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      verification: {
        allowedScripts: ["install", "deploy", "start"],
      },
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(false);
    expect(result!.summary.errors).toHaveLength(3);
    const msgs = result!.summary.errors.map((e) => e.message);
    expect(msgs.some((m) => m.includes("install") && m.includes("forbidden"))).toBe(true);
    expect(msgs.some((m) => m.includes("deploy") && m.includes("forbidden"))).toBe(true);
    expect(msgs.some((m) => m.includes("start") && m.includes("forbidden"))).toBe(true);
    expect(result!.phase2).toBeUndefined();
  });

  it("rejects allowedScripts with shell-ish tokens", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      verification: {
        allowedScripts: ["test & echo", "foo;bar"],
      },
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(false);
    expect(result!.summary.errors.length).toBeGreaterThanOrEqual(2);
    const msgs = result!.summary.errors.map((e) => e.message);
    expect(msgs.some((m) => m.includes("shell-ish"))).toBe(true);
  });

  it("rejects allowedScripts with wrong type", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      verification: {
        allowedScripts: "not-an-array",
      },
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(false);
    expect(result!.summary.errors.some((e) => e.field === "verification.allowedScripts")).toBe(true);
  });

  it("rejects allowedScripts exceeding max entries", async () => {
    const dir = await makeDir();
    const scripts = Array.from({ length: 51 }, (_, i) => `script${i}`);
    await writeConfig(dir, {
      verification: { allowedScripts: scripts },
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(false);
    expect(result!.summary.errors.some((e) => e.message.includes("exceeds maximum"))).toBe(true);
  });

  it("rejects allowedScripts with invalid pattern", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      verification: {
        allowedScripts: ["valid", "invalid$name", "@bad"],
      },
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(false);
    expect(result!.summary.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects verification.timeoutSec out of bounds", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      verification: { timeoutSec: 5 },
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(false);
    expect(result!.summary.errors.some((e) => e.field === "verification.timeoutSec")).toBe(true);
  });

  it("rejects verification.timeoutSec above max", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      verification: { timeoutSec: 500 },
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(false);
  });

  it("rejects verification.timeoutSec non-integer", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      verification: { timeoutSec: 3.14 },
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(false);
    expect(result!.summary.errors.some((e) => e.message.includes("integer"))).toBe(true);
  });

  it("rejects artifacts.retentionDays out of bounds", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      artifacts: { retentionDays: 0 },
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(false);
    expect(result!.summary.errors.some((e) => e.field === "artifacts.retentionDays")).toBe(true);
  });

  it("rejects artifacts.retentionDays above max", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      artifacts: { retentionDays: 400 },
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(false);
  });

  it("validates passthrough with valid names", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      environment: {
        passthrough: ["MY_VAR", "NODE_OPTIONS", "DEBUG_MODE"],
      },
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(true);
    expect(result!.summary.environment_passthrough_count).toBe(3);
    expect(result!.summary.environment_passthrough).toEqual(["MY_VAR", "NODE_OPTIONS", "DEBUG_MODE"]);
    expect(result!.phase2!.environment!.passthrough).toEqual(["MY_VAR", "NODE_OPTIONS", "DEBUG_MODE"]);
  });

  it("rejects passthrough with secret-like names", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      environment: {
        passthrough: ["GITHUB_TOKEN", "OPENAI_API_KEY", "DATABASE_URL"],
      },
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(false);
    expect(result!.summary.errors).toHaveLength(3);
  });

  it("rejects passthrough with invalid env var names", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      environment: {
        passthrough: ["123invalid", "not valid", ""],
      },
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(false);
    expect(result!.summary.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("warns on duplicate passthrough names", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      environment: {
        passthrough: ["MY_VAR", "MY_VAR", "OTHER_VAR"],
      },
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.warnings.some((w) => w.message.includes("Duplicate"))).toBe(true);
    // Deduped in phase2 config
    expect(result!.phase2!.environment!.passthrough).toEqual(["MY_VAR", "OTHER_VAR"]);
  });

  it("warns on unknown Phase 2 subfields", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      verification: {
        allowedScripts: ["test"],
        unknownSub: true,
      },
      artifacts: {
        retentionDays: 7,
        unknownField: 42,
      },
      environment: {
        passthrough: ["MY_VAR"],
        extraField: "value",
      },
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.warnings.length).toBeGreaterThanOrEqual(3);
    expect(result!.summary.warnings.some((w) => w.field === "verification.unknownSub")).toBe(true);
    expect(result!.summary.warnings.some((w) => w.field === "artifacts.unknownField")).toBe(true);
    expect(result!.summary.warnings.some((w) => w.field === "environment.extraField")).toBe(true);
  });

  it("warns on unknown top-level fields (forward compat)", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      future_feature: { enabled: true },
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(true);
    expect(result!.summary.warnings).toHaveLength(1);
    expect(result!.summary.warnings[0].field).toBe("future_feature");
  });

  it("summary never leaks command string values or secret values", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      install: "npx secret-cmd --token supersecret",
      test: "npm run test:secret",
      verification: {
        allowedScripts: ["test:unit", "build"],
      },
      environment: {
        passthrough: ["MY_SAFE_VAR"],
      },
    });

    const result = await readEnvironmentConfig(dir);
    const jsonStr = JSON.stringify(result!.summary);
    expect(jsonStr).not.toContain("secret-cmd");
    expect(jsonStr).not.toContain("supersecret");
    expect(jsonStr).not.toContain("test:secret");
    // Allowed script names and safe passthrough names may be present
    expect(jsonStr).toContain("test:unit");
    expect(jsonStr).toContain("build");
    expect(jsonStr).toContain("MY_SAFE_VAR");
  });

  it("deduplicates allowedScripts with warning", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      verification: {
        allowedScripts: ["test:unit", "lint", "test:unit"],
      },
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.warnings.some((w) => w.message.includes("Duplicate"))).toBe(true);
    expect(result!.phase2!.verification!.allowedScripts).toEqual(["test:unit", "lint"]);
  });

  it("preserves empty allowedScripts as an execution restriction", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      verification: {
        allowedScripts: [],
      },
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(true);
    expect(result!.summary.verification_allowed_scripts_count).toBe(0);
    expect(result!.summary.verification_allowed_scripts).toEqual([]);
    expect(result!.phase2!.verification!.allowedScripts).toEqual([]);
  });

  it("invalid config does not produce phase2 execution config", async () => {
    const dir = await makeDir();
    await writeConfig(dir, {
      install: "",
      verification: { allowedScripts: ["test"] },
    });

    const result = await readEnvironmentConfig(dir);
    expect(result!.summary.ok).toBe(false);
    expect(result!.phase2).toBeUndefined();
  });
});
