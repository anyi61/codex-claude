#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";

import { getPackageInfo } from "./package-info.js";
import { main as startMcpServer } from "./server.js";
import { DEFAULT_ENABLED_TOOLS, renderClaudeDelegateMcpConfig } from "./codex-config.js";

export interface CliDependencies {
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
  startMcp?: () => Promise<void>;
}

export type DoctorStatus = "ready" | "not_ready" | "needs_setup" | "needs_attention";

export interface DoctorCheckNode {
  ok: boolean;
  version: string;
  required: string;
}

export interface DoctorCheckPackage {
  ok: boolean;
  name: string;
  version: string;
}

export interface DoctorCheckClaudeCli {
  ok: boolean;
  path?: string;
  version?: string;
}

export interface DoctorCheckGit {
  ok: boolean;
  version?: string;
  worktree: boolean;
}

export interface DoctorCheckCodexConfig {
  ok: boolean;
  path: string;
}

export interface DoctorCheckMcpServer {
  ok: boolean;
  name: "claude_delegate";
}

export interface DoctorCheckDefaultTools {
  ok: boolean;
  enabled_count: number;
  enabled: string[];
}

export interface DoctorCheckAllowRoots {
  ok: boolean;
  current_repo_allowed?: boolean;
}

export interface DoctorResult {
  ready: boolean;
  status: DoctorStatus;
  checks: {
    node: DoctorCheckNode;
    package: DoctorCheckPackage;
    claude_cli: DoctorCheckClaudeCli;
    git: DoctorCheckGit;
    codex_config: DoctorCheckCodexConfig;
    mcp_server: DoctorCheckMcpServer;
    default_tools: DoctorCheckDefaultTools;
    allow_roots: DoctorCheckAllowRoots;
  };
  warnings: string[];
  next_step: string;
}

async function packageVersion(): Promise<string> {
  const info = await getPackageInfo();
  return `${info.name} v${info.version}`;
}

async function doctorCommand(deps: Required<Pick<CliDependencies, "writeOut" | "writeErr">>, json?: boolean): Promise<number> {
  const { execCapture } = await import("./guard.js");
  const { scanClaudeDelegateConfig } = await import("./codex-config.js");
  const { getAllowRoots } = await import("./guard.js");

  const result: DoctorResult = {
    ready: false,
    status: "ready",
    checks: {
      node: { ok: false, version: "", required: ">=20" },
      package: { ok: false, name: "", version: "" },
      claude_cli: { ok: false },
      git: { ok: false, worktree: false },
      codex_config: { ok: false, path: "" },
      mcp_server: { ok: false, name: "claude_delegate" },
      default_tools: { ok: false, enabled_count: 0, enabled: [] },
      allow_roots: { ok: false },
    },
    warnings: [],
    next_step: "",
  };

  const warnings: string[] = [];
  let notReady = false;
  let needsSetup = false;
  let needsAttention = false;

  // Node check
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  result.checks.node = { ok: nodeMajor >= 20, version: process.versions.node, required: ">=20" };
  if (!result.checks.node.ok) {
    warnings.push(`Node.js ${process.versions.node} is below required >=20`);
    notReady = true;
  }

  // Package check
  try {
    const info = await getPackageInfo();
    result.checks.package = { ok: true, name: info.name, version: info.version };
  } catch {
    result.checks.package = { ok: false, name: "", version: "" };
    warnings.push("Could not read package info");
    notReady = true;
  }

  // Claude CLI check
  const claudeBin = process.env.CLAUDE_BIN ?? "claude";
  try {
    const version = await execCapture(claudeBin, ["--version"], { cwd: process.cwd(), timeoutMs: 10000 });
    result.checks.claude_cli = { ok: true, path: claudeBin !== "claude" ? claudeBin : undefined, version };
  } catch {
    result.checks.claude_cli = { ok: false };
    warnings.push("Claude CLI not found in PATH");
    notReady = true;
  }

  // Git check
  try {
    const gitVersion = await execCapture("git", ["--version"], { cwd: process.cwd(), timeoutMs: 5000 });
    let worktreeSupported = false;
    try {
      await execCapture("git", ["worktree", "list"], { cwd: process.cwd(), timeoutMs: 5000 });
      worktreeSupported = true;
    } catch {
      worktreeSupported = false;
    }
    result.checks.git = { ok: true, version: gitVersion, worktree: worktreeSupported };
  } catch {
    result.checks.git = { ok: false, worktree: false };
    warnings.push("Git not found");
    notReady = true;
  }

  // Codex config check
  let scanResult = undefined as Awaited<ReturnType<typeof scanClaudeDelegateConfig>> | undefined;
  try {
    const scan = await scanClaudeDelegateConfig();
    scanResult = scan;
    result.checks.codex_config = { ok: scan.exists, path: scan.configPath };

    if (!scan.exists) {
      needsSetup = true;
      warnings.push("Codex config not found");
    }

    // MCP server check — validate command = "codex-claude"
    if (scan.mcpClassification) {
      const hasCorrectCommand = scan.mcpCommand === "codex-claude";
      result.checks.mcp_server = { ok: hasCorrectCommand, name: "claude_delegate" };
      if (!hasCorrectCommand) {
        needsSetup = true;
        warnings.push(`claude_delegate command is "${scan.mcpCommand ?? "unset"}", expected "codex-claude"`);
      }
    } else {
      result.checks.mcp_server = { ok: false, name: "claude_delegate" };
      needsSetup = true;
      warnings.push("claude_delegate MCP server not configured");
    }

    // Default tools check — validate actual enabled_tools list
    if (scan.mcpCommand === "codex-claude" && scan.mcpEnabledTools) {
      const defaultTools: string[] = [...DEFAULT_ENABLED_TOOLS];
      const missingTools = defaultTools.filter((t) => !scan.mcpEnabledTools!.includes(t));
      const extraTools = scan.mcpEnabledTools.filter((t) => !defaultTools.includes(t));
      if (missingTools.length === 0 && extraTools.length === 0) {
        result.checks.default_tools.ok = true;
      } else {
        if (missingTools.length > 0) {
          needsAttention = true;
          warnings.push(`Default tools missing from enabled_tools: ${missingTools.join(", ")}`);
        }
        if (extraTools.length > 0) {
          needsAttention = true;
          warnings.push(`Enabled tools include non-default advanced tools: ${extraTools.join(", ")}. The default config should only include the 6 standard tools.`);
        }
      }
      result.checks.default_tools.enabled_count = scan.mcpEnabledTools.length;
      result.checks.default_tools.enabled = [...scan.mcpEnabledTools];
    } else {
      result.checks.default_tools.enabled_count = 0;
      result.checks.default_tools.enabled = [];
      if (scan.mcpCommand === "codex-claude" && scan.mcpEnabledTools === null) {
        needsAttention = true;
        warnings.push("enabled_tools is missing; default config should explicitly enable the 6 standard tools");
      }
    }
  } catch {
    result.checks.codex_config = { ok: false, path: "" };
    needsSetup = true;
  }

  // Allow roots check — use config file value first, then env var as fallback
  try {
    const { realpath } = await import("node:fs/promises");
    const cwd = await realpath(process.cwd());

    // Parse allow roots from config file (scan result from above)
    let allowRootPaths: string[] = [];
    if (scanResult && scanResult.allowRootsValue) {
      const configValue = scanResult.allowRootsValue;
      const delimiter = configValue.includes(":") ? ":" : configValue.includes(";") ? ";" : ",";
      allowRootPaths = configValue.split(delimiter).map((p) => p.trim()).filter(Boolean);
    }
    // Also include env-var / default roots
    for (const root of getAllowRoots()) {
      if (!allowRootPaths.includes(root)) allowRootPaths.push(root);
    }

    const cwdAllowed = allowRootPaths.some((root) => cwd === root || cwd.startsWith(root + "/"));
    result.checks.allow_roots = { ok: cwdAllowed, current_repo_allowed: cwdAllowed };
    if (!cwdAllowed) {
      needsAttention = true;
      warnings.push("Current repo is not included in CODEX_CLAUDE_ALLOW_ROOTS");
    }
  } catch {
    result.checks.allow_roots = { ok: false };
    needsAttention = true;
  }

  // Determine overall status
  if (notReady) {
    result.status = "not_ready";
  } else if (needsSetup) {
    result.status = "needs_setup";
  } else if (needsAttention) {
    result.status = "needs_attention";
  } else {
    result.status = "ready";
  }
  result.ready = result.status === "ready";
  result.warnings = warnings;

  // Next step
  if (result.status === "ready") {
    result.next_step = 'Restart Codex CLI, then ask: "Use claude_setup to check this repository."';
  } else if (result.status === "needs_setup") {
    result.next_step = "codex-claude setup --write";
  } else if (result.status === "needs_attention" && needsAttention) {
    result.next_step = 'codex-claude setup --write --allow-root "' + process.cwd() + '"';
  } else {
    result.next_step = "Run codex-claude doctor again after fixing issues.";
  }

  if (json) {
    deps.writeOut(JSON.stringify(result, null, 2) + "\n");
  } else {
    deps.writeOut("Codex-Claude doctor\n\n");
    const emit = (label: string, ok: boolean) => deps.writeOut(`${ok ? "✓" : "✗"} ${label}\n`);

    emit(`Node.js: ${result.checks.node.version} (${result.checks.node.required})`, result.checks.node.ok);
    emit(`Package: ${result.checks.package.ok ? `${result.checks.package.name} v${result.checks.package.version}` : "unknown"}`, result.checks.package.ok);
    emit(`Claude CLI: ${result.checks.claude_cli.ok ? (result.checks.claude_cli.path ?? "found") : "not found"}`, result.checks.claude_cli.ok);
    if (result.checks.claude_cli.version) {
      deps.writeOut(`  Claude version: ${result.checks.claude_cli.version}\n`);
    }
    emit(`Git: ${result.checks.git.version ?? "not found"}`, result.checks.git.ok);
    emit(`Git worktree: supported`, result.checks.git.worktree);
    if (result.checks.codex_config.ok) {
      emit(`Codex config: ${result.checks.codex_config.path}`, true);
    } else {
      emit(`Codex config: not found`, false);
    }
    emit(`MCP server: ${result.checks.mcp_server.ok ? "claude_delegate configured" : "claude_delegate not configured"}`, result.checks.mcp_server.ok);
    emit(`Default tools: ${result.checks.default_tools.enabled_count} enabled`, result.checks.default_tools.ok);
    if (result.checks.allow_roots.ok !== undefined) {
      emit(`Allow roots: ${result.checks.allow_roots.current_repo_allowed ? "current repo allowed" : "current repo is not included"}`, result.checks.allow_roots.ok);
    }

    deps.writeOut(`\nStatus: ${result.status}\n`);

    if (result.status !== "ready") {
      deps.writeOut("\n");
      for (const w of warnings) {
        deps.writeOut(`  ${w}\n`);
      }
    }

    deps.writeOut(`\nNext step:\n  ${result.next_step}\n`);
  }

  return result.ready ? 0 : 1;
}

export async function runCli(argv = process.argv, deps: CliDependencies = {}): Promise<number> {
  const writeOut = deps.writeOut ?? ((text: string) => process.stdout.write(text));
  const writeErr = deps.writeErr ?? ((text: string) => process.stderr.write(text));
  const startMcp = deps.startMcp ?? startMcpServer;
  const args = argv.slice(2);
  const command = args[0];

  try {
    if (!command || command === "mcp") {
      await startMcp();
      return 0;
    }
    if (command === "--version" || command === "-v") {
      writeOut(`${await packageVersion()}\n`);
      return 0;
    }

    if (command === "print-config") {
      if (args.includes("--npx")) {
        writeErr("--npx is not supported. Install globally with npm install -g @anyi61/codex-claude-delegate-mcp.\n");
        return 2;
      }
      if (args.includes("--source")) {
        const sourceIdx = args.indexOf("--source") + 1;
        const sourcePath = args[sourceIdx];
        if (!sourcePath) {
          writeErr("--source requires a path argument\n");
          return 2;
        }
        if (!sourcePath.startsWith("/")) {
          writeErr("--source requires an absolute path\n");
          return 2;
        }
        const toolLines = DEFAULT_ENABLED_TOOLS.map((t) => `  "${t}"`).join(",\n");
        writeOut(`[mcp_servers.claude_delegate]\ncommand = "node"\nargs = ["${sourcePath}/dist/cli.js"]\nstartup_timeout_sec = 20\ntool_timeout_sec = 600\nenabled_tools = [\n${toolLines}\n]\n`);
        return 0;
      }
      if (args.includes("--project")) {
        const toolLines = DEFAULT_ENABLED_TOOLS.map((t) => `  "${t}"`).join(",\n");
        writeOut(`[mcp_servers.claude_delegate]\ncommand = "codex-claude"\nstartup_timeout_sec = 20\ntool_timeout_sec = 600\nenabled_tools = [\n${toolLines}\n]\n`);
        writeOut(`\nTarget path: ./.codex/config.toml\n`);
        return 0;
      }
      writeOut(renderClaudeDelegateMcpConfig());
      return 0;
    }

    if (command === "setup") {
      if (args.includes("--print")) {
        writeOut("Codex-Claude setup --print\n\n");
        writeOut(renderClaudeDelegateMcpConfig());
        return 0;
      }

      if (args.includes("--write")) {
        const { setupWrite } = await import("./codex-config.js");
        const isProject = args.includes("--project");
        const force = args.includes("--force");

        if (isProject && args.includes("--allow-root")) {
          writeErr("--project and --allow-root cannot be combined. Use global setup for allow-root configuration.\n");
          return 2;
        }

        let allowRootPath: string | undefined;
        const allowRootIdx = args.indexOf("--allow-root");
        if (allowRootIdx >= 0) {
          if (args.length <= allowRootIdx + 1 || args[allowRootIdx + 1].startsWith("--")) {
            writeErr("--allow-root requires a path argument\n");
            return 2;
          }
          allowRootPath = args[allowRootIdx + 1];
        }

        const result = await setupWrite({
          isProject,
          force,
          allowRoot: allowRootPath,
        });

        writeOut(`${result.message}\n`);
        return result.exitCode;
      }

      writeErr("Usage: codex-claude setup --write [--force] [--allow-root <path>] [--project]\n");
      writeErr("       codex-claude setup --print\n");
      return 2;
    }

    if (command === "doctor") {
      const isJson = args.includes("--json");
      const io: Required<Pick<CliDependencies, "writeOut" | "writeErr">> = { writeOut, writeErr };
      return doctorCommand(io, isJson);
    }

    writeErr(`Unknown command: ${command}\n`);
    writeErr("Usage: codex-claude [mcp|--version|print-config|setup|doctor]\n");
    return 2;
  } catch (err) {
    writeErr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

function isDirectRun(): boolean {
  if (!process.argv[1]) return false;
  return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
}

if (isDirectRun()) {
  runCli().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
