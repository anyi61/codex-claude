#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = process.env.SYNC_PLUGIN_VERSION_REPO_ROOT
  ? path.resolve(process.env.SYNC_PLUGIN_VERSION_REPO_ROOT)
  : path.resolve(path.dirname(__filename), "..");

function fail(message) {
  console.error(`sync:plugin-version failed: ${message}`);
  process.exit(1);
}

function readJson(filePath) {
  if (!existsSync(filePath)) {
    fail(`missing file: ${filePath}`);
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    fail(`could not parse JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const packageJsonPath = path.join(repoRoot, "package.json");
const packageJson = readJson(packageJsonPath);

if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
  fail("package.json missing version string");
}

const pluginFiles = [
  path.join(repoRoot, "plugins", "codex-claude-delegate", ".codex-plugin", "plugin.json"),
  path.join(repoRoot, "plugins", "codex-claude-delegate", ".claude-plugin", "plugin.json"),
];

for (const pluginFile of pluginFiles) {
  const pluginJson = readJson(pluginFile);
  pluginJson.version = packageJson.version;
  writeJson(pluginFile, pluginJson);
}

console.log(`sync:plugin-version ok (${packageJson.version})`);
