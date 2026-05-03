# Claude Code Review

## When to use claude_review

Use `claude_review` (MCP tool `claude_delegate`) when you need a second opinion on code changes:

1. **Before risky implementations** — diff of planned changes before applying to main branch
2. **Complex patches** — diffs that touch multiple modules or cross-cutting concerns
3. **Security-sensitive changes** — authentication, authorization, input handling, secrets management
4. **Unfamiliar code** — when you are not sure about edge cases or idiomatic patterns
5. **After claude_implement** — review Claude's diff before calling `claude_apply`
6. **Ongoing codebase audit** — periodic quality or security review of specific modules

## How it works

- Claude runs in read-only mode (cannot modify files)
- Provide a task description and optional diff/file list
- Returns structured findings, recommendations, and severity (critical/high/medium/low/none)

## When NOT to use claude_review

- Typos or trivial formatting (use linters instead)
- After you have already applied changes (review before apply)
- When you just need to understand code (use `claude_query` instead)
