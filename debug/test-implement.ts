import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = path.join(PROJECT_ROOT, "dist", "server.js");

let nextId = 1;
const pending = new Map<number, (v: Record<string, unknown>) => void>();

function req(child: ReturnType<typeof spawn>, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextId++;
  child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((r) => { pending.set(id, r); });
}

function notify(child: ReturnType<typeof spawn>, method: string, params?: Record<string, unknown>): void {
  const msg = params
    ? JSON.stringify({ jsonrpc: "2.0", method, params })
    : JSON.stringify({ jsonrpc: "2.0", method });
  child.stdin!.write(msg + "\n");
}

async function main() {
  const child = spawn("node", [SERVER_PATH], { stdio: ["pipe", "pipe", "pipe"] });
  const rl = createInterface({ input: child.stdout! });

  child.stderr!.on("data", (d: Buffer) => process.stderr.write(`[stderr] ${d.toString().trim()}\n`));

  rl.on("line", (line: string) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    } catch { /* ignore */ }
  });

  // Init
  await req(child, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-implement", version: "0.1.0" },
  });
  notify(child, "notifications/initialized");
  await new Promise((r) => setTimeout(r, 100));

  // Check status now that we have a git repo
  process.stderr.write("\n--- claude_status ---\n");
  const status = await req(child, "tools/call", {
    name: "claude_status",
    arguments: { cwd: PROJECT_ROOT },
  });
  const statusText = (status.result as Record<string, unknown>)?.content as Array<{ text: string }>;
  process.stderr.write(`Status: ${statusText[0].text}\n`);

  // Implement: simple task
  process.stderr.write("\n--- claude_implement (simple test) ---\n");
  const result = await req(child, "tools/call", {
    name: "claude_implement",
    arguments: {
      task: "Create a file called hello.txt in the project root with the exact content: 'hello from claude code via worktree'",
      cwd: PROJECT_ROOT,
      timeout_sec: 120,
    },
  });
  const resultText = (result.result as Record<string, unknown>)?.content as Array<{ text: string }>;
  const parsed = JSON.parse(resultText[0].text);
  process.stderr.write(`Result status: ${parsed.claude_report?.status}\n`);
  process.stderr.write(`Report summary: ${parsed.claude_report?.summary?.slice(0, 200)}\n`);
  process.stderr.write(`Server observed files: ${JSON.stringify(parsed.server_observed?.changed_files)}\n`);
  process.stderr.write(`Worktree: ${parsed.server_observed?.worktree_path}\n`);

  // Implement with resource limits to verify plumbing works
  process.stderr.write("\n--- claude_implement (with resource limits) ---\n");
  const result2 = await req(child, "tools/call", {
    name: "claude_implement",
    arguments: {
      task: "Create a file called hello2.txt in the project root with the exact content: 'testing resource limits'",
      cwd: PROJECT_ROOT,
      timeout_sec: 120,
      max_cost_usd: 0.5,
      max_changed_files: 1,
    },
  });
  const result2Text = (result2.result as Record<string, unknown>)?.content as Array<{ text: string }>;
  const parsed2 = JSON.parse(result2Text[0].text);
  const resourceLimits = parsed2.server_observed?.resource_limits;
  process.stderr.write(`resource_limits: ${JSON.stringify(resourceLimits, null, 2)}\n`);

  // Assert resource_limits structure
  if (!resourceLimits) throw new Error("resource_limits missing from implement response");
  if (resourceLimits.max_cost_usd !== 0.5) throw new Error(`expected max_cost_usd=0.5, got ${resourceLimits.max_cost_usd}`);
  if (resourceLimits.max_changed_files !== 1) throw new Error(`expected max_changed_files=1, got ${resourceLimits.max_changed_files}`);
  if (typeof resourceLimits.actual_changed_files !== "number") throw new Error(`expected actual_changed_files to be a number, got ${typeof resourceLimits.actual_changed_files}`);
  if (typeof resourceLimits.changed_files_exceeded !== "boolean") throw new Error(`expected changed_files_exceeded to be a boolean, got ${typeof resourceLimits.changed_files_exceeded}`);
  if (!Array.isArray(resourceLimits.warnings)) throw new Error("expected warnings to be an array");
  process.stderr.write("  ✓ all resource_limits assertions passed\n");

  // Test validation: max_cost_usd too large
  process.stderr.write("\n--- claude_implement (invalid max_cost_usd > 10) ---\n");
  const result3 = await req(child, "tools/call", {
    name: "claude_implement",
    arguments: {
      task: "create a file",
      cwd: PROJECT_ROOT,
      timeout_sec: 30,
      max_cost_usd: 99,
    },
  });
  const result3Text = (result3.result as Record<string, unknown>)?.content as Array<{ text: string }>;
  const parsed3 = JSON.parse(result3Text[0].text);
  process.stderr.write(`Invalid max_cost_usd error: ${parsed3?.error ?? "(no error)"}\n`);
  if (!parsed3.error?.includes("max_cost_usd")) throw new Error(`expected max_cost_usd validation error, got: ${parsed3.error ?? "none"}`);
  process.stderr.write("  ✓ max_cost_usd validation error asserted\n");

  // Test validation: max_changed_files negative
  process.stderr.write("\n--- claude_implement (invalid max_changed_files = -1) ---\n");
  const result4 = await req(child, "tools/call", {
    name: "claude_implement",
    arguments: {
      task: "create a file",
      cwd: PROJECT_ROOT,
      timeout_sec: 30,
      max_changed_files: -1,
    },
  });
  const result4Text = (result4.result as Record<string, unknown>)?.content as Array<{ text: string }>;
  const parsed4 = JSON.parse(result4Text[0].text);
  process.stderr.write(`Invalid max_changed_files error: ${parsed4?.error ?? "(no error)"}\n`);
  if (!parsed4.error?.includes("max_changed_files")) throw new Error(`expected max_changed_files validation error, got: ${parsed4.error ?? "none"}`);
  process.stderr.write("  ✓ max_changed_files validation error asserted\n");

  child.stdin!.end();
  await new Promise((r) => setTimeout(r, 500));
  child.kill();
  process.stderr.write("\n--- Done ---\n");
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err}\n`);
  process.exit(1);
});
