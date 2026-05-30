import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = path.resolve(import.meta.dirname, "..", "scripts", "check-release-metadata.mjs");
const repoRoot = path.resolve(import.meta.dirname, "..");

type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

const tmpDirs: string[] = [];

function runScript(env: Record<string, string>): RunResult {
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

async function writeFixtureDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "check-metadata-test-"));
  tmpDirs.push(dir);
  return dir;
}

async function writePackageFixture(dir: string, data: { name?: string; version?: string }) {
  await writeFile(path.join(dir, "package.json"), JSON.stringify(data, null, 2), "utf8");
}

function registryJson(version: string, latest = version): string {
  return JSON.stringify({
    version,
    "dist-tags": { latest },
  });
}

function flattenedRegistryJson(version: string, latest = version): string {
  return JSON.stringify({
    version,
    "dist-tags.latest": latest,
  });
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("check-release-metadata.mjs", () => {
  it("passes when registry version matches local and git tag exists", async () => {
    const dir = await writeFixtureDir();
    await writePackageFixture(dir, { name: "@anyi61/test-pkg", version: "1.0.0" });

    const result = runScript({
      CHECK_RELEASE_REPO_ROOT: dir,
      CHECK_RELEASE_NPM_VIEW_JSON: registryJson("1.0.0"),
      CHECK_RELEASE_GIT_TAGS: "v1.0.0\n",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("check:release:metadata ok");
    expect(result.stdout).toContain("1.0.0");
  });

  it("passes local dry run when npm and git checks are explicitly skipped", async () => {
    const dir = await writeFixtureDir();
    await writePackageFixture(dir, { name: "@anyi61/test-pkg", version: "1.0.0" });

    const result = runScript({
      CHECK_RELEASE_REPO_ROOT: dir,
      CHECK_RELEASE_SKIP_NPM: "1",
      CHECK_RELEASE_SKIP_GIT: "1",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("registry=skipped");
    expect(result.stdout).toContain("tag=skipped");
  });

  it("passes when npm returns flattened dist-tags.latest metadata", async () => {
    const dir = await writeFixtureDir();
    await writePackageFixture(dir, { name: "@anyi61/test-pkg", version: "1.0.0" });

    const result = runScript({
      CHECK_RELEASE_REPO_ROOT: dir,
      CHECK_RELEASE_NPM_VIEW_JSON: flattenedRegistryJson("1.0.0"),
      CHECK_RELEASE_GIT_TAGS: "v1.0.0\n",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("latest=1.0.0");
  });

  it("fails when registry version does not match local version", async () => {
    const dir = await writeFixtureDir();
    await writePackageFixture(dir, { name: "@anyi61/test-pkg", version: "1.0.0" });

    const result = runScript({
      CHECK_RELEASE_REPO_ROOT: dir,
      CHECK_RELEASE_NPM_VIEW_JSON: registryJson("0.9.0", "1.0.0"),
      CHECK_RELEASE_GIT_TAGS: "v1.0.0\n",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("registry version 0.9.0 !== package.json 1.0.0");
  });

  it("fails when registry latest does not match local version", async () => {
    const dir = await writeFixtureDir();
    await writePackageFixture(dir, { name: "@anyi61/test-pkg", version: "1.0.0" });

    const result = runScript({
      CHECK_RELEASE_REPO_ROOT: dir,
      CHECK_RELEASE_NPM_VIEW_JSON: registryJson("1.0.0", "0.9.0"),
      CHECK_RELEASE_GIT_TAGS: "v1.0.0\n",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("registry dist-tags.latest 0.9.0 !== package.json 1.0.0");
  });

  it("fails when git tag does not exist", async () => {
    const dir = await writeFixtureDir();
    await writePackageFixture(dir, { name: "@anyi61/test-pkg", version: "1.0.0" });

    const result = runScript({
      CHECK_RELEASE_REPO_ROOT: dir,
      CHECK_RELEASE_NPM_VIEW_JSON: registryJson("1.0.0"),
      CHECK_RELEASE_GIT_TAGS: "",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("git tag v1.0.0 is not present at HEAD");
  });

  it("fails when package.json is missing", async () => {
    const dir = await writeFixtureDir();

    const result = runScript({
      CHECK_RELEASE_REPO_ROOT: dir,
      CHECK_RELEASE_NPM_VIEW_JSON: registryJson("1.0.0"),
      CHECK_RELEASE_GIT_TAGS: "v1.0.0\n",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("package.json");
  });

  it("fails when package.json has no version", async () => {
    const dir = await writeFixtureDir();
    await writePackageFixture(dir, { name: "@anyi61/test-pkg" });

    const result = runScript({
      CHECK_RELEASE_REPO_ROOT: dir,
      CHECK_RELEASE_NPM_VIEW_JSON: registryJson("1.0.0"),
      CHECK_RELEASE_GIT_TAGS: "v1.0.0\n",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("package.json missing name or version");
  });

  it("fails when package.json has no name", async () => {
    const dir = await writeFixtureDir();
    await writePackageFixture(dir, { version: "1.0.0" });

    const result = runScript({
      CHECK_RELEASE_REPO_ROOT: dir,
      CHECK_RELEASE_NPM_VIEW_JSON: registryJson("1.0.0"),
      CHECK_RELEASE_GIT_TAGS: "v1.0.0\n",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("package.json missing name or version");
  });

  it("fails when npm view output is invalid JSON", async () => {
    const dir = await writeFixtureDir();
    await writePackageFixture(dir, { name: "@anyi61/test-pkg", version: "1.0.0" });

    const result = runScript({
      CHECK_RELEASE_REPO_ROOT: dir,
      CHECK_RELEASE_NPM_VIEW_JSON: "{bad",
      CHECK_RELEASE_GIT_TAGS: "v1.0.0\n",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("npm view returned invalid JSON");
  });

  it("package.json has check:release:metadata script", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts["check:release:metadata"]).toBe(
      "node scripts/check-release-metadata.mjs",
    );
  });

  it("check:release:metadata is not in prepublishOnly", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts.prepublishOnly).not.toContain("check:release:metadata");
  });

  it("check:release:metadata is not in release scripts", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts.release).not.toContain("check:release:metadata");
    expect(pkg.scripts["release:minor"]).not.toContain("check:release:metadata");
    expect(pkg.scripts["release:major"]).not.toContain("check:release:metadata");
  });
});
