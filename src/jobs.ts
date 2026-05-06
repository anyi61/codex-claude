import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  BackgroundJobCleanupEntry,
  BackgroundJobStatus,
  BackgroundJobSummary,
  BackgroundJobType,
} from "./schema.js";

export interface BackgroundJobRecord extends BackgroundJobSummary {
  payload: Record<string, unknown>;
  result?: Record<string, unknown>;
}

interface JobListInput {
  cwd: string;
  limit: number;
  status?: BackgroundJobStatus;
  type?: BackgroundJobType;
}

interface JobCleanupInput {
  cwd: string;
  older_than_hours?: number;
  dry_run: boolean;
  limit: number;
}

const TERMINAL_JOB_STATUSES = new Set<BackgroundJobStatus>(["succeeded", "failed", "cancelled"]);

const ACTIVE_JOB_STATUSES = new Set<BackgroundJobStatus>(["queued", "running"]);

interface ActiveFingerprintInput {
  cwd: string;
  type?: BackgroundJobType;
  fingerprint: string;
}

export class JobStore {
  private readonly jobsDir: string;

  constructor(private readonly baseDir: string) {
    this.jobsDir = path.join(baseDir, "jobs");
  }

  async init(): Promise<void> {
    await mkdir(this.jobsDir, { recursive: true });
  }

  async create(record: BackgroundJobRecord): Promise<void> {
    await this.init();
    await this.writeRecord(record);
  }

  async get(jobId: string): Promise<BackgroundJobRecord | null> {
    const filePath = this.getJobPath(jobId);
    if (!existsSync(filePath)) return null;
    try {
      return JSON.parse(await readFile(filePath, "utf8")) as BackgroundJobRecord;
    } catch {
      return null;
    }
  }

  async update(jobId: string, patch: Partial<BackgroundJobRecord>): Promise<BackgroundJobRecord | null> {
    const current = await this.get(jobId);
    if (!current) return null;
    const next = {
      ...current,
      ...patch,
      job_id: current.job_id,
    } satisfies BackgroundJobRecord;
    await this.writeRecord(next);
    return next;
  }

  async list(input: JobListInput): Promise<BackgroundJobRecord[]> {
    const jobs = await this.readAllRecords();
    return jobs
      .filter((entry): entry is BackgroundJobRecord => entry !== null)
      .filter((entry) => entry.cwd === input.cwd)
      .filter((entry) => !input.status || entry.status === input.status)
      .filter((entry) => !input.type || entry.type === input.type)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, input.limit);
  }

  async cleanup(input: JobCleanupInput): Promise<{
    dry_run: boolean;
    matched_count: number;
    removed_count: number;
    failed_count: number;
    entries: BackgroundJobCleanupEntry[];
  }> {
    const cutoff = typeof input.older_than_hours === "number"
      ? Date.now() - (input.older_than_hours * 60 * 60 * 1000)
      : null;
    const jobs = (await this.readAllRecords())
      .filter((entry): entry is BackgroundJobRecord => entry !== null)
      .filter((entry) => entry.cwd === input.cwd)
      .filter((entry) => TERMINAL_JOB_STATUSES.has(entry.status))
      .filter((entry) => {
        if (cutoff === null) return true;
        const updatedAt = Date.parse(entry.updated_at);
        return Number.isFinite(updatedAt) && updatedAt <= cutoff;
      })
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
      .slice(0, input.limit);

    const entries: BackgroundJobCleanupEntry[] = [];
    let removedCount = 0;
    let failedCount = 0;

    for (const job of jobs) {
      if (input.dry_run) {
        entries.push({
          job_id: job.job_id,
          type: job.type,
          status: job.status,
          updated_at: job.updated_at,
          removed: false,
          summary: job.summary,
        });
        continue;
      }

      try {
        await unlink(this.getJobPath(job.job_id));
        removedCount += 1;
        entries.push({
          job_id: job.job_id,
          type: job.type,
          status: job.status,
          updated_at: job.updated_at,
          removed: true,
          summary: job.summary,
        });
      } catch (err) {
        failedCount += 1;
        entries.push({
          job_id: job.job_id,
          type: job.type,
          status: job.status,
          updated_at: job.updated_at,
          removed: false,
          summary: job.summary,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      dry_run: input.dry_run,
      matched_count: jobs.length,
      removed_count: removedCount,
      failed_count: failedCount,
      entries,
    };
  }

  async findActiveByFingerprint(input: ActiveFingerprintInput): Promise<BackgroundJobRecord | null> {
    const jobs = await this.readAllRecords();
    const match = jobs
      .filter((entry): entry is BackgroundJobRecord => entry !== null)
      .filter((entry) => entry.cwd === input.cwd)
      .filter((entry) => !input.type || entry.type === input.type)
      .filter((entry) => entry.fingerprint === input.fingerprint)
      .filter((entry) => ACTIVE_JOB_STATUSES.has(entry.status))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    return match ?? null;
  }

  async touchHeartbeat(jobId: string, heartbeatAt = new Date().toISOString()): Promise<BackgroundJobRecord | null> {
    const current = await this.get(jobId);
    if (!current) return null;
    if (TERMINAL_JOB_STATUSES.has(current.status)) return current;
    return this.update(jobId, {
      heartbeat_at: heartbeatAt,
      updated_at: heartbeatAt,
    });
  }

  private getJobPath(jobId: string): string {
    return path.join(this.jobsDir, `${jobId}.json`);
  }

  private async readAllRecords(): Promise<Array<BackgroundJobRecord | null>> {
    await this.init();
    const entries = await readdir(this.jobsDir).catch(() => []);
    return Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map(async (entry) => {
          try {
            const raw = await readFile(path.join(this.jobsDir, entry), "utf8");
            return JSON.parse(raw) as BackgroundJobRecord;
          } catch {
            return null;
          }
        })
    );
  }

  private async writeRecord(record: BackgroundJobRecord): Promise<void> {
    const filePath = this.getJobPath(record.job_id);
    const tmpPath = `${filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(record, null, 2), "utf8");
    await rename(tmpPath, filePath);
  }
}
