# Codex-Claude Delegate Optimization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve `codex-claude-delegate-mcp` from a solid single-delegate bridge into a more observable, easier-to-operate, and more extensible delegation system without abandoning the current CLI + MCP + worktree architecture.

**Architecture:** Keep the current one-shot task delegation model: Codex plans, the MCP server mediates, Claude executes inside an isolated worktree, and the server independently observes the result. Optimize around reliability, operator ergonomics, extensibility, and workflow closure rather than introducing real-time agent chat or a full orchestration platform.

**Tech Stack:** TypeScript, Node.js, MCP stdio server, Claude Code CLI, Git worktree, Zod, Vitest

---

## Why This Plan

The current repository is already strong on the core loop:

- secure subprocess launch
- worktree isolation
- server-side diff observation
- apply / cleanup lifecycle
- structured JSON outputs

The gap versus adjacent projects is not the basic bridge. The gap is in the surrounding product layer:

- weaker observability than JSONL / TUI / replay-oriented tools
- weaker workflow automation than issue-driven or multi-agent orchestrators
- weaker extensibility than bridge projects exposing richer tool families
- weaker day-2 operations than projects with better state inspection and recovery flows

This plan keeps the existing product thesis and closes those gaps in priority order.

## Optimization Priorities

### P0: Turn the bridge into an auditable operations tool

Reason:
Projects like `helix-codex`, `ccswarm`, and worktree dashboards differentiate less by raw execution and more by operator visibility. Your current server already records useful facts, but those facts are not yet presented as first-class operational surfaces.

Expected outcome:

- users can answer "what ran, where, with which session, what changed, and why apply failed" without reading ad hoc logs
- debugging stale worktrees and failed delegate runs becomes routine instead of forensic

### P1: Make delegation flows easier to compose

Reason:
Several similar projects expose richer toolsets: query, explain, planning, review variants, and multi-step workflows. Your current tool surface is clean, but still low-level.

Expected outcome:

- Codex can drive more nuanced delegation patterns without prompt hacks
- the server becomes easier to use as a reusable building block

### P2: Prepare for controlled multi-agent expansion

Reason:
The market is clearly moving toward agent pools, issue-driven execution, and best-of-n patterns. You should not copy those platforms wholesale, but you should avoid boxing the project into a single-worker future.

Expected outcome:

- the repository can later support multiple delegated workers or strategy variants without rewriting core modules

## Proposed Workstreams

### Task 1: Add run history and inspect tooling

**Files:**
- Modify: `src/server.ts`
- Modify: `src/claude-cli.ts`
- Modify: `src/schema.ts`
- Create: `debug/mcp-runs.ts`
- Create: `docs/RUN_HISTORY.md`
- Test: `tests/claude-cli.test.ts`

- [ ] Add a read-only MCP tool such as `claude_runs` or `claude_inspect_run` that lists recent run logs from `.codex-claude-delegate/runs`.
- [ ] Return structured fields for run id, tool type, cwd, start/end timestamps, requested session id, returned session id, worktree path, apply status, and refusal reason.
- [ ] Add filtering knobs for recent N runs, tool type, status, and worktree name.
- [ ] Update tests to cover log parsing, missing log directories, and malformed historical records.
- [ ] Document the operator workflow for "inspect failed implement", "find orphaned worktree", and "trace apply refusal".

Why:

- this borrows the observability advantage from JSONL- and replay-oriented tools without changing your architecture
- it directly builds on the run log foundation you already have

### Task 2: Unify lifecycle state into an explicit run model

**Files:**
- Modify: `src/schema.ts`
- Modify: `src/claude-cli.ts`
- Modify: `src/server.ts`
- Test: `tests/schema.test.ts`
- Test: `tests/claude-cli.test.ts`

- [ ] Define a first-class run lifecycle model: `queued`, `running`, `success`, `partial`, `failed`, `apply_blocked`, `applied`, `cleaned`.
- [ ] Persist lifecycle transitions into run logs instead of scattering them across tool-specific payloads.
- [ ] Make `claude_apply` and `claude_cleanup` update the original implement run record when possible.
- [ ] Expose lifecycle summaries in `claude_status` so the status tool becomes an actual operational dashboard, not only an environment check.

Why:

- similar platforms feel more mature because task state is explicit
- your current tools are good individually, but the end-to-end run state is still implicit

### Task 3: Expand tool surface around real user workflows

**Files:**
- Modify: `src/server.ts`
- Modify: `src/schema.ts`
- Modify: `src/claude-cli.ts`
- Modify: `README.md`
- Test: `tests/schema.test.ts`
- Test: new focused tool tests as needed

- [ ] Add a `claude_explain` style read-only tool optimized for architecture/code explanation, instead of overloading `claude_query` prompts.
- [ ] Add a `claude_plan` or `claude_review_plan` style tool for implementation-plan validation before coding.
- [ ] Add a `claude_resume` convenience layer or clearer explicit semantics for implement-session continuation, so session reuse is easier to reason about.
- [ ] Consider a `claude_apply_preview` mode that reports files and conflicts without modifying the main worktree.

Why:

- this borrows a practical strength from richer bridge products: more intent-specific tools
- it reduces prompt ambiguity and improves compatibility with future Codex skills/plugins

### Task 4: Strengthen apply safety and conflict handling

**Files:**
- Modify: `src/claude-cli.ts`
- Modify: `src/schema.ts`
- Modify: `README.md`
- Create: `debug/test-apply-preview.ts`
- Test: `tests/claude-cli.test.ts`

- [ ] Add a dry-run preview path for apply that reports exactly which files would be copied, deleted, or refused.
- [ ] Improve conflict reporting so users see per-file reasons: dirty main workspace, unsupported rename/copy status, missing source file, out-of-scope change, limit overflow.
- [ ] Record apply attempts in logs even when no files are changed.
- [ ] Consider support for safe rename handling if it can be represented without weakening scope validation.

Why:

- worktree tools and issue-driven orchestrators win on operational clarity
- your current refusal behavior is safe, but still relatively opaque at the point of failure

### Task 5: Make documentation stateful and self-consistent

**Files:**
- Modify: `README.md`
- Modify: `docs/PROJECT_STATUS.md`
- Modify: `docs/DECISIONS.md`
- Modify: `docs/COMPLETION_AUDIT.md`
- Create: `docs/ROADMAP.md`
- Create: `debug/mcp-doc-audit.ts`

- [ ] Separate stable product docs from time-sensitive status docs.
- [ ] Move dated status assertions into a single living status file with a visible "last verified" stamp.
- [ ] Add a lightweight doc audit script that checks claims like available npm scripts, test counts, and tool names against the repository.
- [ ] Reduce duplicated operational guidance spread across README, SPEC, and audit documents.

Why:

- right now some docs already drift from the actual repository state
- that hurts trust, especially for an infrastructure tool whose value depends on correctness

### Task 6: Introduce extensibility seams for future providers

**Files:**
- Modify: `src/claude-cli.ts`
- Modify: `src/schema.ts`
- Modify: `src/server.ts`
- Create: `src/providers/claude.ts`
- Create: `src/providers/types.ts`
- Test: `tests/claude-cli.test.ts` or split provider tests

- [ ] Extract provider-neutral execution interfaces from Claude-specific subprocess logic.
- [ ] Keep Claude as the only implementation for now, but define boundaries for `query`, `review`, `implement`, `apply metadata`, and session semantics.
- [ ] Avoid exposing multi-provider complexity in the public API until the internal seam is stable.

Why:

- many adjacent projects already market themselves as multi-model bridges
- even if you do not want that now, a provider seam prevents future refactors from cutting across every file

### Task 7: Add issue- and batch-oriented orchestration helpers

**Files:**
- Modify: `src/server.ts`
- Modify: `src/schema.ts`
- Create: `debug/test-batch-flow.ts`
- Update: `README.md`

- [ ] Add optional metadata fields to implement requests: `task_id`, `ticket_url`, `branch_hint`, `labels`, `parent_run_id`.
- [ ] Persist this metadata in run logs and expose it in inspection tools.
- [ ] Add a batch helper pattern, either as a documented workflow or an MCP tool, for "run review on these three files", "delegate three independent tasks", or "plan -> implement -> review".

Why:

- issue-driven orchestration tools are strong because they preserve task identity across the whole lifecycle
- you do not need a full platform to benefit from that discipline

### Task 8: Improve test depth around failure-path behavior

**Files:**
- Modify: `tests/claude-cli.test.ts`
- Modify: `tests/schema.test.ts`
- Modify: `tests/guard.test.ts`
- Create: `tests/server.test.ts`
- Create: `debug/test-failure-modes.ts`

- [ ] Add tests for malformed stdout JSON, non-zero exit with valid payload, expired session recovery, apply refusal branches, and corrupted run logs.
- [ ] Add handler-level tests for MCP tool validation and envelope consistency.
- [ ] Add regression coverage for doc-audit or run-inspection helpers once they exist.

Why:

- the highest-value remaining test area is not happy-path functionality
- it is failure-path determinism and operator trust

## Recommended Delivery Order

1. Task 5: documentation consistency
2. Task 1: run inspection tooling
3. Task 2: explicit lifecycle model
4. Task 4: apply preview and conflict clarity
5. Task 8: failure-path test expansion
6. Task 3: workflow-specific tool expansion
7. Task 7: issue/batch metadata
8. Task 6: provider seam extraction

## What Not To Do Now

- do not pivot to real-time Claude Code Channels or tmux-based live collaboration
- do not rebuild the project as a generic multi-agent platform
- do not add multiple model providers before the internal provider seam exists
- do not broaden write permissions or relax scope/apply protections for convenience

Those features are visible in adjacent projects, but they solve a different product problem than this repository currently solves well.

## Concrete Recommendations For This Repository Today

### Best immediate win

Build run inspection plus apply preview first.

Reason:

- it improves day-2 usability more than adding another execution tool
- it leverages your existing log and worktree architecture
- it makes later orchestration work easier because state becomes inspectable

### Best product differentiation

Double down on "trusted delegation with server-observed enforcement".

Reason:

- most bridge projects emphasize connectivity
- your strongest moat is safe delegation with independent verification
- the roadmap should amplify that instead of diluting it

### Best medium-term bet

Introduce workflow metadata and lifecycle modeling before multi-provider support.

Reason:

- task identity, state, and auditability matter regardless of provider
- provider abstraction without run-state maturity is architecture theater

## Success Criteria

- operators can inspect recent runs and diagnose failures without reading raw log files
- apply failures are explainable and previewable before mutation
- documentation claims stay synchronized with repository reality
- MCP tools map more closely to user intents, not just transport primitives
- the codebase has clear seams for future orchestration and provider expansion

