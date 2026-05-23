import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readEnvironmentConfig } from "../src/environment-config.js";

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
});
