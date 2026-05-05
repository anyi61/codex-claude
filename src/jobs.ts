import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
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
    await this.init();
    const entries = await readdir(this.jobsDir).catch(() => []);
    const jobs = (
      await Promise.all(
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
      )
    )
      .filter((entry): entry is BackgroundJobRecord => entry !== null)
      .filter((entry) => entry.cwd === input.cwd)
      .filter((entry) => !input.status || entry.status === input.status)
      .filter((entry) => !input.type || entry.type === input.type)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));

    return jobs.slice(0, input.limit);
  }

  private getJobPath(jobId: string): string {
    return path.join(this.jobsDir, `${jobId}.json`);
  }

  private async writeRecord(record: BackgroundJobRecord): Promise<void> {
    const filePath = this.getJobPath(record.job_id);
    const tmpPath = `${filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(record, null, 2), "utf8");
    await rename(tmpPath, filePath);
  }
}
