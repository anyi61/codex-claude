# Claude Code Review

For ordinary review requests, prefer `claude_task mode=review` and poll with `claude_job_wait`. Use `instruction_files` for plan/checklist context. Use direct `claude_review` only for Advanced / Debug workflows or when the user explicitly asks for the bottom-level tool.

## When to use review

1. **Before risky implementations** — diff of planned changes before applying to main branch
2. **Complex patches** — diffs that touch multiple modules or cross-cutting concerns
3. **Security-sensitive changes** — authentication, authorization, input handling, secrets management
4. **Unfamiliar code** — when you are not sure about edge cases or idiomatic patterns
5. **After claude_implement** — review Claude's diff before calling `claude_apply`

## How it works

- Claude runs in read-only mode (cannot modify files)
- Provide a task description and optional diff/file list
- Returns structured findings, recommendations, and severity (critical/high/medium/low/none)

## When NOT to use claude_review

- Typos or trivial formatting (use linters instead)
- After you have already applied changes (review before apply)
- When you just need to understand code (use `claude_query` instead)

A review result is not apply approval. After reviewing a delegated worktree, ask the user before any non-preview `claude_apply` call.
