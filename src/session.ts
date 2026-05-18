import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

// ---- Types ----

export type SessionType = "query" | "review" | "implement";

export interface Session {
  session_id: string;
  type: SessionType;
  repo_key: string;
  repo_path: string;
  created_at: string;
  last_used: string;
  use_count: number;
  summary: string;
  expired: boolean;
}

interface SessionFile {
  version: number;
  sessions: Session[];
}

export interface SessionLog {
  requested_session_id: string | null;
  resumed: boolean;
  forked: boolean;
  returned_session_id: string | null;
}

// ---- Repo key ----

export async function computeRepoKey(cwd: string): Promise<string> {
  const resolved = await realpath(cwd);
  return createHash("sha256").update(resolved).digest("hex");
}

// ---- Session store ----

const STORE_VERSION = 1;
const RECENT_WINDOW_MINUTES = 20;
export { RECENT_WINDOW_MINUTES };
const MAX_AGE_HOURS = 24;

export class SessionStore {
  private filePath: string;
  #writeLock: Promise<void> = Promise.resolve();

  constructor(baseDir: string) {
    this.filePath = path.join(baseDir, "sessions.json");
  }

  async init(): Promise<void> {
    await this.withWriteLock(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      try {
        await readFile(this.filePath, "utf-8");
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          await this.atomicWrite({ version: STORE_VERSION, sessions: [] });
          return;
        }
        throw err;
      }
    });
  }

  // Find the most recent unexpired session matching type + repo, within the time window.
  async getRecent(repoKey: string, type: SessionType, withinMinutes: number = RECENT_WINDOW_MINUTES): Promise<Session | null> {
    const store = await this.read();
    const cutoff = Date.now() - withinMinutes * 60 * 1000;

    const candidates = store.sessions
      .filter((s) => s.repo_key === repoKey && s.type === type && !s.expired)
      .filter((s) => new Date(s.last_used).getTime() > cutoff)
      .sort((a, b) => new Date(b.last_used).getTime() - new Date(a.last_used).getTime());

    return candidates[0] ?? null;
  }

  async getById(sessionId: string): Promise<Session | null> {
    const store = await this.read();
    return store.sessions.find((session) => session.session_id === sessionId) ?? null;
  }

  async listByRepo(repoKey: string, limit = 10): Promise<Session[]> {
    const store = await this.read();
    return store.sessions
      .filter((session) => session.repo_key === repoKey)
      .sort((a, b) => new Date(b.last_used).getTime() - new Date(a.last_used).getTime())
      .slice(0, limit);
  }

  // Create or update a session record.
  async upsert(sessionId: string, type: SessionType, repoKey: string, repoPath: string, summary?: string): Promise<void> {
    await this.withWriteLock(async () => {
      const store = await this.read();
      const idx = store.sessions.findIndex((s) => s.session_id === sessionId);

      const now = new Date().toISOString();
      const entry: Session = {
        session_id: sessionId,
        type,
        repo_key: repoKey,
        repo_path: repoPath,
        created_at: idx >= 0 ? store.sessions[idx].created_at : now,
        last_used: now,
        use_count: idx >= 0 ? store.sessions[idx].use_count + 1 : 1,
        summary: summary ?? "",
        expired: false,
      };

      if (idx >= 0) {
        store.sessions[idx] = entry;
      } else {
        store.sessions.push(entry);
      }

      await this.atomicWrite(store);
    });
  }

  async markExpired(sessionId: string): Promise<void> {
    await this.withWriteLock(async () => {
      const store = await this.read();
      const session = store.sessions.find((s) => s.session_id === sessionId);
      if (session) {
        session.expired = true;
        await this.atomicWrite(store);
      }
    });
  }

  // Remove sessions expired longer than MAX_AGE_HOURS ago.
  async prune(): Promise<void> {
    await this.withWriteLock(async () => {
      const store = await this.read();
      const cutoff = Date.now() - MAX_AGE_HOURS * 60 * 60 * 1000;
      store.sessions = store.sessions.filter((s) => {
        if (!s.expired) return true;
        return new Date(s.last_used).getTime() > cutoff;
      });
      await this.atomicWrite(store);
    });
  }

  async getAll(): Promise<Session[]> {
    return (await this.read()).sessions;
  }

  // ---- Internals ----

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.#writeLock;
    let resolve: () => void;
    this.#writeLock = new Promise<void>((r) => { resolve = r; });
    await prev;
    try {
      return await fn();
    } finally {
      resolve!();
    }
  }

  private async read(): Promise<SessionFile> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      return JSON.parse(raw) as SessionFile;
    } catch {
      return { version: STORE_VERSION, sessions: [] };
    }
  }

  private async atomicWrite(data: SessionFile): Promise<void> {
    const tmp = this.filePath + ".tmp";
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
    await rename(tmp, this.filePath);
  }
}
