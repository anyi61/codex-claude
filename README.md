# codex-claude-delegate-mcp

Let Codex delegate read/review/write tasks to Claude Code through a local MCP server.

## Quick Start

```bash
npm install -g @anyi61/codex-claude-delegate-mcp
codex-claude setup --write
codex-claude doctor
```

Restart Codex, then ask:

```text
Use claude_setup to check this repository.
```

### 60-Second Demo

```text
1. claude_setup                          → checks workspace readiness
2. claude_task(mode="read", ...)         → delegate a read analysis
3. claude_task(mode="write", ...)        → delegate a write task with instruction_files
4. claude_job_wait(...)                  → poll until the job completes
5. claude_result(...)                    → inspect results and changed files
6. claude_apply(preview=true, ...)       → preview the diff
7. user approval                         → user confirms
8. claude_apply(cleanup=true, ...)       → apply changes and clean up worktree
9. claude_cleanup(dry_run=true, ...)     → confirm no stale worktrees remain
```

## Features

- **Delegate read/review/write tasks** — from Codex to Claude Code
- **Isolated git worktree execution** — write tasks run in a separate worktree, leaving your main workspace untouched
- **Background job polling** — all delegations are queued as background jobs with progress tracking
- **Preview before apply** — review worktree diffs before landing changes in your main workspace
- **Review gate** — optional stop-hook that prompts review before terminal state transitions

## Install

### Prerequisites

- Codex CLI installed and authenticated
- `node` >= 20 available in PATH
- Claude Code CLI `claude` available in PATH (or set `CLAUDE_BIN`)
- Git (write mode requires worktree support)

### Global install (recommended)

```bash
npm install -g @anyi61/codex-claude-delegate-mcp
```

Verify installation:

```bash
codex-claude --version
```

### Setup

Write the MCP server configuration to Codex config:

```bash
codex-claude setup --write
```

This adds `command = "codex-claude"` with the default 6 tools to `~/.codex/config.toml`.

Options:

| Flag | Description |
|------|-------------|
| `--force` | Overwrite existing claude_delegate config (creates timestamped backup) |
| `--allow-root <path>` | Add a repository to `CODEX_CLAUDE_ALLOW_ROOTS` |
| `--project` | Write to `./.codex/config.toml` instead of global config |
| `--print` | Preview the config that would be written |

### Doctor

Verify your installation:

```bash
codex-claude doctor
```

Checks Node.js ≥ 20, package version, Claude CLI path/version, Git, worktree support, Codex config, default tools, and allow roots.

```bash
codex-claude doctor --json
```

### Print config

See the MCP server TOML config without writing:

```bash
codex-claude print-config
codex-claude print-config --source /path/to/repo
codex-claude print-config --project
```

## Default tool set

`setup --write` and `print-config` enable exactly 6 tools:

| Tool | Usage |
|------|-------|
| `claude_setup` | First-use / check workspace readiness |
| `claude_task` | **Recommended entry point**, auto-routes to read/review/write |
| `claude_job_wait` | Poll background job until terminal state |
| `claude_result` | Get the most relevant completed result + next_actions |
| `claude_apply` | Preview or land worktree changes into main workspace |
| `claude_cleanup` | Remove stale delegated worktrees (defaults to dry-run) |

## Usage flow

### Read-only analysis

```text
claude_task(mode="read", cwd="/path/to/repo", task="Explain how auth works")
  → claude_job_wait(cwd="...", job_id="job-xxx")
  → claude_result(cwd="...", prefer="latest-job")
```

### Review / audit

```text
claude_task(mode="review", cwd="/path/to/repo", task="Check for security issues")
  → claude_job_wait → claude_result
```

### Write / apply / cleanup

```text
claude_task(mode="write", cwd="/path/to/repo", task="Implement feature X")
  → claude_job_wait(cwd="...", job_id="...")
  → claude_result(cwd="...")
  → claude_apply(cwd="...", worktree_path=".claude/worktrees/...", preview=true)
  → user confirms → claude_apply(cwd="...", worktree_path="...", cleanup=true, confirmed_by_user=true)
  → claude_cleanup(cwd="...", dry_run=true)
```

## Advanced / Debug tools

These tools are NOT in the default config. Enable them explicitly in `~/.codex/config.toml`:

```toml
[mcp_servers.claude_delegate]
enabled_tools = ["claude_status", "claude_runs", "claude_run_inspect", "claude_workspace_status", "claude_review_gate", "claude_query", "claude_review", "claude_implement", "claude_jobs", "claude_job_result", "claude_job_cancel", "claude_job_cleanup"]
```

| Tool | Purpose |
|------|---------|
| `claude_status` | Check Claude/Git/worktree/auth status |
| `claude_runs` | List historical run logs |
| `claude_run_inspect` | View single run details by run_id |
| `claude_workspace_status` | Aggregated view: jobs / runs / sessions / worktrees |
| `claude_review_gate` | Enable/disable/status review gate |
| `claude_query` | Read-only Q&A (low-level entry) |
| `claude_review` | Read-only review (low-level entry) |
| `claude_implement` | Isolated worktree implementation (low-level entry) |
| `claude_jobs` | List background jobs |
| `claude_job_result` | Read job by job_id |
| `claude_job_cancel` | Cancel a running job |
| `claude_job_cleanup` | Clean old terminal job records |

## Important notes

- **`claude_task.files` is deprecated.** Use `instruction_files` instead. `claude_task.files` is treated as context only, not apply scope.
- **`claude_implement.files`** is a strict scope control for cases where precise file constraints are needed.
- **Uncommitted workspace changes:** Default returns `needs_user`. Pass `dirty_policy=committed` to ignore local changes, or `dirty_policy=snapshot` to copy dirty files into the worktree.
- **Polling behavior:** `claude_job_wait` does not long-block. When `poll_too_soon=true`, wait until `next_allowed_poll_at`. When `waiting=true`, do not start a duplicate job.
- **Turn caps:** `claude_task` does not accept `max_turns`. Use Advanced tools (`claude_query` / `claude_review` / `claude_implement`) when explicit turn limits are needed.
- **Apply safety:** `preview=true` does not modify the main workspace. Non-preview `claude_apply` requires `confirmed_by_user=true` after user approval.
- **Invalid combination:** `preview=true` + `cleanup=true` is rejected — preview should not delete the worktree.
- **Next actions:** `claude_result` and `claude_job_wait` only suggest preview operations (`preview=true`), never direct non-preview apply.

## Configuration

### Allow roots

Default allowed roots are `~/projects`, `~/work`, `~/codex-claude`. Extend via:

```toml
# ~/.codex/config.toml
[shell_environment_policy.set]
CODEX_CLAUDE_ALLOW_ROOTS = "/Users/you/projects:/Users/you/work:/Users/you/my-repo"
```

Or use the CLI:

```bash
codex-claude setup --write --allow-root "$(pwd)"
```

### Development / maintenance

If you are a maintainer building from source:

```bash
git clone https://github.com/anyi61/codex-claude.git
cd codex-claude
npm install
npm run build:plugin
npm run check:plugin
```

The plugin directory (`plugins/`) remains as internal packaging. For development, use `npm run dev` or `npm run build`.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `claude` command not found | Install Claude Code CLI or set `CLAUDE_BIN` |
| cwd outside allowed roots | `codex-claude setup --write --allow-root "$(pwd)"` |
| Dangerous allow root | Use a specific repo path, not `/`, `/tmp`, `/etc`, or `$HOME` |
| `poll_too_soon=true` | Wait until `next_allowed_poll_at`, do not start a new task |
| `waiting=true` | Continue polling the same `job_id`, do not re-delegate |
| Stale job | Use claude_result to inspect; with Advanced tools, claude_job_cancel may help |
| Apply refused: dirty workspace | Commit/stash changes, or use `dirty_policy=committed` |
| Missing `confirmed_by_user` | Show the preview and get explicit user approval before applying |
| `preview=true` + `cleanup=true` | Split into preview and confirmed apply+cleanup |
| Leftover worktrees | `claude_cleanup(cwd="...", dry_run=true)` then `dry_run=false` |

## Uninstall

```bash
npm uninstall -g @anyi61/codex-claude-delegate-mcp
```

To also remove the MCP server configuration from Codex, delete the `[mcp_servers.claude_delegate]` section from `~/.codex/config.toml` manually.

## Security

- `spawn("claude", args[])` — no shell injection
- `--tools` / `--allowedTools` / `--disallowedTools` — three-layer tool control
- `--permission-mode dontAsk` — non-interactive safe mode
- `sanitizeEnv()` — minimal environment (strips API keys, tokens, SSH agent)
- `BRIDGE_DEPTH` — recursion protection (≥2 refused)
- `validateCwd()` — realpath + allow roots whitelist
- `dangerousRoot()` — rejects `/`, `/tmp`, `/etc`, `$HOME`

## Known limitations

- No real-time bidirectional communication (Codex → Claude one-shot delegation)
- ~2-5s cold start per Claude invocation
- No automatic worktree cleanup (use `claude_cleanup`)
- Old job records lack fingerprint/heartbeat; stale classification falls back to updated_at
- Stale detection is advisory only, does not auto-kill processes

## Maintainer release checklist

```bash
# 确保 git 已提交所有更改
git status

# 一行发布: 自动 bump patch 版本 → build → test → publish
npm run release
```

发布后创建 GitHub Release 并推送 tag（如需）:

```bash
git tag v$(node -p "require('./package.json').version")
git push origin v$(node -p "require('./package.json').version")
```
