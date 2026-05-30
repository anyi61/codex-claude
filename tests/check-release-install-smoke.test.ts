import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = path.resolve(import.meta.dirname, "..", "scripts", "check-release-install-smoke.mjs");
const repoRoot = path.resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const packageName = packageJson.name as string;
const packageVersion = packageJson.version as string;
const binName = Object.keys(packageJson.bin ?? {})[0];

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

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "check-release-install-test-"));
  tmpDirs.push(dir);
  return dir;
}

async function writeJson(filePath: string, data: unknown) {
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function writeBinScript(filePath: string, body: string) {
  await writeFile(filePath, `#!/usr/bin/env node\n${body}\n`, "utf8");
  await chmod(filePath, 0o755);
}

/**
 * Build a fake installed-package directory layout that the script can verify:
 *   base/
 *     node_modules/.bin/<binName>   -> outputs expected version line
 *     node_modules/<pkgName>/dist/cli.js
 *     node_modules/<pkgName>/dist/server.js
 *     package.json                   (required by --prefix npm layout)
 */
async function buildFakeInstallDir(
  baseDir: string,
  pkgName: string,
  pkgVersion: string,
  binName: string,
  binBody = `console.log("${pkgName} v${pkgVersion}");`,
) {
  const binDir = path.join(baseDir, "node_modules", ".bin");
  const pkgDist = path.join(baseDir, "node_modules", pkgName, "dist");
  await mkdir(binDir, { recursive: true });
  await mkdir(pkgDist, { recursive: true });
  await writeBinScript(path.join(binDir, binName), binBody);
  await writeFile(path.join(pkgDist, "cli.js"), "// cli stub\n", "utf8");
  await writeFile(path.join(pkgDist, "server.js"), "// server stub\n", "utf8");
  await writeJson(path.join(baseDir, "package.json"), { name: "release-install-check", private: true });
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("check-release-install-smoke.mjs", () => {
  it("happy path with CHECK_RELEASE_INSTALL_DIR", async () => {
    const base = await tmpDir();
    await buildFakeInstallDir(base, packageName, packageVersion, binName);

    const result = runScript({
      CHECK_RELEASE_INSTALL_DIR: base,
      CHECK_RELEASE_REPO_ROOT: repoRoot,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("check:release:install ok");
  });

  it("fails when CHECK_RELEASE_TARBALL_FILE points to absent file", async () => {
    const result = runScript({
      CHECK_RELEASE_TARBALL_FILE: "/tmp/nonexistent-release-999.tgz",
      CHECK_RELEASE_REPO_ROOT: repoRoot,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("file not found");
  });

  it("fails when bin --version outputs wrong version", async () => {
    const base = await tmpDir();
    await buildFakeInstallDir(
      base,
      packageName,
      packageVersion,
      binName,
      `console.log("${packageName} v99.99.99");`,
    );

    const result = runScript({
      CHECK_RELEASE_INSTALL_DIR: base,
      CHECK_RELEASE_REPO_ROOT: repoRoot,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("does not contain");
  });

  it("fails when bin exits nonzero", async () => {
    const base = await tmpDir();
    await buildFakeInstallDir(
      base,
      packageName,
      packageVersion,
      binName,
      `process.exit(42);`,
    );

    const result = runScript({
      CHECK_RELEASE_INSTALL_DIR: base,
      CHECK_RELEASE_REPO_ROOT: repoRoot,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("exited");
  });

  it("fails when dist/server.js is missing", async () => {
    const base = await tmpDir();
    await buildFakeInstallDir(base, packageName, packageVersion, binName);
    await unlink(path.join(base, "node_modules", packageName, "dist", "server.js"));

    const result = runScript({
      CHECK_RELEASE_INSTALL_DIR: base,
      CHECK_RELEASE_REPO_ROOT: repoRoot,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("dist/server.js");
  });

  it("fails when dist/cli.js is missing", async () => {
    const base = await tmpDir();
    await buildFakeInstallDir(base, packageName, packageVersion, binName);
    await unlink(path.join(base, "node_modules", packageName, "dist", "cli.js"));

    const result = runScript({
      CHECK_RELEASE_INSTALL_DIR: base,
      CHECK_RELEASE_REPO_ROOT: repoRoot,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("dist/cli.js");
  });

  it("package.json has check:release:install script", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts["check:release:install"]).toBe("node scripts/check-release-install-smoke.mjs");
  });

  it("prepublishOnly includes check:release:install after check:release", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const prepublish: string = pkg.scripts.prepublishOnly;
    const releaseIdx = prepublish.indexOf("check:release");
    const installIdx = prepublish.indexOf("check:release:install");
    expect(releaseIdx).toBeGreaterThanOrEqual(0);
    expect(installIdx).toBeGreaterThan(releaseIdx);
  });

  it("prepublishOnly runs security:grep after tests", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const prepublish: string = pkg.scripts.prepublishOnly;
    const testIdx = prepublish.indexOf("npm test");
    const securityIdx = prepublish.indexOf("npm run security:grep");
    expect(testIdx).toBeGreaterThanOrEqual(0);
    expect(securityIdx).toBeGreaterThan(testIdx);
  });
});
