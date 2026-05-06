import { mkdir, readFile, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { dangerousRoot, getAllowRoots } from "./guard.js";

const SERVER_NAME = "claude_delegate";
const ALLOW_ROOTS_KEY = "CODEX_CLAUDE_ALLOW_ROOTS";

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

function parseTomlStringValue(line: string): string | null {
  const match = line.match(/^\s*CODEX_CLAUDE_ALLOW_ROOTS\s*=\s*"((?:\\"|[^"])*)"\s*$/m);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1].replace(/\\"/g, "\"");
  }
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

function updateEnvTable(config: string, envValue: string): string {
  const assignment = `${ALLOW_ROOTS_KEY} = ${tomlString(envValue)}`;
  const tablePattern = new RegExp(`(\\[mcp_servers\\.${SERVER_NAME}\\.env\\]\\n)([\\s\\S]*?)(?=\\n\\[|$)`);
  const match = config.match(tablePattern);
  if (!match) {
    const needsNewline = config.length > 0 && !config.endsWith("\n");
    return `${config}${needsNewline ? "\n" : ""}\n[mcp_servers.${SERVER_NAME}.env]\n${assignment}\n`;
  }

  const body = match[2] ?? "";
  const nextBody = body.match(new RegExp(`^\\s*${ALLOW_ROOTS_KEY}\\s*=`, "m"))
    ? body.replace(new RegExp(`^\\s*${ALLOW_ROOTS_KEY}\\s*=.*$`, "m"), assignment)
    : `${body}${body.endsWith("\n") || body.length === 0 ? "" : "\n"}${assignment}\n`;
  return config.replace(tablePattern, `${match[1]}${nextBody}`);
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

  const existingMatch = config.match(new RegExp(`\\[mcp_servers\\.${SERVER_NAME}\\.env\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`));
  const existingValue = existingMatch ? parseTomlStringValue(existingMatch[1] ?? "") : null;
  const configuredRoots = existingValue ? splitAllowRootsValue(existingValue) : getAllowRoots();
  const allowRoots = uniqueRoots([...configuredRoots, resolved]);
  const envValue = allowRoots.join(path.delimiter);
  const nextConfig = updateEnvTable(config, envValue);
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
