# Background Job Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit cleanup path for persisted background jobs so terminal job records do not accumulate indefinitely.

**Status calibration (2026-05-05):** Implemented and covered by schema/CLI/server tests; `claude_job_cleanup` supports dry-run, age filtering, limit handling, and terminal-job deletion.

**Architecture:** Keep the current background job storage model in `src/jobs.ts`, but add a repo-scoped cleanup operation that only targets terminal jobs (`succeeded`, `failed`, `cancelled`). Expose it as a dedicated MCP tool instead of silently pruning on write, so behavior stays observable and reversible via `dry_run`.

**Tech Stack:** TypeScript, Node.js fs/promises, MCP SDK, zod, Vitest

---

## File Map

- Modify: `src/schema.ts`
  Add cleanup input/result types and zod schema.
- Modify: `src/jobs.ts`
  Add terminal-job cleanup support in the store.
- Modify: `src/claude-cli.ts`
  Add repo-scoped cleanup helper wrapping the store behavior.
- Modify: `src/server.ts`
  Register and route the new cleanup tool.
- Modify: `README.md`
  Document job cleanup workflow and retention limits.
- Modify: `tests/schema.test.ts`
  Cover cleanup input validation.
- Modify: `tests/claude-cli.test.ts`
  Cover cleanup behavior and dry-run behavior.
- Modify: `tests/server.test.ts`
  Cover handler routing/error shaping for the new tool.

## Scope

This slice adds one explicit MCP tool:

- `claude_job_cleanup`

Proposed behavior:

- default `dry_run: true`
- only considers jobs for the requested `cwd`
- only considers terminal jobs
- optional `older_than_hours`
- optional `limit`
- returns matched/removed/failed counts plus entry details

It does not add automatic retention-on-write in this iteration.

## Task 1: Add Types And Validation

**Files:**
- Modify: `src/schema.ts`
- Modify: `tests/schema.test.ts`

- [x] Add `ClaudeJobCleanupInput`, `ClaudeJobCleanupResult`, and a cleanup-entry type.
- [x] Add `claudeJobCleanupInputSchema` with:
  - `cwd`
  - `older_than_hours?: number`
  - `dry_run?: boolean`
  - `limit?: number`
- [x] Add schema tests for valid dry-run input and invalid zero/negative limits.

## Task 2: Add Store-Level Cleanup

**Files:**
- Modify: `src/jobs.ts`
- Modify: `tests/claude-cli.test.ts`

- [x] Add a store helper that lists/removes matching terminal jobs for one repo.
- [x] Filter by `cwd`, terminal status, optional age threshold, and optional limit.
- [x] Return per-job cleanup entries plus aggregate counts.
- [x] Add tests for:
  - dry-run leaves files untouched
  - non-dry-run removes only old terminal jobs
  - running jobs are preserved

## Task 3: Wire Cleanup Into MCP

**Files:**
- Modify: `src/claude-cli.ts`
- Modify: `src/server.ts`
- Modify: `tests/server.test.ts`
- Modify: `README.md`

- [x] Add `cleanupBackgroundJobs(...)` helper in `src/claude-cli.ts`.
- [x] Register `claude_job_cleanup` in `src/server.ts`.
- [x] Route handler validation/cwd resolution into the helper.
- [x] Add handler-level tests for routing and validation errors.
- [x] Document the new tool and recommended usage in `README.md`.

## Verification

- [x] Run: `npm test -- tests/server.test.ts tests/schema.test.ts tests/claude-cli.test.ts`
- [x] Run: `npm run build`
- [x] Run: `npm test`
- [x] Run: `npm run typecheck`
- [x] Review: `git diff -- src/jobs.ts src/claude-cli.ts src/schema.ts src/server.ts tests README.md`
