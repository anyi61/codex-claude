#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = process.env.CHECK_RELEASE_REPO_ROOT
  ? path.resolve(process.env.CHECK_RELEASE_REPO_ROOT)
  : path.resolve(path.dirname(__filename), "..");

function fail(message) {
  console.error(`check:release failed: ${message}`);
  process.exit(1);
}

// Pack file list

const requiredAssets = [
  "dist/server.js",
  "dist/cli.js",
  "plugins/codex-claude-delegate/server/server.js",
  "plugins/codex-claude-delegate/server/job-runner.js",
  "plugins/codex-claude-delegate/.mcp.json",
  "plugins/codex-claude-delegate/.codex-plugin/plugin.json",
  "plugins/codex-claude-delegate/skills/",
  "plugins/codex-claude-delegate/hooks/hooks.json",
  "scripts/uninstall-plugin.mjs",
  "README.md",
  "SECURITY.md",
  "LICENSE",
];

const forbiddenPrefixes = [
  "src/",
  "tests/",
  "node_modules/",
  ".git/",
  ".env",
  ".npmrc",
  ".claude/",
  ".codex-claude-delegate/",
];

/** @returns {{ path: string }[]} */
function getPackFiles() {
  if (process.env.CHECK_RELEASE_PACK_JSON_FILE) {
    const fixturePath = path.resolve(repoRoot, process.env.CHECK_RELEASE_PACK_JSON_FILE);
    if (!existsSync(fixturePath)) {
      fail(`CHECK_RELEASE_PACK_JSON_FILE set but file not found: ${fixturePath}`);
    }
    const parsed = JSON.parse(readFileSync(fixturePath, "utf8"));
    if (!Array.isArray(parsed) || parsed.length === 0 || !Array.isArray(parsed[0]?.files)) {
      fail("CHECK_RELEASE_PACK_JSON_FILE: fixture must be a non-empty array with [0].files");
    }
    return parsed[0].files;
  }

  try {
    const stdout = execFileSync("npm", ["pack", "--json", "--dry-run"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 60000,
    });
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed) || parsed.length === 0 || !Array.isArray(parsed[0]?.files)) {
      fail("npm pack --json --dry-run returned unexpected format");
    }
    return parsed[0].files;
  } catch (error) {
    if (error instanceof SyntaxError) {
      fail(`npm pack output was not valid JSON: ${error.message}`);
    }
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
    const message = error instanceof Error ? error.message : String(error);
    fail(`npm pack --json --dry-run failed: ${stderr.trim() || message}`);
  }
}

const packFiles = getPackFiles();
const filePaths = packFiles.map((f) => f.path).sort();

// Required asset checks

for (const required of requiredAssets) {
  if (required.endsWith("/")) {
    if (!filePaths.some((f) => f.startsWith(required))) {
      fail(`required asset directory has no files: ${required}`);
    }
  } else {
    if (!filePaths.includes(required)) {
      fail(`required asset missing from tarball: ${required}`);
    }
  }
}

// Forbidden asset checks

for (const filePath of filePaths) {
  for (const prefix of forbiddenPrefixes) {
    if (filePath === prefix || filePath.startsWith(prefix)) {
      fail(`forbidden asset in tarball: ${filePath}`);
    }
  }
}

// Version consistency

const pluginRoot = process.env.CHECK_RELEASE_PLUGIN_ROOT
  ? path.resolve(process.env.CHECK_RELEASE_PLUGIN_ROOT)
  : path.join(repoRoot, "plugins", "codex-claude-delegate");

const codexPluginPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
const claudePluginPath = path.join(pluginRoot, ".claude-plugin", "plugin.json");

if (!existsSync(codexPluginPath)) {
  fail(`missing .codex-plugin/plugin.json at ${codexPluginPath}`);
}
if (!existsSync(claudePluginPath)) {
  fail(`missing .claude-plugin/plugin.json at ${claudePluginPath}`);
}

const packageJsonPath = path.join(repoRoot, "package.json");
if (!existsSync(packageJsonPath)) {
  fail(`missing package.json at ${packageJsonPath}`);
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const codexPlugin = JSON.parse(readFileSync(codexPluginPath, "utf8"));
const claudePlugin = JSON.parse(readFileSync(claudePluginPath, "utf8"));

if (typeof packageJson.version !== "string" || !packageJson.version.length) {
  fail("package.json missing version string");
}
if (typeof codexPlugin.version !== "string" || !codexPlugin.version.length) {
  fail(".codex-plugin/plugin.json missing version string");
}
if (typeof claudePlugin.version !== "string" || !claudePlugin.version.length) {
  fail(".claude-plugin/plugin.json missing version string");
}
if (codexPlugin.version !== packageJson.version) {
  fail(
    `version mismatch: .codex-plugin ${codexPlugin.version} !== package.json ${packageJson.version}`,
  );
}
if (claudePlugin.version !== packageJson.version) {
  fail(
    `version mismatch: .claude-plugin ${claudePlugin.version} !== package.json ${packageJson.version}`,
  );
}
if (codexPlugin.version !== claudePlugin.version) {
  fail(
    `version mismatch: .codex-plugin ${codexPlugin.version} !== .claude-plugin ${claudePlugin.version}`,
  );
}

console.log(`check:release ok (${filePaths.length} tarball files)`);
