# Decisions

## Continue the Existing CLI Delegate

The repository already has the intended architecture: Codex calls an MCP stdio server, the server spawns `claude -p` with argument arrays, Claude works in a delegated git worktree, and Codex decides whether to apply the result. Rewriting to agent-bridge, Channels, or a new plugin shape would increase risk without addressing the current P0/P1 engineering gaps.

## Add Tests Before Wider Refactors

The highest-risk behavior is security-sensitive: cwd allow roots, environment sanitization, recursion depth, CLI tool restrictions, and structured output schemas. The new tests target those surfaces first so later envelope and validation changes have a guardrail.

## Keep the CLI Route

The CLI route reuses the user's local Claude Code installation and auth state. It also keeps subprocess policy visible in one place: spawn argument arrays, `safeEnv`, `--tools`, `--allowedTools`, `--disallowedTools`, and `--permission-mode dontAsk`.

## Do Not Use Agent Bridge or Channels

This project is a task delegation MCP server, not a real-time multi-agent bridge. Claude Code Channels would change the product model and introduce experimental dependency risk. Agent-bridge solves a different collaboration pattern.

## Current Acceptance State

- Build: passing with `npm run build`.
- Typecheck: passing with `npm run typecheck`.
- Tests: test files and scripts are present, but Vitest could not be installed in the current sandbox because npm registry access through `127.0.0.1:7890` is blocked with `EPERM`.
- Git commits: blocked in this sandbox because writes under `.git/` are denied, so `git rm --cached`, `git add`, and `git commit` cannot create `.git/index.lock`.
