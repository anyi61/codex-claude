import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(PROJECT_ROOT, "plugins", "codex-claude-delegate");
const DIST_SERVER = path.join(PROJECT_ROOT, "dist", "server.js");
const STRICT_STOP_HOOK = process.env.STRICT_STOP_HOOK === "1";
const USE_REAL_CLAUDE_HOME = process.env.USE_REAL_CLAUDE_HOME === "1";

type ClaudeRun = {
  timedOut: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  debugLog: string;
};

function assertIncludes(haystack: string, needle: string, label: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`Expected ${label} to include ${JSON.stringify(needle)}`);
  }
}

function validatePlugin(): void {
  const result = spawnSync("claude", ["plugin", "validate", PLUGIN_ROOT], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(
      [
        "Claude plugin validation failed.",
        `status=${result.status}`,
        `stdout=${result.stdout.trim()}`,
        `stderr=${result.stderr.trim()}`,
      ].join("\n"),
    );
  }
}

async function runClaudeRuntime(repoRoot: string, homeRoot: string): Promise<ClaudeRun> {
  const debugFile = path.join(repoRoot, "claude-hooks-debug.log");
  const child = spawn(
    "claude",
    [
      "-p",
      "Reply with OK only.",
      "--plugin-dir",
      PLUGIN_ROOT,
      "--output-format=stream-json",
      "--include-hook-events",
      "--max-turns",
      "1",
      "--tools",
      "",
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
      "--verbose",
      "--debug",
      "hooks",
      "--debug-file",
      debugFile,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: homeRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  let settled = false;
  let timedOut = false;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (!STRICT_STOP_HOOK && stdout.includes('"type":"init"') && !settled) {
      setTimeout(() => {
        if (!settled) {
          timedOut = true;
          child.kill("SIGTERM");
        }
      }, 1500);
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const fallbackTimeout = setTimeout(() => {
    if (!settled) {
      timedOut = true;
      child.kill("SIGTERM");
    }
  }, STRICT_STOP_HOOK ? 120000 : 15000);

  const status = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  }).finally(() => {
    settled = true;
    clearTimeout(fallbackTimeout);
  });

  const debugLog = existsSync(debugFile) ? await readFile(debugFile, "utf8") : "";
  return { timedOut, status, stdout, stderr, debugLog };
}

async function main(): Promise<void> {
  if (!existsSync(DIST_SERVER)) {
    throw new Error(`Missing ${DIST_SERVER}. Run npm run build before this runtime check.`);
  }

  validatePlugin();

  const fixturesRoot = path.join(PROJECT_ROOT, ".debug-fixtures");
  await mkdir(fixturesRoot, { recursive: true });
  const root = await mkdtemp(path.join(fixturesRoot, "claude-plugin-runtime-"));
  const homeRoot = USE_REAL_CLAUDE_HOME ? process.env.HOME : path.join(root, "home");
  if (!homeRoot) {
    throw new Error("HOME is not set. Cannot run Claude runtime check.");
  }
  const repoRoot = path.join(root, "repo");
  await mkdir(path.join(repoRoot, ".codex-claude-delegate"), { recursive: true });
  if (!USE_REAL_CLAUDE_HOME) {
    await mkdir(homeRoot, { recursive: true });
  }
  await writeFile(
    path.join(repoRoot, ".codex-claude-delegate", "review-gate.json"),
    JSON.stringify({ enabled: true, pending_review: true, workspace_root: repoRoot }, null, 2),
    "utf8",
  );

  let passed = false;
  try {
    const run = await runClaudeRuntime(repoRoot, homeRoot);
    const combined = `${run.stdout}\n${run.stderr}\n${run.debugLog}`;

    assertIncludes(combined, "codex-claude-delegate", "Claude runtime output");
    assertIncludes(combined, "Loaded hooks from standard location for plugin codex-claude-delegate", "Claude debug log");
    assertIncludes(combined, "Registered 1 hooks from 1 plugins", "Claude debug log");
    assertIncludes(combined, 'MCP server "plugin:codex-claude-delegate:claude_delegate": Successfully connected', "Claude debug log");
    assertIncludes(combined, "mcp__plugin_codex-claude-delegate_claude_delegate__claude_review_gate", "Claude stream init");
    assertIncludes(combined, "mcp__plugin_codex-claude-delegate_claude_delegate__claude_task", "Claude stream init");

    const sawStopHook =
      combined.includes('"hook_event_name":"Stop"') ||
      combined.includes('"hookEventName":"Stop"') ||
      combined.includes('"hook_event":"Stop"') ||
      combined.includes('"hook_name":"Stop"');
    const stopHookErrored =
      combined.includes('"subtype":"hook_response"') &&
      combined.includes('"hook_event":"Stop"') &&
      combined.includes('"outcome":"error"');
    if (sawStopHook && stopHookErrored) {
      throw new Error(
        [
          "Claude runtime fired the Stop hook, but the hook command failed.",
          `timedOut=${run.timedOut}`,
          `status=${run.status}`,
          `stdout=${run.stdout}`,
          `stderr=${run.stderr}`,
          `debugLog=${run.debugLog}`,
        ].join("\n"),
      );
    }
    const apiBlocked =
      combined.includes("FailedToOpenSocket") ||
      combined.includes("Connection error") ||
      combined.includes("No API key available") ||
      combined.includes('"subtype":"api_retry"');
    if (!sawStopHook && apiBlocked && !STRICT_STOP_HOOK) {
      process.stderr.write(
        [
          "=== CLAUDE PLUGIN RUNTIME PARTIAL PASSED ===",
          "Verified: plugin manifest, hook registration, MCP server connection, and MCP tool exposure.",
          "Skipped: actual Stop hook firing, because Claude could not complete a model response in this environment.",
          "Set STRICT_STOP_HOOK=1 USE_REAL_CLAUDE_HOME=1 in an authenticated Claude environment to require a real Stop hook event.",
          "",
        ].join("\n"),
      );
      passed = true;
      return;
    }

    if (!sawStopHook) {
      throw new Error(
        [
          "Claude runtime loaded the plugin, but no Stop hook event was observed.",
          `timedOut=${run.timedOut}`,
          `status=${run.status}`,
          `stdout=${run.stdout}`,
          `stderr=${run.stderr}`,
          `debugLog=${run.debugLog}`,
        ].join("\n"),
      );
    }

    assertIncludes(combined, "Review gate is enabled for this workspace", "Stop hook output");
    process.stderr.write("=== CLAUDE PLUGIN RUNTIME PASSED ===\n");
    passed = true;
  } finally {
    if (passed) {
      await rm(root, { recursive: true, force: true });
    } else {
      process.stderr.write(`Preserved failed runtime fixture for inspection: ${root}\n`);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
