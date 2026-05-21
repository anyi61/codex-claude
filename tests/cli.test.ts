import { chmodSync } from "node:fs";
import { mkdtemp, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";

// Mock guard and codex-config so doctor tests can be isolated.
// Factories spread the real implementation so non-doctor tests work unchanged.
vi.mock("../src/guard.js", async () => {
  const actual = await vi.importActual<typeof import("../src/guard.js")>("../src/guard.js");
  return {
    ...actual,
    execCapture: vi.fn(),
    getAllowRoots: vi.fn(),
  };
});

vi.mock("../src/codex-config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/codex-config.js")>("../src/codex-config.js");
  return {
    ...actual,
    scanClaudeDelegateConfig: vi.fn(),
  };
});

function makeIo() {
  return {
    stdout: "",
    stderr: "",
    writeOut(this: { stdout: string }, text: string) { this.stdout += text; },
    writeErr(this: { stderr: string }, text: string) { this.stderr += text; },
  };
}

const cleanupPaths: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanupPaths.length > 0) {
    await rm(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

describe("codex-claude CLI", () => {
  it("prints package version", async () => {
    const io = makeIo();
    const exitCode = await runCli(["node", "codex-claude", "--version"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });

    expect(exitCode).toBe(0);
    expect(io.stdout).toMatch(/^@anyi61\/codex-claude-delegate-mcp v\d+\.\d+\.\d+/);
  });

  it("starts MCP server when called with no args", async () => {
    const startMcp = vi.fn(async () => undefined);
    const io = makeIo();

    const exitCode = await runCli(["node", "codex-claude"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp,
    });

    expect(exitCode).toBe(0);
    expect(startMcp).toHaveBeenCalledOnce();
    expect(io.stdout).toBe("");
  });

  it("starts MCP server for mcp subcommand", async () => {
    const startMcp = vi.fn(async () => undefined);
    const io = makeIo();

    const exitCode = await runCli(["node", "codex-claude", "mcp"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp,
    });

    expect(exitCode).toBe(0);
    expect(startMcp).toHaveBeenCalledOnce();
  });

  it("does not expose codex-claude-delegate-mcp as a bin alias", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    expect(pkg.bin).toEqual({ "codex-claude": "dist/cli.js" });
    expect(JSON.stringify(pkg)).not.toContain('"codex-claude-delegate-mcp":"./dist/cli.js"');
  });

  it("prints unknown command error", async () => {
    const io = makeIo();
    const exitCode = await runCli(["node", "codex-claude", "--unknown"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });

    expect(exitCode).toBe(2);
    expect(io.stderr).toContain("Unknown command");
  });

  it("dispatches uninstall command to packaged uninstall flow", async () => {
    const io = makeIo();
    const runUninstall = vi.fn(() => 0);
    const exitCode = await runCli(["node", "codex-claude", "uninstall", "--yes"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
      runUninstall,
    });

    expect(exitCode).toBe(0);
    expect(runUninstall).toHaveBeenCalledWith(["--yes"]);
  });

  it("prints npm global config", async () => {
    const io = makeIo();
    const exitCode = await runCli(["node", "codex-claude", "print-config"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });
    expect(exitCode).toBe(0);
    expect(io.stdout).toContain('command = "codex-claude"');
    expect(io.stdout).not.toContain('command = "npx"');
  });

  it("rejects removed npx option", async () => {
    const io = makeIo();
    const exitCode = await runCli(["node", "codex-claude", "print-config", "--npx"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
    });
    expect(exitCode).toBe(2);
    expect(io.stderr).toContain("--npx is not supported");
  });

  it("prints setup --print output", async () => {
    const io = makeIo();
    const exitCode = await runCli(["node", "codex-claude", "setup", "--print"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });
    expect(exitCode).toBe(0);
    expect(io.stdout).toContain("Codex-Claude setup --print");
    expect(io.stdout).toContain('command = "codex-claude"');
  });

  it("prints source config without mcp subcommand", async () => {
    const io = makeIo();
    const exitCode = await runCli(["node", "codex-claude", "print-config", "--source", "/repo"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });
    expect(exitCode).toBe(0);
    expect(io.stdout).toContain('command = "node"');
    expect(io.stdout).toContain('args = ["/repo/dist/cli.js"]');
    expect(io.stdout).not.toContain('"mcp"');
  });

  it("prints project config note", async () => {
    const io = makeIo();
    const exitCode = await runCli(["node", "codex-claude", "print-config", "--project"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });
    expect(exitCode).toBe(0);
    expect(io.stdout).toContain("./.codex/config.toml");
    expect(io.stdout).toContain('command = "codex-claude"');
  });

  it("publishes only codex-claude bin", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    expect(pkg.bin).toEqual({ "codex-claude": "dist/cli.js" });
    expect(JSON.stringify(pkg)).not.toContain('"codex-claude-delegate-mcp":"./dist/cli.js"');
  });

  it("declares node >=20", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    expect(pkg.engines.node).toBe(">=20");
  });

  it("includes LICENSE in package files", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    expect(pkg.files).toContain("LICENSE");
  });

  it("has license field in package.json", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    expect(pkg.license).toBe("MIT");
  });

  it("rejects --project --allow-root combination", async () => {
    const io = makeIo();
    const exitCode = await runCli(["node", "codex-claude", "setup", "--write", "--project", "--allow-root", "/tmp"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });
    expect(exitCode).toBe(2);
    expect(io.stderr).toContain("--project and --allow-root cannot be combined");
  });

  // Doctor tests using mocked guard and codex-config modules.
  // The mocks above make execCapture, getAllowRoots, scanClaudeDelegateConfig
  // into vi.fn() stubs that return undefined by default.
  // Each test sets them up explicitly.

  async function setupDoctorMocks(opts: {
    execCapture?: (cmd: string, args: string[], opts?: any) => Promise<string>;
    scanResult?: any;
    allowRoots?: string[];
    fakeCodex?: "success" | "failure" | "none";
  }) {
    const guardModule = vi.mocked(await import("../src/guard.js"));
    guardModule.execCapture.mockImplementation(opts.execCapture ?? (async () => "1.0.0"));
    guardModule.getAllowRoots.mockReturnValue(opts.allowRoots ?? []);
    const codexModule = vi.mocked(await import("../src/codex-config.js"));
    const scanResult = opts.scanResult ?? {
      configPath: "/fake/.codex/config.toml",
      exists: false,
      hasAllowRoots: false,
      allowRootsValue: null,
      mcpClassification: null,
      mcpServerKeys: [],
      envKeys: [],
      mcpCommand: null,
      mcpEnabledTools: null,
      mcpToolTimeoutSec: null,
    };
    codexModule.scanClaudeDelegateConfig.mockResolvedValue(scanResult);
    if (scanResult.mcpCommand === "codex-claude" && opts.fakeCodex !== "none") {
      await installFakeCodexClaude(opts.fakeCodex ?? "success");
    }
  }

  async function installFakeCodexClaude(mode: "success" | "failure") {
    const binDir = await mkdtemp(path.join(os.tmpdir(), "codex-doctor-cli-"));
    cleanupPaths.push(binDir);
    const scriptPath = path.join(binDir, "codex-claude");
    const body = mode === "success"
      ? [
        "#!/usr/bin/env node",
        "let buffered = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => {",
        "  buffered += chunk;",
        "  const line = buffered.split(/\\r?\\n/).find(Boolean);",
        "  if (!line) return;",
        "  const request = JSON.parse(line);",
        "  if (request.method !== 'initialize') process.exit(3);",
        "  process.stdout.write(JSON.stringify({",
        "    jsonrpc: '2.0',",
        "    id: request.id,",
        "    result: {",
        "      protocolVersion: request.params.protocolVersion,",
        "      capabilities: { tools: {} },",
        "      serverInfo: { name: 'fake-codex-claude', version: '1.0.0' }",
        "    }",
        "  }) + '\\n');",
        "});",
        "",
      ].join("\n")
      : [
        "#!/usr/bin/env node",
        "process.stderr.write('fake launch failed\\n');",
        "process.exit(42);",
        "",
      ].join("\n");
    await writeFile(scriptPath, body, "utf8");
    chmodSync(scriptPath, 0o755);
    vi.stubEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`);
  }

  it("returns structured doctor --json output", async () => {
    await setupDoctorMocks({
      execCapture: async () => "1.0.0",
      scanResult: {
        configPath: "/fake/.codex/config.toml",
        exists: true,
        hasAllowRoots: false,
        allowRootsValue: null,
        mcpClassification: { origin: "manual", hasCommand: true, hasArgs: true, hasEnv: false },
        mcpServerKeys: ["command", "enabled_tools"],
        envKeys: [],
        mcpCommand: "codex-claude",
        mcpEnabledTools: ["claude_setup", "claude_task", "claude_result", "claude_apply", "claude_cleanup"],
        mcpToolTimeoutSec: 600,
      },
    });

    const io = makeIo();
    const exitCode = await runCli(["node", "codex-claude", "doctor", "--json"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });
    const parsed = JSON.parse(io.stdout);
    expect(parsed).toHaveProperty("ready");
    expect(parsed).toHaveProperty("status");
    expect(parsed).toHaveProperty("checks");
    expect(parsed.checks).toHaveProperty("node");
    expect(parsed.checks).toHaveProperty("package");
    expect(parsed.checks).toHaveProperty("claude_cli");
    expect(parsed.checks).toHaveProperty("git");
    expect(parsed.checks).toHaveProperty("codex_config");
    expect(parsed.checks).toHaveProperty("mcp_server");
    expect(parsed.checks).toHaveProperty("default_tools");
    expect(parsed.checks).toHaveProperty("allow_roots");
    expect(parsed.checks.claude_cli).not.toHaveProperty("authenticated");
    expect(parsed.checks.claude_cli.auth_status).toBe("unknown");
    expect(parsed.checks.mcp_server.launch_smoke).toHaveProperty("ok");
    expect(parsed.checks.mcp_server.launch_smoke.ok).toBe(true);
    expect(parsed.ready_means).toEqual(expect.arrayContaining([
      expect.stringContaining("default 5 tools"),
    ]));
  });

  it("doctor performs a real bounded MCP initialize smoke when static config is valid", async () => {
    const cwd = process.cwd();
    await setupDoctorMocks({
      execCapture: async (_cmd, args) => args[0] === "auth" ? "logged in" : "1.0.0",
      scanResult: {
        configPath: "/fake/.codex/config.toml",
        exists: true,
        hasAllowRoots: true,
        allowRootsValue: cwd,
        mcpClassification: { origin: "manual", hasCommand: true, hasArgs: true, hasEnv: false },
        mcpServerKeys: ["command", "enabled_tools"],
        envKeys: [],
        mcpCommand: "codex-claude",
        mcpEnabledTools: ["claude_setup", "claude_task", "claude_result", "claude_apply", "claude_cleanup"],
        mcpToolTimeoutSec: 600,
      },
    });

    const io = makeIo();
    const exitCode = await runCli(["node", "codex-claude", "doctor", "--json"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });

    const parsed = JSON.parse(io.stdout);
    expect(exitCode).toBe(0);
    expect(parsed.ready).toBe(true);
    expect(parsed.checks.mcp_server.launch_smoke).toEqual({
      ok: true,
      detail: expect.stringContaining("MCP initialize handshake completed"),
    });
  });

  it("doctor reports launch smoke failure as not_ready with problem details", async () => {
    const cwd = process.cwd();
    await setupDoctorMocks({
      fakeCodex: "failure",
      execCapture: async (_cmd, args) => args[0] === "auth" ? "logged in" : "1.0.0",
      scanResult: {
        configPath: "/fake/.codex/config.toml",
        exists: true,
        hasAllowRoots: true,
        allowRootsValue: cwd,
        mcpClassification: { origin: "manual", hasCommand: true, hasArgs: true, hasEnv: false },
        mcpServerKeys: ["command", "enabled_tools"],
        envKeys: [],
        mcpCommand: "codex-claude",
        mcpEnabledTools: ["claude_setup", "claude_task", "claude_result", "claude_apply", "claude_cleanup"],
        mcpToolTimeoutSec: 600,
      },
    });

    const io = makeIo();
    const exitCode = await runCli(["node", "codex-claude", "doctor", "--json"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });

    const parsed = JSON.parse(io.stdout);
    expect(exitCode).toBe(1);
    expect(parsed.ready).toBe(false);
    expect(parsed.status).toBe("not_ready");
    expect(parsed.checks.mcp_server.launch_smoke.ok).toBe(false);
    expect(parsed.checks.mcp_server.launch_smoke.detail).toContain("fake launch failed");
    expect(parsed.problems).toContainEqual({
      problem: expect.stringContaining("MCP launch smoke failed"),
      fix: expect.stringContaining("codex-claude launcher"),
      next_step: "codex-claude doctor --json",
    });
  });

  it("doctor non-json output includes status and next_step", async () => {
    await setupDoctorMocks({
      execCapture: async () => "1.0.0",
      scanResult: {
        configPath: "/fake/.codex/config.toml",
        exists: true,
        hasAllowRoots: false,
        allowRootsValue: null,
        mcpClassification: { origin: "manual", hasCommand: true, hasArgs: true, hasEnv: false },
        mcpServerKeys: ["command", "enabled_tools"],
        envKeys: [],
        mcpCommand: "codex-claude",
        mcpEnabledTools: ["claude_setup", "claude_task", "claude_result", "claude_apply", "claude_cleanup"],
        mcpToolTimeoutSec: 600,
      },
    });

    const io = makeIo();
    const exitCode = await runCli(["node", "codex-claude", "doctor"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });
    expect(typeof exitCode).toBe("number");
    expect(io.stdout).toContain("Codex-Claude doctor");
    expect(io.stdout).toContain("Status:");
    expect(io.stdout).toMatch(/Problem:|Next step:/);
  });

  it("doctor detects wrong MCP command as needs_setup", async () => {
    await setupDoctorMocks({
      execCapture: async () => "1.0.0",
      scanResult: {
        configPath: "/fake/.codex/config.toml",
        exists: true,
        hasAllowRoots: false,
        allowRootsValue: null,
        mcpClassification: { origin: "manual", hasCommand: true, hasArgs: true, hasEnv: false },
        mcpServerKeys: ["command", "args"],
        envKeys: [],
        mcpCommand: "npx",
        mcpEnabledTools: null,
        mcpToolTimeoutSec: null,
      },
    });

    const io = makeIo();
    const exitCode = await runCli(["node", "codex-claude", "doctor", "--json"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });
    const parsed = JSON.parse(io.stdout);
    expect(exitCode).toBe(1);
    expect(parsed.status).toBe("needs_setup");
    expect(parsed.checks.mcp_server.ok).toBe(false);
    expect(parsed.checks.mcp_server.launch_smoke).toEqual({
      ok: false,
      detail: "Skipped because MCP server config is not valid.",
    });
    expect(parsed.problems[0]).toHaveProperty("fix");
    expect(parsed.warnings.some((w: string) => w.includes("npx"))).toBe(true);
  });

  it("doctor detects missing default tools as needs_attention", async () => {
    await setupDoctorMocks({
      execCapture: async () => "1.0.0",
      scanResult: {
        configPath: "/fake/.codex/config.toml",
        exists: true,
        hasAllowRoots: false,
        allowRootsValue: null,
        mcpClassification: { origin: "manual", hasCommand: true, hasArgs: true, hasEnv: false },
        mcpServerKeys: ["command", "enabled_tools"],
        envKeys: [],
        mcpCommand: "codex-claude",
        mcpEnabledTools: ["claude_setup", "claude_task", "claude_result", "claude_apply"],
        mcpToolTimeoutSec: 600,
      },
    });

    const io = makeIo();
    const exitCode = await runCli(["node", "codex-claude", "doctor", "--json"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });
    const parsed = JSON.parse(io.stdout);
    expect(parsed.status).toBe("needs_attention");
    expect(parsed.checks.default_tools.ok).toBe(false);
    expect(parsed.warnings.some((w: string) => w.includes("cleanup"))).toBe(true);
  });

  it("doctor detects missing enabled_tools as needs_attention", async () => {
    const cwd = process.cwd();
    await setupDoctorMocks({
      execCapture: async () => "1.0.0",
      scanResult: {
        configPath: "/fake/.codex/config.toml",
        exists: true,
        hasAllowRoots: true,
        allowRootsValue: cwd,
        mcpClassification: { origin: "manual", hasCommand: true, hasArgs: true, hasEnv: false },
        mcpServerKeys: ["command"],
        envKeys: [],
        mcpCommand: "codex-claude",
        mcpEnabledTools: null,
        mcpToolTimeoutSec: 600,
      },
    });

    const io = makeIo();
    const exitCode = await runCli(["node", "codex-claude", "doctor", "--json"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });
    const parsed = JSON.parse(io.stdout);
    expect(parsed.status).toBe("needs_attention");
    expect(parsed.ready).toBe(false);
    expect(parsed.checks.default_tools.ok).toBe(false);
    expect(parsed.checks.default_tools.enabled_count).toBe(0);
    expect(parsed.warnings.some((w: string) => w.includes("enabled_tools is missing"))).toBe(true);
  });

  it("doctor detects allow roots from config file scan result", async () => {
    const cwd = process.cwd();
    await setupDoctorMocks({
      execCapture: async () => "1.0.0",
      scanResult: {
        configPath: "/fake/.codex/config.toml",
        exists: true,
        hasAllowRoots: true,
        allowRootsValue: cwd,
        mcpClassification: { origin: "manual", hasCommand: true, hasArgs: true, hasEnv: false },
        mcpServerKeys: ["command", "enabled_tools"],
        envKeys: [],
        mcpCommand: "codex-claude",
        mcpEnabledTools: ["claude_setup", "claude_task", "claude_result", "claude_apply", "claude_cleanup"],
        mcpToolTimeoutSec: 600,
      },
    });

    const io = makeIo();
    const exitCode = await runCli(["node", "codex-claude", "doctor", "--json"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });
    const parsed = JSON.parse(io.stdout);
    expect(parsed.checks.allow_roots.ok).toBe(true);
    expect(parsed.checks.allow_roots.current_repo_allowed).toBe(true);
  });

  it("doctor detects too-low tool_timeout_sec for default block wait", async () => {
    const cwd = process.cwd();
    await setupDoctorMocks({
      execCapture: async () => "1.0.0",
      scanResult: {
        configPath: "/fake/.codex/config.toml",
        exists: true,
        hasAllowRoots: true,
        allowRootsValue: cwd,
        mcpClassification: { origin: "manual", hasCommand: true, hasArgs: true, hasEnv: false },
        mcpServerKeys: ["command", "enabled_tools", "tool_timeout_sec"],
        envKeys: [],
        mcpCommand: "codex-claude",
        mcpEnabledTools: ["claude_setup", "claude_task", "claude_result", "claude_apply", "claude_cleanup"],
        mcpToolTimeoutSec: 120,
      },
    });

    const io = makeIo();
    const exitCode = await runCli(["node", "codex-claude", "doctor", "--json"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });
    const parsed = JSON.parse(io.stdout);
    expect(exitCode).toBe(1);
    expect(parsed.status).toBe("needs_attention");
    expect(parsed.checks.codex_config.tool_timeout_ok).toBe(false);
    expect(parsed.problems.some((p: { problem: string }) => p.problem.includes("tool_timeout_sec"))).toBe(true);
  });

  it("doctor reports active background job runner PIDs from persisted state", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-doctor-pids-"));
    cleanupPaths.push(stateDir);
    const jobsDir = path.join(stateDir, "jobs");
    await mkdir(jobsDir, { recursive: true });
    await writeFile(path.join(jobsDir, "job-active-implement.json"), JSON.stringify({
      job_id: "job-active-implement",
      type: "implement",
      status: "running",
      cwd: "/tmp/repo",
      created_at: "2026-05-20T00:00:00.000Z",
      updated_at: "2026-05-20T00:01:00.000Z",
      pid: 4242,
      payload: { cwd: "/tmp/repo", task: "implement something" },
    }));
    vi.stubEnv("CODEX_CLAUDE_BACKGROUND_STATE_DIR", stateDir);

    await setupDoctorMocks({
      execCapture: async (_cmd, args) => args[0] === "auth" ? "logged in" : "1.0.0",
      allowRoots: [process.cwd()],
      scanResult: {
        configPath: "/fake/.codex/config.toml",
        exists: true,
        hasAllowRoots: false,
        allowRootsValue: null,
        mcpClassification: { origin: "manual", hasCommand: true, hasArgs: true, hasEnv: false },
        mcpServerKeys: ["command", "enabled_tools"],
        envKeys: [],
        mcpCommand: "codex-claude",
        mcpEnabledTools: ["claude_setup", "claude_task", "claude_result", "claude_apply", "claude_cleanup"],
        mcpToolTimeoutSec: 600,
      },
    });

    const io = makeIo();
    const exitCode = await runCli(["node", "codex-claude", "doctor", "--json"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });
    const parsed = JSON.parse(io.stdout);
    expect(parsed.checks.active_claude_processes).toMatchObject({ ok: true, count: 1 });
    expect(parsed.checks.active_claude_processes.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ job_id: "job-active-implement", pid: 4242 }),
      ]),
    );
    expect(parsed.status).toBe("ready");
  });

  it("doctor text output includes active background job runner PID count", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-doctor-pids-"));
    cleanupPaths.push(stateDir);
    const jobsDir = path.join(stateDir, "jobs");
    await mkdir(jobsDir, { recursive: true });
    await writeFile(path.join(jobsDir, "job-active-implement.json"), JSON.stringify({
      job_id: "job-active-implement",
      type: "implement",
      status: "running",
      cwd: "/tmp/repo",
      created_at: "2026-05-20T00:00:00.000Z",
      updated_at: "2026-05-20T00:01:00.000Z",
      pid: 4242,
      payload: { cwd: "/tmp/repo", task: "implement something" },
    }));
    vi.stubEnv("CODEX_CLAUDE_BACKGROUND_STATE_DIR", stateDir);

    await setupDoctorMocks({
      execCapture: async (_cmd, args) => args[0] === "auth" ? "logged in" : "1.0.0",
      allowRoots: [process.cwd()],
      scanResult: {
        configPath: "/fake/.codex/config.toml",
        exists: true,
        hasAllowRoots: false,
        allowRootsValue: null,
        mcpClassification: { origin: "manual", hasCommand: true, hasArgs: true, hasEnv: false },
        mcpServerKeys: ["command", "enabled_tools"],
        envKeys: [],
        mcpCommand: "codex-claude",
        mcpEnabledTools: ["claude_setup", "claude_task", "claude_result", "claude_apply", "claude_cleanup"],
        mcpToolTimeoutSec: 600,
      },
    });

    const io = makeIo();
    const exitCode = await runCli(["node", "codex-claude", "doctor"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });

    expect(exitCode).toBe(0);
    expect(io.stdout).toContain("Active Claude processes: 1");
    expect(io.stdout).toContain("Status: ready");
  });
});
