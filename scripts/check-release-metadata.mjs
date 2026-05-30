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
  console.error(`check:release:metadata failed: ${message}`);
  process.exit(1);
}

// Read package.json

const packageJsonPath = path.join(repoRoot, "package.json");
if (!existsSync(packageJsonPath)) {
  fail(`missing package.json at ${packageJsonPath}`);
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

if (
  typeof packageJson.name !== "string"
  || packageJson.name.length === 0
  || typeof packageJson.version !== "string"
  || packageJson.version.length === 0
) {
  fail("package.json missing name or version");
}

const { name, version } = packageJson;

// Check registry metadata

let registryMetadata;
if (process.env.CHECK_RELEASE_SKIP_NPM === "1") {
  registryMetadata = null;
} else if (process.env.CHECK_RELEASE_NPM_VIEW_JSON) {
  try {
    registryMetadata = JSON.parse(process.env.CHECK_RELEASE_NPM_VIEW_JSON);
  } catch {
    fail("npm view returned invalid JSON");
  }
} else {
  try {
    const stdout = execFileSync("npm", ["view", name, "version", "dist-tags.latest", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 30000,
    });
    registryMetadata = JSON.parse(stdout.trim());
  } catch (err) {
    if (err instanceof SyntaxError) {
      fail("npm view returned invalid JSON");
    }
    const stderr = err && typeof err === "object" && "stderr" in err ? String(err.stderr) : "";
    const message = err instanceof Error ? err.message : String(err);
    fail(`npm view failed for ${name}: ${stderr.trim() || message}`);
  }
}

let registryVersion = "skipped";
let registryLatest = "skipped";
if (registryMetadata !== null) {
  registryVersion = registryMetadata?.version;
  registryLatest = registryMetadata?.["dist-tags"]?.latest;

  if (typeof registryVersion !== "string") {
    fail(`npm view missing version for ${name}`);
  }
  registryLatest = typeof registryMetadata?.["dist-tags.latest"] === "string"
    ? registryMetadata["dist-tags.latest"]
    : registryLatest;
  if (typeof registryLatest !== "string") {
    fail(`npm view missing dist-tags.latest for ${name}`);
  }
  if (registryVersion !== version) {
    fail(`registry version ${registryVersion} !== package.json ${version}`);
  }
  if (registryLatest !== version) {
    fail(`registry dist-tags.latest ${registryLatest} !== package.json ${version}`);
  }
}

// Check git tag at HEAD

const expectedTag = `v${version}`;
let tagExists;
if (process.env.CHECK_RELEASE_SKIP_GIT === "1") {
  tagExists = null;
} else if (process.env.CHECK_RELEASE_GIT_TAGS !== undefined) {
  tagExists = process.env.CHECK_RELEASE_GIT_TAGS
    .split(/\r?\n/)
    .map((tag) => tag.trim())
    .includes(expectedTag);
} else {
  try {
    const stdout = execFileSync("git", ["tag", "--points-at", "HEAD", expectedTag], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 10000,
    });
    tagExists = stdout.trim().length > 0;
  } catch (err) {
    const stderr = err && typeof err === "object" && "stderr" in err ? String(err.stderr) : "";
    const message = err instanceof Error ? err.message : String(err);
    fail(`git tag check failed: ${stderr.trim() || message}`);
  }
}

if (tagExists === false) {
  fail(`git tag ${expectedTag} is not present at HEAD`);
}

console.log(
  `check:release:metadata ok (${name} v${version}, registry=${registryVersion}, latest=${registryLatest}, tag=${tagExists === null ? "skipped" : expectedTag})`,
);
