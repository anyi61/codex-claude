import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
export type EnvStatus = "set" | "set-redacted" | "present-in-parent-stripped" | "unset";
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
    max_cost_usd?: number;
    max_changed_files?: number;
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
export interface ResourceLimits {
    max_cost_usd?: number;
    max_changed_files?: number;
    actual_changed_files: number;
    changed_files_exceeded: boolean;
    warnings: string[];
}
export interface ServerObserved {
    changed_files: string[];
    diff_stat: string;
    diff_name_only: string;
    worktree_path?: string;
    resource_limits?: ResourceLimits;
}
export interface ClaudeResult {
    claude_report: Record<string, unknown>;
    server_observed: ServerObserved;
}
export interface EnvironmentDiagnostics {
    proxy_env_present: boolean;
    http_proxy: EnvStatus;
    https_proxy: EnvStatus;
    no_proxy: EnvStatus;
    anthropic_base_url: EnvStatus;
    anthropic_auth_token: EnvStatus;
    anthropic_api_key: EnvStatus;
    local_proxy_host?: string;
    local_proxy_port?: number;
    local_proxy_reachable?: boolean;
    local_proxy_error?: string;
    likely_sandbox_blocked: boolean;
    recommendation?: string;
}
export interface ClaudeStatusResult {
    claude_available: boolean;
    claude_version: string | null;
    auth_status: string | null;
    git_available: boolean;
    worktree_capable: boolean;
    cwd_valid: boolean;
    cwd_is_git_repo: boolean;
    delegated_worktrees_count: number;
    delegated_worktrees: string[];
    stale_worktrees_count: number;
    errors: string[];
    environment_diagnostics?: EnvironmentDiagnostics;
}
export interface SessionLog {
    requested_session_id: string | null;
    resumed: boolean;
    forked: boolean;
    returned_session_id: string | null;
}
export interface ClaudeApplyInput {
    cwd: string;
    worktree_path: string;
    cleanup?: boolean;
}
export interface ClaudeApplyResult {
    applied_files: string[];
    diff_stat: string;
    cleanup_performed: boolean;
    conflicts: string[];
    error?: string;
}
export interface ClaudeCleanupInput {
    cwd: string;
    older_than_hours?: number;
    dry_run?: boolean;
}
export interface CleanupEntry {
    worktree_name: string;
    removed: boolean;
    error?: string;
}
export interface ClaudeCleanupResult {
    dry_run: boolean;
    removed_count: number;
    failed_count: number;
    entries: CleanupEntry[];
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
