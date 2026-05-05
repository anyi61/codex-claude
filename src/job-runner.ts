import path from "node:path";
import { JobStore } from "./jobs.js";
import { abortActiveClaudeRun, executeBackgroundJob } from "./claude-cli.js";

const JOB_STATE_DIR_ENV = "CODEX_CLAUDE_BACKGROUND_STATE_DIR";

function getBackgroundStateDir(): string {
  if (process.env[JOB_STATE_DIR_ENV]) {
    return path.resolve(process.env[JOB_STATE_DIR_ENV]!);
  }
  if (process.env.CODEX_CLAUDE_RUN_LOG_DIR) {
    return path.dirname(path.resolve(process.env.CODEX_CLAUDE_RUN_LOG_DIR));
  }
  return path.join(process.cwd(), ".codex-claude-delegate");
}

async function markCancelled(jobId: string): Promise<void> {
  const store = new JobStore(getBackgroundStateDir());
  await store.init();
  await store.update(jobId, {
    status: "cancelled",
    updated_at: new Date().toISOString(),
    summary: "Cancelled by user",
    error: undefined,
  });
}

async function main(): Promise<void> {
  const jobId = process.argv[2]?.trim();
  if (!jobId) {
    throw new Error("jobId is required");
  }

  let shuttingDown = false;
  process.on("SIGTERM", () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      await markCancelled(jobId).catch(() => {});
      abortActiveClaudeRun("SIGTERM");
      process.exit(0);
    })();
  });

  try {
    await executeBackgroundJob(jobId);
  } catch {
    process.exitCode = 1;
  }
}

await main();
