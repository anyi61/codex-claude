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
export interface SessionLog {
    requested_session_id: string | null;
    resumed: boolean;
    forked: boolean;
    returned_session_id: string | null;
}
export declare function computeRepoKey(cwd: string): Promise<string>;
declare const RECENT_WINDOW_MINUTES = 20;
export { RECENT_WINDOW_MINUTES };
export declare class SessionStore {
    private filePath;
    constructor(baseDir: string);
    init(): Promise<void>;
    getRecent(repoKey: string, type: SessionType, withinMinutes?: number): Session | null;
    upsert(sessionId: string, type: SessionType, repoKey: string, repoPath: string, summary?: string): void;
    markExpired(sessionId: string): void;
    prune(): void;
    getAll(): Session[];
    private read;
    private atomicWrite;
}
