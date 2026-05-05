import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
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

  constructor(baseDir: string) {
    this.filePath = path.join(baseDir, "sessions.json");
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    if (!existsSync(this.filePath)) {
      this.atomicWrite({ version: STORE_VERSION, sessions: [] });
    }
  }

  // Find the most recent unexpired session matching type + repo, within the time window.
  getRecent(repoKey: string, type: SessionType, withinMinutes: number = RECENT_WINDOW_MINUTES): Session | null {
    const store = this.read();
    const cutoff = Date.now() - withinMinutes * 60 * 1000;

    const candidates = store.sessions
      .filter((s) => s.repo_key === repoKey && s.type === type && !s.expired)
      .filter((s) => new Date(s.last_used).getTime() > cutoff)
      .sort((a, b) => new Date(b.last_used).getTime() - new Date(a.last_used).getTime());

    return candidates[0] ?? null;
  }

  getById(sessionId: string): Session | null {
    const store = this.read();
    return store.sessions.find((session) => session.session_id === sessionId) ?? null;
  }

  listByRepo(repoKey: string, limit = 10): Session[] {
    const store = this.read();
    return store.sessions
      .filter((session) => session.repo_key === repoKey)
      .sort((a, b) => new Date(b.last_used).getTime() - new Date(a.last_used).getTime())
      .slice(0, limit);
  }

  // Create or update a session record.
  upsert(sessionId: string, type: SessionType, repoKey: string, repoPath: string, summary?: string): void {
    const store = this.read();
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

    this.atomicWrite(store);
  }

  markExpired(sessionId: string): void {
    const store = this.read();
    const session = store.sessions.find((s) => s.session_id === sessionId);
    if (session) {
      session.expired = true;
      this.atomicWrite(store);
    }
  }

  // Remove sessions expired longer than MAX_AGE_HOURS ago.
  prune(): void {
    const store = this.read();
    const cutoff = Date.now() - MAX_AGE_HOURS * 60 * 60 * 1000;
    store.sessions = store.sessions.filter((s) => {
      if (!s.expired) return true;
      return new Date(s.last_used).getTime() > cutoff;
    });
    this.atomicWrite(store);
  }

  getAll(): Session[] {
    return this.read().sessions;
  }

  // ---- Internals ----

  private read(): SessionFile {
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      return JSON.parse(raw) as SessionFile;
    } catch {
      return { version: STORE_VERSION, sessions: [] };
    }
  }

  private atomicWrite(data: SessionFile): void {
    const tmp = this.filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmp, this.filePath);
  }
}
