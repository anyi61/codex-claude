import { mkdir, readFile, writeFile, cp, realpath } from "node:fs/promises";
import path from "node:path";

import { dangerousRoot, getAllowRoots } from "./guard.js";

const SERVER_NAME = "claude_delegate";
const ALLOW_ROOTS_KEY = "CODEX_CLAUDE_ALLOW_ROOTS";
const SHELL_ENV_TABLE = "shell_environment_policy.set";

export interface CodexAllowRootConfiguration {
  config_path: string;
  changed: boolean;
  allow_roots: string[];
  env_value: string;
  message: string;
}

function codexConfigPath(): string {
  const codexHome = process.env.CODEX_HOME ?? (process.env.HOME ? path.join(process.env.HOME, ".codex") : "");
  if (!codexHome) throw new Error("Cannot locate Codex config: HOME and CODEX_HOME are both unset.");
  return path.join(codexHome, "config.toml");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function splitAllowRootsValue(value: string): string[] {
  const delimiterPattern = path.delimiter === ";" ? /[;,]/g : /[:,]/g;
  return value.split(delimiterPattern).map((part) => part.trim()).filter(Boolean);
}

function uniqueRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const root of roots) {
    if (!seen.has(root)) {
      seen.add(root);
      result.push(root);
    }
  }
  return result;
}

function updateTomlTableValue(config: string, tableName: string, key: string, value: string): string {
  const assignment = `${key} = ${tomlString(value)}`;
  const escapedTable = tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tablePattern = new RegExp(`(\\[${escapedTable}\\]\\n)([\\s\\S]*?)(?=\\n\\[|$)`);
  const match = config.match(tablePattern);
  if (!match) {
    const needsNewline = config.length > 0 && !config.endsWith("\n");
    return `${config}${needsNewline ? "\n" : ""}\n[${tableName}]\n${assignment}\n`;
  }

  const body = match[2] ?? "";
  const nextBody = body.match(new RegExp(`^\\s*${escapedKey}\\s*=`, "m"))
    ? body.replace(new RegExp(`^\\s*${escapedKey}\\s*=.*$`, "m"), assignment)
    : `${body}${body.endsWith("\n") || body.length === 0 ? "" : "\n"}${assignment}\n`;
  return config.replace(tablePattern, `${match[1]}${nextBody}`);
}

function hasManualMcpServerTable(config: string): boolean {
  return new RegExp(`^\\s*\\[mcp_servers\\.${SERVER_NAME}\\]\\s*$`, "m").test(config);
}

function updateEnvTable(config: string, envValue: string): string {
  return updateTomlTableValue(config, `mcp_servers.${SERVER_NAME}.env`, ALLOW_ROOTS_KEY, envValue);
}

function updateShellEnvTable(config: string, envValue: string): string {
  return updateTomlTableValue(config, SHELL_ENV_TABLE, ALLOW_ROOTS_KEY, envValue);
}

function readTableValue(config: string, tableName: string, key: string): string | null {
  const escapedTable = tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tableMatch = config.match(new RegExp(`\\[${escapedTable}\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`));
  if (!tableMatch) return null;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyMatch = tableMatch[1]?.match(new RegExp(`^\\s*${escapedKey}\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"\\s*$`, "m"));
  if (!keyMatch) return null;
  try {
    return JSON.parse(`"${keyMatch[1]}"`) as string;
  } catch {
    return keyMatch[1].replace(/\\"/g, "\"");
  }
}

/** Read the string values from a TOML array (e.g. `enabled_tools = ["a", "b"]`). */
function readTableArrayValues(config: string, tableName: string, key: string): string[] | null {
  const escapedTable = tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tableMatch = config.match(new RegExp(`\\[${escapedTable}\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`));
  if (!tableMatch) return null;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const arrayMatch = tableMatch[1]?.match(new RegExp(`^\\s*${escapedKey}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*$`, "m"));
  if (!arrayMatch) return null;
  const values: string[] = [];
  const stringMatches = arrayMatch[1].matchAll(/"((?:\\"|[^"])*)"/g);
  for (const m of stringMatches) {
    values.push(m[1]);
  }
  return values;
}

function removeEnvOnlyTable(config: string): string {
  if (hasManualMcpServerTable(config)) return config;
  return config.replace(new RegExp(`\\n?\\[mcp_servers\\.${SERVER_NAME}\\.env\\]\\n[\\s\\S]*?(?=\\n\\[|$)`), "");
}

function updateAllowRootsConfig(config: string, envValue: string): string {
  if (hasManualMcpServerTable(config)) {
    return updateEnvTable(config, envValue);
  }
  const cleaned = removeEnvOnlyTable(config);
  return updateShellEnvTable(cleaned, envValue);
}

function readConfiguredAllowRoots(config: string): string | null {
  return (
    readTableValue(config, `mcp_servers.${SERVER_NAME}.env`, ALLOW_ROOTS_KEY)
    ?? readTableValue(config, SHELL_ENV_TABLE, ALLOW_ROOTS_KEY)
  );
}

// =============== Uninstall support: pure functions ===============

/** Classification of an MCP server section in TOML config */
export interface McpServerClassification {
  origin: "auto" | "env_only" | "manual";
  hasCommand: boolean;
  hasArgs: boolean;
  hasEnv: boolean;
}

/**
 * Remove a resolved path from a delimiter-separated allow-roots value.
 * Returns null when the result would be empty, the original value when
 * nothing changed, or the new joined string.
 */
export function removePathFromAllowRootsValue(
  currentValue: string,
  pathToRemove: string,
  delimiter: string,
): string | null {
  const normalizedToRemove = path.resolve(pathToRemove);
  const parts = currentValue.split(delimiter).map((p) => p.trim()).filter(Boolean);
  const remaining = parts.filter((p) => {
    try {
      return path.resolve(p) !== normalizedToRemove;
    } catch {
      return true; // keep unparsable paths
    }
  });
  if (remaining.length === 0) return null;
  if (remaining.length === parts.length) return currentValue;
  return remaining.join(delimiter);
}

/** Extract the raw text content of a TOML table body. */
function getTableContent(config: string, tableName: string): string | null {
  const escapedTable = tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = config.match(new RegExp(`\\[${escapedTable}\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`));
  return match ? match[1] : null;
}

/**
 * Delete a key assignment line from a TOML table section.
 * Does not remove the table header or other keys.
 */
export function deleteTomlTableKey(config: string, tableName: string, key: string): string {
  const escapedTable = tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tablePattern = new RegExp(`(\\[${escapedTable}\\]\\n)([\\s\\S]*?)(?=\\n\\[|$)`);
  return config.replace(tablePattern, (_match, header, body) => {
    const newBody = body.replace(new RegExp(`^[ \\t]*${escapedKey}\\s*=.*\\n?`, "m"), "");
    return `${header}${newBody}`;
  });
}

/** Read the list of key names defined in a TOML table. */
export function readTableKeys(config: string, tableName: string): string[] {
  const content = getTableContent(config, tableName);
  if (!content) return [];
  const keyMatches = content.matchAll(/^\s*(\w+)\s*=/gm);
  return [...keyMatches].map((m) => m[1]);
}

/**
 * Classify the `[mcp_servers.claude_delegate]` section in a TOML config:
 * - "auto": command="node" and args point to this plugin's server script.
 * - "env_only": only an `.env` subsection exists, no command/args.
 * - "manual": anything else (custom command, different args, etc.).
 * Returns null when no claude_delegate MCP section exists.
 */
export function classifyMcpServerSection(config: string): McpServerClassification | null {
  const mainTablePattern = new RegExp(`^\\s*\\[mcp_servers\\.${SERVER_NAME}\\]\\s*$`, "m");
  const envTablePattern = new RegExp(`^\\s*\\[mcp_servers\\.${SERVER_NAME}\\.env\\]\\s*$`, "m");
  const hasMain = mainTablePattern.test(config);
  const hasEnv = envTablePattern.test(config);
  if (!hasMain && !hasEnv) return null;

  let hasCommand = false;
  let hasArgs = false;
  if (hasMain) {
    const mainContent = getTableContent(config, `mcp_servers.${SERVER_NAME}`);
    if (mainContent) {
      hasCommand = /^\s*command\s*=/m.test(mainContent);
      hasArgs = /^\s*args\s*=/m.test(mainContent);
    }
  }

  const command = hasMain ? readTableValue(config, `mcp_servers.${SERVER_NAME}`, "command") : null;
  const isNodeCommand = command === "node";
  const mainContent = hasMain ? getTableContent(config, `mcp_servers.${SERVER_NAME}`) : "";
  const pointsToPlugin = /(?:^|["'\s\[])(?:\.\/server\/server\.js|[^"'\s,\]]*codex-claude-delegate\/server\/server\.js)(?=["'\s,\]]|$)/.test(mainContent ?? "");

  let origin: "auto" | "env_only" | "manual";
  if (isNodeCommand && pointsToPlugin) {
    origin = "auto";
  } else if (!hasCommand && !hasArgs && hasEnv) {
    origin = "env_only";
  } else {
    origin = "manual";
  }

  return { origin, hasCommand, hasArgs, hasEnv };
}

// =============== Uninstall support: IO functions ===============

export interface ClaudeDelegateConfigScan {
  configPath: string;
  exists: boolean;
  hasAllowRoots: boolean;
  allowRootsValue: string | null;
  mcpClassification: McpServerClassification | null;
  mcpServerKeys: string[];
  envKeys: string[];
  mcpCommand: string | null;
  mcpEnabledTools: string[] | null;
}

/**
 * Read-only scan of ~/.codex/config.toml for claude_delegate related configuration.
 * Returns an empty result when the config file does not exist (never throws).
 */
export async function scanClaudeDelegateConfig(): Promise<ClaudeDelegateConfigScan> {
  const configPath = codexConfigPath();
  let config = "";
  let exists = false;
  try {
    config = await readFile(configPath, "utf8");
    exists = true;
  } catch {
    return { configPath, exists: false, hasAllowRoots: false, allowRootsValue: null, mcpClassification: null, mcpServerKeys: [], envKeys: [], mcpCommand: null, mcpEnabledTools: null };
  }

  const classification = classifyMcpServerSection(config);
  const mcpServerKeys = classification ? readTableKeys(config, `mcp_servers.${SERVER_NAME}`) : [];
  const envKeys = (classification?.hasEnv ?? false) ? readTableKeys(config, `mcp_servers.${SERVER_NAME}.env`) : [];

  const envAllowRoot = readTableValue(config, `mcp_servers.${SERVER_NAME}.env`, ALLOW_ROOTS_KEY);
  const shellAllowRoot = readTableValue(config, SHELL_ENV_TABLE, ALLOW_ROOTS_KEY);
  const allowRootsValue = envAllowRoot ?? shellAllowRoot ?? null;
  const mcpCommand = classification ? readTableValue(config, `mcp_servers.${SERVER_NAME}`, "command") : null;
  const mcpEnabledTools = classification ? readTableArrayValues(config, `mcp_servers.${SERVER_NAME}`, "enabled_tools") : null;
  return { configPath, exists, hasAllowRoots: allowRootsValue !== null, allowRootsValue, mcpClassification: classification, mcpServerKeys, envKeys, mcpCommand, mcpEnabledTools };
}

export interface RemoveAllowRootResult {
  configPath: string;
  changed: boolean;
  message: string;
}

/**
 * Remove the given cwd from CODEX_CLAUDE_ALLOW_ROWS in the TOML config.
 * Only operates on `CODEX_CLAUDE_ALLOW_ROOTS`; preserves other keys in the same table.
 * Idempotent: returns changed=false when the path is already absent.
 */
export async function removeAllowRoot(cwd: string): Promise<RemoveAllowRootResult> {
  const configPath = codexConfigPath();
  let config = "";
  try {
    config = await readFile(configPath, "utf8");
  } catch {
    return { configPath, changed: false, message: "Config file not found." };
  }

  // Use path.resolve (not realpath) to avoid symlink resolution differences
  // (e.g. /var → /private/var on macOS).
  const resolved = path.resolve(cwd);

  let currentValue: string | null = null;
  let sourceTable: string | null = null;

  const envValue = readTableValue(config, `mcp_servers.${SERVER_NAME}.env`, ALLOW_ROOTS_KEY);
  if (envValue !== null) {
    currentValue = envValue;
    sourceTable = `mcp_servers.${SERVER_NAME}.env`;
  } else {
    const shellValue = readTableValue(config, SHELL_ENV_TABLE, ALLOW_ROOTS_KEY);
    if (shellValue !== null) {
      currentValue = shellValue;
      sourceTable = SHELL_ENV_TABLE;
    }
  }

  if (currentValue === null || sourceTable === null) {
    return { configPath, changed: false, message: `${ALLOW_ROOTS_KEY} not found in config.` };
  }

  const delimiter = currentValue.includes(path.delimiter)
    ? path.delimiter
    : currentValue.includes(",")
      ? ","
      : path.delimiter;
  const newValue = removePathFromAllowRootsValue(currentValue, resolved, delimiter);

  if (newValue === currentValue) {
    return { configPath, changed: false, message: `Path ${resolved} not found in ${ALLOW_ROOTS_KEY}.` };
  }

  if (newValue === null) {
    config = deleteTomlTableKey(config, sourceTable, ALLOW_ROOTS_KEY);
  } else {
    config = updateTomlTableValue(config, sourceTable, ALLOW_ROOTS_KEY, newValue);
  }

  await writeFile(configPath, config, "utf8");
  return { configPath, changed: true, message: `Removed ${resolved} from ${ALLOW_ROOTS_KEY}.` };
}

export interface RemoveMcpServerResult {
  configPath: string;
  changed: boolean;
  action: "deleted" | "env_deleted" | "manual_skip" | "not_found";
  message: string;
}

function removeMcpServerTables(config: string): string {
  let modified = config;
  const envPattern = new RegExp(`\\n?\\[mcp_servers\\.${SERVER_NAME}\\.env\\]\\n[\\s\\S]*?(?=\\n\\[|$)`);
  modified = modified.replace(envPattern, "");
  const mainPattern = new RegExp(`\\n?\\[mcp_servers\\.${SERVER_NAME}\\]\\n[\\s\\S]*?(?=\\n\\[|$)`);
  return modified.replace(mainPattern, "");
}

/**
 * Remove or flag the `[mcp_servers.claude_delegate]` section:
 * - "auto": delete the entire section (including .env subsection).
 * - "env_only": delete .env subsection; also removes empty parent header.
 * - "manual": no-op, returns manual_skip for caller to decide.
 */
export async function removeOrFlagMcpServerSection(): Promise<RemoveMcpServerResult> {
  const configPath = codexConfigPath();
  let config = "";
  try {
    config = await readFile(configPath, "utf8");
  } catch {
    return { configPath, changed: false, action: "not_found", message: "Config file not found." };
  }

  const classification = classifyMcpServerSection(config);
  if (!classification) {
    return { configPath, changed: false, action: "not_found", message: `[mcp_servers.${SERVER_NAME}] not found in config.` };
  }

  if (classification.origin === "manual") {
    return { configPath, changed: false, action: "manual_skip", message: `[mcp_servers.${SERVER_NAME}] appears manually configured; skipped.` };
  }

  if (classification.origin === "auto") {
    const modified = removeMcpServerTables(config);
    if (modified !== config) {
      await writeFile(configPath, modified, "utf8");
    }
    return { configPath, changed: modified !== config, action: "deleted", message: `Deleted [mcp_servers.${SERVER_NAME}] section.` };
  }

  // env_only: remove the .env subsection, then clean up empty parent
  let modified = config;
  const envPattern = new RegExp(`\\n?\\[mcp_servers\\.${SERVER_NAME}\\.env\\]\\n[\\s\\S]*?(?=\\n\\[|$)`, "m");
  modified = modified.replace(envPattern, "");
  const mainContent = getTableContent(modified, `mcp_servers.${SERVER_NAME}`);
  if (mainContent !== null && mainContent.trim() === "") {
    modified = modified.replace(new RegExp(`\\n?\\[mcp_servers\\.${SERVER_NAME}\\]\\n?`), "");
  }
  if (modified !== config) {
    await writeFile(configPath, modified, "utf8");
  }
  return { configPath, changed: modified !== config, action: "env_deleted", message: `Deleted [mcp_servers.${SERVER_NAME}.env] section.` };
}

/**
 * Remove the claude_delegate MCP section after an explicit user confirmation.
 * This is intentionally separate from removeOrFlagMcpServerSection so --yes
 * mode can keep manual MCP config fail-closed.
 */
export async function removeConfirmedMcpServerSection(): Promise<RemoveMcpServerResult> {
  const configPath = codexConfigPath();
  let config = "";
  try {
    config = await readFile(configPath, "utf8");
  } catch {
    return { configPath, changed: false, action: "not_found", message: "Config file not found." };
  }

  const classification = classifyMcpServerSection(config);
  if (!classification) {
    return { configPath, changed: false, action: "not_found", message: `[mcp_servers.${SERVER_NAME}] not found in config.` };
  }

  const modified = removeMcpServerTables(config);
  if (modified !== config) {
    await writeFile(configPath, modified, "utf8");
  }
  return { configPath, changed: modified !== config, action: "deleted", message: `Deleted [mcp_servers.${SERVER_NAME}] section after user confirmation.` };
}

export async function configureCodexAllowRoot(rawCwd: string): Promise<CodexAllowRootConfiguration> {
  let resolved: string;
  try {
    resolved = await realpath(rawCwd);
  } catch {
    throw new Error(`Cannot configure allow root because path does not exist: ${rawCwd}`);
  }
  if (dangerousRoot(rawCwd) || dangerousRoot(resolved)) {
    throw new Error(`Refusing to configure dangerous allow root: ${resolved}`);
  }

  const configPath = codexConfigPath();
  await mkdir(path.dirname(configPath), { recursive: true });
  let config = "";
  try {
    config = await readFile(configPath, "utf8");
  } catch {}

  const existingValue = readConfiguredAllowRoots(config);
  const configuredRoots = existingValue ? splitAllowRootsValue(existingValue) : getAllowRoots();
  const allowRoots = uniqueRoots([...configuredRoots, resolved]);
  const envValue = allowRoots.join(path.delimiter);
  const nextConfig = updateAllowRootsConfig(config, envValue);
  const changed = nextConfig !== config;

  if (changed) {
    await writeFile(configPath, nextConfig, "utf8");
  }
  process.env.CODEX_CLAUDE_ALLOW_ROOTS = envValue;

  return {
    config_path: configPath,
    changed,
    allow_roots: allowRoots,
    env_value: envValue,
    message: changed
      ? `Added ${resolved} to ${ALLOW_ROOTS_KEY} for ${SERVER_NAME}.`
      : `${resolved} is already present in ${ALLOW_ROOTS_KEY} for ${SERVER_NAME}.`,
  };
}

// =============== NPM global setup config helpers ===============

export const DEFAULT_ENABLED_TOOLS = [
  "claude_setup",
  "claude_task",
  "claude_job_wait",
  "claude_result",
  "claude_apply",
  "claude_cleanup",
] as const;

export interface SetupConfigOptions {
  force?: boolean;
}

export interface SetupConfigResult {
  changed: boolean;
  existed: boolean;
  content: string;
  message: string;
}

export function renderClaudeDelegateMcpConfig(): string {
  const tools = DEFAULT_ENABLED_TOOLS.map((tool) => `  "${tool}"`).join(",\n");
  return `[mcp_servers.claude_delegate]\ncommand = "codex-claude"\nstartup_timeout_sec = 20\ntool_timeout_sec = 600\nenabled_tools = [\n${tools}\n]\n`;
}

export function upsertClaudeDelegateMcpServer(config: string, options: SetupConfigOptions = {}): SetupConfigResult {
  const hasServer = /^\s*\[mcp_servers\.claude_delegate\]\s*$/m.test(config);
  if (hasServer && !options.force) {
    return { changed: false, existed: true, content: config, message: "Existing MCP server found: claude_delegate" };
  }
  const nextSection = renderClaudeDelegateMcpConfig();
  if (!hasServer) {
    const separator = config.length > 0 && !config.endsWith("\n") ? "\n\n" : config.length > 0 ? "\n" : "";
    return { changed: true, existed: false, content: `${config}${separator}${nextSection}`, message: "Added MCP server: claude_delegate" };
  }
  const tablePattern = /^\s*\[mcp_servers\.claude_delegate\]\s*\n[\s\S]*?(?=^\s*\[|$(?![\s\S]))/m;
  return { changed: true, existed: true, content: config.replace(tablePattern, nextSection), message: "Replaced MCP server config: claude_delegate" };
}

export interface SetupWriteOptions {
  isProject?: boolean;
  force?: boolean;
  allowRoot?: string;
}

export interface SetupWriteResult {
  exitCode: number;
  message: string;
}

export async function setupWrite(options: SetupWriteOptions = {}): Promise<SetupWriteResult> {
  const configDir = options.isProject
    ? path.join(process.cwd(), ".codex")
    : process.env.CODEX_HOME
      ? path.join(process.env.CODEX_HOME)
      : path.join(process.env.HOME ?? "/tmp", ".codex");
  const configPath = path.join(configDir, "config.toml");

  await mkdir(configDir, { recursive: true });

  let config = "";
  let configExisted = false;
  try {
    config = await readFile(configPath, "utf8");
    configExisted = true;
  } catch {
    config = "";
  }

  if (options.force && configExisted) {
    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
    const backupPath = `${configPath}.bak-${ts}`;
    await cp(configPath, backupPath);
  }

  const upsertResult = upsertClaudeDelegateMcpServer(config, { force: options.force });
  let message = upsertResult.message;

  if (upsertResult.changed) {
    await writeFile(configPath, upsertResult.content, "utf8");
  }

  if (options.allowRoot) {
    try {
      const allowResult = await configureCodexAllowRoot(options.allowRoot);
      message += `\n${allowResult.message}`;
    } catch (err) {
      return { exitCode: 1, message: `${message}\nError: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return { exitCode: 0, message };
}
