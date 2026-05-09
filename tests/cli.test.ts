import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
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

describe("codex-claude CLI", () => {
  it("prints package version", async () => {
    const io = makeIo();
    const exitCode = await runCli(["node", "codex-claude", "--version"], {
      writeOut: io.writeOut.bind(io),
      writeErr: io.writeErr.bind(io),
      startMcp: vi.fn(),
    });

    expect(exitCode).toBe(0);
    expect(io.stdout).toMatch(/^codex-claude-delegate-mcp v\d+\.\d+\.\d+/);
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
    expect(pkg.bin).toEqual({ "codex-claude": "./dist/cli.js" });
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
    expect(pkg.bin).toEqual({ "codex-claude": "./dist/cli.js" });
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
  }) {
    const guardModule = vi.mocked(await import("../src/guard.js"));
    guardModule.execCapture.mockImplementation(opts.execCapture ?? (async () => "1.0.0"));
    guardModule.getAllowRoots.mockReturnValue(opts.allowRoots ?? []);
    const codexModule = vi.mocked(await import("../src/codex-config.js"));
    codexModule.scanClaudeDelegateConfig.mockResolvedValue(opts.scanResult ?? {
      configPath: "/fake/.codex/config.toml",
      exists: false,
      hasAllowRoots: false,
      allowRootsValue: null,
      mcpClassification: null,
      mcpServerKeys: [],
      envKeys: [],
      mcpCommand: null,
      mcpEnabledTools: null,
    });
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
        mcpEnabledTools: ["claude_setup", "claude_task", "claude_job_wait", "claude_result", "claude_apply", "claude_cleanup"],
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
        mcpEnabledTools: ["claude_setup", "claude_task", "claude_job_wait", "claude_result", "claude_apply", "claude_cleanup"],
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
        mcpEnabledTools: ["claude_setup", "claude_task", "claude_job_wait", "claude_result", "claude_apply"],
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
        mcpEnabledTools: ["claude_setup", "claude_task", "claude_job_wait", "claude_result", "claude_apply", "claude_cleanup"],
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
});
