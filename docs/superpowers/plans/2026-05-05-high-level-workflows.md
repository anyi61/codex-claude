# High-Level Workflow Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add higher-level workflow capabilities on top of the current MCP primitives: a better result experience, review gate / stop hook support, a unified rescue/task entrypoint, and a stronger session/workspace job view.

**Architecture:** Keep the existing low-level tools intact and add a thin “workflow layer” above them. Each slice should reuse current run logs, job persistence, session tracking, and detached background execution instead of introducing a second orchestration system. The new layer should produce clearer next actions, better workspace summaries, and an easier entrypoint for common delegation flows.

**Tech Stack:** TypeScript, MCP SDK, existing `src/server.ts` / `src/claude-cli.ts` / `src/jobs.ts` / `src/session.ts`, Vitest, debug MCP scripts

---

## File Map

- Modify: `src/schema.ts`
  Add new workflow tool input/result types and validation.
- Modify: `src/claude-cli.ts`
  Add normalized result helper, workspace dashboard helper, unified task helper, and review gate helpers.
- Modify: `src/server.ts`
  Register and route the new tools.
- Modify: `src/session.ts`
  Reuse or extend session metadata where needed for result/task/dashboard views.
- Modify: `src/guard.ts`
  If needed for stop-hook installation validation.
- Modify: `README.md`
  Document workflow-level tools and gate setup/teardown.
- Modify: `tests/schema.test.ts`
- Modify: `tests/claude-cli.test.ts`
- Modify: `tests/server.test.ts`
- Create: `tests/review-gate.test.ts`
- Create: `debug/test-high-level-workflows.ts`
  Real MCP flow for result/task/gate/dashboard.
- Create or modify: hook/script assets under `plugins/` or repo-local helper paths if gate installation needs a concrete stop-hook script.

## Scope

This plan implements four user-facing capabilities:

1. Higher-level result experience
2. Review gate / stop hook
3. Unified rescue/task-style entrypoint
4. Stronger session/workspace job view

The low-level tools (`claude_job_result`, `claude_runs`, `claude_run_inspect`, `claude_implement`, etc.) remain supported.

## Phase 1: Higher-Level Result Experience

**Intent:** Replace “inspect multiple primitive tools manually” with one normalized result tool that finds the most relevant finished artifact and tells the caller what to do next.

### Task 1.1: Add `claude_result`

**Files:**
- Modify: `src/schema.ts`
- Modify: `src/claude-cli.ts`
- Modify: `src/server.ts`
- Modify: `tests/schema.test.ts`
- Modify: `tests/claude-cli.test.ts`
- Modify: `tests/server.test.ts`
- Modify: `README.md`

- [x] Add `ClaudeResultInput` with:
  - `cwd`
  - optional `job_id`
  - optional `run_id`
  - optional `prefer` enum such as `latest-job | latest-run | latest-implement | latest-review`
- [x] Add `ClaudeResultResult` with:
  - normalized `source_type` (`job` or `run`)
  - `job` and/or `run`
  - `session`
  - `result`
  - `related_runs`
  - `next_actions`
  - `summary`
- [x] Implement a helper that:
  - resolves explicit `job_id` first
  - resolves explicit `run_id` next
  - otherwise picks the latest relevant finished job/run for the repo
  - extracts `returned_session_id` when present
  - derives `next_actions` like:
    - `claude_apply`
    - `claude_cleanup`
    - `claude_review`
    - `claude_implement` with `resume_latest`
- [ ] Add tests for:
  - explicit `job_id`
  - explicit `run_id`
  - latest implement result with resumable session
  - missing result returns a shaped error
  - Still missing explicit coverage for the missing-result shaped error.
- [x] Document `claude_result` in `README.md`

### Task 1.2: Real-flow verification for `claude_result`

**Files:**
- Modify: `debug/test-high-level-workflows.ts`

- [x] Add a real MCP flow that:
  - starts a background implement job
  - waits for completion
  - calls `claude_result`
  - verifies returned `summary`, `next_actions`, and any session / worktree fields are coherent

## Phase 2: Stronger Session/Workspace Job View

**Intent:** Make it easy to answer “what is happening in this repo/workspace right now?” without juggling `claude_status`, `claude_jobs`, and run logs manually.

### Task 2.1: Add `claude_workspace_status`

**Files:**
- Modify: `src/schema.ts`
- Modify: `src/claude-cli.ts`
- Modify: `src/server.ts`
- Modify: `tests/schema.test.ts`
- Modify: `tests/claude-cli.test.ts`
- Modify: `tests/server.test.ts`
- Modify: `README.md`

- [x] Add `ClaudeWorkspaceStatusInput` with:
  - `cwd`
  - optional `limit`
  - optional `include_terminal`
- [x] Add `ClaudeWorkspaceStatusResult` with:
  - `workspace_root`
  - `running_jobs`
  - `queued_jobs`
  - `recent_terminal_jobs`
  - `recent_runs`
  - `latest_sessions`
  - `delegated_worktrees`
  - `counts`
  - `attention_items`
- [x] Implement a helper that aggregates:
  - active background jobs
  - latest terminal jobs
  - recent run summaries
  - latest query/implement session ids if available
  - current delegated worktree list
  - warning-style “attention items”, e.g.:
    - queued jobs older than N minutes
    - apply-blocked lifecycle
    - stale worktrees
- [ ] Add tests covering:
  - running + terminal jobs summary
  - stale worktree / apply-blocked signals
  - empty workspace view
  - Still missing explicit empty workspace view coverage.
- [x] Document the new workspace-centric status tool

### Task 2.2: Real-flow verification for workspace view

**Files:**
- Modify: `debug/test-high-level-workflows.ts`

- [ ] Verify:
  - queued/running/succeeded job counts
  - recent runs appear in one combined workspace view
  - Real flow currently verifies terminal jobs and recent runs, but not queued/running counts.

## Phase 3: Unified Rescue/Task Entry Point

**Intent:** Give users one high-level tool for “hand this problem to Claude”, instead of making them choose between query/review/implement manually.

### Task 3.1: Add `claude_task`

**Files:**
- Modify: `src/schema.ts`
- Modify: `src/claude-cli.ts`
- Modify: `src/server.ts`
- Modify: `tests/schema.test.ts`
- Modify: `tests/claude-cli.test.ts`
- Modify: `tests/server.test.ts`
- Modify: `README.md`

- [x] Add `ClaudeTaskInput` with:
  - `cwd`
  - `task`
  - `mode` enum such as `auto | read | review | write`
  - optional `background`
  - optional `resume_latest`
  - optional `files`
  - optional `constraints`
  - optional `diff`
  - optional `timeout_sec`
  - optional `max_turns`
- [x] Add a dispatcher helper that maps:
  - `read` -> query
  - `review` -> review
  - `write` -> implement
  - `auto` -> infer from presence of `diff`, `files`, or explicit “fix/change/implement” intent
- [x] Support high-level resume behavior for write mode without exposing too many low-level knobs.
- [x] Return a normalized workflow result with:
  - `delegated_mode`
  - `result`
  - `job`
  - `session`
  - `next_actions`
- [x] Add tests for mode routing and background routing.
- [x] Document `claude_task` as the new rescue-style entrypoint.

### Task 3.2: Real-flow verification for `claude_task`

**Files:**
- Modify: `debug/test-high-level-workflows.ts`

- [ ] Verify:
  - `mode=read background=true`
  - `mode=write background=true`
  - `mode=auto` chooses review or implement appropriately
  - Real flow currently covers read background and auto->review, but not write background.

## Phase 4: Review Gate / Stop Hook

**Intent:** Provide an opt-in guardrail that reminds or forces a review pass before a workflow stops, similar to a stop-time review gate.

### Task 4.1: Add review gate config and setup tools

**Files:**
- Modify: `src/schema.ts`
- Modify: `src/claude-cli.ts`
- Modify: `src/server.ts`
- Modify: `src/guard.ts`
- Modify: `tests/schema.test.ts`
- Create: `tests/review-gate.test.ts`
- Modify: `README.md`
- Create or modify hook asset files under repo-local helper paths

- [x] Add a small repo-local config record for review gate state, e.g. inside `.codex-claude-delegate/`.
- [x] Add tools:
  - `claude_setup`
  - `claude_review_gate`
- [x] `claude_setup` should report:
  - server readiness
  - hook installability
  - gate enabled/disabled state
  - suggested next steps
- [x] `claude_review_gate` should support:
  - `action=enable`
  - `action=disable`
  - `action=status`
- [x] Enable path should install or update a concrete stop-hook helper/script for the current workspace.
- [ ] Add tests for:
  - config persistence
  - enable/disable/status transitions
  - invalid workspace / duplicate install handling
  - Still missing explicit invalid workspace coverage.

### Task 4.2: Real-flow verification for gate

**Files:**
- Modify: `debug/test-high-level-workflows.ts`
- Create: `debug/test-review-gate-hook.ts`
- Create: `debug/test-claude-plugin-runtime.ts`

- [x] Verify:
  - enabling the gate reports success
  - status reflects enabled state
  - disabling reports success
  - any installed hook artifact exists where expected
  - direct hook execution emits `systemMessage` when review is pending
  - external Claude plugin runtime loads the plugin, registers the Stop hook, connects the plugin MCP server, and exposes high-level tools
  - strict external validation with `STRICT_STOP_HOOK=1 USE_REAL_CLAUDE_HOME=1 node --import tsx debug/test-claude-plugin-runtime.ts` confirms a real Claude completion fires the Stop hook
- [x] Compatibility fixes from real runtime validation:
  - hook command uses `node '${CLAUDE_PLUGIN_ROOT}/hooks/review-gate-stop.mjs'` instead of executing the `.mjs` file directly, so it does not depend on executable bits.
  - Stop hook output uses top-level `systemMessage`; `hookSpecificOutput` is intentionally omitted because Claude 2.1.116 validates that field against non-Stop hook schemas.

## Final Verification

- [x] Run: `npm run build`
- [x] Run: `npm test`
- [x] Run: `npm run typecheck`
- [x] Run: `npx tsx debug/test-high-level-workflows.ts`
- [x] Review changed scope with `git diff --stat`
- [x] Confirm `README.md` documents every new high-level tool
- [x] Confirm low-level tools still work and were not removed
