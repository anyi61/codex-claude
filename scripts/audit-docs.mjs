#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const checkedRoots = [
  "README.md",
  "CONTRIBUTING.md",
  "docs/advanced-tools.md",
  "docs/configuration-reference.md",
  "docs/workflows.md",
  "docs/uninstall-execution-checklist.md",
  "docs/product",
  "plugins/codex-claude-delegate/skills",
  "plugins/codex-claude-delegate/.codex-plugin/plugin.json",
];

const requiredReadmePhrases = [
  "非官方项目",
  "`codex-claude doctor` 通过后，应满足",
  "One Message To Codex",
  "instruction_files vs `files`",
  "security_profile=\"default\"",
  "claude_task(job_id=...)",
];

async function listFiles(target) {
  const absolute = path.join(root, target);
  const info = await stat(absolute).catch(() => null);
  if (!info) return [];
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
  const enabledToolsPattern = /(?<!`)enabled_tools\s*=\s*\[[\s\S]*?\]/g;
  for (const match of text.matchAll(enabledToolsPattern)) {
    if (!/claude_job_wait/.test(match[0])) continue;

    const context = text.slice(Math.max(0, match.index - 400), match.index);
    const defaultContext = /(默认|default|setup --write|print-config|generated config|only\s+6\s+tools)/i.test(context);
    const advancedContext = /(不在默认|not\s+in\s+default|高级|advanced|recovery|调试|手动|额外|高级\/恢复)/i.test(context);
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
  const enabledToolsPattern = /(?<!`)enabled_tools\s*=\s*\[([\s\S]*?)\]/g;
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

function isDefaultEnabledToolsContext(text, index) {
  const before = text.slice(Math.max(0, index - 400), index);
  const blockLineStart = text.lastIndexOf("\n", index) + 1;
  const line = text.slice(blockLineStart, text.indexOf("\n", index) === -1 ? text.length : text.indexOf("\n", index));
  if (/^\s*\|/.test(line)) return false;
  if (/(不在默认|not\s+in\s+default|高级|advanced|recovery|调试|手动|额外|高级\/恢复)/i.test(before)) return false;
  return /(默认|default|setup\s+--write|print-config)/i.test(before);
}

function findUnknownBacktickedTools(text, knownTools) {
  const knownServerNames = new Set(["claude_delegate"]);
  const unknown = new Set();
  for (const match of text.matchAll(/`(claude_[a-z_]+)`/g)) {
    const name = match[1];
    if (knownServerNames.has(name)) continue;
    if (!knownTools.includes(name)) unknown.add(name);
  }
  return [...unknown];
}

function hasClaudeApplyContradiction(text) {
  const sentences = text.split(/(?<=[.!?。！？\n])\s*/);
  for (const sentence of sentences) {
    if (!/\bclaude_apply\b/.test(sentence)) continue;
    if (/^\s*\|/.test(sentence) || /\|.*\|.*\|/.test(sentence)) continue;
    if (/(?:preview|预览)[^.!?。！？\n]*(?:not|不)[^.!?。！？\n]*(?:modif|修改|change|变更)/i.test(sentence)) continue;
    if (/(?:not|不)[^.!?。！？\n]*(?:modif|修改|change|变更)[^.!?。！？\n]*(?:preview|预览)/i.test(sentence)) continue;
    if (/confirmed_by_user|confirm|approval|批准|确认/i.test(sentence)) continue;
    const directClaim = /`?claude_apply`?[^|.。!?！？\n]{0,80}(read.only|non.destructive|safe|not[^|.。!?！？\n]*destructive|只读|不[^|.。!?！？\n]*修改|无[^|.。!?！？\n]*副作用)/i.test(sentence);
    const reverseClaim = /(read.only|non.destructive|safe|not[^|.。!?！？\n]*destructive|只读|不[^|.。!?！？\n]*修改|无[^|.。!?！？\n]*副作用)[^|.。!?！？\n]{0,80}`?claude_apply`?/i.test(sentence);
    if (directClaim || reverseClaim) return true;
  }
  return false;
}

// ── Manifest extraction helpers ──

function extractBaseToolNames(text) {
  const names = [];
  for (const m of text.matchAll(/name:\s*"([^"]+)"/g)) {
    if (m[1].startsWith("claude_")) names.push(m[1]);
  }
  return names;
}

function extractDefaultEnabledTools(text) {
  const block = text.match(/DEFAULT_ENABLED_TOOLS\s*=\s*\[([\s\S]*?)\]/);
  if (!block) return [];
  const tools = [];
  for (const m of block[1].matchAll(/"([^"]+)"/g)) tools.push(m[1]);
  return tools;
}

function extractClaudeApplyMetadata(text) {
  const block = text.match(/claude_apply:\s*\{[\s\S]*?annotations:\s*\{([^}]+)\}/);
  if (!block) return null;
  const hints = {};
  for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"]) {
    const m = block[1].match(new RegExp(hint + ":\\s*(true|false)"));
    if (m) hints[hint] = m[1] === "true";
  }
  return Object.keys(hints).length > 0 ? hints : null;
}

function extractPreviewTokenSchema(text) {
  const m = text.match(/preview_token:.*?\.regex\(\/(.*?)\/[gimsuy]*/);
  return m ? { regex: m[1] } : null;
}

async function extractVersions() {
  const versionFiles = [
    "package.json",
    "plugins/codex-claude-delegate/.codex-plugin/plugin.json",
    "plugins/codex-claude-delegate/.claude-plugin/plugin.json",
  ];
  const versions = {};
  for (const file of versionFiles) {
    try {
      const raw = await readFile(path.join(root, file), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.version) versions[file] = parsed.version;
    } catch {}
  }
  return versions;
}

function extractDocEnabledCount(text) {
  const enabledCountMatch = text.match(/enabled_count['":\s]*:\s*['"]?(\d+)/);
  if (enabledCountMatch) return parseInt(enabledCountMatch[1], 10);
  return null;
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

// ── Manifest-based consistency checks ──

const serverSrc = await readFile(path.join(root, "src/server.ts"), "utf8").catch(() => null);
const configSrc = await readFile(path.join(root, "src/codex-config.ts"), "utf8").catch(() => null);
const schemaSrc = await readFile(path.join(root, "src/schema.ts"), "utf8").catch(() => null);

const manifest = {
  baseToolNames: serverSrc ? extractBaseToolNames(serverSrc) : [],
  defaultEnabledTools: configSrc ? extractDefaultEnabledTools(configSrc) : [],
  claudeApplyMetadata: serverSrc ? extractClaudeApplyMetadata(serverSrc) : null,
  previewTokenSchema: schemaSrc ? extractPreviewTokenSchema(schemaSrc) : null,
  versions: await extractVersions(),
};

const sourceAvailable = serverSrc || configSrc || schemaSrc;

if (sourceAvailable) {
  const sourceToolCount = manifest.defaultEnabledTools.length;

  for (const file of files) {
    const text = await readFile(path.join(root, file), "utf8");

    // Check 1: default tool count claims must match source
    if (sourceToolCount > 0) {
      const docCount = extractDocEnabledCount(text);
      if (docCount !== null && docCount !== sourceToolCount) {
        failures.push(`${file}: doc claims enabled count ${docCount} but source has ${sourceToolCount}`);
      }
    }

    // Check 2: default-context enabled_tools must match DEFAULT_ENABLED_TOOLS and not include claude_job_wait
    if (manifest.defaultEnabledTools.length > 0) {
      const enabledToolsPattern = /(?<!`)enabled_tools\s*=\s*\[[\s\S]*?\]/g;
      for (const match of text.matchAll(enabledToolsPattern)) {
        const block = match[0];
        if (!isDefaultEnabledToolsContext(text, match.index)) continue;
        for (const tool of manifest.defaultEnabledTools) {
          if (!block.includes(tool)) {
            failures.push(`${file}: default-context enabled_tools missing ${tool}`);
          }
        }
        if (/claude_job_wait/.test(block)) {
          failures.push(`${file}: default-context enabled_tools includes claude_job_wait`);
        }
      }
    }

    // Check 3: README unknown claude_* tool names
    if (manifest.baseToolNames.length > 0 && file === "README.md") {
      for (const tool of findUnknownBacktickedTools(readme, manifest.baseToolNames)) {
        failures.push(`README.md: mentions unknown tool ${tool} not in BASE_TOOL_DEFINITIONS`);
      }
    }

    // Check 4: claude_apply docs must not contradict metadata
    if (
      /\bclaude_apply\b/.test(text)
      && hasClaudeApplyContradiction(text)
      && manifest.claudeApplyMetadata
      && !manifest.claudeApplyMetadata.readOnlyHint
      && manifest.claudeApplyMetadata.destructiveHint
    ) {
      failures.push(`${file}: claude_apply described as read-only/safe but metadata marks it destructive`);
    }

    // Check 5: preview_token format
    if (/\bpreview_token\b/.test(text)) {
      if (/64\s*bytes|64\s*字节|32[\s-]*char/i.test(text)) {
        failures.push(`${file}: preview_token claims 64 bytes or 32 chars`);
      }
    }
  }

  // Verify preview_token schema regex uses lowercase hex
  if (manifest.previewTokenSchema) {
    const has64LowerHex = manifest.previewTokenSchema.regex.includes("a-f0-9") || manifest.previewTokenSchema.regex.includes("a-f\\d");
    if (!has64LowerHex) {
      failures.push("src/schema.ts: preview_token regex does not require lowercase hex");
    }
  }
}

// Check version consistency
const versionEntries = Object.entries(manifest.versions);
if (versionEntries.length > 1) {
  const distinct = new Set(versionEntries.map(([, v]) => v));
  if (distinct.size > 1) {
    const parts = versionEntries.map(([f, v]) => `${f}=${v}`).join(", ");
    failures.push(`version mismatch: ${parts}`);
  }
}

// Check advanced tools in the advanced-tools reference. README only needs to
// link to that reference so the user entry point can stay concise.
if (manifest.baseToolNames.length > 0) {
  if (!readme.includes("docs/advanced-tools.md")) {
    failures.push("README.md: missing link to advanced tool documentation");
  }
  const advancedTools = await readFile(path.join(root, "docs/advanced-tools.md"), "utf8").catch(() => "");
  const advancedToolMentions = advancedTools.match(/\bclaude_[a-z_]+\b/g) || [];
  const missingAdvanced = manifest.baseToolNames.filter(
    (tool) => !advancedToolMentions.includes(tool),
  );
  if (missingAdvanced.length > 0) {
    failures.push(`docs/advanced-tools.md: missing advanced tool documentation: ${missingAdvanced.join(", ")}`);
  }
}

if (failures.length > 0) {
  console.error("doc audit failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`doc audit ok (${files.length} files)`);
