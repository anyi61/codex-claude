import type { ClaudeApplyInput, ClaudeApplyResult, ClaudeCleanupInput, ClaudeCleanupResult, ClaudeImplementInput, ClaudeQueryInput, ClaudeReviewInput, ClaudeResult, ClaudeStatusResult } from "./schema.js";
export declare function checkClaudeStatus(cwd: string): Promise<ClaudeStatusResult>;
export declare function runClaudeQuery(input: ClaudeQueryInput, runId: string): Promise<Record<string, unknown>>;
export declare function runClaudeReview(input: ClaudeReviewInput, runId: string): Promise<Record<string, unknown>>;
export declare function runClaudeImplement(input: ClaudeImplementInput, runId: string): Promise<ClaudeResult>;
export declare function runClaudeApply(input: ClaudeApplyInput, runId: string): Promise<ClaudeApplyResult>;
export declare function runClaudeCleanup(input: ClaudeCleanupInput, runId: string): Promise<ClaudeCleanupResult>;
