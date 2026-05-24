import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = path.resolve(import.meta.dirname, "..", "scripts", "check-release-assets.mjs");
const repoRoot = path.resolve(import.meta.dirname, "..");

type AuditResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

const tmpDirs: string[] = [];

function runCheckRelease(env: Record<string, string>): AuditResult {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, ...env },
      timeout: 30000,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    if (err && typeof err === "object" && "stdout" in err && "stderr" in err) {
      return {
        stdout: String(err.stdout),
        stderr: String(err.stderr),
        exitCode: typeof err.code === "number" ? err.code : 1,
      };
    }
    throw err;
  }
}

async function writeFixtureDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "check-release-test-"));
  tmpDirs.push(dir);
  return dir;
}

async function writePackFixture(dir: string, files: { path: string }[]) {
  const fixturePath = path.join(dir, "pack-fixture.json");
  await writeFile(
    fixturePath,
    JSON.stringify([{ id: "test@1.0.0", name: "test", version: "1.0.0", files }]),
    "utf8",
  );
  return fixturePath;
}

async function writePackageFixture(dir: string, version = "0.1.0") {
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "test", version }, null, 2),
    "utf8",
  );
}

async function writePluginFixtures(dir: string, codexVersion: string, claudeVersion: string) {
  const codexDir = path.join(dir, ".codex-plugin");
  const claudeDir = path.join(dir, ".claude-plugin");
  await mkdir(codexDir, { recursive: true });
  await mkdir(claudeDir, { recursive: true });
  await writeFile(
    path.join(codexDir, "plugin.json"),
    JSON.stringify({ name: "test", version: codexVersion }),
    "utf8",
  );
  await writeFile(
    path.join(claudeDir, "plugin.json"),
    JSON.stringify({ name: "test", version: claudeVersion }),
    "utf8",
  );
}

function validFiles(): { path: string }[] {
  return [
    { path: "dist/server.js" },
    { path: "dist/cli.js" },
    { path: "plugins/codex-claude-delegate/server/server.js" },
    { path: "plugins/codex-claude-delegate/server/job-runner.js" },
    { path: "plugins/codex-claude-delegate/.mcp.json" },
    { path: "plugins/codex-claude-delegate/.codex-plugin/plugin.json" },
    { path: "plugins/codex-claude-delegate/skills/claude-delegate.md" },
    { path: "plugins/codex-claude-delegate/hooks/hooks.json" },
    { path: "scripts/uninstall-plugin.mjs" },
    { path: "README.md" },
    { path: "SECURITY.md" },
    { path: "LICENSE" },
  ];
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("check-release-assets.mjs", () => {
  it("passes with valid pack output", async () => {
    const dir = await writeFixtureDir();
    const fixturePath = await writePackFixture(dir, validFiles());
    await writePackageFixture(dir);
    const pluginDir = await writeFixtureDir();
    await writePluginFixtures(pluginDir, "0.1.0", "0.1.0");

    const result = runCheckRelease({
      CHECK_RELEASE_PACK_JSON_FILE: fixturePath,
      CHECK_RELEASE_REPO_ROOT: dir,
      CHECK_RELEASE_PLUGIN_ROOT: pluginDir,
    });

    expect(result.exitCode).toBe(0);
  });

  it("fails when README.md is missing from tarball", async () => {
    const dir = await writeFixtureDir();
    const files = validFiles().filter((f) => f.path !== "README.md");
    const fixturePath = await writePackFixture(dir, files);
    await writePackageFixture(dir);
    const pluginDir = await writeFixtureDir();
    await writePluginFixtures(pluginDir, "0.1.0", "0.1.0");

    const result = runCheckRelease({
      CHECK_RELEASE_PACK_JSON_FILE: fixturePath,
      CHECK_RELEASE_REPO_ROOT: dir,
      CHECK_RELEASE_PLUGIN_ROOT: pluginDir,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("README.md");
  });

  it("fails when src/server.ts is forbidden in tarball", async () => {
    const dir = await writeFixtureDir();
    const files = [...validFiles(), { path: "src/server.ts" }];
    const fixturePath = await writePackFixture(dir, files);
    await writePackageFixture(dir);
    const pluginDir = await writeFixtureDir();
    await writePluginFixtures(pluginDir, "0.1.0", "0.1.0");

    const result = runCheckRelease({
      CHECK_RELEASE_PACK_JSON_FILE: fixturePath,
      CHECK_RELEASE_REPO_ROOT: dir,
      CHECK_RELEASE_PLUGIN_ROOT: pluginDir,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("forbidden");
    expect(result.stderr).toContain("src/server.ts");
  });

  it("fails when plugin versions mismatch", async () => {
    const dir = await writeFixtureDir();
    const fixturePath = await writePackFixture(dir, validFiles());
    await writePackageFixture(dir);
    const pluginDir = await writeFixtureDir();
    await writePluginFixtures(pluginDir, "0.1.0", "0.2.0");

    const result = runCheckRelease({
      CHECK_RELEASE_PACK_JSON_FILE: fixturePath,
      CHECK_RELEASE_REPO_ROOT: dir,
      CHECK_RELEASE_PLUGIN_ROOT: pluginDir,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("version mismatch");
  });
});
