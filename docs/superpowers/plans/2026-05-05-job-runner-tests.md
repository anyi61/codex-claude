# Background Job Runner Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add direct regression coverage for `src/job-runner.ts`, especially the signal-triggered cancellation path and failed execution path.

**Architecture:** Keep runtime behavior unchanged, but extract the top-level runner logic into small exported helpers so tests can invoke the flow without booting a real detached process. The runner should still start automatically when executed as the entrypoint.

**Tech Stack:** TypeScript, Node.js process signal handling, Vitest, existing `JobStore`, `abortActiveClaudeRun`, `executeBackgroundJob`

---

## File Map

- Modify: `src/job-runner.ts`
  Export small helpers for signal registration and one-shot execution.
- Create: `tests/job-runner.test.ts`
  Add direct tests for success, failure, missing job id, and SIGTERM cancellation flow.

## Scope

This slice covers:

- missing `jobId` input
- `executeBackgroundJob()` throwing
- `SIGTERM` triggering persisted cancellation + `abortActiveClaudeRun("SIGTERM")`
- preserving current entrypoint behavior

It does not redesign the background worker model.

## Task 1: Make `job-runner.ts` Testable

**Files:**
- Modify: `src/job-runner.ts`

- [x] Export `markCancelled(jobId)`
- [x] Export a small runner helper such as `runJobRunner(jobId, deps?)`
- [x] Export or isolate signal registration so tests can trigger the SIGTERM path without a real subprocess
- [x] Keep the current direct-start behavior when run as the entrypoint

## Task 2: Add Direct Runner Tests

**Files:**
- Create: `tests/job-runner.test.ts`

- [x] Add a test for missing `jobId`
- [x] Add a test asserting execute failure sets exit behavior or propagates correctly through the helper contract
- [x] Add a test asserting SIGTERM marks the job cancelled and calls `abortActiveClaudeRun("SIGTERM")`
- [x] Add a test ensuring duplicate SIGTERM does not double-run cleanup

## Verification

- [x] Run: `npm test -- tests/job-runner.test.ts`
- [x] Run: `npm test`
- [x] Run: `npm run build`
- [x] Run: `npm run typecheck`
- [x] Review: `git diff -- src/job-runner.ts tests/job-runner.test.ts`
