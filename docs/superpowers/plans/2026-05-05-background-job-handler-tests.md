# Background Job Handler Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add direct handler-level regression coverage for the background MCP tools without relying only on helper tests or full stdio debug scripts.

**Architecture:** Refactor `src/server.ts` just enough to make tool registration and tool-call routing testable as pure module exports, while preserving the current stdio startup path for normal execution. Add a focused `tests/server.test.ts` suite that mocks guard/CLI dependencies and verifies validation, routing, and error shaping for `claude_jobs`, `claude_job_result`, `claude_job_cancel`, and `claude_job_wait`.

**Tech Stack:** TypeScript, MCP SDK, Vitest, existing server helpers in `src/server.ts`, mocked `guard.ts` and `claude-cli.ts`

---

## File Map

- Modify: `src/server.ts`
  Export testable registration/routing helpers and isolate stdio bootstrap.
- Create: `tests/server.test.ts`
  Add handler-level tests for background MCP tools.
- Modify: `README.md`
  No required change for this slice unless the refactor affects documented behavior.

## Scope

This iteration covers only handler-level regression protection for:

- `claude_jobs`
- `claude_job_result`
- `claude_job_cancel`
- `claude_job_wait`

It does not add new user-facing capabilities.

### Task 1: Make `src/server.ts` Testable

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Refactor bootstrap behind exported helpers**

Extract the current tool registration into exported functions such as:

```ts
export function registerToolDefinitions(server: Server): void { ... }
export function registerToolHandlers(server: Server): void { ... }
export async function startServer(): Promise<void> { ... }
```

Keep the direct startup path at the bottom, but make it call `startServer()`.

- [ ] **Step 2: Export a pure handler helper for tool calls**

Export a helper used by the request handler, for example:

```ts
export async function handleToolCall(name: string, args: unknown, runId = randomUUID()) {
  // existing switch body
}
```

The MCP `CallToolRequestSchema` handler should become a thin wrapper that forwards into this helper.

- [ ] **Step 3: Verify the refactor compiles**

Run: `npm run build`

Expected: PASS with unchanged runtime behavior.

### Task 2: Add Handler-Level Tests

**Files:**
- Create: `tests/server.test.ts`

- [ ] **Step 1: Write tests for validation and routing**

Create `tests/server.test.ts` with mocked dependencies from `src/guard.ts` and `src/claude-cli.ts`.

Add coverage for:

```ts
it("routes claude_jobs through listBackgroundJobs with resolved cwd", async () => { ... });
it("returns validation errors for claude_job_result with empty job_id", async () => { ... });
it("returns not found error when claude_job_result has no record", async () => { ... });
it("returns cancel error when claude_job_cancel reports not cancelled", async () => { ... });
it("routes claude_job_wait through waitForBackgroundJob with resolved cwd", async () => { ... });
```

Assertions should verify:

- `validateCwd` is called
- CLI helper receives the resolved cwd
- error cases return `errorResult(...)` shaped content

- [ ] **Step 2: Run the new server test to verify failure**

Run: `npm test -- tests/server.test.ts`

Expected: FAIL before the `src/server.ts` refactor is complete.

- [ ] **Step 3: Re-run after refactor**

Run: `npm test -- tests/server.test.ts`

Expected: PASS.

### Task 3: Full Verification

**Files:**
- Modify: `src/server.ts`
- Create: `tests/server.test.ts`

- [ ] **Step 1: Run focused regression suite**

Run: `npm test -- tests/server.test.ts tests/schema.test.ts tests/claude-cli.test.ts`

Expected: PASS.

- [ ] **Step 2: Run full verification**

Run: `npm run build`
Expected: PASS

Run: `npm test`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Review scoped diff**

Run: `git diff -- src/server.ts tests/server.test.ts`

Expected: only the server testability refactor and the new handler-level tests are included.
