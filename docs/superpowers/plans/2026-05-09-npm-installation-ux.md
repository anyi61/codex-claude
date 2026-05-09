# Npm Installation UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the PRD-defined npm-only installation and first-use experience for `codex-claude-delegate-mcp`.

**Scope:** P0 items are in scope with full implementation. P1 items `setup --project`, `print-config --source`, and `print-config --project` are included with focused implementation and tests because the PRD names them in the CLI surface. P2 items (`stable launcher`, local config directory, MCP structured output schemas) are out of scope for this plan.

**Architecture:** Add a user-facing CLI entrypoint (`src/cli.ts`) that can either start the existing MCP stdio server or run local setup/doctor/print-config commands. Keep MCP tool behavior in `src/server.ts` / `src/claude-cli.ts`, but add a small shared interaction helper so the default 6 tools consistently return user-readable `interaction` blocks. Codex config writing should live in focused pure functions in `src/codex-config.ts` and should only emit npm global `command = "codex-claude"` config.

**Tech Stack:** TypeScript ESM, Node.js >= 20, Zod, MCP SDK stdio server, Vitest. Implementation must preserve two-space indentation, double quotes, semicolons, local `.js` import extensions, and snake_case MCP wire fields.

---

## Product Decisions Locked By PRD

- Ordinary users install only with `npm install -g codex-claude-delegate-mcp`.
- Do not provide or document an `npx` temporary-run path.
- Do not keep Codex plugin marketplace as an ordinary-user installation path.
- The only user command is `codex-claude`; `codex-claude-delegate-mcp` remains the npm package name only, not a bin alias.
- `codex-claude` with no args starts the MCP stdio server.
- `codex-claude mcp` also starts the MCP stdio server.
- `setup --write` writes `command = "codex-claude"`; no npx/global-bin auto-selection exists.
- Default config enables only 6 tools: `claude_setup`, `claude_task`, `claude_job_wait`, `claude_result`, `claude_apply`, `claude_cleanup`.
- `--allow-root` is P0.
- `interaction` is P0 and must cover all 6 default tools.
- `claude_setup` may report review-gate status, but must not force enable/install review gate. Review-gate writes stay in Advanced / Debug `claude_review_gate`.

## File Responsibility Map

- Create `src/cli.ts`: Parse CLI args, dispatch `mcp`, `--version`, `print-config`, `setup`, and `doctor`; import and call `main()` from `src/server.ts` for MCP mode.
- Modify `src/server.ts`: Export a reusable MCP server `main()` that can be called by `src/cli.ts`; add interaction blocks to the default 6 tool results; keep Advanced / Debug tools unchanged unless needed for shared helpers.
- Modify `src/schema.ts`: Add shared `InteractionBlock` types and helpers if they fit better here; preserve existing `jsonResult()` compatibility.
- Modify `src/claude-cli.ts`: Add interaction data to `runClaudeSetup`, `runClaudeTask`, `waitForBackgroundJob`, `getClaudeResult`, `runClaudeApply`, and `runClaudeCleanup` return objects or wrap them at server boundary.
- Modify `src/codex-config.ts`: Add pure TOML generation, setup write/print support, backup/force behavior, allow-root update helpers, config scanning helpers for doctor, and project/global path helpers.
- Create `tests/cli.test.ts`: CLI command behavior, stdout/stderr, exit codes, no-arg/mcp dispatch seams, version output, print-config, setup dry/print/write cases, doctor JSON cases.
- Modify `tests/codex-config.test.ts`: Pure TOML/config behavior for setup, force backup naming seam, allow roots, dangerous root rejection, default 6 tools, no npx output.
- Modify `tests/server.test.ts`, `tests/claude-cli.test.ts`, `tests/job-wait.test.ts`: Verify interaction blocks for the default 6 tools and no direct non-preview apply suggestion.
- Modify `package.json`: Add `bin`, `files`, `engines`, `prepublishOnly`; ensure package still builds plugin artifacts only as maintainer/internal artifacts.
- Create: `LICENSE` if absent, because package metadata declares MIT and the PRD publish package includes LICENSE.
- Modify `README.md`: Rewrite ordinary-user path to npm global only; remove plugin marketplace and npx instructions from ordinary-user docs.
- Modify `docs/development-overview.md`: Document npm-only user install, CLI architecture, and plugin marketplace deprecation for ordinary users.
- Modify plugin skill docs only if they mention ordinary-user installation; keep MCP usage guidance current.

## Task 1: CLI Entrypoint And Package Metadata

**Files:**
- Create: `src/cli.ts`
- Modify: `src/server.ts`
- Modify: `package.json`
- Create: `tests/cli.test.ts`

- [ ] **Step 1: Write CLI tests first**

Add `tests/cli.test.ts` with tests that execute exported CLI functions in-process rather than spawning real long-running MCP stdio. Use injectable dependencies so tests can assert dispatch without starting a real server.

Required test cases:

```ts
import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";

function makeIo() {
  return {
    stdout: "",
    stderr: "",
    writeOut(text: string) { this.stdout += text; },
    writeErr(text: string) { this.stderr += text; },
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
  });
});
```

- [ ] **Step 2: Implement minimal CLI module**

Create `src/cli.ts` with:

```ts
#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { main as startMcpServer } from "./server.js";

export interface CliDependencies {
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
  startMcp?: () => Promise<void>;
}

async function packageVersion(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = resolve(here, "..", "package.json");
  const raw = await readFile(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as { name: string; version: string };
  return `${parsed.name} v${parsed.version}`;
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
  return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isDirectRun()) {
  runCli().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
```

- [ ] **Step 3: Export server main without changing direct-run behavior**

In `src/server.ts`, ensure `main()` is exported and still used when `server.ts` is executed directly. If it is already exported, only adjust imports if necessary.

Expected shape:

```ts
export async function main(): Promise<void> {
  const server = new Server(
    { name: "codex-claude-delegate-mcp", version: await packageVersion() },
    { capabilities: { tools: {} } },
  );
  registerToolDefinitions(server);
  registerToolHandlers(server);
  await server.connect(new StdioServerTransport());
}
```

If `server.ts` cannot import the CLI helper without a cycle, add a tiny shared `src/package-info.ts` helper that reads package name/version and import it from both `src/cli.ts` and `src/server.ts`. Do not hard-code `0.1.0`.

- [ ] **Step 4: Update package metadata**

Modify `package.json`:

```json
{
  "main": "dist/server.js",
  "bin": {
    "codex-claude": "./dist/cli.js"
  },
  "files": [
    "dist/",
    "plugins/codex-claude-delegate/server/",
    "plugins/codex-claude-delegate/skills/",
    "plugins/codex-claude-delegate/hooks/",
    "plugins/codex-claude-delegate/.codex-plugin/",
    "plugins/codex-claude-delegate/.mcp.json",
    "README.md",
    "LICENSE"
  ],
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "prepublishOnly": "npm run build && npm run typecheck && npm test && npm run build:plugin && npm run check:plugin"
  }
}
```

Preserve existing scripts and dependencies. Do not add `codex-claude-delegate-mcp` under `bin`.

- [ ] **Step 5: Add LICENSE if absent**

If the repository does not already contain a `LICENSE` file, create one matching the existing `package.json` `license` field. Use the standard MIT License text with the project owner/year. If maintainers do not want to add a license file, remove `LICENSE` from the package `files` array and update the PRD before implementation; do not leave package metadata and package files inconsistent.

- [ ] **Step 6: Implementer verification**

Implementer runs:

```bash
npm test -- tests/cli.test.ts
npm run build
node dist/cli.js --version
```

Expected:

```text
cli tests pass
build succeeds
node dist/cli.js --version prints codex-claude-delegate-mcp v<package version>
```

## Task 2: Config Generation, Setup, And Print Config

**Files:**
- Modify: `src/codex-config.ts`
- Modify: `src/cli.ts`
- Modify: `tests/codex-config.test.ts`
- Modify: `tests/cli.test.ts`

- [ ] **Step 1: Add pure config tests**

Extend `tests/codex-config.test.ts` with tests for npm-only config generation.

Required assertions:

```ts
import {
  DEFAULT_ENABLED_TOOLS,
  renderClaudeDelegateMcpConfig,
  upsertClaudeDelegateMcpServer,
} from "../src/codex-config.js";

describe("npm global setup config", () => {
  it("renders only codex-claude command and default 6 tools", () => {
    const toml = renderClaudeDelegateMcpConfig();
    expect(toml).toContain('[mcp_servers.claude_delegate]');
    expect(toml).toContain('command = "codex-claude"');
    expect(toml).not.toContain('command = "npx"');
    expect(toml).not.toContain('codex-claude-delegate-mcp"]');
    for (const tool of DEFAULT_ENABLED_TOOLS) expect(toml).toContain(`"${tool}"`);
    expect(toml).not.toContain("claude_implement");
    expect(toml).not.toContain("claude_job_cancel");
  });

  it("does not overwrite an existing server unless force is true", () => {
    const existing = '[mcp_servers.claude_delegate]\ncommand = "custom"\n';
    const result = upsertClaudeDelegateMcpServer(existing, { force: false });
    expect(result.changed).toBe(false);
    expect(result.content).toBe(existing);
  });

  it("replaces an existing server when force is true", () => {
    const existing = '[mcp_servers.claude_delegate]\ncommand = "custom"\n';
    const result = upsertClaudeDelegateMcpServer(existing, { force: true });
    expect(result.changed).toBe(true);
    expect(result.content).toContain('command = "codex-claude"');
    expect(result.content).not.toContain('command = "custom"');
  });
});
```

- [ ] **Step 2: Implement config helpers**

In `src/codex-config.ts`, add exports:

```ts
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
```

Prefer reusing the existing table parsing helpers if this regex becomes hard to reason about. Keep tests strict enough to catch accidental npx output.

- [ ] **Step 3: Add setup and print-config CLI tests**

In `tests/cli.test.ts`, add tests using a temp HOME/CODEX_HOME and dependency-injected filesystem where practical. At minimum cover:

```ts
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
```

- [ ] **Step 4: Implement `print-config` and `setup --print`**

In `src/cli.ts`:

```ts
if (command === "print-config") {
  if (args.includes("--npx")) {
    writeErr("--npx is not supported. Install globally with npm install -g codex-claude-delegate-mcp.\n");
    return 2;
  }
  writeOut(renderClaudeDelegateMcpConfig());
  return 0;
}

if (command === "setup" && args.includes("--print")) {
  writeOut("Codex-Claude setup --print\n\n");
  writeOut(renderClaudeDelegateMcpConfig());
  return 0;
}
```

- [ ] **Step 5: Implement `print-config --source` and `print-config --project`**

Add explicit support for the P1 print variants while keeping ordinary-user output npm-global by default.

Required behavior:

```text
codex-claude print-config
  -> prints command = "codex-claude" config

codex-claude print-config --source /absolute/path/to/repo
  -> prints command = "node" and args = ["/absolute/path/to/repo/dist/cli.js"]
  -> rejects relative source paths with exit code 2
  -> does not include an "mcp" arg because no-arg cli starts MCP

codex-claude print-config --project
  -> prints the same MCP server TOML and a short note that the target path is ./.codex/config.toml
```

Add tests:

```ts
it("prints source config without mcp subcommand", async () => {
  const io = makeIo();
  const exitCode = await runCli(["node", "codex-claude", "print-config", "--source", "/repo"], depsWithIo(io));
  expect(exitCode).toBe(0);
  expect(io.stdout).toContain('command = "node"');
  expect(io.stdout).toContain('args = ["/repo/dist/cli.js"]');
  expect(io.stdout).not.toContain('"mcp"');
});

it("prints project config note", async () => {
  const io = makeIo();
  const exitCode = await runCli(["node", "codex-claude", "print-config", "--project"], depsWithIo(io));
  expect(exitCode).toBe(0);
  expect(io.stdout).toContain('./.codex/config.toml');
  expect(io.stdout).toContain('command = "codex-claude"');
});
```

- [ ] **Step 6: Implement `setup --write`, `--force`, and `--allow-root`**

Add CLI behavior:

```text
codex-claude setup --write
codex-claude setup --write --force
codex-claude setup --write --allow-root /abs/repo
```

Implementation requirements:

- Locate config via `CODEX_HOME` or `$HOME/.codex/config.toml`.
- Create parent directory if missing.
- If config file does not exist, create it.
- If `[mcp_servers.claude_delegate]` exists and `--force` is absent, do not modify.
- If `--force`, write timestamped backup before replacing.
- If `--allow-root`, call existing allow-root update path, reject dangerous roots via `dangerousRoot()` and realpath the target.
- New generated MCP server config must never include npx.

- [ ] **Step 7: Implement `setup --write --project`**

Add P1 project-level setup support:

```text
codex-claude setup --write --project
  -> target ./.codex/config.toml under current working directory
  -> create ./.codex/ if missing
  -> default no overwrite when claude_delegate exists
  -> --force creates ./.codex/config.toml.bak-YYYYMMDD-HHMMSS before replacement
  -> writes command = "codex-claude" and default 6 tools only
```

Add tests:

```ts
it("writes project config", async () => {
  const project = await makeTempProject();
  const exitCode = await runCli(["node", "codex-claude", "setup", "--write", "--project"], depsForCwd(project));
  expect(exitCode).toBe(0);
  const config = await readFile(join(project, ".codex", "config.toml"), "utf8");
  expect(config).toContain('command = "codex-claude"');
  expect(config).not.toContain('command = "npx"');
});
```

- [ ] **Step 8: Implementer verification**

Implementer runs:

```bash
npm test -- tests/codex-config.test.ts tests/cli.test.ts
node dist/cli.js print-config
node dist/cli.js print-config --source "$(pwd)"
node dist/cli.js print-config --project
node dist/cli.js setup --print
```

Expected:

```text
no npx config appears
setup --print includes command = "codex-claude"
default enabled_tools count is 6
```

## Task 3: Doctor Command

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/codex-config.ts`
- Modify: `src/guard.ts` only if a small reusable helper is needed
- Create or extend: `tests/cli.test.ts`

- [ ] **Step 1: Write doctor tests**

Add CLI tests with dependency injection for command execution. Required cases:

```ts
it("prints ready doctor output", async () => {
  const io = makeIo();
  const exitCode = await runCli(["node", "codex-claude", "doctor"], fakeReadyDoctorDeps(io));
  expect(exitCode).toBe(0);
  expect(io.stdout).toContain("Status: ready");
  expect(io.stdout).toContain("Default tools: 6 enabled");
});

it("prints JSON doctor output", async () => {
  const io = makeIo();
  const exitCode = await runCli(["node", "codex-claude", "doctor", "--json"], fakeNotReadyDoctorDeps(io));
  expect(exitCode).toBe(1);
  const parsed = JSON.parse(io.stdout);
  expect(parsed.ready).toBe(false);
  expect(parsed.checks.claude_cli.authenticated).toBe(false);
});

it("reports needs_setup when claude_delegate is missing", async () => {
  const io = makeIo();
  const exitCode = await runCli(["node", "codex-claude", "doctor"], fakeMissingConfigDeps(io));
  expect(exitCode).toBe(1);
  expect(io.stdout).toContain("Status: needs_setup");
  expect(io.stdout).toContain("codex-claude setup --write");
});

it("reports needs_attention when cwd is outside allow roots", async () => {
  const io = makeIo();
  const exitCode = await runCli(["node", "codex-claude", "doctor"], fakeOutsideAllowRootsDeps(io));
  expect(exitCode).toBe(1);
  expect(io.stdout).toContain("Status: needs_attention");
  expect(io.stdout).toContain('codex-claude setup --write --allow-root');
});
```

- [ ] **Step 2: Define doctor result types**

In `src/cli.ts` or a new `src/doctor.ts` if the file gets large:

```ts
export type DoctorStatus = "ready" | "not_ready" | "needs_setup" | "needs_attention";

export interface DoctorResult {
  ready: boolean;
  status: DoctorStatus;
  checks: {
    node: { ok: boolean; version: string; required: string };
    package: { ok: boolean; name: string; version: string };
    claude_cli: { ok: boolean; path?: string; version?: string; authenticated?: boolean };
    git: { ok: boolean; version?: string; worktree: boolean };
    codex_config: { ok: boolean; path: string };
    mcp_server: { ok: boolean; name: "claude_delegate" };
    default_tools: { ok: boolean; enabled_count: number; enabled: string[] };
    allow_roots: { ok: boolean; current_repo_allowed?: boolean };
  };
  warnings: string[];
  next_step: string;
}
```

- [ ] **Step 3: Implement checks**

Required checks:

- Node major version >= 20.
- Package name/version from package.json.
- Claude CLI path via `CLAUDE_BIN` or PATH lookup.
- `claude --version` works.
- Claude auth works. Use a conservative command that implementation validates against the installed Claude CLI. If no stable `whoami` exists, run the smallest non-mutating command available and classify failure as not authenticated/cannot run non-interactively.
- Git exists via `git --version`.
- Worktree support via `git worktree list` when current cwd is a git repo.
- Codex config exists.
- Config has `[mcp_servers.claude_delegate]` with `command = "codex-claude"`.
- Default 6 tools enabled. If `enabled_tools` absent, classify as needs_attention because PRD requires explicit default 6.
- Current cwd is within allow roots.

- [ ] **Step 4: Human and JSON output**

Human output must include check marks and a final status line. JSON output must match PRD shape and be parseable with `JSON.parse()`.

Exit codes:

```text
0: ready
1: not_ready, needs_setup, needs_attention
2: invalid CLI arguments
```

- [ ] **Step 5: Implementer verification**

Implementer runs:

```bash
npm test -- tests/cli.test.ts -t "doctor"
node dist/cli.js doctor --json
```

Expected:

```text
doctor JSON is valid
doctor never reports ready if Claude auth fails or config is missing
```

## Task 4: Interaction Blocks For Default 6 MCP Tools

**Files:**
- Modify: `src/schema.ts`
- Modify: `src/server.ts` and/or `src/claude-cli.ts`
- Modify: `tests/server.test.ts`
- Modify: `tests/claude-cli.test.ts`
- Modify: `tests/job-wait.test.ts`

- [ ] **Step 1: Add shared type and helper**

In `src/schema.ts`:

```ts
export interface InteractionBlock {
  headline: string;
  state: string;
  next_step: string;
}

export function withInteraction<T extends Record<string, unknown>>(
  result: T,
  interaction: InteractionBlock,
): T & { interaction: InteractionBlock } {
  return { ...result, interaction };
}
```

- [ ] **Step 2: Write coverage tests for all default tools**

Add a server-level test that mocks each default tool handler result and verifies an `interaction` object exists on successful/default responses:

```ts
const defaultTools = [
  "claude_setup",
  "claude_task",
  "claude_job_wait",
  "claude_result",
  "claude_apply",
  "claude_cleanup",
];

it.each(defaultTools)("returns interaction for %s", async (toolName) => {
  const result = await callRepresentativeTool(toolName);
  const payload = JSON.parse(result.content[0].text);
  expect(payload.interaction).toEqual({
    headline: expect.any(String),
    state: expect.any(String),
    next_step: expect.any(String),
  });
});
```

Use existing test helpers in `tests/server.test.ts`; do not call real Claude.

- [ ] **Step 3: Add interactions**

Required states:

```text
claude_setup ready: state="ready"
claude_setup needs_attention: state="needs_attention"
claude_task queued: state="delegated_execution"
claude_job_wait running: state="waiting"
claude_job_wait poll_too_soon: state="poll_too_soon"
claude_job_wait stale: state="needs_attention"
claude_result implement ready: state="result_ready"
claude_apply preview: state="apply_preview"
claude_apply refused: state="needs_user"
claude_apply applied: state="applied"
claude_cleanup dry_run: state="cleanup_preview"
claude_cleanup dry_run=false: state="cleaned"
```

Keep text concise and actionable. Do not remove existing fields.

- [ ] **Step 4: Preserve apply safety**

Ensure `buildNextActions()` still only suggests preview apply:

```ts
expect(applyActions).toEqual([
  expect.objectContaining({
    tool: "claude_apply",
    args: expect.objectContaining({ preview: true }),
  }),
]);
expect(applyActions).not.toContainEqual(
  expect.objectContaining({ args: expect.objectContaining({ cleanup: true }) }),
);
```

Ensure non-preview apply still requires `confirmed_by_user=true`.

- [ ] **Step 5: Implementer verification**

Implementer runs targeted tests:

```bash
npm test -- tests/server.test.ts tests/claude-cli.test.ts tests/job-wait.test.ts
```

Expected:

```text
all default 6 tools have interaction blocks
no direct non-preview apply suggestions exist
```

## Task 5: Setup Behavior Around Review Gate

**Files:**
- Modify: `src/claude-cli.ts`
- Modify: `src/server.ts` if needed
- Modify: `tests/server.test.ts`
- Modify: `tests/review-gate.test.ts`
- Modify: `plugins/codex-claude-delegate/skills/claude-delegate.md` if it states setup enables review gate

- [ ] **Step 1: Write tests that setup does not force-enable review gate**

Add tests asserting `claude_setup` reports review-gate availability/status but does not persistently enable or disable review gate unless `claude_review_gate` is called.

Representative assertion:

```ts
it("claude_setup reports review gate state without enabling it", async () => {
  const result = await handleToolCall("claude_setup", { cwd: repoPath });
  const payload = JSON.parse(result.content[0].text);
  expect(payload.review_gate).toBeDefined();
  expect(payload.interaction.state).toBe("ready");
  expect(await readReviewGateEnabled(repoPath)).not.toBe(true);
});
```

Use existing review-gate test helpers or add a small helper local to the test file.

- [ ] **Step 2: Adjust setup implementation if needed**

If current `runClaudeSetup()` writes hook manifests or enables gate, split behavior:

- `claude_setup`: read/check/report only.
- `claude_review_gate action=enable`: writes/enables.
- `claude_review_gate action=disable`: disables.
- `claude_review_gate action=status`: reports.

Do not remove readiness checks. Do not make review gate a default tool.

- [ ] **Step 3: Update tool descriptions**

Update `TOOL_DEFINITIONS` text for `claude_setup` to say it checks review-gate availability/status, not that it installs/enables review gate.

- [ ] **Step 4: Implementer verification**

Implementer runs:

```bash
npm test -- tests/review-gate.test.ts tests/server.test.ts -t "setup|review gate|claude_review_gate"
```

Expected:

```text
claude_setup does not enable review gate
claude_review_gate remains the only write/enable path
```

## Task 6: README And Documentation Rewrite

**Files:**
- Modify: `README.md`
- Modify: `docs/development-overview.md`
- Modify: `plugins/codex-claude-delegate/skills/claude-delegate.md`
- Modify: `plugins/codex-claude-delegate/skills/claude-review.md` only if it mentions install path
- Modify: `docs/onboarding-plan.md` or mark as historical if it conflicts

- [ ] **Step 1: Rewrite README first screen**

README top sections must be:

```md
# codex-claude-delegate-mcp

Let Codex delegate read/review/write tasks to Claude Code through a local MCP server.

## Quick Start

```bash
npm install -g codex-claude-delegate-mcp
codex-claude setup --write
codex-claude doctor
```

Restart Codex, then ask:

```text
Use claude_setup to check this repository.
```
```

Do not include Codex plugin marketplace installation in ordinary-user Quick Start, Install, Troubleshooting, or demo sections.

- [ ] **Step 2: Add 60-second demo**

Demo must cover:

```text
claude_setup
claude_task mode=read
claude_task mode=write with instruction_files
claude_job_wait
claude_result
claude_apply preview=true
user approval
claude_apply cleanup=true confirmed_by_user=true
claude_cleanup dry_run=true
```

Use a small write demo such as updating a temporary docs paragraph. Do not imply complex business correctness is required for first-run validation.

- [ ] **Step 3: Remove npx and plugin marketplace ordinary-user paths**

Search docs for these terms:

```bash
rg -n "npx|plugin marketplace|codex plugin marketplace|/plugins|Codex plugin" README.md docs plugins/codex-claude-delegate/skills
```

Allowed remaining mentions:

- PRD historical/non-goal statements.
- Development docs explicitly marked as internal/maintainer/historical packaging.
- File paths under `plugins/` when discussing repository structure.

- [ ] **Step 4: Update development overview**

Document:

```text
Ordinary users install through npm global only.
Codex plugin marketplace is no longer an ordinary-user install path.
The plugin directory remains repository/internal packaging unless separately removed in a future cleanup.
```

- [ ] **Step 5: Implementer verification**

Implementer runs doc grep checks:

```bash
rg -n "npx|plugin marketplace|codex plugin marketplace" README.md docs plugins/codex-claude-delegate/skills
```

Expected:

```text
No ordinary-user install path recommends npx or Codex plugin marketplace.
Any remaining mention is clearly historical, internal, non-goal, or repo-structure context.
```

## Task 7: Publish And Pack Verification

**Files:**
- Modify: `package.json`
- Modify: `.gitignore` only if package artifacts require adjustment
- Modify: `scripts/check-plugin.mjs` only if package checks need awareness of CLI output
- Create or modify: `tests/plugin-runtime.test.ts` if package/files assertions belong there

- [ ] **Step 1: Add package metadata tests**

Add tests that inspect `package.json`:

```ts
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
```

- [ ] **Step 2: Ensure built CLI is executable after build**

TypeScript does not always preserve shebang/executable mode as desired. Implementer must verify `dist/cli.js` starts with:

```js
#!/usr/bin/env node
```

If `tsc` preserves shebang, no extra build step is needed. If executable mode is needed for npm bin, npm handles bin shims, but the shebang should still be present.

- [ ] **Step 3: Verify package contents**

Implementer runs:

```bash
npm pack --dry-run
```

Expected package includes:

```text
dist/cli.js
dist/server.js
README.md
LICENSE
package.json
```

Expected package does not include:

```text
.codex-claude-delegate runtime state
.claude worktrees
debug fixtures
source-only test files unless intentionally included
```

- [ ] **Step 4: Full implementation verification**

Implementer runs final commands and reports output:

```bash
npm run build
npm run typecheck
npm test
npm run build:plugin
npm run check:plugin
node dist/cli.js --version
node dist/cli.js print-config
node dist/cli.js print-config --source "$(pwd)"
node dist/cli.js print-config --project
node dist/cli.js setup --print
node dist/cli.js doctor --json
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}\n' | node dist/cli.js
npm pack --dry-run
```

Expected:

```text
all commands succeed except doctor may return non-ready on machines without Claude auth, but JSON must be valid and accurately classify the problem
MCP initialize returns a valid JSON-RPC response
```

## Cross-Task Review Checklist

Before marking implementation complete, reviewer checks:

- [ ] `package.json` has exactly one bin: `codex-claude`.
- [ ] `package.json` `files` includes `LICENSE`, and `LICENSE` exists.
- [ ] `src/cli.ts` no-arg path starts MCP server and prints nothing to stdout before MCP JSON-RPC.
- [ ] No ordinary-user docs recommend `npx`.
- [ ] No ordinary-user docs recommend Codex plugin marketplace installation.
- [ ] `setup --write` writes `command = "codex-claude"` and default 6 tools only.
- [ ] `setup --write --force` backs up before replacement.
- [ ] `setup --write --allow-root` rejects `/`, `/tmp`, `/etc`, and `$HOME`.
- [ ] `doctor` checks Node, package, Claude CLI path/version/auth, Git, worktree, config, default tools, and allow roots.
- [ ] Default 6 MCP tools all include `interaction.headline`, `interaction.state`, and `interaction.next_step`.
- [ ] `claude_result` / `claude_job_wait` next actions never suggest direct non-preview apply.
- [ ] Non-preview `claude_apply` still requires `confirmed_by_user=true`.
- [ ] `preview=true` plus `cleanup=true` is still rejected.
- [ ] `claude_setup` reports review-gate status but does not force enable review gate.
- [ ] Generated plugin runtime files are only changed if `npm run build:plugin` was intentionally run by implementer.

## Notes For Implementer

- Do not reintroduce `max_turns` on `claude_task`.
- Do not add `npx` support as a hidden option.
- Do not add `codex-claude-delegate-mcp` as a bin alias.
- Do not make `claude_review_gate` a default tool.
- Do not let `interaction` replace existing JSON fields; add it alongside current payloads.
- Keep Advanced / Debug tools available for explicit users, but never in default setup config.
