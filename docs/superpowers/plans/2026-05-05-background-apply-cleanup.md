# Background Apply/Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the background job model beyond review/implement so `claude_apply` and `claude_cleanup` can also run asynchronously when the caller prefers queueable workflows.

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

- [ ] Expand `BackgroundJobType` to `"review" | "implement" | "apply" | "cleanup"`
- [ ] Add optional `background` to `ClaudeApplyInput` and `ClaudeCleanupInput`
- [ ] Update zod schemas and schema tests

## Task 2: Extend Queue And Worker Execution

- [ ] Add `startBackgroundApply(...)` and `startBackgroundCleanup(...)`
- [ ] Teach `executeBackgroundJob(...)` to dispatch apply/cleanup jobs
- [ ] Add summary/worktree extraction behavior that still makes sense for non-review/implement jobs
- [ ] Add CLI tests for queueing apply/cleanup jobs

## Task 3: Wire MCP Handlers

- [ ] Register `background` input fields for apply/cleanup tools
- [ ] Route `background: true` into background enqueue helpers
- [ ] Keep sync path unchanged when `background` is absent/false
- [ ] Update README examples and workflow notes

## Verification

- [ ] Run: `npm test -- tests/server.test.ts tests/schema.test.ts tests/claude-cli.test.ts`
- [ ] Run: `npm test`
- [ ] Run: `npm run build`
- [ ] Run: `npm run typecheck`
- [ ] Review: `git diff -- src/schema.ts src/claude-cli.ts src/server.ts tests README.md`
