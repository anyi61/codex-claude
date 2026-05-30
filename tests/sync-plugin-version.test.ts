import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = path.resolve(import.meta.dirname, "..", "scripts", "sync-plugin-version.mjs");
const repoRoot = path.resolve(import.meta.dirname, "..");
const packageJsonPath = path.join(repoRoot, "package.json");

const tmpDirs: string[] = [];

async function makeRepoFixture(packageVersion = "9.8.7") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sync-plugin-version-"));
  tmpDirs.push(dir);
  await mkdir(path.join(dir, "plugins", "codex-claude-delegate", ".codex-plugin"), { recursive: true });
  await mkdir(path.join(dir, "plugins", "codex-claude-delegate", ".claude-plugin"), { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", version: packageVersion }, null, 2), "utf8");
  await writeFile(path.join(dir, "plugins", "codex-claude-delegate", ".codex-plugin", "plugin.json"), JSON.stringify({ name: "codex", version: "0.0.1", extra: true }, null, 2), "utf8");
  await writeFile(path.join(dir, "plugins", "codex-claude-delegate", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "claude", version: "0.0.2" }, null, 2), "utf8");
  return dir;
}

async function readJson(filePath: string) {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("sync-plugin-version.mjs", () => {
  it("syncs both plugin metadata versions from package.json", async () => {
    const dir = await makeRepoFixture("1.2.3");

    const stdout = execFileSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, SYNC_PLUGIN_VERSION_REPO_ROOT: dir },
    });

    const codexPlugin = await readJson(path.join(dir, "plugins", "codex-claude-delegate", ".codex-plugin", "plugin.json"));
    const claudePlugin = await readJson(path.join(dir, "plugins", "codex-claude-delegate", ".claude-plugin", "plugin.json"));
    expect(stdout).toContain("1.2.3");
    expect(codexPlugin.version).toBe("1.2.3");
    expect(codexPlugin.extra).toBe(true);
    expect(claudePlugin.version).toBe("1.2.3");
  });

  it("is wired into all release scripts after npm version", async () => {
    const packageJson = await readJson(packageJsonPath);
    const scripts = packageJson.scripts as Record<string, string>;

    for (const name of ["release", "release:minor", "release:major"]) {
      expect(scripts[name]).toContain("npm version");
      expect(scripts[name]).toContain("npm run sync:plugin-version");
      expect(scripts[name].indexOf("npm version")).toBeLessThan(scripts[name].indexOf("npm run sync:plugin-version"));
      expect(scripts[name].indexOf("npm run sync:plugin-version")).toBeLessThan(scripts[name].indexOf("npm publish"));
    }
  });
});
