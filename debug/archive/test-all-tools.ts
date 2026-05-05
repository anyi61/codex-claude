import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = path.join(PROJECT_ROOT, "dist", "server.js");

let nextId = 1;
const pending = new Map<number, (v: Record<string, unknown>) => void>();

function req(child: ReturnType<typeof spawn>, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextId++;
  child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve) => pending.set(id, resolve));
}

function notify(child: ReturnType<typeof spawn>, method: string, params?: Record<string, unknown>): void {
  child.stdin!.write(JSON.stringify(params ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", method }) + "\n");
}

function getPayload(resp: Record<string, unknown>): Record<string, unknown> {
  const text = ((resp.result as Record<string, unknown>)?.content as Array<{ text: string }>)?.[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(args[0], args.slice(1), { cwd, encoding: "utf8" }).trim();
}

async function createFixtureRepo(): Promise<string> {
  const fixtureRoot = path.join(PROJECT_ROOT, ".debug-fixtures");
  await mkdir(fixtureRoot, { recursive: true });
  const repo = await mkdtemp(path.join(fixtureRoot, "codex-claude-full-"));
  sh(repo, "git", "init");
  sh(repo, "git", "config", "user.name", "Test User");
  sh(repo, "git", "config", "user.email", "test@example.com");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "src", "server.ts"), "export const value = 1;\n");
  await writeFile(path.join(repo, "README.md"), "# Fixture\n");
  sh(repo, "git", "add", ".");
  sh(repo, "git", "commit", "-m", "init");
  return repo;
}

async function main(): Promise<void> {
  const child = spawn("node", [SERVER_PATH], { stdio: ["pipe", "pipe", "pipe"] });
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
      // ignore parse failures
    }
  });

  await req(child, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-all-tools", version: "0.1.0" },
  });
  notify(child, "notifications/initialized");

  const fixtureRepo = await createFixtureRepo();
  try {
    process.stderr.write("\n=== claude_status ===\n");
    const status = getPayload(await req(child, "tools/call", { name: "claude_status", arguments: { cwd: PROJECT_ROOT } }));
    if (status.claude_available !== true || status.git_available !== true) {
      throw new Error(`claude_status unexpected: ${JSON.stringify(status)}`);
    }
    process.stderr.write("  ✓ claude_status passed\n");

    process.stderr.write("\n=== claude_query ===\n");
    const query = getPayload(await req(child, "tools/call", {
      name: "claude_query",
      arguments: { cwd: PROJECT_ROOT, task: "List the six tool names of this MCP server only." },
    }));
    const answer = String((query.data as Record<string, unknown> | undefined)?.answer ?? "");
    if (!answer.includes("claude_status") || !answer.includes("claude_cleanup")) {
      throw new Error(`claude_query answer missing expected tool names: ${answer}`);
    }
    process.stderr.write("  ✓ claude_query passed\n");

    process.stderr.write("\n=== claude_review ===\n");
    const review = getPayload(await req(child, "tools/call", {
      name: "claude_review",
      arguments: {
        cwd: PROJECT_ROOT,
        task: "Review this tiny diff for correctness.",
        diff: "diff --git a/a.txt b/a.txt\n+hello\n",
        timeout_sec: 120,
      },
    }));
    const reviewData = review.data as Record<string, unknown> | undefined;
    if (!reviewData || typeof reviewData.findings !== "string" || typeof reviewData.recommendations !== "string" || typeof reviewData.severity !== "string") {
      throw new Error(`claude_review response shape invalid: ${JSON.stringify(review)}`);
    }
    process.stderr.write("  ✓ claude_review passed\n");

    process.stderr.write("\n=== claude_implement ===\n");
    const implement = getPayload(await req(child, "tools/call", {
      name: "claude_implement",
      arguments: {
        cwd: fixtureRepo,
        task: "Append one line 'Implemented by Claude delegate.' to README.md and do not modify other files.",
        files: ["README.md"],
        max_changed_files: 1,
        timeout_sec: 180,
      },
    }));
    process.stderr.write(`implement payload: ${JSON.stringify(implement, null, 2)}\n`);
    const observed = implement.server_observed as Record<string, unknown> | undefined;
    const changed = (observed?.changed_files as string[] | undefined) ?? [];
    if (changed.length !== 1 || changed[0] !== "README.md") {
      throw new Error(`claude_implement changed_files unexpected: ${JSON.stringify(changed)}`);
    }
    const worktree = String(observed?.worktree_path ?? "");
    if (!worktree.includes("codex-delegated-")) {
      throw new Error(`claude_implement missing worktree path: ${JSON.stringify(observed)}`);
    }
    process.stderr.write(`  ✓ claude_implement passed (${worktree})\n`);

    process.stderr.write("\n=== claude_apply ===\n");
    const apply = getPayload(await req(child, "tools/call", {
      name: "claude_apply",
      arguments: { cwd: fixtureRepo, worktree_path: worktree, cleanup: false },
    }));
    const appliedFiles = (apply.applied_files as string[] | undefined) ?? [];
    if (!appliedFiles.includes("README.md")) {
      throw new Error(`claude_apply did not apply README.md: ${JSON.stringify(apply)}`);
    }
    const content = await readFile(path.join(fixtureRepo, "README.md"), "utf8");
    if (!content.includes("Implemented by Claude delegate.")) {
      throw new Error(`claude_apply result not present in file content: ${content}`);
    }
    process.stderr.write("  ✓ claude_apply passed\n");

    process.stderr.write("\n=== claude_cleanup ===\n");
    const cleanupDry = getPayload(await req(child, "tools/call", {
      name: "claude_cleanup",
      arguments: { cwd: fixtureRepo, dry_run: true, older_than_hours: 0 },
    }));
    if (typeof cleanupDry.removed_count !== "number") {
      throw new Error(`claude_cleanup dry_run invalid: ${JSON.stringify(cleanupDry)}`);
    }
    const cleanup = getPayload(await req(child, "tools/call", {
      name: "claude_cleanup",
      arguments: { cwd: fixtureRepo, dry_run: false, older_than_hours: 0 },
    }));
    if (typeof cleanup.removed_count !== "number" || typeof cleanup.failed_count !== "number") {
      throw new Error(`claude_cleanup invalid: ${JSON.stringify(cleanup)}`);
    }
    process.stderr.write(`  ✓ claude_cleanup passed (removed=${cleanup.removed_count}, failed=${cleanup.failed_count})\n`);
  } finally {
    child.stdin!.end();
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.kill();
    await rm(fixtureRepo, { recursive: true, force: true });
  }

  process.stderr.write("\n=== ALL TOOLS PASSED ===\n");
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
