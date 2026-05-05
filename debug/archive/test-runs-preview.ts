import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

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

async function createFixtureRepo(root: string): Promise<{ repo: string; worktreeRel: string; logDir: string }> {
  const repo = path.join(root, "repo");
  const logDir = path.join(root, "runs");
  await mkdir(repo, { recursive: true });
  await mkdir(logDir, { recursive: true });
  sh(root, "git", "init", repo);
  sh(repo, "git", "config", "user.name", "Test User");
  sh(repo, "git", "config", "user.email", "test@example.com");
  await writeFile(path.join(repo, "README.md"), "# Fixture\n");
  sh(repo, "git", "add", ".");
  sh(repo, "git", "commit", "-m", "init");

  const worktreeRel = ".claude/worktrees/codex-delegated-preview";
  sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
  const worktree = path.join(repo, worktreeRel);
  await writeFile(path.join(worktree, "README.md"), "# Fixture\n\npreview change\n");
  const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");

  await writeFile(path.join(logDir, "implement-run.json"), JSON.stringify({
    type: "implement",
    input: { cwd: repo, files: ["README.md"] },
    report: { status: "success", summary: "Updated README.md" },
    observed: {
      worktree_path: worktreeRel,
      worktree_name: "codex-delegated-preview",
      base_commit: baseCommit,
      changed_files: ["README.md"],
      scope: { requested_files: ["README.md"], out_of_scope_files: [], scope_exceeded: false, warnings: [] },
      resource_limits: { actual_changed_files: 1, changed_files_exceeded: false, warnings: [] },
    },
    session: { requested_session_id: null, returned_session_id: "sess-123" },
  }, null, 2));

  return { repo, worktreeRel, logDir };
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(PROJECT_ROOT, ".debug-fixtures", "runs-preview-"));
  const { repo, worktreeRel, logDir } = await createFixtureRepo(root);
  const child = spawn("node", [SERVER_PATH], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, CODEX_CLAUDE_RUN_LOG_DIR: logDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rl = createInterface({ input: child.stdout! });
  child.stderr!.on("data", (data: Buffer) => process.stderr.write(data.toString()));
  rl.on("line", (line: string) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    } catch {
      // ignore
    }
  });

  try {
    await req(child, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "runs-preview", version: "0.1.0" } });
    notify(child, "notifications/initialized");

    process.stderr.write("\n=== claude_runs ===\n");
    const runs = payload(await req(child, "tools/call", {
      name: "claude_runs",
      arguments: { cwd: repo, type: "implement", limit: 5 },
    }));
    const entries = (runs.entries as Array<Record<string, unknown>> | undefined) ?? [];
    if (entries.length !== 1 || entries[0]?.worktree_name !== "codex-delegated-preview") {
      throw new Error(`claude_runs returned unexpected entries: ${JSON.stringify(runs)}`);
    }
    process.stderr.write(`  ✓ claude_runs returned ${entries.length} filtered entry\n`);

    process.stderr.write("\n=== claude_status recent runs ===\n");
    const status = payload(await req(child, "tools/call", {
      name: "claude_status",
      arguments: { cwd: repo },
    }));
    const recentRuns = status.recent_runs as Record<string, unknown> | undefined;
    const lifecycleCounts = recentRuns?.lifecycle_counts as Record<string, unknown> | undefined;
    if (!recentRuns || !Array.isArray(recentRuns.entries) || lifecycleCounts?.success !== 1) {
      throw new Error(`claude_status recent_runs unexpected: ${JSON.stringify(status)}`);
    }
    process.stderr.write("  ✓ claude_status exposes recent run summary\n");

    process.stderr.write("\n=== claude_apply preview ===\n");
    const preview = payload(await req(child, "tools/call", {
      name: "claude_apply",
      arguments: { cwd: repo, worktree_path: worktreeRel, preview: true },
    }));
    if (preview.preview !== true) {
      throw new Error(`claude_apply preview flag missing: ${JSON.stringify(preview)}`);
    }
    const planned = (preview.planned_changes as Array<Record<string, unknown>> | undefined) ?? [];
    if (planned.length !== 1 || planned[0]?.status !== "M" || planned[0]?.file !== "README.md") {
      throw new Error(`claude_apply preview returned unexpected changes: ${JSON.stringify(preview)}`);
    }
    const content = await readFile(path.join(repo, "README.md"), "utf8");
    if (content !== "# Fixture\n") {
      throw new Error(`preview mutated main workspace unexpectedly: ${JSON.stringify(content)}`);
    }
    process.stderr.write("  ✓ claude_apply preview reported changes without mutation\n");

    process.stderr.write("\n=== claude_apply actual ===\n");
    const applied = payload(await req(child, "tools/call", {
      name: "claude_apply",
      arguments: { cwd: repo, worktree_path: worktreeRel, preview: false },
    }));
    const appliedFiles = (applied.applied_files as string[] | undefined) ?? [];
    if (appliedFiles.length !== 1 || appliedFiles[0] !== "README.md") {
      throw new Error(`claude_apply returned unexpected applied files: ${JSON.stringify(applied)}`);
    }
    const appliedRuns = payload(await req(child, "tools/call", {
      name: "claude_runs",
      arguments: { cwd: repo, type: "implement", worktree_name: "codex-delegated-preview" },
    }));
    const appliedEntry = ((appliedRuns.entries as Array<Record<string, unknown>> | undefined) ?? [])[0];
    if (appliedEntry?.lifecycle !== "applied") {
      throw new Error(`implement lifecycle was not updated to applied: ${JSON.stringify(appliedRuns)}`);
    }
    process.stderr.write("  ✓ implement lifecycle updated to applied\n");

    process.stderr.write("\n=== claude_cleanup actual ===\n");
    const cleaned = payload(await req(child, "tools/call", {
      name: "claude_cleanup",
      arguments: { cwd: repo, dry_run: false, older_than_hours: 0 },
    }));
    if (cleaned.removed_count !== 1) {
      throw new Error(`claude_cleanup did not remove delegated worktree: ${JSON.stringify(cleaned)}`);
    }
    const cleanedRuns = payload(await req(child, "tools/call", {
      name: "claude_runs",
      arguments: { cwd: repo, type: "implement", worktree_name: "codex-delegated-preview" },
    }));
    const cleanedEntry = ((cleanedRuns.entries as Array<Record<string, unknown>> | undefined) ?? [])[0];
    if (cleanedEntry?.lifecycle !== "cleaned") {
      throw new Error(`implement lifecycle was not updated to cleaned: ${JSON.stringify(cleanedRuns)}`);
    }
    process.stderr.write("  ✓ implement lifecycle updated to cleaned\n");
  } finally {
    child.stdin!.end();
    await new Promise((resolve) => setTimeout(resolve, 200));
    child.kill();
    await rm(root, { recursive: true, force: true });
  }

  process.stderr.write("\n=== RUNS/PREVIEW PASSED ===\n");
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
