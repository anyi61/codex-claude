# Advanced Tools

`codex-claude setup --write` enables only the default workflow tools:
`claude_setup`, `claude_task`, `claude_result`, `claude_apply`, and
`claude_cleanup`.

The tools below are for debugging, recovery, or lower-level integrations. Keep
the default tools enabled when adding any of them.

```toml
[mcp_servers.claude_delegate]
enabled_tools = [
  "claude_setup",
  "claude_task",
  "claude_result",
  "claude_apply",
  "claude_cleanup",
  "claude_status",
  "claude_runs",
  "claude_run_inspect",
  "claude_workspace_status",
  "claude_review_gate",
  "claude_job_wait",
  "claude_query",
  "claude_review",
  "claude_implement",
  "claude_jobs",
  "claude_job_result",
  "claude_job_cancel",
  "claude_job_cleanup",
  "claude_export"
]
```

| Tool | Use |
|------|-----|
| `claude_status` | Check Claude CLI, Git, worktree, and auth readiness. |
| `claude_runs` | List delegated run logs for a workspace. |
| `claude_run_inspect` | Inspect one run by `run_id`. |
| `claude_workspace_status` | Show jobs, runs, sessions, worktrees, and attention items. |
| `claude_review_gate` | Enable, disable, or inspect the review gate. |
| `claude_query` | Low-level read-only query entry point. |
| `claude_review` | Low-level review entry point. |
| `claude_implement` | Low-level isolated worktree implementation entry point. |
| `claude_jobs` | List background jobs. |
| `claude_job_result` | Read a job result by `job_id`. |
| `claude_job_cancel` | Cancel a running job. |
| `claude_job_cleanup` | Remove stale terminal job records. |
| `claude_job_wait` | Advanced / Recovery. Continue waiting for a background job; the default path is `claude_task(job_id=...)`. |
| `claude_export` | Export delegated worktree changes to a local branch without changing the main workspace. |

Prefer `claude_task` for normal use. It routes to read, review, or write mode,
waits inline by default, and returns standardized next actions.
