import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
export interface ClaudeStatusInput {
    cwd: string;
}
export interface ClaudeQueryInput {
    task: string;
    cwd: string;
    timeout_sec?: number;
}
export interface ClaudeReviewInput {
    task: string;
    cwd: string;
    diff?: string;
    files?: string[];
    timeout_sec?: number;
}
export interface ClaudeImplementInput {
    task: string;
    cwd: string;
    files?: string[];
    constraints?: string[];
    timeout_sec?: number;
    session_key?: string;
    fork_session?: boolean;
}
export interface TestResult {
    ran: boolean;
    command?: string;
    passed?: boolean;
    output_tail?: string;
}
export interface ClaudeReport {
    status: "success" | "failed" | "partial" | "needs_user";
    summary: string;
    changed_files: string[];
    commands_run: string[];
    tests: TestResult;
    risks: string[];
    next_steps: string[];
}
export interface ServerObserved {
    changed_files: string[];
    diff_stat: string;
    diff_name_only: string;
    worktree_path?: string;
}
export interface ClaudeResult {
    claude_report: Record<string, unknown>;
    server_observed: ServerObserved;
}
export interface ClaudeStatusResult {
    claude_available: boolean;
    claude_version: string | null;
    auth_status: string | null;
    git_available: boolean;
    worktree_capable: boolean;
    cwd_valid: boolean;
    cwd_is_git_repo: boolean;
    errors: string[];
}
export interface SessionLog {
    requested_session_id: string | null;
    resumed: boolean;
    forked: boolean;
    returned_session_id: string | null;
}
export declare const QUERY_SCHEMA: {
    readonly type: "object";
    readonly required: readonly ["answer"];
    readonly properties: {
        readonly answer: {
            readonly type: "string";
            readonly description: "The full, detailed answer to the question. Include all relevant information.";
        };
    };
};
export declare const REVIEW_SCHEMA: {
    readonly type: "object";
    readonly required: readonly ["findings", "recommendations", "severity"];
    readonly properties: {
        readonly findings: {
            readonly type: "string";
            readonly description: "Detailed review findings: bugs, design issues, security concerns, performance problems.";
        };
        readonly recommendations: {
            readonly type: "string";
            readonly description: "Specific, actionable recommendations for each finding.";
        };
        readonly severity: {
            readonly type: "string";
            readonly enum: readonly ["critical", "high", "medium", "low", "none"];
            readonly description: "Overall severity of issues found.";
        };
    };
};
export declare const IMPLEMENT_SCHEMA: {
    readonly type: "object";
    readonly required: readonly ["status", "summary", "changed_files", "commands_run", "tests", "risks", "next_steps"];
    readonly properties: {
        readonly status: {
            readonly type: "string";
            readonly enum: readonly ["success", "failed", "partial", "needs_user"];
        };
        readonly summary: {
            readonly type: "string";
        };
        readonly changed_files: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
        };
        readonly commands_run: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
        };
        readonly tests: {
            readonly type: "object";
            readonly required: readonly ["ran"];
            readonly properties: {
                readonly ran: {
                    readonly type: "boolean";
                };
                readonly command: {
                    readonly type: "string";
                };
                readonly passed: {
                    readonly type: "boolean";
                };
                readonly output_tail: {
                    readonly type: "string";
                };
            };
        };
        readonly risks: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
        };
        readonly next_steps: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
        };
    };
};
export declare const RESULT_SCHEMA: {
    readonly type: "object";
    readonly required: readonly ["status", "summary", "changed_files", "commands_run", "tests", "risks", "next_steps"];
    readonly properties: {
        readonly status: {
            readonly type: "string";
            readonly enum: readonly ["success", "failed", "partial", "needs_user"];
        };
        readonly summary: {
            readonly type: "string";
        };
        readonly changed_files: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
        };
        readonly commands_run: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
        };
        readonly tests: {
            readonly type: "object";
            readonly required: readonly ["ran"];
            readonly properties: {
                readonly ran: {
                    readonly type: "boolean";
                };
                readonly command: {
                    readonly type: "string";
                };
                readonly passed: {
                    readonly type: "boolean";
                };
                readonly output_tail: {
                    readonly type: "string";
                };
            };
        };
        readonly risks: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
        };
        readonly next_steps: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
        };
    };
};
export declare function buildImplementPrompt(input: ClaudeImplementInput): string;
export declare function buildReviewPrompt(input: ClaudeReviewInput): string;
export declare function buildQueryPrompt(input: ClaudeQueryInput): string;
export declare function jsonResult(data: unknown): CallToolResult;
export declare function errorResult(message: string): CallToolResult;
export declare function formatDuration(ms: number): string;
