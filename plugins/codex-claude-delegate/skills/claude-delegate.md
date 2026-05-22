# Claude Code Delegate

Use `claude_task` for normal read/review/write delegation. `claude_task` defaults to inline-wait mode (blocking the MCP call until the result is ready). If the task isn't finished when the inline wait times out, `claude_task` returns `status="running"` with a `job_id` — call `claude_task(job_id=...)` to continue waiting for that same job. Do not start another job or implement locally while `waiting=true`.
First run sequence: `claude_setup` -> `claude_task` -> (if status=running) `claude_task(job_id=...)`.

`claude_task` does not accept `max_turns`. If the user explicitly asks for a turn cap, use the appropriate Advanced / Debug tool (`claude_query`, `claude_review`, or `claude_implement`) instead of the default high-level entrypoint.

For write tasks, `claude_task` produces an isolated git worktree result only — it never directly applies changes to the main workspace. Non-preview `claude_apply` modifies the main workspace. Always run `claude_apply preview=true` first, show or summarize the planned diff, and wait for explicit user approval before calling non-preview `claude_apply` with `confirmed_by_user=true`.

`preview=true` and `cleanup=true` must not be combined in a single `claude_apply` call — the server rejects this combination. Workflow `next_actions` from `claude_task` and `claude_result` only suggests `preview=true` actions; it never emits direct non-preview apply suggestions.

For normal `claude_task` calls, do not pass `files`. If Claude should read a plan or checklist, use `instruction_files` or mention the file in `task`; these files are context, not modification scope. Use `claude_task.allowed_files` for hard file modification limits, or Advanced / Debug `claude_implement.files` for advanced use.

## When NOT to use claude_implement

- Single-line bug fixes
- Adding a simple function to one file
- Tasks you can complete correctly in < 3 trivial edits
- Read-only tasks (use `claude_task mode=read` instead)

## Resumable implement sessions

When a write task returns `status="partial"` or `status="failed"` with a `session` field, there is a resumable Claude session. The workflow `next_actions` will include a `claude_task(mode="write", resume_latest=true, task="Continue the previous implementation task and finish incomplete work.")` suggestion.

- Present the user with options: preview existing changes, resume the session, or discard.
- Do NOT automatically resume without user confirmation.
- Do NOT skip preview when worktree changes exist.
- Only use `resume_latest=true` after the user explicitly chooses to continue.
- If the user chooses to discard, start a fresh `claude_task(mode="write")` without `resume_latest`.

## Default workflow

1. Start with `claude_task mode=write` and pass `task`, `cwd`, optional `instruction_files`, `constraints`, and `dirty_policy`.
2. `claude_task` defaults to inline wait — it blocks until the job completes or the wait timeout is reached.
3. If the returned `status="running"`, call `claude_task(job_id=...)` to continue waiting for the same job.
4. When the job completes inline, the result is returned directly — no separate `claude_result` call is needed.
5. Preview with `claude_apply preview=true` (no user approval needed for preview).
6. Show or summarize the planned diff to the user and ask whether to apply it.
7. Only after explicit user approval, apply with `claude_apply cleanup=true confirmed_by_user=true`.
8. Use `claude_cleanup` for leftover delegated worktrees.
