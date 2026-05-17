import path from "node:path";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JobStore } from "./jobs.js";
import { abortActiveClaudeRun, executeBackgroundJob } from "./claude-cli.js";
import { getBackgroundStateDir } from "./background-jobs.js";

export interface JobRunnerDependencies {
  createStore?: () => JobStore;
  executeBackgroundJob?: (jobId: string) => Promise<void>;
  abortActiveClaudeRun?: (signal?: NodeJS.Signals) => boolean;
  onSignal?: (signal: NodeJS.Signals, handler: () => void) => void;
  exit?: (code: number) => never | void;
  setExitCode?: (code: number) => void;
}

export async function markCancelled(jobId: string, createStore?: () => JobStore): Promise<void> {
  const store = createStore ? createStore() : new JobStore(getBackgroundStateDir());
  await store.init();
  await store.update(jobId, {
    status: "cancelled",
    updated_at: new Date().toISOString(),
    summary: "Cancelled by user",
    error: undefined,
  });
}

export function registerTerminationHandler(jobId: string, deps: JobRunnerDependencies = {}): () => void {
  const onSignal = deps.onSignal ?? ((signal, handler) => {
    process.on(signal, handler);
  });
  const abort = deps.abortActiveClaudeRun ?? abortActiveClaudeRun;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let shuttingDown = false;

  const handleSigterm = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      await markCancelled(jobId, deps.createStore).catch(() => {});
      abort("SIGTERM");
      exit(0);
    })();
  };

  onSignal("SIGTERM", handleSigterm);
  return handleSigterm;
}

export async function runJobRunner(jobId: string, deps: JobRunnerDependencies = {}): Promise<void> {
  if (!jobId.trim()) {
    throw new Error("jobId is required");
  }
  registerTerminationHandler(jobId, deps);

  try {
    await (deps.executeBackgroundJob ?? executeBackgroundJob)(jobId);
  } catch {
    if (deps.setExitCode) {
      deps.setExitCode(1);
    } else {
      process.exitCode = 1;
    }
  }
}

export async function main(argv: string[] = process.argv, deps: JobRunnerDependencies = {}): Promise<void> {
  const jobId = argv[2]?.trim() ?? "";
  await runJobRunner(jobId, deps);
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) {
  await main();
}
