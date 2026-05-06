# Claude Code Delegate

Use `claude_task` for normal read/review/write delegation. After it returns a `job_id`, call `claude_job_wait` for that same job. Respect `recommended_delay_ms`. Do not start another job or implement locally while `waiting=true`.

## When NOT to use claude_implement

- Single-line bug fixes
- Adding a simple function to one file
- Tasks you can complete correctly in < 3 trivial edits
- Read-only tasks (use `claude_task mode=read` instead)

## Default workflow

1. Start with `claude_task mode=write` and pass `task`, `cwd`, `files`, `constraints`, `max_cost_usd`, `max_changed_files`.
2. Capture the returned `job_id`.
3. Poll with `claude_job_wait`, respecting `recommended_delay_ms`.
4. When the job finishes terminal, call `claude_result`.
5. Preview with `claude_apply preview=true`.
6. After review, apply with `claude_apply cleanup=true`.
7. Use `claude_cleanup` for leftover delegated worktrees.
