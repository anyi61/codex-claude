# Background Query Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow `claude_query` to use the same persistent background job model as review/implement/apply/cleanup, so long-running read-only analysis can be queued instead of blocking the caller.

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

- [ ] Extend `BackgroundJobType` and any schema enums to include `query`
- [ ] Add optional `background` to `ClaudeQueryInput` and zod validation
- [ ] Add `startBackgroundQuery(...)`
- [ ] Teach `executeBackgroundJob(...)` to dispatch query jobs
- [ ] Route `claude_query background=true` into the queue helper
- [ ] Update README examples and workflow notes
- [ ] Add schema, CLI, and server tests

## Verification

- [ ] Run: `npm test -- tests/server.test.ts tests/schema.test.ts tests/claude-cli.test.ts`
- [ ] Run: `npm test`
- [ ] Run: `npm run build`
- [ ] Run: `npm run typecheck`
