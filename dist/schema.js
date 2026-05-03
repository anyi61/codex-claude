// ---- JSON Schemas for --json-schema flag ----
// For claude_query: answer-focused, no file/tool fields.
export const QUERY_SCHEMA = {
    type: "object",
    required: ["answer"],
    properties: {
        answer: { type: "string", description: "The full, detailed answer to the question. Include all relevant information." },
    },
};
// For claude_review: findings-focused, read-only.
export const REVIEW_SCHEMA = {
    type: "object",
    required: ["findings", "recommendations", "severity"],
    properties: {
        findings: { type: "string", description: "Detailed review findings: bugs, design issues, security concerns, performance problems." },
        recommendations: { type: "string", description: "Specific, actionable recommendations for each finding." },
        severity: { type: "string", enum: ["critical", "high", "medium", "low", "none"], description: "Overall severity of issues found." },
    },
};
// For claude_implement: full task report with file changes and test results.
export const IMPLEMENT_SCHEMA = {
    type: "object",
    required: ["status", "summary", "changed_files", "commands_run", "tests", "risks", "next_steps"],
    properties: {
        status: {
            type: "string",
            enum: ["success", "failed", "partial", "needs_user"],
        },
        summary: { type: "string" },
        changed_files: {
            type: "array",
            items: { type: "string" },
        },
        commands_run: {
            type: "array",
            items: { type: "string" },
        },
        tests: {
            type: "object",
            required: ["ran"],
            properties: {
                ran: { type: "boolean" },
                command: { type: "string" },
                passed: { type: "boolean" },
                output_tail: { type: "string" },
            },
        },
        risks: {
            type: "array",
            items: { type: "string" },
        },
        next_steps: {
            type: "array",
            items: { type: "string" },
        },
    },
};
// Backwards-compatible alias
export const RESULT_SCHEMA = IMPLEMENT_SCHEMA;
// ---- Prompt templates ----
export function buildImplementPrompt(input) {
    let prompt = `## Task\n\n${input.task}\n\n`;
    if (input.files?.length) {
        prompt += `## Relevant Files\n\n${input.files.map((f) => `- \`${f}\``).join("\n")}\n\n`;
    }
    prompt += `## Constraints\n\n`;
    prompt += `- You are a worker delegated by Codex. Do NOT call Codex or any Codex-related tools.\n`;
    prompt += `- Do not delegate this task to another agent. Complete it yourself.\n`;
    prompt += `- Work exclusively within the provided worktree.\n`;
    prompt += `- After making changes, run the project's tests if available.\n`;
    if (input.constraints?.length) {
        prompt += input.constraints.map((c) => `- ${c}`).join("\n") + "\n";
    }
    prompt += `\n## Deliverable\n\n`;
    prompt += `Return a structured result with: status (success/failed/partial/needs_user), summary, changed_files list, commands_run list, tests (ran, command, passed, output_tail), risks list, and next_steps list.`;
    return prompt;
}
export function buildReviewPrompt(input) {
    let prompt = `## Review Request\n\n${input.task}\n\n`;
    if (input.diff) {
        prompt += `## Diff to Review\n\n\`\`\`diff\n${input.diff}\n\`\`\`\n\n`;
    }
    if (input.files?.length) {
        prompt += `## Relevant Files\n\n${input.files.map((f) => `- \`${f}\``).join("\n")}\n\n`;
    }
    prompt += `\n## Instructions\n\n`;
    prompt += `- You are a reviewer. Do NOT modify any files.\n`;
    prompt += `- Do NOT call Codex or any Codex-related tools.\n`;
    prompt += `- Provide a thorough code review: bugs, design issues, security concerns, performance problems.\n`;
    prompt += `- Return your findings in a structured result with: findings (detailed description of each issue), recommendations (specific actionable fixes), and severity (one of: critical, high, medium, low, none).\n`;
    return prompt;
}
export function buildQueryPrompt(input) {
    let prompt = `## Question\n\n${input.task}\n\n`;
    prompt += `## Instructions\n\n`;
    prompt += `- You are in read-only mode. Do NOT modify any files.\n`;
    prompt += `- Do NOT call Codex or any Codex-related tools.\n`;
    prompt += `- Answer thoroughly with all relevant details.\n`;
    prompt += `- Return your answer in a structured result with: answer (a single string containing your complete answer with all details).\n`;
    return prompt;
}
// ---- MCP tool result helpers ----
export function jsonResult(data) {
    return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
}
export function errorResult(message) {
    return {
        content: [{ type: "text", text: JSON.stringify({ error: message }) }],
        isError: true,
    };
}
//# sourceMappingURL=schema.js.map