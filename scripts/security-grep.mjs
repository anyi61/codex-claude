#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const srcRoot = path.join(repoRoot, "src");

const spawnAllowlist = new Set([
  "src/background-jobs.ts",
  "src/claude-process.ts",
  "src/cli.ts",
  "src/guard.ts",
  "src/verification.ts",
]);

const processEnvAllowlist = new Set([
  "src/background-jobs.ts",
  "src/claude-process.ts",
  "src/cli.ts",
  "src/codex-config.ts",
  "src/guard.ts",
  "src/review-gate.ts",
  "src/run-logs.ts",
]);

const boundarySensitiveFiles = new Set([
  "src/transaction.ts",
  "src/worktree-observer.ts",
]);

async function collectSourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function addFinding(findings, file, line, category, detail) {
  findings.push({ file, line, category, detail });
}

const findings = [];

for (const filePath of await collectSourceFiles(srcRoot)) {
  const relPath = path.relative(repoRoot, filePath);
  const content = await readFile(filePath, "utf8");
  const lines = content.split("\n");
  const usesBoundaryHelper = content.includes("resolveRepoLocalPath");

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;

    if (/\bshell\s*:\s*true\b/.test(line)) {
      addFinding(findings, relPath, lineNumber, "shell:true", "shell execution requires explicit security review");
    }

    if (/\bspawn\s*\(/.test(line) && !spawnAllowlist.has(relPath)) {
      addFinding(findings, relPath, lineNumber, "spawn", "new child process call needs env and argv review");
    }

    if (/\bprocess\.env\b/.test(line) && !processEnvAllowlist.has(relPath)) {
      addFinding(findings, relPath, lineNumber, "process.env", "direct env access outside config/process boundary");
    }

    if (boundarySensitiveFiles.has(relPath) && /\bpath\.join\s*\(/.test(line) && !usesBoundaryHelper) {
      addFinding(findings, relPath, lineNumber, "path.join", "boundary-sensitive file lacks resolveRepoLocalPath usage");
    }
  }
}

if (findings.length === 0) {
  console.log("security:grep ok - no flagged patterns");
  process.exit(0);
}

console.error(`security:grep found ${findings.length} flagged pattern(s):`);
for (const finding of findings) {
  console.error(`${finding.file}:${finding.line} [${finding.category}] ${finding.detail}`);
}
process.exit(1);
