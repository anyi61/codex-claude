import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_SCRIPT = path.join(PROJECT_ROOT, "plugins", "codex-claude-delegate", "hooks", "review-gate-stop.mjs");

function runHook(cwd: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("node", [HOOK_SCRIPT], {
    cwd,
    env: {
      ...process.env,
      PWD: cwd,
    },
    encoding: "utf8",
  });
  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    status: result.status,
  };
}

async function writeGateState(cwd: string, state: Record<string, unknown>): Promise<void> {
  const stateDir = path.join(cwd, ".codex-claude-delegate");
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "review-gate.json"), JSON.stringify(state, null, 2), "utf8");
}

async function main(): Promise<void> {
  const fixturesRoot = path.join(PROJECT_ROOT, ".debug-fixtures");
  await mkdir(fixturesRoot, { recursive: true });
  const root = await mkdtemp(path.join(fixturesRoot, "review-gate-hook-"));

  try {
    const missingState = runHook(root);
    if (missingState.status !== 0 || missingState.stdout !== "") {
      throw new Error(`Expected missing gate state to exit quietly, got ${JSON.stringify(missingState)}`);
    }

    await writeGateState(root, {
      enabled: true,
      pending_review: false,
      workspace_root: root,
    });
    const noPending = runHook(root);
    if (noPending.status !== 0 || noPending.stdout !== "") {
      throw new Error(`Expected non-pending gate state to exit quietly, got ${JSON.stringify(noPending)}`);
    }

    await writeGateState(root, {
      enabled: true,
      pending_review: true,
      workspace_root: root,
    });
    const pending = runHook(root);
    if (pending.status !== 0 || !pending.stdout) {
      throw new Error(`Expected pending gate state to emit JSON, got ${JSON.stringify(pending)}`);
    }

    const payload = JSON.parse(pending.stdout) as {
      review_gate?: { pending_review?: unknown };
      systemMessage?: unknown;
      additional_context?: unknown;
    };
    if (payload.review_gate?.pending_review !== true) {
      throw new Error(`Expected pending_review=true in hook output, got ${pending.stdout}`);
    }
    if (typeof payload.systemMessage !== "string" || payload.systemMessage.length === 0) {
      throw new Error(`Expected systemMessage in hook output, got ${pending.stdout}`);
    }
    if (typeof payload.additional_context !== "string" || payload.additional_context.length === 0) {
      throw new Error(`Expected additional_context in hook output, got ${pending.stdout}`);
    }

    process.stderr.write("=== REVIEW GATE HOOK PASSED ===\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
