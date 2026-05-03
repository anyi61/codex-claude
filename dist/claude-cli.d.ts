import type { ClaudeImplementInput, ClaudeQueryInput, ClaudeReviewInput, ClaudeReport, ClaudeResult, ClaudeStatusResult } from "./schema.js";
export declare function checkClaudeStatus(cwd: string): Promise<ClaudeStatusResult>;
export declare function runClaudeQuery(input: ClaudeQueryInput, runId: string): Promise<ClaudeReport>;
export declare function runClaudeReview(input: ClaudeReviewInput, runId: string): Promise<ClaudeReport>;
export declare function runClaudeImplement(input: ClaudeImplementInput, runId: string): Promise<ClaudeResult>;
