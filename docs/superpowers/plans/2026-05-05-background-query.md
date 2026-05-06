# Background Query Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow `claude_query` to use the same persistent background job model as review/implement/apply/cleanup, so long-running read-only analysis can be queued instead of blocking the caller.

**Status calibration (2026-05-05):** Implemented and covered by schema/CLI/server tests; `claude_query background=true` queues a persistent query job.

**Architecture:** Extend `BackgroundJobType` one final time to include `query`, add a queue helper in `src/claude-cli.ts`, wire optional `background: true` through `src/server.ts`, and rely on the existing `claude_jobs` / `claude_job_result` / `claude_job_wait` / `claude_job_cancel` interfaces for lifecycle handling.

**Tech Stack:** TypeScript, MCP SDK, existing `JobStore`, detached `job-runner`, Vitest

---

## File Map

- Modify: `src/schema.ts`
- Modify: `src/claude-cli.ts`
- Modify: `src/server.ts`
- Modify: `README.md`
- Modify: `tests/schema.test.ts`
- Modify: `tests/claude-cli.test.ts`
- Modify: `tests/server.test.ts`

## Scope

This slice adds:

- `claude_query.background`
- background job type `query`

It does not add any new top-level tools.

## Task Checklist

- [x] Extend `BackgroundJobType` and any schema enums to include `query`
- [x] Add optional `background` to `ClaudeQueryInput` and zod validation
- [x] Add `startBackgroundQuery(...)`
- [x] Teach `executeBackgroundJob(...)` to dispatch query jobs
- [x] Route `claude_query background=true` into the queue helper
- [x] Update README examples and workflow notes
- [x] Add schema, CLI, and server tests

## Verification

- [x] Run: `npm test -- tests/server.test.ts tests/schema.test.ts tests/claude-cli.test.ts`
- [x] Run: `npm test`
- [x] Run: `npm run build`
- [x] Run: `npm run typecheck`
