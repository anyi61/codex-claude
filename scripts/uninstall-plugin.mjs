#!/usr/bin/env node

/**
 * Uninstall orchestration script for codex-claude-delegate plugin.
 *
 * Phases:
 *   1. scanResources()        – scan marketplace, MCP server, TOML config, state dir, hooks, worktrees
 *   2. phaseRemoveMarketplace() – codex plugin marketplace remove
 *   3. phaseRemoveMcp()         – codex mcp remove claude_delegate
 *   4. phaseCleanTomlRemainders() – re-scan TOML, patch leftovers
 *   5. phaseHandleStateDir()    – .codex-claude-delegate/ handling (3 options)
 *   6. phaseReportWorktrees()    – detect delegated worktrees, only report
 *   7. phaseCleanHooks()         – clean review-gate hook reference
 *   8. printResult()             – summary
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sourceRoot = path.resolve(__dirname, "..");
const repoRoot = process.env.CODEX_UNINSTALL_REPO_ROOT
  ? path.resolve(process.env.CODEX_UNINSTALL_REPO_ROOT)
  : sourceRoot;
const SERVER_NAME = "claude_delegate";
const ALLOW_ROOTS_KEY = "CODEX_CLAUDE_ALLOW_ROOTS";
const STATE_DIR_NAME = ".codex-claude-delegate";

// ---- CLI args ----

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const yesMode = args.includes("--yes");

let keepState = "all";
for (const a of args) {
  const m = a.match(/^--keep-state=(.+)$/);
  if (m) {
    keepState = m[1];
    break;
  }
}

// ---- Results accumulator ----

const results = { success: [], failed: [], skipped: [], manual: [] };

function recordSuccess(phase, msg) { results.success.push({ phase, msg }); }
function recordFailed(phase, msg)  { results.failed.push({ phase, msg }); }
function recordSkipped(phase, msg) { results.skipped.push({ phase, msg }); }
function recordManual(phase, msg)  { results.manual.push({ phase, msg }); }

// ---- Dynamic import of codex-config ----

let scanFn;
let removeAllowRootFn;
let removeOrFlagMcpServerSectionFn;
let removeConfirmedMcpServerSectionFn;

async function loadCodexConfig() {
  if (dryRun) {
    // Dry-run must work in a fresh clone before npm run build has produced dist/.
    scanFn = inlineScan;
  } else {
    const mod = await import(pathToFileURL(path.join(sourceRoot, "dist", "codex-config.js")).href);
    scanFn = mod.scanClaudeDelegateConfig;
    removeAllowRootFn = mod.removeAllowRoot;
    removeOrFlagMcpServerSectionFn = mod.removeOrFlagMcpServerSection;
    removeConfirmedMcpServerSectionFn = mod.removeConfirmedMcpServerSection;
  }
}

// ---- Inline scanning (fallback for dry-run without dist) ----

function codexConfigPath() {
  const codexHome = process.env.CODEX_HOME ?? (process.env.HOME ? path.join(process.env.HOME, ".codex") : "");
  if (!codexHome) throw new Error("Cannot locate Codex config: HOME and CODEX_HOME are both unset.");
  return path.join(codexHome, "config.toml");
}

function inlineReadTableValue(config, tableName, key) {
  const escapedTable = tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tableMatch = config.match(new RegExp(`\\[${escapedTable}\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`));
  if (!tableMatch) return null;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyMatch = tableMatch[1]?.match(new RegExp(`^\\s*${escapedKey}\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"\\s*$`, "m"));
  if (!keyMatch) return null;
  try {
    return JSON.parse(`"${keyMatch[1]}"`) ?? keyMatch[1].replace(/\\"/g, '"');
  } catch {
    return keyMatch[1].replace(/\\"/g, '"');
  }
}

function inlineClassifySection(config) {
  const mainPattern = new RegExp(`^\\s*\\[mcp_servers\\.${SERVER_NAME}\\]\\s*$`, "m");
  const envPattern = new RegExp(`^\\s*\\[mcp_servers\\.${SERVER_NAME}\\.env\\]\\s*$`, "m");
  const hasMain = mainPattern.test(config);
  const hasEnv = envPattern.test(config);
  if (!hasMain && !hasEnv) return null;

  if (hasMain) {
    const cmd = inlineReadTableValue(config, `mcp_servers.${SERVER_NAME}`, "command");
    const bodyMatch = config.match(new RegExp(`\\[mcp_servers\\.${SERVER_NAME}\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`));
    const body = bodyMatch ? bodyMatch[1] : "";
    const pointsToPlugin = /(?:^|["'\s\[])(?:\.\/server\/server\.js|[^"'\s,\]]*codex-claude-delegate\/server\/server\.js)(?=["'\s,\]]|$)/.test(body);
    if (cmd === "node" && pointsToPlugin) return "auto";
    const hasCmd = /^\s*command\s*=/m.test(body);
    const hasArgs = /^\s*args\s*=/m.test(body);
    if (hasCmd || hasArgs) return "manual";
    if (hasEnv) return "env_only";
    return "manual";
  }

  // Only env subsection exists
  if (hasEnv) return "env_only";
  return null;
}

async function inlineScan() {
  const configPath = codexConfigPath();
  let config = "";
  let exists = false;
  try {
    config = readFileSync(configPath, "utf8");
    exists = true;
  } catch {
    return { configPath, exists: false, hasAllowRoots: false, allowRootsValue: null, mcpClassification: null, mcpServerKeys: [], envKeys: [] };
  }

  const origin = inlineClassifySection(config);
  const mcpServerKeys = [];
  const envKeys = [];

  if (origin) {
    const mainBody = config.match(new RegExp(`\\[mcp_servers\\.${SERVER_NAME}\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`));
    if (mainBody) {
      for (const line of mainBody[1].split("\n")) {
        const km = line.match(/^\s*(\w+)\s*=/);
        if (km) mcpServerKeys.push(km[1]);
      }
    }
    const envBody = config.match(new RegExp(`\\[mcp_servers\\.${SERVER_NAME}\\.env\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`));
    if (envBody) {
      for (const line of envBody[1].split("\n")) {
        const km = line.match(/^\s*(\w+)\s*=/);
        if (km) envKeys.push(km[1]);
      }
    }
  }

  const envAllowRoot = inlineReadTableValue(config, `mcp_servers.${SERVER_NAME}.env`, ALLOW_ROOTS_KEY);
  const shellAllowRoot = inlineReadTableValue(config, "shell_environment_policy.set", ALLOW_ROOTS_KEY);
  const allowRootsValue = envAllowRoot ?? shellAllowRoot ?? null;
  const classification = origin ? { origin, hasCommand: mcpServerKeys.includes("command"), hasArgs: mcpServerKeys.includes("args"), hasEnv: !!((origin === "auto" || origin === "env_only" || origin === "manual") && envKeys.length > 0) } : null;

  return { configPath, exists, hasAllowRoots: allowRootsValue !== null, allowRootsValue, mcpClassification: classification, mcpServerKeys, envKeys };
}

// ---- Phases ----

async function scanResources() {
  console.log("\n[scan] Scanning resources...\n");

  // 1. Codex config scan
  const configScan = await scanFn();
  if (configScan.exists) {
    console.log(`  Config:     ${configScan.configPath}`);
    if (configScan.hasAllowRoots) {
      console.log(`  Allow roots: ${configScan.allowRootsValue}`);
    }
    if (configScan.mcpClassification) {
      console.log(`  MCP origin:  ${configScan.mcpClassification.origin}`);
    }
  } else {
    console.log(`  Config:     (not found)`);
  }

  // 2. Marketplace
  let marketplaceName = null;
  try {
    const listOut = execFileSync("codex", ["plugin", "marketplace", "list"], { encoding: "utf8", stdio: "pipe", timeout: 15000 });
    // Try to find our plugin name from output
    const lines = listOut.split("\n").map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.includes("codex-claude") || line.includes("codex_claude")) {
        // Extract the name (first word before whitespace or colon)
        const name = line.split(/[:\s]/)[0].trim();
        if (name) {
          marketplaceName = name;
          break;
        }
      }
    }
  } catch {
    // codex CLI might not be available or no marketplace configured
  }
  console.log(`  Marketplace: ${marketplaceName ?? "(not detected)"}`);

  // 3. State dir
  const stateDir = path.join(repoRoot, STATE_DIR_NAME);
  let stateItems = [];
  if (existsSync(stateDir)) {
    try {
      stateItems = await readdir(stateDir);
    } catch {}
  }
  console.log(`  State dir:   ${stateDir} (${stateItems.length} items)`);
  for (const item of stateItems) {
    console.log(`    - ${item}`);
  }

  // 4. Hooks
  const hookManifest = path.join(repoRoot, "plugins", "codex-claude-delegate", "hooks", "hooks.json");
  const hookInstalled = existsSync(hookManifest);
  console.log(`  Hooks:       ${hookInstalled ? hookManifest : "(not found)"}`);

  // 5. Worktrees
  const worktreesDir = path.join(repoRoot, ".claude", "worktrees");
  let delegatedWorktrees = [];
  if (existsSync(worktreesDir)) {
    try {
      const entries = await readdir(worktreesDir);
      delegatedWorktrees = entries.filter(e => e.startsWith("codex-delegated-"));
    } catch {}
  }
  if (delegatedWorktrees.length > 0) {
    console.log(`  Worktrees:`);
    for (const wt of delegatedWorktrees) {
      console.log(`    - .claude/worktrees/${wt}`);
    }
  } else {
    console.log(`  Worktrees:   (none detected)`);
  }

  return { configScan, marketplaceName, stateDir, stateItems, hookInstalled, delegatedWorktrees };
}

async function phaseRemoveMarketplace(scan) {
  console.log("\n[phase] Removing marketplace entry...");
  if (dryRun) {
    console.log("  (dry-run) would remove marketplace entry");
    recordSkipped("marketplace", "dry-run");
    return;
  }

  if (!scan.marketplaceName) {
    console.log("  Marketplace name not detected. Run 'codex plugin marketplace list' to find the name and remove manually.");
    console.log("  Manual command: codex plugin marketplace remove <name>");
    recordManual("marketplace", "Name not detected. Run manually: codex plugin marketplace remove <name>");
    return;
  }

  try {
    execFileSync("codex", ["plugin", "marketplace", "remove", scan.marketplaceName], { stdio: "pipe", timeout: 15000 });
    console.log(`  Removed marketplace entry: ${scan.marketplaceName}`);
    recordSuccess("marketplace", `Removed ${scan.marketplaceName}`);
  } catch (err) {
    console.log(`  Failed to remove marketplace entry: ${err.message}`);
    console.log(`  Manual command: codex plugin marketplace remove ${scan.marketplaceName}`);
    recordFailed("marketplace", err.message);
    recordManual("marketplace", `codex plugin marketplace remove ${scan.marketplaceName}`);
  }
}

async function phaseRemoveMcp() {
  console.log("\n[phase] Removing MCP server via codex mcp remove...");
  if (dryRun) {
    console.log("  (dry-run) would run: codex mcp remove claude_delegate");
    recordSkipped("mcp-remove", "dry-run");
    return;
  }

  try {
    execFileSync("codex", ["mcp", "remove", "claude_delegate"], { stdio: "pipe", timeout: 15000 });
    console.log("  Ran: codex mcp remove claude_delegate");
    recordSuccess("mcp-remove", "codex mcp remove claude_delegate executed");
  } catch (err) {
    console.log(`  codex mcp remove failed: ${err.message}`);
    recordFailed("mcp-remove", err.message);
  }
}

async function phaseCleanTomlRemainders(scan) {
  console.log("\n[phase] Cleaning TOML remainders...");
  if (dryRun) {
    console.log("  (dry-run) would scan and clean TOML remainders");
    if (scan.configScan.mcpClassification) {
      console.log(`  MCP section origin: ${scan.configScan.mcpClassification.origin}`);
    }
    if (scan.configScan.hasAllowRoots) {
      console.log(`  Allow roots: ${scan.configScan.allowRootsValue}`);
    }
    recordSkipped("toml", "dry-run");
    return;
  }

  // Re-scan to get fresh state
  const freshScan = await scanFn();

  // Handle MCP server section remains
  if (freshScan.mcpClassification) {
    if (freshScan.mcpClassification.origin === "manual") {
      if (yesMode) {
        console.log("  Manual MCP config detected; skipped under --yes mode.");
        console.log("  Remove manually: edit ~/.codex/config.toml and delete [mcp_servers.claude_delegate] section.");
        recordManual("toml-mcp", "Manual MCP config skipped (--yes mode)");
      } else {
        const confirmed = await confirmManualMcpRemoval();
        if (!confirmed) {
          console.log("  Manual MCP config kept by user choice.");
          recordManual("toml-mcp", "Manual MCP config kept by user choice");
        } else if (removeConfirmedMcpServerSectionFn) {
          const result = await removeConfirmedMcpServerSectionFn();
          if (result.changed) {
            console.log(`  ${result.message}`);
            recordSuccess("toml-mcp", result.message);
          } else {
            console.log(`  ${result.message}`);
            recordSkipped("toml-mcp", result.message);
          }
        } else {
          console.log("  codex-config not loaded; cannot remove manual MCP section.");
          recordFailed("toml-mcp", "codex-config not available");
        }
      }
    } else {
      // auto or env_only: clean automatically
      if (removeOrFlagMcpServerSectionFn) {
        const result = await removeOrFlagMcpServerSectionFn();
        if (result.changed) {
          console.log(`  ${result.message}`);
          recordSuccess("toml-mcp", result.message);
        } else {
          console.log(`  ${result.message}`);
          recordSkipped("toml-mcp", result.message);
        }
      } else {
        console.log("  codex-config not loaded; cannot clean TOML MCP section.");
        recordFailed("toml-mcp", "codex-config not available");
      }
    }
  } else {
    console.log("  No MCP server section remainders in TOML.");
    recordSkipped("toml-mcp", "No remainder");
  }

  // Handle allow-roots
  if (freshScan.hasAllowRoots && removeAllowRootFn) {
    try {
      const result = await removeAllowRootFn(repoRoot);
      if (result.changed) {
        console.log(`  ${result.message}`);
        recordSuccess("toml-allow-root", result.message);
      } else {
        console.log(`  Allow roots: ${result.message}`);
        recordSkipped("toml-allow-root", result.message);
      }
    } catch (err) {
      console.log(`  Failed to remove allow root: ${err.message}`);
      recordFailed("toml-allow-root", err.message);
    }
  } else {
    console.log("  No allow-roots remainder for this repo.");
    recordSkipped("toml-allow-root", "None");
  }
}

async function confirmManualMcpRemoval() {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log("  Manual MCP config detected for [mcp_servers.claude_delegate].");
    console.log("  This may have been created by the user rather than the plugin installer.");
    rl.question("  Delete this MCP server section? [y/N]: ", (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}

async function phaseHandleStateDir(scan) {
  console.log("\n[phase] Handling .codex-claude-delegate/ state directory...");
  if (dryRun) {
    if (scan.stateItems.length > 0) {
      console.log(`  (dry-run) state directory has ${scan.stateItems.length} item(s):`);
      for (const item of scan.stateItems) {
        console.log(`    - ${item}`);
      }
    } else {
      console.log("  (dry-run) state directory does not exist or is empty.");
    }
    recordSkipped("state-dir", "dry-run");
    return;
  }

  if (!existsSync(scan.stateDir)) {
    console.log("  State directory does not exist; nothing to clean.");
    recordSkipped("state-dir", "Not found");
    return;
  }

  const itemsToDelete = [];
  let itemsToKeep = [];

  if (yesMode) {
    // --yes mode: default keep all, or respect --keep-state
    if (keepState === "all") {
      console.log("  --yes mode: keeping all state files.");
      recordSkipped("state-dir", "All kept (--yes mode)");
      return;
    } else if (keepState === "none") {
      itemsToDelete.push(...scan.stateItems);
    } else {
      const keepList = keepState.split(",").map(s => s.trim()).filter(Boolean);
      itemsToKeep = keepList;
      const knownFiles = { sessions: "sessions.json", runs: "runs", jobs: "jobs", "review-gate": "review-gate.json" };
      for (const item of scan.stateItems) {
        const isKept = keepList.some(k => knownFiles[k] && item === knownFiles[k]);
        if (!isKept) itemsToDelete.push(item);
      }
    }
  } else {
    // Interactive mode
    const chosen = await interactiveStateDirPrompt(scan.stateItems);
    if (chosen === "all") {
      itemsToDelete.push(...scan.stateItems);
    } else if (chosen === "none") {
      console.log("  Keeping all state files.");
      recordSkipped("state-dir", "All kept by user choice");
      return;
    } else {
      // chosen is an array of items to keep
      itemsToKeep = chosen;
      for (const item of scan.stateItems) {
        if (!chosen.includes(item)) itemsToDelete.push(item);
      }
    }
  }

  // Delete selected items
  for (const item of itemsToDelete) {
    const itemPath = path.join(scan.stateDir, item);
    try {
      await rm(itemPath, { recursive: true, force: true });
      console.log(`  Deleted: ${item}`);
      recordSuccess("state-dir", `Deleted ${item}`);
    } catch (err) {
      console.log(`  Failed to delete ${item}: ${err.message}`);
      recordFailed("state-dir", `Failed to delete ${item}`);
    }
  }

  // If state dir is now empty, remove it
  if (itemsToDelete.length > 0) {
    try {
      const remaining = await readdir(scan.stateDir);
      if (remaining.length === 0) {
        await rm(scan.stateDir, { recursive: true, force: true });
        console.log("  Removed empty state directory.");
        recordSuccess("state-dir", "Removed empty directory");
      }
    } catch {}
  }
}

async function interactiveStateDirPrompt(items) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log(`  How to handle .codex-claude-delegate/ local state?`);
    console.log("  1) Delete all");
    console.log("  2) Keep all (default)");
    console.log("  3) Specify which to keep");
    rl.question("  Choose [1/2/3]: ", (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed === "1") resolve("all");
      else if (trimmed === "3") {
        resolve(promptSpecifyKeep(items));
      } else {
        resolve("none");
      }
    });
  });
}

async function promptSpecifyKeep(items) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const validIds = ["jobs", "runs", "sessions", "review-gate"];
    const fileMap = { jobs: "jobs", runs: "runs", sessions: "sessions.json", "review-gate": "review-gate.json" };
    console.log(`  Valid identifiers: ${validIds.join(", ")}`);
    rl.question("  Enter identifiers to keep (comma-separated): ", (answer) => {
      rl.close();
      const chosen = answer.split(",").map(s => s.trim()).filter(Boolean);
      const resolved = [];
      for (const id of chosen) {
        if (fileMap[id]) resolved.push(fileMap[id]);
      }
      if (resolved.length === 0) {
        console.log("  No valid identifiers entered; keeping all.");
        resolve("none");
      } else {
        resolve(resolved);
      }
    });
  });
}

async function phaseReportWorktrees(scan) {
  console.log("\n[phase] Checking delegated worktrees...");

  if (scan.delegatedWorktrees.length === 0) {
    console.log("  No delegated worktrees found.");
    recordSkipped("worktrees", "None found");
    return;
  }

  console.log(`  Found ${scan.delegatedWorktrees.length} delegated worktree(s):`);
  for (const wt of scan.delegatedWorktrees) {
    console.log(`    .claude/worktrees/${wt}`);
  }
  console.log("  These are not automatically deleted.");
  console.log("  To clean up: run claude_cleanup(cwd=repo, dry_run=true) then claude_cleanup(cwd=repo, dry_run=false).");
  recordManual("worktrees", `${scan.delegatedWorktrees.length} worktree(s) found; manual cleanup required`);

  if (!dryRun) {
    recordSkipped("worktrees", "Reported only, not deleted");
  }
}

async function phaseCleanHooks() {
  console.log("\n[phase] Cleaning review-gate hook references...");

  const hookManifest = path.join(repoRoot, "plugins", "codex-claude-delegate", "hooks", "hooks.json");
  const stateFilePath = path.join(repoRoot, STATE_DIR_NAME, "review-gate.json");

  if (!existsSync(hookManifest) && !existsSync(stateFilePath)) {
    console.log("  No review-gate hook or state found.");
    recordSkipped("hooks", "None found");
    return;
  }

  if (existsSync(stateFilePath)) {
    console.log("  Review-gate state file exists: .codex-claude-delegate/review-gate.json");
    console.log("  (Will be handled by state directory phase)");
  }

  if (existsSync(hookManifest) && !dryRun) {
    console.log("  Hook manifest will be removed when plugin is uninstalled from marketplace.");
    recordSkipped("hooks", "Plugin removal handles hook manifest");
  } else {
    console.log("  No action needed for hooks.");
    recordSkipped("hooks", "No action needed");
  }
}

function printResult() {
  console.log("\n========== Uninstall Summary ==========\n");

  if (results.success.length > 0) {
    console.log("  Successful:");
    for (const r of results.success) {
      console.log(`    ✓ [${r.phase}] ${r.msg}`);
    }
    console.log();
  }

  if (results.failed.length > 0) {
    console.log("  Failed:");
    for (const r of results.failed) {
      console.log(`    ✗ [${r.phase}] ${r.msg}`);
    }
    console.log();
  }

  if (results.skipped.length > 0) {
    console.log("  Skipped:");
    for (const r of results.skipped) {
      console.log(`    - [${r.phase}] ${r.msg}`);
    }
    console.log();
  }

  if (results.manual.length > 0) {
    console.log("  Requires manual attention:");
    for (const r of results.manual) {
      console.log(`    ! [${r.phase}] ${r.msg}`);
    }
    console.log();
  }

  const total = results.success.length + results.failed.length + results.skipped.length + results.manual.length;
  console.log(`  Total: ${total} items`);
  if (results.failed.length > 0) {
    console.log(`  ${results.failed.length} failure(s) – see details above.`);
  }
  console.log("  Recommended: restart Codex after uninstall.");
  console.log("");
}

// ---- Main ----

async function main() {
  console.log(`codex-claude-delegate uninstall ${dryRun ? "(dry-run)" : ""}`);
  console.log(`  repo: ${repoRoot}`);
  console.log(`  options: ${dryRun ? "--dry-run " : ""}${yesMode ? "--yes " : ""}--keep-state=${keepState}`);
  console.log("");

  await loadCodexConfig();
  const scan = await scanResources();
  await phaseRemoveMarketplace(scan);
  await phaseRemoveMcp(scan);
  await phaseCleanTomlRemainders(scan);
  await phaseHandleStateDir(scan);
  await phaseReportWorktrees(scan);
  await phaseCleanHooks(scan);
  printResult();
}

main().catch((err) => {
  console.error("Uninstall failed:", err);
  process.exit(1);
});
