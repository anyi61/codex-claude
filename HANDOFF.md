# Codex Claude Handoff

## Goal

Continue development of `/Users/anyi/codex-claude`, a TypeScript MCP server that lets Codex delegate work to Claude Code in isolated git worktrees.

Current high-level backlog from the last handoff is complete. The latest release is published.

## Current Progress

- Branch: `main`
- Current release: `@anyi61/codex-claude-delegate-mcp@0.1.13`
- Latest release commit: `f2909bd chore: release v0.1.13`
- Latest release tag: `v0.1.13`
- Registry verified: `npm view @anyi61/codex-claude-delegate-mcp version dist-tags.latest --json` returns `0.1.13` for both `version` and `dist-tags.latest`.
- Release metadata verified: `npm run check:release:metadata` passed after `v0.1.13` was created at `HEAD`.
- Worktree status at handoff update: clean.

Completed since the earlier handoff:

- `UX/RUN-GROUP-001`
  - Added caller-provided grouping metadata (`goal_item_id`, `supersedes_run_id`) across delegated write jobs, run logs, `claude_runs`, `claude_result`, and `claude_workspace_status`.
  - Released in the `0.1.12` line.

- `STATE-MACHINE-002`
  - Added fault-injection coverage for artifact index tmp/corrupt/stale-entry behavior, background job recovery PID/heartbeat edge cases, and review-gate fingerprint binding.
  - Tightened review gate clearing so empty-string binding fields are explicit mismatch values.
  - Commit: `cc2c6c7 test: harden state-machine fault coverage`

- `AUDIT-DOCS-003`
  - Promoted missing advanced-tool README documentation from informational output to release-blocking `audit:docs` failure.
  - Documented `claude_export` in README advanced tools.
  - Commit: `915f26e test: block missing advanced tool docs`

- `REL-003`
  - Added `scripts/check-release-metadata.mjs`.
  - Added `npm run check:release:metadata`.
  - The command verifies local package version, npm registry `version` / `dist-tags.latest`, and `git tag --points-at HEAD v<version>`.
  - Deliberately excluded from `prepublishOnly` and `release*` scripts because it checks post-publish state.
  - Commit: `60d0e71 test: add release metadata checks`

- `MULTI-ROOT-002`
  - Strengthened `context_roots` provenance prompt guidance so query/review outputs cite context-root evidence with `[alias]` plus file path or git command.
  - Added prompt tests and README docs.
  - Commit: `b63d42e test: clarify context root provenance`

- `0.1.13` release
  - `npm run release` bumped from `0.1.12` to `0.1.13`, synced plugin metadata, ran `prepublishOnly`, and published to npm.
  - `prepublishOnly` passed: build, typecheck, full Vitest suite (`956 passed`), build:plugin, check:plugin, audit:docs, check:release, check:release:install.
  - Commit/tag pushed to GitHub.
  - Commit: `f2909bd chore: release v0.1.13`

## What Worked

- Use Goal mode for multi-item sequences.
- For each implementation item:
  - write a plan under `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`;
  - delegate implementation to Claude with `goal_item_id`;
  - preview delegated diff with `claude_apply preview=true`;
  - apply only after review;
  - run targeted verification locally;
  - commit each item separately;
  - clean delegated worktrees.
- Use `allowed_files` when delegating to Claude to keep changes surgical.
- Use `git add -f` for docs under `docs/`, because docs are ignored by git rules.
- Use `npm run check:release:metadata` after publishing/tagging to catch registry/tag drift.

## What Did Not Work

- Treating missing advanced tools in README as informational allowed `claude_export` to remain undocumented. This is now release-blocking.
- Running `npm run check:release:metadata` before the release tag points at `HEAD` correctly fails. It is a post-publish/post-tag check.
- Claude's own Bash calls may be denied in delegated runs; trust server-side verification when present and rerun key verification locally before committing.

## Next Steps

No known open backlog items remain from the previous handoff.

Recommended starting point for a fresh AI:

1. Run `git status --short`.
2. Read `AGENTS.md`.
3. Read this `HANDOFF.md`.
4. If asked for new development, inspect current docs or ask the user for the next priority.

Useful verification commands:

```bash
npm run typecheck
npm run audit:docs
npm run check:release
npm run check:release:install
npm run check:release:metadata
```

For broad safety before publishing:

```bash
npm test
```

Operational notes:

- Do not manually edit `dist/`.
- Do not manually edit `plugins/codex-claude-delegate/server/*.js` except via `npm run build:plugin`.
- Do not revert user changes.
- CodeGraph is available for structural code questions.
- Use `rg` for literal text search.
