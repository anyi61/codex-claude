import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export class LockBusyError extends Error {
  constructor(message: string, readonly lockPath: string) {
    super(message);
    this.name = "LockBusyError";
  }
}

export interface FileLock {
  path: string;
  release: () => Promise<void>;
}

interface AcquireFileLockInput {
  cwd: string;
  resource: string;
  staleMs?: number;
  waitMs?: number;
}

const DEFAULT_STALE_MS = 10 * 60 * 1000;

function lockDir(cwd: string): string {
  return path.join(cwd, ".codex-claude-delegate", "locks");
}

function lockName(resource: string): string {
  const digest = createHash("sha256").update(resource).digest("hex").slice(0, 24);
  return `${digest}.lock`;
}

export function getLockPath(cwd: string, resource: string): string {
  return path.join(lockDir(cwd), lockName(resource));
}

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function lockIsStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const raw = await readFile(path.join(lockPath, "owner.json"), "utf8");
    const owner = JSON.parse(raw) as { pid?: unknown; acquired_at?: unknown };
    const acquiredAt = typeof owner.acquired_at === "string" ? Date.parse(owner.acquired_at) : NaN;
    const tooOld = Number.isFinite(acquiredAt) && Date.now() - acquiredAt > staleMs;
    return tooOld && !pidAlive(owner.pid);
  } catch {
    try {
      const st = await stat(lockPath);
      return Date.now() - st.mtimeMs > staleMs;
    } catch {
      return true;
    }
  }
}

export async function acquireFileLock(input: AcquireFileLockInput): Promise<FileLock> {
  const staleMs = input.staleMs ?? DEFAULT_STALE_MS;
  const targetPath = getLockPath(input.cwd, input.resource);
  const token = randomUUID();
  const deadline = Date.now() + (input.waitMs ?? 0);

  await mkdir(path.dirname(targetPath), { recursive: true });

  for (;;) {
    try {
      await mkdir(targetPath);
      await writeFile(path.join(targetPath, "owner.json"), JSON.stringify({
        pid: process.pid,
        resource: input.resource,
        token,
        acquired_at: new Date().toISOString(),
      }, null, 2), "utf8");
      return {
        path: targetPath,
        release: async () => {
          await rm(targetPath, { recursive: true, force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (await lockIsStale(targetPath, staleMs)) {
        await rm(targetPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      throw new LockBusyError(`Lock is already held for ${input.resource}`, targetPath);
    }
  }
}

export async function withFileLock<T>(
  input: AcquireFileLockInput,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await acquireFileLock({ waitMs: 5000, ...input });
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
