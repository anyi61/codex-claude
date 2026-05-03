export interface CwdCheck {
    ok: boolean;
    resolved: string;
    error?: string;
}
export declare function validateCwd(raw: string): Promise<CwdCheck>;
export declare function isGitRepo(cwd: string): Promise<boolean>;
export declare function supportsWorktree(cwd: string): Promise<boolean>;
export declare const MAX_BRIDGE_DEPTH = 2;
export declare function checkRecursion(): number;
export declare function sanitizeEnv(): Record<string, string>;
export declare function execCapture(command: string, args: string[], opts: {
    cwd: string;
    timeoutMs?: number;
}): Promise<string>;
export declare function execStream(command: string, args: string[], opts: {
    cwd: string;
    timeoutMs?: number;
}, onStdout?: (line: string) => void): Promise<{
    code: number | null;
    stderr: string;
}>;
