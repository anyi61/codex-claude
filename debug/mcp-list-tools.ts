import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = path.join(PROJECT_ROOT, "dist", "server.js");

const EXPECTED_TOOLS = [
  "claude_status",
  "claude_setup",
  "claude_runs",
  "claude_run_inspect",
  "claude_result",
  "claude_workspace_status",
  "claude_task",
  "claude_review_gate",
  "claude_query",
  "claude_review",
  "claude_implement",
  "claude_jobs",
  "claude_job_result",
  "claude_job_cancel",
  "claude_job_wait",
  "claude_job_cleanup",
  "claude_apply",
  "claude_cleanup",
];

let nextId = 1;
const pending = new Map<number, (value: Record<string, unknown>) => void>();

function req(
  child: ReturnType<typeof spawn>,
  method: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const id = nextId++;
  child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve) => pending.set(id, resolve));
}

function notify(child: ReturnType<typeof spawn>, method: string, params?: Record<string, unknown>): void {
  child.stdin!.write(JSON.stringify(params ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", method }) + "\n");
}

async function main(): Promise<void> {
  const child = spawn("node", [SERVER_PATH], { stdio: ["pipe", "pipe", "pipe"] });
  const rl = createInterface({ input: child.stdout! });

  child.stderr!.on("data", (chunk: Buffer) => process.stderr.write(chunk.toString()));
  rl.on("line", (line: string) => {
    try {
      const msg = JSON.parse(line) as { id?: number };
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg as Record<string, unknown>);
        pending.delete(msg.id);
      }
    } catch {}
  });

  await req(child, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-list-tools", version: "1" },
  });
  notify(child, "notifications/initialized");

  const response = await req(child, "tools/list", {});
  const tools = ((response.result as { tools?: Array<{ name?: string }> } | undefined)?.tools ?? [])
    .map((tool) => tool.name)
    .filter((name): name is string => typeof name === "string");

  const missing = EXPECTED_TOOLS.filter((tool) => !tools.includes(tool));
  const extra = tools.filter((tool) => !EXPECTED_TOOLS.includes(tool));
  process.stdout.write(JSON.stringify({ count: tools.length, tools, missing, extra }, null, 2) + "\n");

  child.stdin!.end();
  child.kill();

  if (missing.length > 0) {
    throw new Error(`Missing expected MCP tools: ${missing.join(", ")}`);
  }
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
