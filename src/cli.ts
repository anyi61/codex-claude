#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";

import { getPackageInfo } from "./package-info.js";
import { main as startMcpServer } from "./server.js";
import { DEFAULT_ENABLED_TOOLS, renderClaudeDelegateMcpConfig } from "./codex-config.js";

export interface CliDependencies {
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
  startMcp?: () => Promise<void>;
  runUninstall?: (args: string[]) => number;
  runMcpLaunchSmoke?: () => Promise<LaunchSmokeResult>;
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
  auth_status?: "ok" | "missing" | "unknown";
  auth_confidence?: "verified" | "unknown";
}

export interface DoctorCheckGit {
  ok: boolean;
  version?: string;
  worktree: boolean;
}

export interface DoctorCheckCodexConfig {
  ok: boolean;
  path: string;
  tool_timeout_sec?: number | null;
  tool_timeout_ok?: boolean;
}

export interface DoctorCheckMcpServer {
  ok: boolean;
  name: "claude_delegate";
  launch_smoke?: {
    ok: boolean;
    detail: string;
  };
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

export interface DoctorCheckActiveClaudeProcesses {
  ok: boolean;
  count: number;
  jobs: Array<{ job_id: string; pid: number; type: string }>;
}

export interface DoctorCheckEnvSanitization {
  ok: boolean;
  allowlisted_count: number;
  allowlisted_names: string[];
  passthrough_count: number;
  passthrough_names: string[];
  blocked_passthrough_count: number;
  blocked_passthrough_names: string[];
}

export interface DoctorCheckEnvironmentConfig {
  ok: boolean;
  exists: boolean;
  errors: number;
  warnings: number;
  fields_present: string[];
  // Phase 2 fields
  verification_allowed_scripts_count?: number;
  verification_allowed_scripts?: string[];
  verification_timeout_sec?: number;
  artifacts_retention_days?: number;
  environment_passthrough_count?: number;
  environment_passthrough?: string[];
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
    active_claude_processes: DoctorCheckActiveClaudeProcesses;
    env_sanitization: DoctorCheckEnvSanitization;
    environment_config: DoctorCheckEnvironmentConfig;
  };
  warnings: string[];
  problems: Array<{ problem: string; fix: string; next_step: string }>;
  ready_means: string[];
  next_step: string;
}

interface LaunchSmokeResult {
  ok: boolean;
  detail: string;
}

const MCP_LAUNCH_SMOKE_TIMEOUT_MS = 3000;
const MCP_INITIALIZE_PROTOCOL_VERSION = "2024-11-05";

async function packageVersion(): Promise<string> {
  const info = await getPackageInfo();
  return `${info.name} v${info.version}`;
}

function runUninstallScript(args: string[]): number {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const scriptPath = resolve(packageRoot, "scripts", "uninstall-plugin.mjs");
  execFileSync(process.execPath, [scriptPath, ...args], {
    stdio: "inherit",
    env: {
      ...process.env,
      CODEX_UNINSTALL_REPO_ROOT: process.cwd(),
    },
  });
  return 0;
}

function compactProcessOutput(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

function appendProcessOutput(detail: string, stderr: string, stdout: string): string {
  const stderrText = compactProcessOutput(stderr);
  if (stderrText) return `${detail}: ${stderrText}`;
  const stdoutText = compactProcessOutput(stdout);
  if (stdoutText) return `${detail}: stdout=${stdoutText}`;
  return detail;
}

function runLocalMcpLaunchSmoke(timeoutMs = MCP_LAUNCH_SMOKE_TIMEOUT_MS): Promise<LaunchSmokeResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";

    const child = spawn("codex-claude", [], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stopChild = () => {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, 250).unref();
      }
      child.unref();
    };

    const finish = (result: LaunchSmokeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopChild();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        detail: appendProcessOutput(`Timed out after ${timeoutMs}ms waiting for MCP initialize response from codex-claude`, stderr, stdout),
      });
    }, timeoutMs);
    timer.unref();

    child.once("error", (err) => {
      finish({ ok: false, detail: `Failed to launch codex-claude: ${err.message}` });
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      const status = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
      finish({
        ok: false,
        detail: appendProcessOutput(`codex-claude exited before MCP initialize response (${status})`, stderr, stdout),
      });
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      let newlineIndex = stdout.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdout.slice(0, newlineIndex).trim();
        stdout = stdout.slice(newlineIndex + 1);
        if (line) {
          try {
            const message = JSON.parse(line) as { id?: unknown; result?: unknown; error?: unknown };
            if (message.id === 1) {
              if (message.error) {
                finish({ ok: false, detail: `MCP initialize returned error: ${JSON.stringify(message.error).slice(0, 500)}` });
              } else if (message.result && typeof message.result === "object") {
                child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
                finish({ ok: true, detail: "MCP initialize handshake completed using codex-claude." });
              } else {
                finish({ ok: false, detail: "MCP initialize response was missing a result object." });
              }
              return;
            }
          } catch {
            finish({ ok: false, detail: `Invalid MCP JSON response from codex-claude: ${line.slice(0, 500)}` });
            return;
          }
        }
        newlineIndex = stdout.indexOf("\n");
      }
    });

    child.stdin?.on("error", () => {
      // The close handler reports process failures with stderr; avoid an unhandled EPIPE.
    });

    const initializeRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_INITIALIZE_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "codex-claude-doctor", version: "1.0.0" },
      },
    };

    try {
      child.stdin?.write(`${JSON.stringify(initializeRequest)}\n`);
    } catch (err) {
      finish({
        ok: false,
        detail: `Failed to write MCP initialize request to codex-claude: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}

async function doctorCommand(deps: Required<Pick<CliDependencies, "writeOut" | "writeErr">> & Pick<CliDependencies, "runMcpLaunchSmoke">, json?: boolean): Promise<number> {
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
      active_claude_processes: { ok: true, count: 0, jobs: [] },
      env_sanitization: { ok: true, allowlisted_count: 0, allowlisted_names: [], passthrough_count: 0, passthrough_names: [], blocked_passthrough_count: 0, blocked_passthrough_names: [] },
      environment_config: { ok: true, exists: false, errors: 0, warnings: 0, fields_present: [] },
    },
    warnings: [],
    problems: [],
    ready_means: [
      "Codex can launch the claude_delegate MCP server with command codex-claude.",
      "The default 5 tools are explicitly enabled and Advanced/Recovery tools stay hidden.",
      "tool_timeout_sec can cover the default 540 second block wait window.",
      "The current repository is included in CODEX_CLAUDE_ALLOW_ROOTS.",
      "Claude CLI is available; auth may still need a real Claude invocation if reported unknown.",
    ],
    next_step: "",
  };

  const warnings: string[] = [];
  const problems: DoctorResult["problems"] = [];
  const addProblem = (problem: string, fix: string, nextStep: string) => {
    problems.push({ problem, fix, next_step: nextStep });
    warnings.push(problem);
  };
  let notReady = false;
  let needsSetup = false;
  let needsAttention = false;

  // Node check
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  result.checks.node = { ok: nodeMajor >= 20, version: process.versions.node, required: ">=20" };
  if (!result.checks.node.ok) {
    addProblem(`Node.js ${process.versions.node} is below required >=20`, "Install Node.js 20 or newer.", "node -v");
    notReady = true;
  }

  // Package check
  try {
    const info = await getPackageInfo();
    result.checks.package = { ok: true, name: info.name, version: info.version };
  } catch {
    result.checks.package = { ok: false, name: "", version: "" };
    addProblem("Could not read package info", "Reinstall @anyi61/codex-claude-delegate-mcp globally.", "npm install -g @anyi61/codex-claude-delegate-mcp");
    notReady = true;
  }

  // Claude CLI check
  const claudeBin = process.env.CLAUDE_BIN ?? "claude";
  try {
    const version = await execCapture(claudeBin, ["--version"], { cwd: process.cwd(), timeoutMs: 10000 });
    let authStatus: "ok" | "missing" | "unknown" = "unknown";
    try {
      const authOutput = await execCapture(claudeBin, ["auth", "status"], { cwd: process.cwd(), timeoutMs: 10000 });
      authStatus = /logged in|authenticated|ok/i.test(authOutput) ? "ok" : /not logged in|unauthenticated|missing/i.test(authOutput) ? "missing" : "unknown";
    } catch {
      authStatus = "unknown";
    }
    result.checks.claude_cli = {
      ok: true,
      path: claudeBin !== "claude" ? claudeBin : undefined,
      version,
      auth_status: authStatus,
      auth_confidence: authStatus === "ok" ? "verified" : "unknown",
    };
    if (authStatus === "missing") {
      addProblem("Claude CLI reports that authentication is missing", "Run Claude Code login/auth setup.", "claude");
      notReady = true;
    } else if (authStatus === "unknown") {
      needsAttention = true;
      addProblem("Claude CLI auth status could not be verified", "Open Claude Code once and confirm it can run a simple prompt.", "claude");
    }
  } catch {
    result.checks.claude_cli = { ok: false };
    addProblem("Claude CLI not found in PATH", "Install Claude Code CLI or set CLAUDE_BIN to a trusted local executable.", "claude --version");
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
    addProblem("Git not found", "Install Git and make sure it is available on PATH.", "git --version");
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
      addProblem("Codex config not found", "Write the default claude_delegate MCP configuration.", "codex-claude setup --write");
    }

    // MCP server check — validate command = "codex-claude"
    if (scan.mcpClassification) {
      const hasCorrectCommand = scan.mcpCommand === "codex-claude";
      result.checks.mcp_server = { ok: hasCorrectCommand, name: "claude_delegate" };
      if (!hasCorrectCommand) {
        needsSetup = true;
        addProblem(`claude_delegate command is "${scan.mcpCommand ?? "unset"}", expected "codex-claude"`, "Replace the MCP server command with the global codex-claude launcher.", "codex-claude setup --write --force");
      }
    } else {
      result.checks.mcp_server = { ok: false, name: "claude_delegate" };
      needsSetup = true;
      addProblem("claude_delegate MCP server not configured", "Add the claude_delegate MCP server to Codex config.", "codex-claude setup --write");
    }

    if (!result.checks.mcp_server.ok) {
      result.checks.mcp_server.launch_smoke = { ok: false, detail: "Skipped because MCP server config is not valid." };
    } else if (!result.checks.package.ok) {
      result.checks.mcp_server.launch_smoke = { ok: false, detail: "Skipped because package info could not be read." };
    } else {
      const launchSmoke = await (deps.runMcpLaunchSmoke ?? runLocalMcpLaunchSmoke)();
      result.checks.mcp_server.launch_smoke = launchSmoke;
      if (!launchSmoke.ok) {
        notReady = true;
        addProblem(
          `MCP launch smoke failed: ${launchSmoke.detail}`,
          "Verify the global codex-claude launcher starts the local MCP server and reinstall the package if needed.",
          "codex-claude doctor --json",
        );
      }
    }

    result.checks.codex_config.tool_timeout_sec = scan.mcpToolTimeoutSec ?? null;
    result.checks.codex_config.tool_timeout_ok = typeof scan.mcpToolTimeoutSec === "number" && scan.mcpToolTimeoutSec >= 600;
    if (!result.checks.codex_config.tool_timeout_ok) {
      needsAttention = true;
      addProblem(
        `tool_timeout_sec is ${scan.mcpToolTimeoutSec ?? "missing"}, expected at least 600`,
        "Set tool_timeout_sec = 600 for [mcp_servers.claude_delegate].",
        "codex-claude setup --write --force",
      );
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
          addProblem(`Default tools missing from enabled_tools: ${missingTools.join(", ")}`, "Restore the default 5 enabled tools.", "codex-claude setup --write --force");
        }
        if (extraTools.length > 0) {
          needsAttention = true;
          addProblem(`Enabled tools include non-default advanced tools: ${extraTools.join(", ")}. The default config should only include the 5 standard tools.`, "Keep Advanced/Recovery tools out of the default enabled_tools list.", "codex-claude setup --write --force");
        }
      }
      result.checks.default_tools.enabled_count = scan.mcpEnabledTools.length;
      result.checks.default_tools.enabled = [...scan.mcpEnabledTools];
    } else {
      result.checks.default_tools.enabled_count = 0;
      result.checks.default_tools.enabled = [];
      if (scan.mcpCommand === "codex-claude" && scan.mcpEnabledTools === null) {
        needsAttention = true;
        addProblem("enabled_tools is missing; default config should explicitly enable the 5 standard tools", "Write the explicit default enabled_tools list.", "codex-claude setup --write --force");
      }
    }
  } catch {
    result.checks.codex_config = { ok: false, path: "" };
    result.checks.mcp_server.launch_smoke = { ok: false, detail: "Skipped because Codex config could not be scanned." };
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
      addProblem("Current repo is not included in CODEX_CLAUDE_ALLOW_ROOTS", "Add this repository to CODEX_CLAUDE_ALLOW_ROOTS.", 'codex-claude setup --write --allow-root "' + process.cwd() + '"');
    }
  } catch {
    result.checks.allow_roots = { ok: false };
    needsAttention = true;
    addProblem("Could not verify CODEX_CLAUDE_ALLOW_ROOTS", "Check that the current directory exists and Codex config is readable.", "codex-claude doctor --json");
  }

  // Active background job runner PIDs (persisted state, not live Claude CLI children)
  try {
    const { existsSync } = await import("node:fs");
    const { getBackgroundStateDir, getJobStore } = await import("./background-jobs.js");
    const stateDir = getBackgroundStateDir();
    if (existsSync(stateDir)) {
      const store = await getJobStore();
      const runningJobs = await store.list({ limit: 10, status: "running" });
      if (runningJobs.length > 0) {
        const activeProcesses = runningJobs
          .filter((job) => typeof job.pid === "number")
          .map((job) => ({ job_id: job.job_id, pid: job.pid!, type: job.type }));
        result.checks.active_claude_processes = {
          ok: true,
          count: activeProcesses.length,
          jobs: activeProcesses,
        };
      }
    }
  } catch {
    result.checks.active_claude_processes = { ok: true, count: 0, jobs: [] };
  }

  // Environment sanitization diagnostics (never leaks values)
  try {
    const { getEnvSanitizationDiagnostics } = await import("./guard.js");
    const envDiag = getEnvSanitizationDiagnostics();
    result.checks.env_sanitization = {
      ok: true,
      allowlisted_count: envDiag.allowlisted_present,
      allowlisted_names: envDiag.allowlisted_names,
      passthrough_count: envDiag.passthrough_present,
      passthrough_names: envDiag.passthrough_names,
      blocked_passthrough_count: envDiag.blocked_passthrough_count,
      blocked_passthrough_names: envDiag.blocked_passthrough_names,
    };
    // Blocked passthrough entries are informational only — do not make doctor not_ready
  } catch {
    result.checks.env_sanitization = { ok: true, allowlisted_count: 0, allowlisted_names: [], passthrough_count: 0, passthrough_names: [], blocked_passthrough_count: 0, blocked_passthrough_names: [] };
  }

  // Environment config diagnostics (never leaks command values)
  try {
    const { readEnvironmentConfig } = await import("./environment-config.js");
    const envConfigResult = await readEnvironmentConfig(process.cwd());
    if (envConfigResult) {
      const s = envConfigResult.summary;
      result.checks.environment_config = {
        ok: s.ok,
        exists: true,
        errors: s.errors.length,
        warnings: s.warnings.length,
        fields_present: s.fields_present,
        verification_allowed_scripts_count: s.verification_allowed_scripts_count,
        verification_allowed_scripts: s.verification_allowed_scripts,
        verification_timeout_sec: s.verification_timeout_sec,
        artifacts_retention_days: s.artifacts_retention_days,
        environment_passthrough_count: s.environment_passthrough_count,
        environment_passthrough: s.environment_passthrough,
      };
      if (!s.ok) {
        needsAttention = true;
        addProblem(
          `Environment config at ${s.path} has ${s.errors.length} error(s) and ${s.warnings.length} warning(s)`,
          "Fix the issues in .codex-claude-delegate/environment.json",
          "codex-claude doctor --json",
        );
      } else if (s.warnings.length > 0) {
        // Warnings alone do not promote to needs_attention
        warnings.push(`Environment config has ${s.warnings.length} warning(s)`);
      }
    } else {
      result.checks.environment_config = {
        ok: true,
        exists: false,
        errors: 0,
        warnings: 0,
        fields_present: [],
      };
    }
  } catch {
    result.checks.environment_config = {
      ok: true,
      exists: false,
      errors: 0,
      warnings: 0,
      fields_present: [],
    };
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
  result.problems = problems;

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
    emit(`Active Claude processes: ${result.checks.active_claude_processes.count}`, true);
    if (result.checks.allow_roots.ok !== undefined) {
      emit(`Allow roots: ${result.checks.allow_roots.current_repo_allowed ? "current repo allowed" : "current repo is not included"}`, result.checks.allow_roots.ok);
    }

    const es = result.checks.env_sanitization;
    const esParts = [`allowlisted: ${es.allowlisted_count}`];
    if (es.passthrough_count > 0) esParts.push(`passthrough: ${es.passthrough_count}`);
    if (es.blocked_passthrough_count > 0) esParts.push(`blocked passthrough: ${es.blocked_passthrough_count}`);
    emit(`Env sanitization: ${esParts.join(", ")}`, es.ok);
    if (es.allowlisted_names.length > 0) {
      deps.writeOut(`  Allowlisted: ${es.allowlisted_names.join(", ")}\n`);
    }
    if (es.passthrough_names.length > 0) {
      deps.writeOut(`  Passthrough: ${es.passthrough_names.join(", ")}\n`);
    }
    if (es.blocked_passthrough_names.length > 0) {
      deps.writeOut(`  Blocked passthrough: ${es.blocked_passthrough_names.join(", ")}\n`);
    }

    const ec = result.checks.environment_config;
    if (ec.exists) {
      const parts: string[] = [];
      if (ec.fields_present.length > 0) parts.push(`fields: ${ec.fields_present.join(", ")}`);
      if (ec.verification_allowed_scripts_count !== undefined && ec.verification_allowed_scripts_count > 0) {
        parts.push(`allowed scripts: ${ec.verification_allowed_scripts_count}`);
      }
      if (ec.verification_timeout_sec !== undefined) {
        parts.push(`timeout: ${ec.verification_timeout_sec}s`);
      }
      if (ec.artifacts_retention_days !== undefined) {
        parts.push(`retention: ${ec.artifacts_retention_days}d`);
      }
      if (ec.environment_passthrough_count !== undefined && ec.environment_passthrough_count > 0) {
        parts.push(`passthrough: ${ec.environment_passthrough_count}`);
      }
      if (ec.errors > 0) parts.push(`${ec.errors} error(s)`);
      if (ec.warnings > 0) parts.push(`${ec.warnings} warning(s)`);
      emit(`Environment config: ${parts.join("; ")}`, ec.ok);
      if (ec.verification_allowed_scripts && ec.verification_allowed_scripts.length > 0) {
        deps.writeOut(`  Allowed scripts: ${ec.verification_allowed_scripts.join(", ")}\n`);
      }
      if (ec.environment_passthrough && ec.environment_passthrough.length > 0) {
        deps.writeOut(`  Passthrough: ${ec.environment_passthrough.join(", ")}\n`);
      }
    }

    deps.writeOut(`\nStatus: ${result.status}\n`);

    if (result.status !== "ready") {
      deps.writeOut("\n");
      for (const item of problems) {
        deps.writeOut(`Problem: ${item.problem}\n`);
        deps.writeOut(`Fix: ${item.fix}\n`);
        deps.writeOut(`Next step: ${item.next_step}\n\n`);
      }
    }

    deps.writeOut(`\nNext step:\n  ${result.next_step}\n`);
  }

  return result.ready ? 0 : 1;
}

function parseNonNegativeNumber(value: string | undefined, option: string): number | string {
  if (value === undefined || value.startsWith("--")) return `${option} requires a value`;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return `${option} must be a non-negative number`;
  return parsed;
}

function parsePositiveInteger(value: string | undefined, option: string): number | string {
  if (value === undefined || value.startsWith("--")) return `${option} requires a value`;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return `${option} must be a positive integer`;
  return parsed;
}

async function cleanupArtifactsCommand(
  args: string[],
  deps: Required<Pick<CliDependencies, "writeOut" | "writeErr">>
): Promise<number> {
  let cwd = process.cwd();
  let olderThanHours = 720;
  let limit = 100;
  let dryRun = true;
  let json = false;
  let explicitDryRun = false;
  let execute = false;

  for (let idx = 1; idx < args.length; idx += 1) {
    const arg = args[idx];
    if (arg === "--dry-run") {
      explicitDryRun = true;
      dryRun = true;
      continue;
    }
    if (arg === "--execute") {
      execute = true;
      dryRun = false;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--cwd") {
      const value = args[idx + 1];
      if (!value || value.startsWith("--")) {
        deps.writeErr("--cwd requires a path argument\n");
        return 2;
      }
      cwd = value;
      idx += 1;
      continue;
    }
    if (arg === "--older-than-hours") {
      const parsed = parseNonNegativeNumber(args[idx + 1], "--older-than-hours");
      if (typeof parsed === "string") {
        deps.writeErr(`${parsed}\n`);
        return 2;
      }
      olderThanHours = parsed;
      idx += 1;
      continue;
    }
    if (arg === "--limit") {
      const parsed = parsePositiveInteger(args[idx + 1], "--limit");
      if (typeof parsed === "string") {
        deps.writeErr(`${parsed}\n`);
        return 2;
      }
      limit = parsed;
      idx += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      deps.writeErr(`Unknown cleanup-artifacts option: ${arg}\n`);
      return 2;
    }
    deps.writeErr(`Unknown cleanup-artifacts argument: ${arg}\n`);
    return 2;
  }

  if (explicitDryRun && execute) {
    deps.writeErr("--dry-run and --execute cannot be combined\n");
    return 2;
  }

  const { cleanupDelegateArtifacts } = await import("./claude-cli.js");
  const result = await cleanupDelegateArtifacts({
    cwd,
    older_than_hours: olderThanHours,
    dry_run: dryRun,
    limit,
  });

  if (json) {
    deps.writeOut(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    deps.writeOut("Codex-Claude cleanup-artifacts\n\n");
    deps.writeOut(`cwd: ${cwd}\n`);
    deps.writeOut(`older_than_hours: ${olderThanHours}\n`);
    deps.writeOut(`limit: ${limit}\n`);
    deps.writeOut(`dry_run: ${dryRun}\n\n`);
    deps.writeOut(`Jobs: ${result.jobs.matched_count} matched, ${result.jobs.removed_count} removed, ${result.jobs.failed_count} failed\n`);
    deps.writeOut(`Run logs: ${result.run_logs.matched_count} matched, ${result.run_logs.removed_count} removed, ${result.run_logs.failed_count} failed\n`);
    if (dryRun) {
      deps.writeOut("\nRun again with --execute after reviewing the preview.\n");
    }
  }

  return result.jobs.failed_count > 0 || result.run_logs.failed_count > 0 ? 1 : 0;
}

export async function runCli(argv = process.argv, deps: CliDependencies = {}): Promise<number> {
  const writeOut = deps.writeOut ?? ((text: string) => process.stdout.write(text));
  const writeErr = deps.writeErr ?? ((text: string) => process.stderr.write(text));
  const startMcp = deps.startMcp ?? startMcpServer;
  const runUninstall = deps.runUninstall ?? runUninstallScript;
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
          writeErr("--project and --allow-root cannot be combined.\n");
          writeErr("  --project writes MCP config to ./.codex/config.toml (project-scoped).\n");
          writeErr("  --allow-root modifies the global Codex allow-root configuration (~/.codex/config.toml).\n");
          writeErr("To set up both: run setup --write --allow-root <path> first (global config),\n");
          writeErr("then run setup --write --project (project config).\n");
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
      writeErr("\n");
      writeErr("  --write              Write claude_delegate MCP config\n");
      writeErr("  --force              Overwrite existing config (creates timestamped backup)\n");
      writeErr("  --allow-root <path>  Add path to global Codex allow-root config\n");
      writeErr("  --project            Write to ./.codex/config.toml (project-scoped), not global config\n");
      writeErr("  --print              Preview config without writing\n");
      writeErr("\n");
      writeErr("Note: --project and --allow-root affect different scopes and cannot be combined.\n");
      writeErr("Use global setup for allow-root config, then --project for project-scoped config.\n");
      return 2;
    }

    if (command === "doctor") {
      const isJson = args.includes("--json");
      const io: Required<Pick<CliDependencies, "writeOut" | "writeErr">> & Pick<CliDependencies, "runMcpLaunchSmoke"> = { writeOut, writeErr, runMcpLaunchSmoke: deps.runMcpLaunchSmoke };
      return doctorCommand(io, isJson);
    }

    if (command === "cleanup-artifacts") {
      return cleanupArtifactsCommand(args, { writeOut, writeErr });
    }

    if (command === "uninstall") {
      return runUninstall(args.slice(1));
    }

    writeErr(`Unknown command: ${command}\n`);
    writeErr("Usage: codex-claude [mcp|--version|print-config|setup|doctor|cleanup-artifacts|uninstall]\n");
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
