#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = process.env.CHECK_RELEASE_REPO_ROOT
  ? path.resolve(process.env.CHECK_RELEASE_REPO_ROOT)
  : path.resolve(path.dirname(__filename), "..");

function fail(message) {
  console.error(`check:release:install failed: ${message}`);
  process.exit(1);
}

const packageJsonPath = path.join(repoRoot, "package.json");
if (!existsSync(packageJsonPath)) {
  fail(`missing package.json at ${packageJsonPath}`);
}
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const packageName = packageJson.name;
const packageVersion = packageJson.version;
if (!packageName || !packageVersion) {
  fail("package.json missing name or version");
}

const binName = Object.keys(packageJson.bin ?? {})[0];
if (!binName) {
  fail("package.json has no bin entry");
}

const tmpDir = mkdtempSync(path.join(os.tmpdir(), "check-release-install-"));
const installDir = process.env.CHECK_RELEASE_INSTALL_DIR
  ? path.resolve(process.env.CHECK_RELEASE_INSTALL_DIR)
  : path.join(tmpDir, "install-project");

const tarballFile = process.env.CHECK_RELEASE_TARBALL_FILE
  ? path.resolve(process.env.CHECK_RELEASE_TARBALL_FILE)
  : undefined;

try {
  // --- Tarball ---
  let tarballPath;

  if (process.env.CHECK_RELEASE_INSTALL_DIR) {
    // Skip tarball + install; just verify the existing install directory.
    verifyInstall(installDir, packageName, packageVersion, binName);
    console.log(`check:release:install ok (pre-created install dir: ${installDir})`);
    process.exit(0);
  }

  if (tarballFile) {
    if (!existsSync(tarballFile)) {
      fail(`CHECK_RELEASE_TARBALL_FILE set but file not found: ${tarballFile}`);
    }
    tarballPath = tarballFile;
  } else {
    const packDest = path.join(tmpDir, "tarball");
    mkdirSync(packDest, { recursive: true });
    let packStdout;
    try {
      packStdout = execFileSync(
        "npm",
        ["pack", "--json", "--pack-destination", packDest],
        { cwd: repoRoot, encoding: "utf8", stdio: "pipe", timeout: 60000 },
      );
    } catch (err) {
      const stderr = err && typeof err === "object" && "stderr" in err ? String(err.stderr) : "";
      fail(`npm pack failed: ${stderr.trim() || (err instanceof Error ? err.message : String(err))}`);
    }

    let packResult;
    try {
      packResult = JSON.parse(packStdout);
    } catch {
      fail(`npm pack returned invalid JSON: ${packStdout.trim()}`);
    }

    const filename = Array.isArray(packResult) && typeof packResult[0]?.filename === "string"
      ? packResult[0].filename
      : undefined;
    if (!filename) {
      fail(`npm pack JSON missing filename: ${JSON.stringify(packResult)}`);
    }

    tarballPath = path.resolve(packDest, filename);
    if (!existsSync(tarballPath)) {
      fail(`expected tarball not found: ${tarballPath}`);
    }
  }

  // --- Install ---
  mkdirSync(installDir, { recursive: true });
  // Create a minimal package.json so npm install works in the temp dir.
  const initPkg = path.join(installDir, "package.json");
  if (!existsSync(initPkg)) {
    writeFileSync(initPkg, JSON.stringify({ name: "release-install-check", private: true }), "utf8");
  }

  try {
    execFileSync(
      "npm",
      [
        "install", tarballPath,
        "--prefix", installDir,
        "--install-strategy=nested",
        "--no-audit", "--no-fund", "--no-package-lock",
        "--ignore-scripts", "--prefer-offline",
      ],
      { encoding: "utf8", stdio: "pipe", timeout: 120000 },
    );
  } catch (err) {
    const stderr = err && typeof err === "object" && "stderr" in err ? String(err.stderr) : "";
    fail(`npm install failed: ${stderr.trim() || (err instanceof Error ? err.message : String(err))}`);
  }

  // --- Verify ---
  verifyInstall(installDir, packageName, packageVersion, binName);

  console.log(`check:release:install ok (package=${packageName} v${packageVersion}, bin=${binName})`);
} finally {
  if (!process.env.CHECK_RELEASE_INSTALL_DIR) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function verifyInstall(baseDir, pkgName, pkgVersion, bin) {
  // Check bin --version
  const binPath = path.join(baseDir, "node_modules", ".bin", bin);
  if (!existsSync(binPath)) {
    fail(`installed bin not found: ${binPath}`);
  }

  let stdout;
  try {
    stdout = execFileSync(binPath, ["--version"], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 15000,
    }).trim();
  } catch (err) {
    const exitCode = err && typeof err === "object" && "status" in err ? err.status : "?";
    fail(`${bin} --version exited ${exitCode}`);
  }

  const expected = `${pkgName} v${pkgVersion}`;
  if (!stdout.includes(expected)) {
    fail(`--version output "${stdout}" does not contain "${expected}"`);
  }

  // Check dist files
  const pkgDir = path.join(baseDir, "node_modules", pkgName);
  for (const file of ["dist/cli.js", "dist/server.js"]) {
    if (!existsSync(path.join(pkgDir, file))) {
      fail(`installed package missing ${file} at ${pkgDir}`);
    }
  }
}
