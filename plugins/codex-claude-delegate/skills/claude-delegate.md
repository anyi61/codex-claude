# Claude Code Delegate

## When to use claude_implement

Use `claude_implement` (MCP tool `claude_delegate`) instead of editing files yourself when:

1. **Multi-file refactors** — changes spanning 3+ files that would benefit from isolated worktree testing
2. **Risky changes** — modifications to core logic where a botched edit would break the build
3. **Unfamiliar languages/frameworks** — when you are less confident about idioms, let Claude Code handle it
4. **User explicitly asks** — if the user says "let Claude do it" or "use claude_implement"
5. **Need a second opinion** — pair-programming style: you plan, Claude implements, you review the diff

## When NOT to use claude_implement

- Single-line bug fixes
- Adding a simple function to one file
- Tasks you can complete correctly in < 3 trivial edits
- Read-only tasks (use `claude_query` or `claude_review` instead)

## How to delegate

Call the MCP tool with:
- `task`: detailed implementation instructions
- `cwd`: project root
- `constraints`: list of things Claude must NOT do
- `files`: optional list of relevant files for context
- `max_cost_usd`: optional budget limit
- `max_changed_files`: optional file count alert

## After implement

1. Review `server_observed.changed_files` and `claude_report.tests`
2. If `resource_limits.changed_files_exceeded`, consider splitting the task
3. Call `claude_apply` to land changes, then `claude_cleanup` for worktree

## Apply rules

- Apply only delegated worktrees reported by `server_observed.worktree_path`
- `claude_apply` lands only `src/` A/M/D changes
- Untracked new `src/` files are supported
- Docs, `dist/`, and root files are ignored by design
- Main workspace conflicts cause full refusal; do not force partial apply
