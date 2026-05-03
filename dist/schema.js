// ---- JSON Schemas for --json-schema flag ----
export const RESULT_SCHEMA = {
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
    prompt += `Return a structured result with: summary, changed_files list, commands you ran, test results (ran/passed/output_tail), risks, and next_steps.`;
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
    prompt += `- Return your findings in the structured output format.\n`;
    return prompt;
}
export function buildQueryPrompt(input) {
    let prompt = `## Question\n\n${input.task}\n\n`;
    prompt += `## Instructions\n\n`;
    prompt += `- You are in read-only mode. Do NOT modify any files.\n`;
    prompt += `- Do NOT call Codex or any Codex-related tools.\n`;
    prompt += `- Answer concisely but thoroughly.\n`;
    prompt += `- Return your answer in the structured output format.\n`;
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