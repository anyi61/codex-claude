# Claude Code Delegate

Use `claude_task` for normal read/review/write delegation. After it returns a `job_id`, call `claude_job_wait` for that same job. Respect `recommended_delay_ms` and `next_allowed_poll_at`. If `poll_too_soon=true`, wait until `next_allowed_poll_at` before polling again. Do not start another job or implement locally while `waiting=true`.
First run sequence: `claude_setup` -> `claude_task` -> `claude_job_wait` -> `claude_result`.

`claude_task` does not accept `max_turns`. If the user explicitly asks for a turn cap, use the appropriate Advanced / Debug tool (`claude_query`, `claude_review`, or `claude_implement`) instead of the default high-level entrypoint.

For write tasks, `claude_task` produces an isolated git worktree result only — it never directly applies changes to the main workspace. Non-preview `claude_apply` modifies the main workspace. Always run `claude_apply preview=true` first, show or summarize the planned diff, and wait for explicit user approval before calling non-preview `claude_apply` with `confirmed_by_user=true`.

`preview=true` and `cleanup=true` must not be combined in a single `claude_apply` call — the server rejects this combination. Workflow `next_actions` from `claude_result` or `claude_job_wait` only suggests `preview=true` actions; it never emits direct non-preview apply suggestions.

For normal `claude_task` calls, do not pass `files`. If Claude should read a plan or checklist, use `instruction_files` or mention the file in `task`; these files are context, not modification scope. Use Advanced / Debug `claude_implement.files` only when strict file modification limits are explicitly required.

## When NOT to use claude_implement

- Single-line bug fixes
- Adding a simple function to one file
- Tasks you can complete correctly in < 3 trivial edits
- Read-only tasks (use `claude_task mode=read` instead)

## Default workflow

1. Start with `claude_task mode=write` and pass `task`, `cwd`, optional `instruction_files`, `constraints`, `max_cost_usd`, `max_changed_files`.
2. Capture the returned `job_id`.
3. Poll with `claude_job_wait`, respecting `recommended_delay_ms`.
4. When the job finishes terminal, call `claude_result`.
5. Preview with `claude_apply preview=true` (no user approval needed for preview).
6. Show or summarize the planned diff to the user and ask whether to apply it.
7. Only after explicit user approval, apply with `claude_apply cleanup=true confirmed_by_user=true`.
8. Use `claude_cleanup` for leftover delegated worktrees.
