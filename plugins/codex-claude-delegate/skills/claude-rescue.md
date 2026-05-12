# Claude Code Rescue — Failure Recovery

Rescue workflows may use Advanced / Debug tools such as `claude_workspace_status`, `claude_job_result`, `claude_runs`, `claude_run_inspect`, and `claude_job_cancel`. Use them only after the default `claude_task` / `claude_result` path is insufficient or the user explicitly asks for diagnosis.

If an apply was refused because a high-level `claude_task` was given a plan file through deprecated `files`, retry the high-level task with `instruction_files` instead. Strict file scope belongs to Advanced / Debug `claude_implement.files`.

## When to use rescue procedures

Use these steps when delegated write work fails or produces unexpected results:

### 1. Write task failed or only partially completed

```
claude_result  # inspect the latest finished job/run
```

If a worktree was created:
- Run `claude_apply preview=true` before any apply decision
- If the result includes a `session` and the user explicitly wants to continue, use the suggested `claude_task(mode="write", resume_latest=true, task="Continue the previous implementation task and finish incomplete work.")`
- If there is no resumable session, start a fresh, smaller `claude_task(mode="write")`

### 2. Changed files exceeded limit

If `server_observed.resource_limits.changed_files_exceeded` is true:
- The worktree contains more changes than expected
- Run `claude_review` on the worktree diff before deciding
- Either apply if changes are correct, or discard the worktree

### 3. Apply conflicts

If `claude_apply` reports conflicts (uncommitted changes in main workspace):
- Commit or stash your local changes first
- Then retry `claude_apply`
- Do NOT force-apply partial changes (the tool refuses to partially apply)

If `claude_apply` reports `No changed source files found`:
- Confirm the delegated worktree actually contains changed files
- Docs, tests, package metadata, and root-level files are valid apply candidates when they were produced by the delegated run
- If untracked files are missing from preview, inspect `git status --short` inside the worktree

### 4. Stale worktrees

If `claude_cleanup(dry_run=true)` shows leftover worktrees:
- Run `claude_cleanup` (dry-run first to see what will be removed)
- Then `claude_cleanup dry_run: false` to remove them
- This frees disk space and keeps `git worktree list` clean

## General principles

- **Never apply blindly**: always review Claude's diff via `server_observed` first
- **Prefer smaller tasks**: a failed 5-file refactor should be split into 3 single-file tasks
- **Check worktree state**: use `claude_result`, `claude_apply preview=true`, or Advanced / Debug inspection tools before retrying
