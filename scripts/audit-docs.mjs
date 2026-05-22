#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const checkedRoots = [
  "README.md",
  "docs/development-overview.md",
  "docs/onboarding-plan.md",
  "docs/uninstall-execution-checklist.md",
  "docs/product",
  "plugins/codex-claude-delegate/skills",
  "plugins/codex-claude-delegate/.codex-plugin/plugin.json",
];

const requiredReadmePhrases = [
  "非官方项目",
  "Ready means",
  "One Message To Codex",
  "instruction_files vs `files`",
  "npx` 不是推荐安装路径",
  "security_profile=\"default\"",
  "claude_task(job_id=...)",
];

async function listFiles(target) {
  const absolute = path.join(root, target);
  if (!target.includes(".") || target.endsWith("/")) {
    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
    const nested = await Promise.all(entries.map((entry) => listFiles(path.join(target, entry.name))));
    return nested.flat();
  }
  return [target];
}

const files = (await Promise.all(checkedRoots.map(listFiles))).flat()
  .filter((file) => file.endsWith(".md") || file.endsWith(".json"));

const failures = [];

function hasStaleDefaultToolCount(text) {
  return [
    /默认工具数\s*\|\s*6\s*个/i,
    /默认只启用(?:以下)?\s*6\s*个工具/i,
    /default\s+6\s+tools/i,
    /default\s+enabled_tools\s+count\s+is\s+6/i,
    /default\s+config\s+enables\s+only\s+6\s+tools/i,
    /默认的\s*6\s*个工具/i,
  ].some((pattern) => pattern.test(text));
}

function hasStaleDefaultToolEnabledCount(text) {
  return /["']?default_tools["']?\s*:\s*\{[\s\S]{0,500}?["']?enabled_count["']?\s*:\s*6\b/i.test(text);
}

function hasDefaultEnabledToolsWithJobWait(text) {
  const enabledToolsPattern = /enabled_tools\s*=\s*\[[\s\S]*?\]/g;
  for (const match of text.matchAll(enabledToolsPattern)) {
    if (!/claude_job_wait/.test(match[0])) continue;

    const context = text.slice(Math.max(0, match.index - 400), match.index);
    const defaultContext = /(默认|default|setup --write|print-config|generated config|only\s+6\s+tools)/i.test(context);
    const advancedContext = /(不在默认|not\s+in\s+default|高级|advanced|recovery|调试|手动|额外)/i.test(context);
    if (defaultContext && !advancedContext) return true;
  }

  return false;
}

function hasNextActionsJobWaitRecommendation(text) {
  return /["']?next_actions["']?\s*:\s*\[[\s\S]{0,1200}?["']tool["']\s*:\s*["']claude_job_wait["']/i.test(text);
}

function hasLegacyPollingSemantics(text) {
  return /poll_too_soon|next_allowed_poll_at|remaining_delay_ms|Do not call claude_job_wait again before next_allowed_poll_at|poll this same job_id/i.test(text);
}

function hasAdvancedEnabledToolsWithoutDefaults(text) {
  const enabledToolsPattern = /enabled_tools\s*=\s*\[([\s\S]*?)\]/g;
  const defaultTools = [
    "claude_setup",
    "claude_task",
    "claude_result",
    "claude_apply",
    "claude_cleanup",
  ];
  for (const match of text.matchAll(enabledToolsPattern)) {
    const list = match[1];
    if (!/claude_job_wait|claude_query|claude_review|claude_implement|claude_jobs|claude_workspace_status/.test(list)) continue;
    if (defaultTools.some((tool) => !list.includes(tool))) return true;
  }
  return false;
}

for (const file of files) {
  const text = await readFile(path.join(root, file), "utf8");
  if (hasStaleDefaultToolCount(text)) {
    failures.push(`${file}: mentions stale default 6 tools`);
  }
  if (hasStaleDefaultToolEnabledCount(text)) {
    failures.push(`${file}: mentions stale default tool enabled_count 6`);
  }
  if (hasDefaultEnabledToolsWithJobWait(text)) {
    failures.push(`${file}: default enabled_tools includes claude_job_wait`);
  }
  if (hasNextActionsJobWaitRecommendation(text)) {
    failures.push(`${file}: next_actions recommends claude_job_wait`);
  }
  if (hasLegacyPollingSemantics(text)) {
    failures.push(`${file}: contains legacy polling semantics`);
  }
  if (/Poll claude_job_wait|轮询到终态|普通路径.*claude_job_wait/i.test(text)) {
    failures.push(`${file}: describes claude_job_wait as an ordinary polling path`);
  }
}

const readme = await readFile(path.join(root, "README.md"), "utf8");
for (const phrase of requiredReadmePhrases) {
  if (!readme.includes(phrase)) {
    failures.push(`README.md: missing required phrase "${phrase}"`);
  }
}

const defaultToolMentions = [
  "claude_setup",
  "claude_task",
  "claude_result",
  "claude_apply",
  "claude_cleanup",
];
for (const tool of defaultToolMentions) {
  if (!readme.includes(tool)) {
    failures.push(`README.md: missing default tool ${tool}`);
  }
}

if (hasAdvancedEnabledToolsWithoutDefaults(readme)) {
  failures.push("README.md: advanced enabled_tools example omits default tools");
}

if (!/claude_job_wait[\s\S]{0,80}(高级\/恢复兼容|Advanced \/ Recovery)/.test(readme)) {
  failures.push("README.md: claude_job_wait must be marked Advanced / Recovery");
}

if (failures.length > 0) {
  console.error("doc audit failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`doc audit ok (${files.length} files)`);
