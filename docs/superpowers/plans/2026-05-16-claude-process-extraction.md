# Claude Process Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `src/claude-cli.ts` maintenance risk by extracting Claude process execution into a focused module without changing public behavior.

**Architecture:** Keep `src/claude-cli.ts` as the public facade. Move only `spawnClaude` and its direct process/execution dependencies into `src/claude-process.ts`; leave prompt construction, security profiles, job orchestration, schema, and server wiring unchanged.

**Tech Stack:** TypeScript ESM, Node16 module resolution, Vitest.

---

## Acceptance Criteria

- `src/claude-cli.ts` continues to export the same public helper functions used by tests: `buildQueryArgs`, `buildReviewArgs`, `buildImplementArgs`, `abortActiveClaudeRun`, `buildSafeEnv`, `truncateTail`, `DANGEROUS_DISALLOWED_TOOLS`.
- No MCP tool schemas or wire fields change.
- `schema.ts`, `server.ts`, and test files remain unchanged during the extraction.
- `buildClaudeArgs` behavior and argument ordering remain byte-for-byte equivalent.
- `activeClaudeChild` stays colocated with `spawnClaude` and `abortActiveClaudeRun`.
- Plugin bundle is refreshed only after source tests and typecheck pass.

## Forbidden Behaviors

- Do not redesign `ClaudeRunOptions` or `ClaudeSpawnResult`.
- Do not change `__test` inline wait hooks.
- Do not alter security profile allowlists.
- Do not modify generated `dist/`.
- Do not move worktree, apply, cleanup, result metadata, or session logic in this first slice.

## Task 1: Extract Claude Process Module

**Files:**
- Create: `src/claude-process.ts`
- Modify: `src/claude-cli.ts`

- [ ] **Step 1: Move process-only code**

Move these symbols from `src/claude-cli.ts` into `src/claude-process.ts`:

```text
CLAUDE_BIN
activeClaudeChild
ClaudeRunOptions
ClaudeSpawnResult
redactSensitive
truncateTail
buildSafeEnv
abortActiveClaudeRun
buildClaudeArgs
successExecution
makeEnvelope
reportIndicatesFailure
implementEnvelopeStatus
noOutputPayload
spawnClaude
redactEnvStatus
parseLocalProxy
probeLocalPort
getEnvironmentDiagnostics
```

- [ ] **Step 2: Re-export compatibility helpers**

In `src/claude-cli.ts`, import from `./claude-process.js` and re-export:

```typescript
export {
  abortActiveClaudeRun,
  buildClaudeArgs,
  buildSafeEnv,
  implementEnvelopeStatus,
  makeEnvelope,
  reportIndicatesFailure,
  spawnClaude,
  successExecution,
  truncateTail,
} from "./claude-process.js";
export type { ClaudeRunOptions, ClaudeSpawnResult } from "./claude-process.js";
```

- [ ] **Step 3: Keep facade wrappers**

Keep these wrappers in `src/claude-cli.ts`:

```typescript
export function buildQueryArgs(input: ClaudeQueryInput): string[] {
  return buildClaudeArgs(createQueryOptions(input));
}

export function buildReviewArgs(input: ClaudeReviewInput): string[] {
  return buildClaudeArgs(createReviewOptions(input));
}

export function buildImplementArgs(input: ClaudeImplementInput): string[] {
  return buildClaudeArgs(createImplementOptions(input));
}
```

- [ ] **Step 4: Verify targeted behavior**

Run:

```bash
npx vitest run tests/claude-cli.test.ts
npm run typecheck
```

Expected: both commands exit 0.

## Task 2: Final Verification And Bundle Refresh

**Files:**
- Modify after tests pass: `plugins/codex-claude-delegate/server/server.js`
- Modify after tests pass: `plugins/codex-claude-delegate/server/job-runner.js`

- [ ] **Step 1: Run full source suite**

Run:

```bash
npm test
npm run build
```

Expected: both commands exit 0.

- [ ] **Step 2: Refresh plugin runtime**

Run:

```bash
npm run build:plugin
npm run check:plugin
npm run audit:docs
```

Expected: all commands exit 0.

- [ ] **Step 3: Inspect diff**

Run:

```bash
git diff --stat
git diff -- src/claude-cli.ts src/claude-process.ts
```

Expected: `src/claude-cli.ts` shrinks; `src/claude-process.ts` contains only process execution helpers; no schema/server/test source files changed.
