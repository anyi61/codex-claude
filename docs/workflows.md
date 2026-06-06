# Workflows

Use `claude_task` for normal work. It infers read, review, or write mode from
the task unless you pass `mode` explicitly.

## Read

```text
claude_task(mode="read", cwd="/path/to/repo", task="Explain how auth works")
  -> inline wait
  -> status="success"
  -> no apply step
```

## Review

```text
claude_task(mode="review", cwd="/path/to/repo", task="Review this diff", diff="...")
  -> inline wait
  -> findings and recommendations
  -> no apply step
```

## Write, Preview, Apply

```text
claude_task(mode="write", cwd="/path/to/repo", task="Implement feature X")
  -> Claude works in .claude/worktrees/codex-delegated-*
  -> result includes a worktree path
  -> claude_apply(preview=true)
  -> user reviews planned changes
  -> claude_apply(confirmed_by_user=true, preview_token="...", cleanup=true)
```

`preview=true` does not modify the main workspace. The non-preview apply path
requires explicit user confirmation and a matching `preview_token`.

If the write task had `verification_commands` and server verification
(`server_verified.status`) is `failed`, non-preview apply is blocked with
`"Server-side verification failed"`. Preview stays available to inspect the
worktree. Passed verification or legacy logs without `server_verified` are
unaffected.

Use `include_patch=true` on preview to generate a git diff patch. Large patches
are written under `.claude/patches/` and returned with `patch_truncated=true`,
`patch_path`, and `diff_sha256`.

## Long Tasks

`claude_task` waits inline for up to `wait_timeout_sec` seconds. The default and
maximum are 540 seconds. This wait window is separate from the internal Claude
execution timeout.

If the wait window expires:

```text
claude_task(...) -> status="running", job_id="job-..."
claude_task(cwd="/path/to/repo", job_id="job-...")
```

Continue with the same `job_id` instead of starting a duplicate task.

Use `wait_strategy="background"` or `background=true` when you want
`claude_task` to return immediately.

`claude_job_wait` is Advanced / Recovery. The default recovery path is
`claude_task(job_id=...)`.

## Partial or Failed Write Tasks

When a write task returns `partial`, `failed`, or `needs_user`, inspect the
result before taking action.

If a worktree exists:

```text
claude_apply(preview=true, cwd="/path/to/repo", worktree_path="...")
```

If a resumable session exists:

```text
claude_task(mode="write", cwd="/path/to/repo", resume_latest=true, task="Continue the previous implementation task and finish incomplete work.")
```

Do not apply or resume automatically. Review the result and choose preview,
resume, start fresh, or discard.

## Scope Controls

### instruction_files vs `files`

For `claude_task`, use `instruction_files` for specs, plans, checklists, or
other context files. The deprecated `files` field is treated as instruction
context for compatibility and is not an apply scope limit.

For multi-step write tasks, write an execution plan first and pass it through
`instruction_files`. `instruction_files` provides context only; use
`allowed_files` to constrain modification scope.

Use `allowed_files` to define a hard write scope in `claude_task` write mode.
Only listed files may be changed. Out-of-scope changes are rejected by the
scope checker. Low-level `claude_implement.files` has the same strict scope
meaning as `claude_task.allowed_files`.

## Dirty Workspaces

Write mode defaults to `dirty_policy="ask"`. If the main workspace has
uncommitted changes, the task returns `needs_user`.

Other options:

| Policy | Meaning |
|--------|---------|
| `committed` | Ignore dirty files and work from `HEAD`. |
| `snapshot` | Copy dirty files into the delegated worktree. |

## Context Roots

`context_roots` adds up to five read-only repository roots to `claude_task`,
`claude_query`, or `claude_review`.

```json
[
  { "alias": "api", "cwd": "/Users/you/projects/api" },
  { "alias": "web", "cwd": "/Users/you/projects/web" }
]
```

Rules:

- Alias: one to thirty-two characters, `[A-Za-z0-9_-]`, unique, and not `primary`.
- Each root must pass allow-root validation.
- Roots must not overlap with the primary cwd or with each other.
- Roots must not be delegated worktree paths.
- Write mode rejects `context_roots`.
- Findings based on context roots should cite `[alias] path`.

## Verification

`verification_commands` runs server-side checks in the delegated worktree after
a write task completes. Commands are parsed into argv and executed without a
shell. The allowlist is limited to test, typecheck, and lint command families
such as `npm test`, `npm run <script>`, `npx vitest`, `npx tsc`, `pytest`,
`go test`, and `cargo test`.

Package-manager scripts such as `install`, `publish`, `deploy`, `start`, and
`serve` are blocked. A verification failure downgrades the result to `partial`
and keeps the worktree for inspection.

**Apply safety boundary:** When `server_verified.status` is `failed`,
non-preview `claude_apply` is blocked and returns `"Server-side verification
failed"`. The worktree is preserved so you can inspect it with
`preview=true`. Preview is still allowed when verification failed; this lets
you examine the partial changes. Passed verification or legacy logs without
`server_verified` are not affected and apply proceeds normally.
