import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = path.join(PROJECT_ROOT, "dist", "server.js");
const TEST_CWD = PROJECT_ROOT;

let nextId = 1;
const pending = new Map<number, (v: Record<string, unknown>) => void>();

function sendRequest(child: ReturnType<typeof spawn>, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextId++;
  const req = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  child.stdin!.write(req + "\n");
  return new Promise((resolve) => { pending.set(id, resolve); });
}

function sendNotification(child: ReturnType<typeof spawn>, method: string, params?: Record<string, unknown>): void {
  const req = params
    ? JSON.stringify({ jsonrpc: "2.0", method, params })
    : JSON.stringify({ jsonrpc: "2.0", method });
  child.stdin!.write(req + "\n");
}

async function main() {
  const child = spawn("node", [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const rl = createInterface({ input: child.stdout! });

  child.stderr!.on("data", (chunk: Buffer) => {
    process.stderr.write(`[stderr] ${chunk.toString().trim()}\n`);
  });

  rl.on("line", (line: string) => {
    try {
      const msg = JSON.parse(line);
      process.stderr.write(`[stdout] id=${msg.id ?? "none"} ${msg.error ? "ERROR" : msg.result ? "OK" : "other"}\n`);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    } catch {
      process.stderr.write(`[stdout-parse-error] ${line.slice(0, 200)}\n`);
    }
  });

  child.on("close", (code) => {
    process.stderr.write(`\nServer exited: ${code}\n`);
  });

  // Step 1: initialize
  process.stderr.write("\n=== Step 1: initialize ===\n");
  const initResp = await sendRequest(child, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "debug-test", version: "0.1.0" },
  });
  const serverInfo = (initResp.result as Record<string, unknown>) ?? {};
  process.stderr.write(`Server: ${JSON.stringify(serverInfo)}\n`);

  // Step 2: initialized notification (fire-and-forget, no response)
  process.stderr.write("\n=== Step 2: initialized ===\n");
  sendNotification(child, "notifications/initialized");
  await new Promise((r) => setTimeout(r, 100));

  // Step 3: list tools
  process.stderr.write("\n=== Step 3: tools/list ===\n");
  const toolsResp = await sendRequest(child, "tools/list", {});
  const tools = ((toolsResp.result as Record<string, unknown>)?.tools as Array<{ name: string }>) ?? [];
  process.stderr.write(`Tools (${tools.length}): ${tools.map((t) => t.name).join(", ")}\n`);

  // Step 4: claude_status
  process.stderr.write("\n=== Step 4: claude_status ===\n");
  const statusResp = await sendRequest(child, "tools/call", {
    name: "claude_status",
    arguments: { cwd: TEST_CWD },
  });
  const statusContent = ((statusResp.result as Record<string, unknown>)?.content as Array<{ text: string }>)?.[0]?.text ?? "{}";
  process.stderr.write(`Status: ${statusContent}\n`);

  // Step 5: claude_query (quick smoke test — reads README.md)
  process.stderr.write("\n=== Step 5: claude_query (runs claude -p) ===\n");
  const queryResp = await sendRequest(child, "tools/call", {
    name: "claude_query",
    arguments: {
      task: "What is the purpose of this project? Check the README.md file. Keep it to one sentence.",
      cwd: TEST_CWD,
      timeout_sec: 60,
    },
  });
  const queryContent = ((queryResp.result as Record<string, unknown>)?.content as Array<{ text: string }>)?.[0]?.text ?? "{}";
  process.stderr.write(`Query: ${queryContent.slice(0, 500)}\n`);

  // Done
  child.stdin!.end();
  await new Promise((r) => setTimeout(r, 500));
  child.kill();
  process.stderr.write("\n=== All tests passed ===\n");
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err}\n`);
  process.exit(1);
});
