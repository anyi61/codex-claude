import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
// ---- Repo key ----
export async function computeRepoKey(cwd) {
    const resolved = await realpath(cwd);
    return createHash("sha256").update(resolved).digest("hex");
}
// ---- Session store ----
const STORE_VERSION = 1;
const RECENT_WINDOW_MINUTES = 20;
export { RECENT_WINDOW_MINUTES };
const MAX_AGE_HOURS = 24;
export class SessionStore {
    filePath;
    constructor(baseDir) {
        this.filePath = path.join(baseDir, "sessions.json");
    }
    async init() {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        if (!existsSync(this.filePath)) {
            this.atomicWrite({ version: STORE_VERSION, sessions: [] });
        }
    }
    // Find the most recent unexpired session matching type + repo, within the time window.
    getRecent(repoKey, type, withinMinutes = RECENT_WINDOW_MINUTES) {
        const store = this.read();
        const cutoff = Date.now() - withinMinutes * 60 * 1000;
        const candidates = store.sessions
            .filter((s) => s.repo_key === repoKey && s.type === type && !s.expired)
            .filter((s) => new Date(s.last_used).getTime() > cutoff)
            .sort((a, b) => new Date(b.last_used).getTime() - new Date(a.last_used).getTime());
        return candidates[0] ?? null;
    }
    // Create or update a session record.
    upsert(sessionId, type, repoKey, repoPath, summary) {
        const store = this.read();
        const idx = store.sessions.findIndex((s) => s.session_id === sessionId);
        const now = new Date().toISOString();
        const entry = {
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
        }
        else {
            store.sessions.push(entry);
        }
        this.atomicWrite(store);
    }
    markExpired(sessionId) {
        const store = this.read();
        const session = store.sessions.find((s) => s.session_id === sessionId);
        if (session) {
            session.expired = true;
            this.atomicWrite(store);
        }
    }
    // Remove sessions expired longer than MAX_AGE_HOURS ago.
    prune() {
        const store = this.read();
        const cutoff = Date.now() - MAX_AGE_HOURS * 60 * 60 * 1000;
        store.sessions = store.sessions.filter((s) => {
            if (!s.expired)
                return true;
            return new Date(s.last_used).getTime() > cutoff;
        });
        this.atomicWrite(store);
    }
    getAll() {
        return this.read().sessions;
    }
    // ---- Internals ----
    read() {
        try {
            const raw = readFileSync(this.filePath, "utf-8");
            return JSON.parse(raw);
        }
        catch {
            return { version: STORE_VERSION, sessions: [] };
        }
    }
    atomicWrite(data) {
        const tmp = this.filePath + ".tmp";
        writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
        renameSync(tmp, this.filePath);
    }
}
//# sourceMappingURL=session.js.map