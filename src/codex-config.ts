import { mkdir, readFile, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
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
