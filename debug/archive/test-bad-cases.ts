import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = path.join(PROJECT_ROOT, "dist", "server.js");

let nextId = 1;
const pending = new Map<number, (value: Record<string, unknown>) => void>();

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(args[0], args.slice(1), { cwd, encoding: "utf8" }).trim();
}

function req(child: ReturnType<typeof spawn>, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextId++;
  child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve) => pending.set(id, resolve));
}

function notify(child: ReturnType<typeof spawn>, method: string, params?: Record<string, unknown>): void {
  child.stdin!.write(JSON.stringify(params ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", method }) + "\n");
}

function payload(resp: Record<string, unknown>): Record<string, unknown> {
  const text = ((resp.result as Record<string, unknown>)?.content as Array<{ text: string }>)?.[0]?.text;
  if (!text) throw new Error(`missing tool content: ${JSON.stringify(resp)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

function expectError(value: Record<string, unknown>, pattern: RegExp, label: string): void {
  const msg = String(value.error ?? "");
  if (!pattern.test(msg)) {
    throw new Error(`${label}: expected error ${pattern}, got ${JSON.stringify(value)}`);
  }
}

async function createFixtureRepo(prefix: string): Promise<string> {
  const root = path.join(PROJECT_ROOT, ".debug-fixtures");
  await mkdir(root, { recursive: true });
  const repo = await mkdtemp(path.join(root, prefix));
  sh(repo, "git", "init");
  sh(repo, "git", "config", "user.name", "Test User");
  sh(repo, "git", "config", "user.email", "test@example.com");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "README.md"), "# Fixture\n");
  await writeFile(path.join(repo, "src", "server.ts"), "export const value = 1;\n");
  sh(repo, "git", "add", ".");
  sh(repo, "git", "commit", "-m", "init");
  return repo;
}

async function createLoggedWorktree(
  repo: string,
  logDir: string,
  runName: string,
  observed: Record<string, unknown>
): Promise<string> {
  const worktreeRel = path.join(".claude", "worktrees", `codex-delegated-${runName}`);
  sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
  const wt = path.join(repo, worktreeRel);
  const baseCommit = sh(wt, "git", "rev-parse", "HEAD");
  await mkdir(logDir, { recursive: true });
  await writeFile(
    path.join(logDir, `${runName}.json`),
    JSON.stringify(
      {
        type: "implement",
        observed: {
          worktree_path: worktreeRel,
          base_commit: baseCommit,
          ...observed,
        },
      },
      null,
      2
    )
  );
  return worktreeRel;
}

async function main(): Promise<void> {
  const logRoot = path.join(PROJECT_ROOT, ".debug-fixtures", "bad-case-logs");
  const logDir = path.join(logRoot, "runs");
  await rm(logRoot, { recursive: true, force: true });

  const child = spawn("node", [SERVER_PATH], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, CODEX_CLAUDE_RUN_LOG_DIR: logDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rl = createInterface({ input: child.stdout! });
  child.stderr!.on("data", (d: Buffer) => process.stderr.write(d.toString()));
  rl.on("line", (line: string) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    } catch {
      // ignore non-JSON lines
    }
  });

  const repos: string[] = [];
  try {
    await req(child, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bad-cases", version: "0.1.0" } });
    notify(child, "notifications/initialized");

    process.stderr.write("\n=== bad: status outside allow roots ===\n");
    const status = payload(await req(child, "tools/call", { name: "claude_status", arguments: { cwd: "/tmp" } }));
    if (status.cwd_valid !== false || !Array.isArray(status.errors)) {
      throw new Error(`expected invalid cwd status, got ${JSON.stringify(status)}`);
    }
    process.stderr.write("  ✓ rejected invalid cwd\n");

    process.stderr.write("\n=== bad: empty query task ===\n");
    expectError(payload(await req(child, "tools/call", {
      name: "claude_query",
      arguments: { cwd: PROJECT_ROOT, task: "" },
    })), /task/i, "empty query task");
    process.stderr.write("  ✓ rejected empty query task\n");

    process.stderr.write("\n=== bad: implement parameter validation ===\n");
    expectError(payload(await req(child, "tools/call", {
      name: "claude_implement",
      arguments: { cwd: PROJECT_ROOT, task: "x", max_changed_files: 101 },
    })), /max_changed_files/i, "max_changed_files");
    expectError(payload(await req(child, "tools/call", {
      name: "claude_implement",
      arguments: { cwd: PROJECT_ROOT, task: "x", worktreeName: "../escape" },
    })), /worktreeName/i, "worktreeName");
    expectError(payload(await req(child, "tools/call", {
      name: "claude_implement",
      arguments: { cwd: PROJECT_ROOT, task: "x", files: ["../escape.md"] },
    })), /escapes cwd/i, "files escape");
    process.stderr.write("  ✓ rejected invalid implement inputs\n");

    process.stderr.write("\n=== bad: dirty requested file ===\n");
    const dirtyRepo = await createFixtureRepo("bad-dirty-");
    repos.push(dirtyRepo);
    await writeFile(path.join(dirtyRepo, "README.md"), "# Fixture\n\nmain workspace dirty\n");
    expectError(payload(await req(child, "tools/call", {
      name: "claude_implement",
      arguments: { cwd: dirtyRepo, task: "Append a line to README.md", files: ["README.md"], timeout_sec: 30 },
    })), /uncommitted changes/i, "dirty requested file");
    process.stderr.write("  ✓ rejected dirty requested file\n");

    process.stderr.write("\n=== bad: apply invalid worktree path ===\n");
    expectError(payload(await req(child, "tools/call", {
      name: "claude_apply",
      arguments: { cwd: PROJECT_ROOT, worktree_path: "/tmp/not-a-worktree" },
    })), /worktree_path must be under/i, "invalid apply path");
    process.stderr.write("  ✓ rejected invalid worktree path\n");

    process.stderr.write("\n=== bad: apply scope/resource refusals ===\n");
    const scopeRepo = await createFixtureRepo("bad-scope-");
    repos.push(scopeRepo);
    const scopeWt = await createLoggedWorktree(scopeRepo, logDir, "scope", {
      changed_files: ["README.md"],
      scope: {
        requested_files: ["src/server.ts"],
        out_of_scope_files: ["README.md"],
        scope_exceeded: true,
        warnings: ["Changed README.md outside requested files: src/server.ts"],
      },
      resource_limits: { actual_changed_files: 1, changed_files_exceeded: false, warnings: [] },
    });
    await writeFile(path.join(scopeRepo, scopeWt, "README.md"), "# Fixture\n\nout of scope\n");
    expectError(payload(await req(child, "tools/call", {
      name: "claude_apply",
      arguments: { cwd: scopeRepo, worktree_path: scopeWt },
    })), /outside requested files/i, "scope exceeded");

    const limitRepo = await createFixtureRepo("bad-limit-");
    repos.push(limitRepo);
    const limitWt = await createLoggedWorktree(limitRepo, logDir, "limit", {
      changed_files: ["README.md"],
      scope: { requested_files: ["README.md"], out_of_scope_files: [], scope_exceeded: false, warnings: [] },
      resource_limits: { max_changed_files: 0, actual_changed_files: 1, changed_files_exceeded: true, warnings: ["too many files"] },
    });
    await writeFile(path.join(limitRepo, limitWt, "README.md"), "# Fixture\n\nlimit exceeded\n");
    expectError(payload(await req(child, "tools/call", {
      name: "claude_apply",
      arguments: { cwd: limitRepo, worktree_path: limitWt },
    })), /resource limits/i, "resource limit exceeded");
    process.stderr.write("  ✓ rejected scope and resource violations\n");

    process.stderr.write("\n=== bad: apply main workspace conflict ===\n");
    const conflictRepo = await createFixtureRepo("bad-conflict-");
    repos.push(conflictRepo);
    const conflictWt = await createLoggedWorktree(conflictRepo, logDir, "conflict", {
      changed_files: ["README.md"],
      scope: { requested_files: ["README.md"], out_of_scope_files: [], scope_exceeded: false, warnings: [] },
      resource_limits: { actual_changed_files: 1, changed_files_exceeded: false, warnings: [] },
    });
    await writeFile(path.join(conflictRepo, conflictWt, "README.md"), "# Fixture\n\nfrom worktree\n");
    await writeFile(path.join(conflictRepo, "README.md"), "# Fixture\n\nmain dirty\n");
    expectError(payload(await req(child, "tools/call", {
      name: "claude_apply",
      arguments: { cwd: conflictRepo, worktree_path: conflictWt },
    })), /Main workspace/i, "main workspace conflict");
    process.stderr.write("  ✓ rejected main workspace conflict\n");

    process.stderr.write("\n=== bad: cleanup dry run is non-destructive ===\n");
    const cleanupRepo = await createFixtureRepo("bad-cleanup-");
    repos.push(cleanupRepo);
    await createLoggedWorktree(cleanupRepo, logDir, "cleanup", {
      changed_files: ["README.md"],
      scope: { requested_files: ["README.md"], out_of_scope_files: [], scope_exceeded: false, warnings: [] },
      resource_limits: { actual_changed_files: 1, changed_files_exceeded: false, warnings: [] },
    });
    const cleanup = payload(await req(child, "tools/call", {
      name: "claude_cleanup",
      arguments: { cwd: cleanupRepo, dry_run: true, older_than_hours: 0 },
    }));
    if (cleanup.dry_run !== true || cleanup.removed_count !== 0) {
      throw new Error(`expected cleanup dry_run to remove nothing, got ${JSON.stringify(cleanup)}`);
    }
    process.stderr.write("  ✓ cleanup dry-run kept worktrees\n");
  } finally {
    child.stdin!.end();
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.kill();
    for (const repo of repos) {
      await rm(repo, { recursive: true, force: true });
    }
    await rm(logRoot, { recursive: true, force: true });
  }

  process.stderr.write("\n=== BAD CASES PASSED ===\n");
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
