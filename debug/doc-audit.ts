import { access, readFile } from "node:fs/promises";
import path from "node:path";

const PROJECT_ROOT = process.cwd();

async function readText(relativePath: string): Promise<string> {
  return readFile(path.join(PROJECT_ROOT, relativePath), "utf8");
}

function uniqueMatches(text: string, regex: RegExp): string[] {
  const values = new Set<string>();
  for (const match of text.matchAll(regex)) {
    if (match[1]) values.add(match[1]);
  }
  return [...values].sort();
}

async function exists(relativePath: string): Promise<boolean> {
  try {
    await access(path.join(PROJECT_ROOT, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const failures: string[] = [];
  const packageJson = JSON.parse(await readText("package.json")) as { scripts?: Record<string, string> };
  const scripts = new Set(Object.keys(packageJson.scripts ?? {}));
  const serverSource = await readText("src/server.ts");
  const readme = await readText("README.md");
  const spec = await readText("SPEC.md");
  const planFiles = [
    "docs/superpowers/plans/2026-05-05-background-apply-cleanup.md",
    "docs/superpowers/plans/2026-05-05-background-job-cleanup.md",
    "docs/superpowers/plans/2026-05-05-background-job-followups.md",
    "docs/superpowers/plans/2026-05-05-background-job-handler-tests.md",
    "docs/superpowers/plans/2026-05-05-background-query.md",
    "docs/superpowers/plans/2026-05-05-high-level-workflows.md",
    "docs/superpowers/plans/2026-05-05-job-runner-tests.md",
  ];
  const planTexts = await Promise.all(planFiles.map(async (file) => `${file}\n${await readText(file)}`));
  const docs = [
    { name: "README.md", text: readme },
    { name: "SPEC.md", text: spec },
    ...planTexts.map((text, index) => ({ name: planFiles[index]!, text })),
  ];

  const toolNames = uniqueMatches(serverSource, /name:\s*"(claude_[a-z_]+)"/g);
  for (const doc of [
    { name: "README.md", text: readme },
    { name: "SPEC.md", text: spec },
  ]) {
    for (const toolName of toolNames) {
      if (!doc.text.includes(toolName)) {
        failures.push(`${doc.name} does not mention tool ${toolName}`);
      }
    }
  }

  for (const doc of docs) {
    for (const scriptName of uniqueMatches(doc.text, /npm run ([\w:-]+)/g)) {
      if (!scripts.has(scriptName)) {
        failures.push(`${doc.name} references missing npm script: ${scriptName}`);
      }
    }

    for (const scriptPath of uniqueMatches(doc.text, /(?:npx tsx|node --import tsx)\s+(debug\/[^\s`#]+)/g)) {
      if (!(await exists(scriptPath))) {
        failures.push(`${doc.name} references missing debug script: ${scriptPath}`);
      }
    }
  }

  if (failures.length > 0) {
    console.error("=== DOC AUDIT FAILED ===");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log("=== DOC AUDIT PASSED ===");
  console.log(`Checked ${toolNames.length} MCP tools, ${scripts.size} npm scripts, and ${docs.length} docs.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
