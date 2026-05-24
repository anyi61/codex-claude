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

vi.mock("../src/claude-cli.js", async () => {
  const actual = await vi.importActual<typeof import("../src/claude-cli.js")>("../src/claude-cli.js");
  return {
    ...actual,
    cleanupDelegateArtifacts: vi.fn(),
  };
});

vi.mock("../src/environment-config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/environment-config.js")>("../src/environment-config.js");
  return {
    ...actual,
    readEnvironmentConfig: vi.fn(),
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
  vi.clearAllMocks();
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

  it("rejects --project --allow-root combination with clear scope explanation", async () => {
    const io = makeIo();
    const exitCode = await runCli(["node", "codex-claude", "setup", "--write", "--project", "--allow-root", "/tmp"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });
    expect(exitCode).toBe(2);
    expect(io.stderr).toContain("--project and --allow-root cannot be combined");
    expect(io.stderr).toContain("./.codex/config.toml");
    expect(io.stderr).toContain("global Codex allow-root");
  });

  it("setup with no flags prints usage describing each flag", async () => {
    const io = makeIo();
    const exitCode = await runCli(["node", "codex-claude", "setup"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });
    expect(exitCode).toBe(2);
    expect(io.stderr).toContain("Usage:");
    expect(io.stderr).toContain("--project");
    expect(io.stderr).toContain("--allow-root");
    expect(io.stderr).toContain("--force");
    expect(io.stderr).toContain("--print");
  });

  function makeArtifactCleanupResult(overrides: Partial<Awaited<ReturnType<typeof import("../src/claude-cli.js").cleanupDelegateArtifacts>>> = {}) {
    return {
      jobs: {
        dry_run: true,
        matched_count: 2,
        removed_count: 0,
        failed_count: 0,
        entries: [],
      },
      run_logs: {
        dry_run: true,
        matched_count: 3,
        removed_count: 0,
        failed_count: 0,
        entries: [],
      },
      ...overrides,
    };
  }

  async function mockedCleanupDelegateArtifacts() {
    const { cleanupDelegateArtifacts } = await import("../src/claude-cli.js");
    return vi.mocked(cleanupDelegateArtifacts);
  }

  it("cleanup-artifacts dry-runs artifacts by default", async () => {
    const cleanupDelegateArtifacts = await mockedCleanupDelegateArtifacts();
    cleanupDelegateArtifacts.mockResolvedValueOnce(makeArtifactCleanupResult());
    const io = makeIo();

    const exitCode = await runCli(["node", "codex-claude", "cleanup-artifacts"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });

    expect(exitCode).toBe(0);
    expect(cleanupDelegateArtifacts).toHaveBeenCalledWith({
      cwd: process.cwd(),
      older_than_hours: 720,
      dry_run: true,
      limit: 100,
    });
    expect(io.stdout).toContain("dry_run: true");
    expect(io.stdout).toContain("Jobs: 2 matched, 0 removed, 0 failed");
    expect(io.stdout).toContain("Run logs: 3 matched, 0 removed, 0 failed");
    expect(io.stdout).toContain("Run again with --execute");
    expect(io.stderr).toBe("");
  });

  it("cleanup-artifacts writes JSON output", async () => {
    const cleanupDelegateArtifacts = await mockedCleanupDelegateArtifacts();
    const result = makeArtifactCleanupResult({
      run_logs: {
        dry_run: true,
        matched_count: 1,
        removed_count: 0,
        failed_count: 0,
        entries: [{ run_id: "run-old", removed: false, updated_at: "2026-05-20T00:00:00.000Z" }],
      },
    });
    cleanupDelegateArtifacts.mockResolvedValueOnce(result);
    const io = makeIo();

    const exitCode = await runCli([
      "node",
      "codex-claude",
      "cleanup-artifacts",
      "--dry-run",
      "--json",
      "--cwd",
      "/tmp/repo",
      "--older-than-hours",
      "24",
      "--limit",
      "10",
    ], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });

    expect(exitCode).toBe(0);
    expect(cleanupDelegateArtifacts).toHaveBeenCalledWith({
      cwd: "/tmp/repo",
      older_than_hours: 24,
      dry_run: true,
      limit: 10,
    });
    expect(JSON.parse(io.stdout)).toEqual(result);
    expect(io.stderr).toBe("");
  });

  it("cleanup-artifacts executes only with explicit flag", async () => {
    const cleanupDelegateArtifacts = await mockedCleanupDelegateArtifacts();
    cleanupDelegateArtifacts.mockResolvedValueOnce(makeArtifactCleanupResult({
      jobs: {
        dry_run: false,
        matched_count: 2,
        removed_count: 2,
        failed_count: 0,
        entries: [],
      },
      run_logs: {
        dry_run: false,
        matched_count: 1,
        removed_count: 1,
        failed_count: 0,
        entries: [],
      },
    }));
    const io = makeIo();

    const exitCode = await runCli(["node", "codex-claude", "cleanup-artifacts", "--execute", "--older-than-hours", "168"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });

    expect(exitCode).toBe(0);
    expect(cleanupDelegateArtifacts).toHaveBeenCalledWith({
      cwd: process.cwd(),
      older_than_hours: 168,
      dry_run: false,
      limit: 100,
    });
    expect(io.stdout).toContain("dry_run: false");
    expect(io.stdout).toContain("Jobs: 2 matched, 2 removed, 0 failed");
    expect(io.stdout).toContain("Run logs: 1 matched, 1 removed, 0 failed");
  });

  it("cleanup-artifacts exits 1 when cleanup has failures", async () => {
    const cleanupDelegateArtifacts = await mockedCleanupDelegateArtifacts();
    cleanupDelegateArtifacts.mockResolvedValueOnce(makeArtifactCleanupResult({
      jobs: {
        dry_run: false,
        matched_count: 1,
        removed_count: 0,
        failed_count: 1,
        entries: [],
      },
    }));
    const io = makeIo();

    const exitCode = await runCli(["node", "codex-claude", "cleanup-artifacts", "--execute"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });

    expect(exitCode).toBe(1);
    expect(io.stdout).toContain("failed");
  });

  it("cleanup-artifacts rejects dry-run and execute together", async () => {
    const cleanupDelegateArtifacts = await mockedCleanupDelegateArtifacts();
    const io = makeIo();

    const exitCode = await runCli(["node", "codex-claude", "cleanup-artifacts", "--dry-run", "--execute"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });

    expect(exitCode).toBe(2);
    expect(cleanupDelegateArtifacts).not.toHaveBeenCalled();
    expect(io.stderr).toContain("--dry-run and --execute cannot be combined");
  });

  it("cleanup-artifacts rejects missing option values and invalid numbers", async () => {
    const cleanupDelegateArtifacts = await mockedCleanupDelegateArtifacts();
    const cases = [
      { argv: ["--cwd"], message: "--cwd requires a path argument" },
      { argv: ["--older-than-hours", "-1"], message: "--older-than-hours must be a non-negative number" },
      { argv: ["--limit", "0"], message: "--limit must be a positive integer" },
    ];

    for (const item of cases) {
      cleanupDelegateArtifacts.mockClear();
      const io = makeIo();
      const exitCode = await runCli(["node", "codex-claude", "cleanup-artifacts", ...item.argv], {
        writeOut: io.writeOut.bind(io),
        writeErr: io.writeErr.bind(io),
        startMcp: vi.fn(),
      });

      expect(exitCode).toBe(2);
      expect(cleanupDelegateArtifacts).not.toHaveBeenCalled();
      expect(io.stderr).toContain(item.message);
    }
  });

  it("cleanup-artifacts rejects unknown options", async () => {
    const cleanupDelegateArtifacts = await mockedCleanupDelegateArtifacts();
    const io = makeIo();

    const exitCode = await runCli(["node", "codex-claude", "cleanup-artifacts", "--remove-everything"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });

    expect(exitCode).toBe(2);
    expect(cleanupDelegateArtifacts).not.toHaveBeenCalled();
    expect(io.stderr).toContain("Unknown cleanup-artifacts option");
  });

  it("cleanup-artifacts rejects unknown positional arguments", async () => {
    const cleanupDelegateArtifacts = await mockedCleanupDelegateArtifacts();
    const io = makeIo();

    const exitCode = await runCli(["node", "codex-claude", "cleanup-artifacts", "leftoverarg"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });

    expect(exitCode).toBe(2);
    expect(cleanupDelegateArtifacts).not.toHaveBeenCalled();
    expect(io.stderr).toContain("Unknown cleanup-artifacts argument");
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

  it("doctor --json includes env_sanitization check", async () => {
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
    await runCli(["node", "codex-claude", "doctor", "--json"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });
    const parsed = JSON.parse(io.stdout);
    expect(parsed.checks).toHaveProperty("env_sanitization");
    expect(parsed.checks.env_sanitization).toHaveProperty("ok");
    expect(parsed.checks.env_sanitization).toHaveProperty("allowlisted_count");
    expect(parsed.checks.env_sanitization).toHaveProperty("allowlisted_names");
    expect(parsed.checks.env_sanitization).toHaveProperty("passthrough_count");
    expect(parsed.checks.env_sanitization).toHaveProperty("passthrough_names");
    expect(parsed.checks.env_sanitization).toHaveProperty("blocked_passthrough_count");
    expect(parsed.checks.env_sanitization).toHaveProperty("blocked_passthrough_names");
    // Must not leak values
    const jsonStr = JSON.stringify(parsed.checks.env_sanitization);
    expect(jsonStr).not.toMatch(/\/usr\//);
    expect(jsonStr).not.toContain("=");
  });

  it("doctor text output includes env sanitization info", async () => {
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
    await runCli(["node", "codex-claude", "doctor"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });
    expect(io.stdout).toContain("Env sanitization:");
    expect(io.stdout).toContain("allowlisted:");
  });

  it("doctor blocked passthrough does not make status not_ready", async () => {
    vi.stubEnv("CODEX_CLAUDE_ENV_PASSTHROUGH", "MY_SAFE_VAR,GITHUB_TOKEN,DB_PASSWORD");
    vi.stubEnv("MY_SAFE_VAR", "ok");

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
    await runCli(["node", "codex-claude", "doctor", "--json"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });
    const parsed = JSON.parse(io.stdout);
    expect(parsed.checks.env_sanitization.blocked_passthrough_count).toBe(2);
    expect(parsed.checks.env_sanitization.blocked_passthrough_names).toEqual(["GITHUB_TOKEN", "DB_PASSWORD"]);
    expect(parsed.checks.env_sanitization.passthrough_names).toEqual(["MY_SAFE_VAR"]);
    // Blocked passthrough should NOT make status not_ready
    expect(parsed.status).not.toBe("not_ready");
  });

  // Environment config doctor tests

  async function setupEnvConfigMock(override: Record<string, unknown> | null | undefined) {
    const envConfigModule = vi.mocked(await import("../src/environment-config.js"));
    if (override === undefined) {
      // File absent
      envConfigModule.readEnvironmentConfig.mockResolvedValue(null);
    } else if (override === null) {
      // Return default (undefined) — simulates real read
      envConfigModule.readEnvironmentConfig.mockResolvedValue(undefined as any);
    } else {
      // Return a custom result
      const base = {
        summary: {
          exists: true,
          path: "/fake/.codex-claude-delegate/environment.json",
          ok: true,
          fields_present: [] as string[],
          install: false,
          test: false,
          start: false,
          symlink_directories_count: 0,
          sparse_paths_count: 0,
          errors: [] as Array<{ field: string; message: string }>,
          warnings: [] as Array<{ field: string; message: string }>,
        },
        _raw: {} as Record<string, unknown> | undefined,
      };
      const merged = {
        summary: { ...base.summary, ...(override.summary ?? {}) },
        _raw: override._raw ?? base._raw,
      };
      envConfigModule.readEnvironmentConfig.mockResolvedValue(merged as any);
    }
  }

  it("doctor --json includes environment_config check when file is absent", async () => {
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
    await setupEnvConfigMock(undefined);

    const io = makeIo();
    await runCli(["node", "codex-claude", "doctor", "--json"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });
    const parsed = JSON.parse(io.stdout);
    expect(parsed.checks).toHaveProperty("environment_config");
    expect(parsed.checks.environment_config.exists).toBe(false);
    expect(parsed.checks.environment_config.ok).toBe(true);
  });

  it("doctor --json includes environment_config check when file is present and valid", async () => {
    await setupDoctorMocks({
      execCapture: async (cmd, args) => {
        if (args[0] === "auth") return "logged in";
        return "1.0.0";
      },
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
    await setupEnvConfigMock({
      summary: {
        exists: true,
        path: "/fake/path",
        ok: true,
        fields_present: ["test", "install"],
        install: true,
        test: true,
        start: false,
        symlink_directories_count: 0,
        sparse_paths_count: 1,
        errors: [],
        warnings: [],
      },
    });

    const io = makeIo();
    await runCli(["node", "codex-claude", "doctor", "--json"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });
    const parsed = JSON.parse(io.stdout);
    expect(parsed.checks.environment_config.exists).toBe(true);
    expect(parsed.checks.environment_config.ok).toBe(true);
    expect(parsed.checks.environment_config.fields_present).toContain("test");
    expect(parsed.checks.environment_config.fields_present).toContain("install");
    expect(parsed.checks.environment_config.errors).toBe(0);
    expect(parsed.checks.environment_config.warnings).toBe(0);
  });

  it("doctor --json includes environment_config with errors when config is invalid", async () => {
    await setupDoctorMocks({
      execCapture: async (cmd, args) => {
        if (args[0] === "auth") return "logged in";
        return "1.0.0";
      },
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
    await setupEnvConfigMock({
      summary: {
        exists: true,
        path: "/fake/path",
        ok: false,
        fields_present: ["install"],
        install: false,
        test: false,
        start: false,
        symlink_directories_count: 0,
        sparse_paths_count: 0,
        errors: [{ field: "install", message: '"install" must not be empty' }],
        warnings: [],
      },
    });

    const io = makeIo();
    await runCli(["node", "codex-claude", "doctor", "--json"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });
    const parsed = JSON.parse(io.stdout);
    expect(parsed.checks.environment_config.exists).toBe(true);
    expect(parsed.checks.environment_config.ok).toBe(false);
    expect(parsed.checks.environment_config.errors).toBeGreaterThan(0);
    expect(parsed.problems.some((problem: { problem: string }) => problem.problem.includes("Environment config"))).toBe(true);
    expect(parsed.ready).toBe(false);
  });

  it("doctor text output shows environment config line when file exists", async () => {
    await setupDoctorMocks({
      execCapture: async (cmd, args) => {
        if (args[0] === "auth") return "logged in";
        return "1.0.0";
      },
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
    await setupEnvConfigMock({
      summary: {
        exists: true,
        path: "/fake/path",
        ok: true,
        fields_present: ["test"],
        install: false,
        test: true,
        start: false,
        symlink_directories_count: 0,
        sparse_paths_count: 0,
        errors: [],
        warnings: [],
      },
    });

    const io = makeIo();
    await runCli(["node", "codex-claude", "doctor"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });
    expect(io.stdout).toContain("Environment config:");
    expect(io.stdout).toContain("test");
  });

  it("doctor text output does not show environment config line when file absent", async () => {
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
    await setupEnvConfigMock(undefined);

    const io = makeIo();
    await runCli(["node", "codex-claude", "doctor"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });
    expect(io.stdout).not.toContain("Environment config:");
  });

  // Phase 2 doctor tests

  it("doctor --json exposes Phase 2 verification summary safely", async () => {
    await setupDoctorMocks({
      execCapture: async (cmd, args) => {
        if (args[0] === "auth") return "logged in";
        return "1.0.0";
      },
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
    await setupEnvConfigMock({
      summary: {
        exists: true,
        path: "/fake/path",
        ok: true,
        fields_present: ["test"],
        install: false,
        test: true,
        start: false,
        symlink_directories_count: 0,
        sparse_paths_count: 0,
        errors: [],
        warnings: [],
        verification_allowed_scripts_count: 2,
        verification_allowed_scripts: ["test:unit", "lint"],
        verification_timeout_sec: 180,
        artifacts_retention_days: 30,
        environment_passthrough_count: 1,
        environment_passthrough: ["MY_VAR"],
      },
    });

    const io = makeIo();
    await runCli(["node", "codex-claude", "doctor", "--json"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });
    const parsed = JSON.parse(io.stdout);
    expect(parsed.checks.environment_config.verification_allowed_scripts_count).toBe(2);
    expect(parsed.checks.environment_config.verification_allowed_scripts).toEqual(["test:unit", "lint"]);
    expect(parsed.checks.environment_config.verification_timeout_sec).toBe(180);
    expect(parsed.checks.environment_config.artifacts_retention_days).toBe(30);
    expect(parsed.checks.environment_config.environment_passthrough_count).toBe(1);
    expect(parsed.checks.environment_config.environment_passthrough).toEqual(["MY_VAR"]);
    // Must not leak command values
    const jsonStr = JSON.stringify(parsed.checks.environment_config);
    expect(jsonStr).not.toContain("vitest");
    expect(jsonStr).not.toContain("secret");
    expect(jsonStr).not.toContain("token");
  });

  it("doctor text output includes Phase 2 safe summary", async () => {
    await setupDoctorMocks({
      execCapture: async (cmd, args) => {
        if (args[0] === "auth") return "logged in";
        return "1.0.0";
      },
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
    await setupEnvConfigMock({
      summary: {
        exists: true,
        path: "/fake/path",
        ok: true,
        fields_present: ["test"],
        install: false,
        test: true,
        start: false,
        symlink_directories_count: 0,
        sparse_paths_count: 0,
        errors: [],
        warnings: [],
        verification_allowed_scripts_count: 2,
        verification_allowed_scripts: ["test:unit", "lint"],
        verification_timeout_sec: 180,
        artifacts_retention_days: 30,
        environment_passthrough_count: 1,
        environment_passthrough: ["MY_VAR"],
      },
    });

    const io = makeIo();
    await runCli(["node", "codex-claude", "doctor"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });
    expect(io.stdout).toContain("Environment config:");
    expect(io.stdout).toContain("allowed scripts: 2");
    expect(io.stdout).toContain("timeout: 180s");
    expect(io.stdout).toContain("retention: 30d");
    expect(io.stdout).toContain("passthrough: 1");
    expect(io.stdout).toContain("Allowed scripts: test:unit, lint");
    expect(io.stdout).toContain("Passthrough: MY_VAR");
    // Must not leak command values
    expect(io.stdout).not.toContain("vitest");
    expect(io.stdout).not.toContain("secret");
  });
});
