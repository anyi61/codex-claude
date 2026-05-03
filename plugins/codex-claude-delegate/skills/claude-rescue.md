# Claude Code Rescue — Failure Recovery

## When to use rescue procedures

Use these steps when `claude_implement` fails or produces unexpected results:

### 1. Implement failed (timeout / max_turns / error)

```
claude_status  # check if worktree exists
```

If worktree was created but Claude timed out:
- Run `claude_query` to inspect the partial worktree state
- Consider re-running `claude_implement` with a **smaller, more focused task**
- Use `session_key` if you want Claude to resume (but beware context pollution)

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
- Confirm the worktree actually changed files under `src/`
- Remember docs, `dist/`, and root-level files are intentionally ignored
- Untracked `src/` files should be detected; if not, inspect `git status --short -- src/` inside the worktree

### 4. Stale worktrees

If `claude_status` shows leftover worktrees:
- Run `claude_cleanup` (dry-run first to see what will be removed)
- Then `claude_cleanup dry_run: false` to remove them
- This frees disk space and keeps `git worktree list` clean

## General principles

- **Never apply blindly**: always review Claude's diff via `server_observed` first
- **Prefer smaller tasks**: a failed 5-file refactor should be split into 3 single-file tasks
- **Check worktree state**: use `claude_status` before retrying to understand what was left behind
