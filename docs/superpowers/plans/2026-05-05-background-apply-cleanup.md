# Background Apply/Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the background job model beyond review/implement so `claude_apply` and `claude_cleanup` can also run asynchronously when the caller prefers queueable workflows.

**Status calibration (2026-05-05):** Implemented and covered by schema/CLI/server tests; `claude_apply` and `claude_cleanup` both support `background=true`.

**Architecture:** Reuse the existing background job store and detached worker model. Expand `BackgroundJobType` to include `apply` and `cleanup`, add queue helpers in `src/claude-cli.ts`, and wire optional `background: true` through the existing MCP handlers. Keep synchronous behavior unchanged.

**Tech Stack:** TypeScript, MCP SDK, existing `JobStore`, detached `job-runner`, Vitest

---

## File Map

- Modify: `src/schema.ts`
  Extend background job types and input schemas.
- Modify: `src/claude-cli.ts`
  Add enqueue helpers and execution support for apply/cleanup jobs.
- Modify: `src/server.ts`
  Expose `background` on apply/cleanup and route to queue helpers.
- Modify: `README.md`
  Document async apply/cleanup usage.
- Modify: `tests/schema.test.ts`
  Cover apply/cleanup background validation.
- Modify: `tests/claude-cli.test.ts`
  Cover enqueue paths and execution routing.
- Modify: `tests/server.test.ts`
  Cover handler routing for background apply/cleanup where feasible.

## Scope

This slice adds:

- `claude_apply.background`
- `claude_cleanup.background`
- background job types `apply` and `cleanup`

It does not add new top-level result/cancel/wait tools because the existing background job interfaces should already work once the new job types are supported.

## Task 1: Extend Types And Schemas

- [x] Expand `BackgroundJobType` to `"review" | "implement" | "apply" | "cleanup"`
- [x] Add optional `background` to `ClaudeApplyInput` and `ClaudeCleanupInput`
- [x] Update zod schemas and schema tests

## Task 2: Extend Queue And Worker Execution

- [x] Add `startBackgroundApply(...)` and `startBackgroundCleanup(...)`
- [x] Teach `executeBackgroundJob(...)` to dispatch apply/cleanup jobs
- [x] Add summary/worktree extraction behavior that still makes sense for non-review/implement jobs
- [x] Add CLI tests for queueing apply/cleanup jobs

## Task 3: Wire MCP Handlers

- [x] Register `background` input fields for apply/cleanup tools
- [x] Route `background: true` into background enqueue helpers
- [x] Keep sync path unchanged when `background` is absent/false
- [x] Update README examples and workflow notes

## Verification

- [x] Run: `npm test -- tests/server.test.ts tests/schema.test.ts tests/claude-cli.test.ts`
- [x] Run: `npm test`
- [x] Run: `npm run build`
- [x] Run: `npm run typecheck`
- [x] Review: `git diff -- src/schema.ts src/claude-cli.ts src/server.ts tests README.md`
