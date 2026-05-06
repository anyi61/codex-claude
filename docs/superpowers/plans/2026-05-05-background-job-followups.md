# Background Job Follow-Ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prioritize and complete the next round of background-job-model improvements without destabilizing the newly shipped queue/result/cancel flow.

**Status calibration (2026-05-05):** Implemented; wait, cleanup, query backgrounding, apply/cleanup backgrounding, handler tests, and runner tests are now present. Remaining future work should be tracked in a new plan rather than this historical checklist.

**Architecture:** Keep the existing background job design intact and improve it in thin vertical slices. Each slice must preserve synchronous tool behavior, reuse the current `jobs.ts` + `job-runner.ts` model, and add narrowly scoped tests and documentation before moving to the next priority.

**Tech Stack:** TypeScript, Node.js child processes, MCP SDK, zod, Vitest, existing background job persistence under `.codex-claude-delegate/jobs`

---

## Priority Checklist

### P0

1. `claude_job_wait`
   Add a higher-level wait tool so clients do not need to hand-roll polling loops for background jobs.

2. Server/handler coverage for background MCP tools
   Add direct regression coverage for `claude_jobs`, `claude_job_result`, `claude_job_cancel`, and the new wait tool at the request-dispatch layer.

### P1

3. Job retention / cleanup
   Add a bounded retention policy or explicit cleanup tool for old terminal jobs.

4. `job-runner.ts` failure/signal tests
   Add more direct coverage for worker shutdown, signal-triggered cancellation, and failed startup behavior.

### P2

5. Background `apply` / `cleanup` orchestration
   Decide whether to extend the background model beyond review/implement.

6. Background `query`
   Consider query backgrounding only after the wait/retention/test story is stable.

## Current Execution Target

This iteration executes **P0-1 only**:

- add `claude_job_wait`
- document it
- add tests for helper logic and server handler routing
- verify with build/test/typecheck

## File Map For P0-1

- Modify: `src/schema.ts`
  Add the wait-tool input/result types and zod schema.
- Modify: `src/server.ts`
  Register the new MCP tool and route it into the background job helper.
- Modify: `src/claude-cli.ts`
  Add a wait helper that polls persisted job state until terminal status or timeout.
- Modify: `tests/schema.test.ts`
  Cover wait-tool validation.
- Modify: `tests/claude-cli.test.ts`
  Cover wait helper behavior and timeout behavior.
- Modify: `README.md`
  Document the wait workflow.

### Task 1: Add Wait Tool Types And Validation

**Files:**
- Modify: `src/schema.ts`
- Test: `tests/schema.test.ts`

- [x] **Step 1: Write the failing schema test**

Add a schema test that asserts:

```ts
expect(claudeJobWaitInputSchema.safeParse({ cwd: "/repo", job_id: "job-1" }).success).toBe(true);
expect(claudeJobWaitInputSchema.safeParse({ cwd: "/repo", job_id: "job-1", timeout_ms: 5000 }).success).toBe(true);
expect(claudeJobWaitInputSchema.safeParse({ cwd: "/repo", job_id: "" }).success).toBe(false);
expect(claudeJobWaitInputSchema.safeParse({ cwd: "/repo", job_id: "job-1", timeout_ms: 0 }).success).toBe(false);
```

- [x] **Step 2: Run the schema test to verify it fails**

Run: `npm test -- tests/schema.test.ts`

Expected: FAIL because `claudeJobWaitInputSchema` does not exist yet.

- [x] **Step 3: Add wait-tool schema types**

In `src/schema.ts`, add:

```ts
export interface ClaudeJobWaitInput {
  cwd: string;
  job_id: string;
  timeout_ms?: number;
  poll_interval_ms?: number;
}
```

And:

```ts
export const claudeJobWaitInputSchema = z.object({
  cwd: cwdSchema,
  job_id: z.string().trim().min(1, "job_id is required"),
  timeout_ms: z.number().int().positive().max(3_600_000).optional().default(30_000),
  poll_interval_ms: z.number().int().positive().max(10_000).optional().default(1_000),
});
```

- [x] **Step 4: Re-run the schema test**

Run: `npm test -- tests/schema.test.ts`

Expected: PASS.

### Task 2: Implement Background Wait Helper

**Files:**
- Modify: `src/claude-cli.ts`
- Test: `tests/claude-cli.test.ts`

- [x] **Step 1: Write failing wait-helper tests**

Add tests that create persisted jobs and assert:

```ts
const result = await reloaded.waitForBackgroundJob({
  cwd: repo,
  job_id: "job-done",
  timeout_ms: 1000,
  poll_interval_ms: 10,
});
expect(result.job.status).toBe("succeeded");
```

And timeout behavior:

```ts
await expect(
  reloaded.waitForBackgroundJob({
    cwd: repo,
    job_id: "job-running",
    timeout_ms: 50,
    poll_interval_ms: 10,
  })
).rejects.toThrow(/Timed out/);
```

- [x] **Step 2: Run the targeted CLI test to verify it fails**

Run: `npm test -- tests/claude-cli.test.ts`

Expected: FAIL because `waitForBackgroundJob` does not exist.

- [x] **Step 3: Implement the polling helper**

In `src/claude-cli.ts`, add:

```ts
export async function waitForBackgroundJob(input: ClaudeJobWaitInput): Promise<{ job: BackgroundJobSummary; result?: Record<string, unknown> }> {
  const start = Date.now();
  while (Date.now() - start < (input.timeout_ms ?? 30_000)) {
    const result = await getBackgroundJobResult({ cwd: input.cwd, job_id: input.job_id });
    if (!result) {
      throw new Error(`Job not found: ${input.job_id}`);
    }
    const status = result.job.status;
    if (status === "succeeded" || status === "failed" || status === "cancelled") {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, input.poll_interval_ms ?? 1_000));
  }
  throw new Error(`Timed out waiting for job ${input.job_id}`);
}
```

- [x] **Step 4: Re-run the targeted CLI test**

Run: `npm test -- tests/claude-cli.test.ts`

Expected: PASS.

### Task 3: Wire `claude_job_wait` Into MCP

**Files:**
- Modify: `src/server.ts`
- Modify: `README.md`
- Test: `tests/claude-cli.test.ts`

- [x] **Step 1: Add the MCP tool definition**

In `src/server.ts`, register:

```ts
{
  name: "claude_job_wait",
  description: "Wait for a background job to reach a terminal state or timeout.",
  inputSchema: {
    type: "object",
    required: ["cwd", "job_id"],
    properties: {
      cwd: { type: "string", description: "Working directory (must be within allowed roots)" },
      job_id: { type: "string", description: "Background job id" },
      timeout_ms: { type: "number", description: "Maximum wait time in milliseconds (default 30000)" },
      poll_interval_ms: { type: "number", description: "Polling interval in milliseconds (default 1000)" },
    },
  },
}
```

- [x] **Step 2: Add the tool handler**

In `src/server.ts`, route:

```ts
case "claude_job_wait": {
  const parsed = claudeJobWaitInputSchema.safeParse(args);
  if (!parsed.success) return errorResult(validationErrorMessage(parsed.error));
  const check = await validateCwd(parsed.data.cwd);
  if (!check.ok) return errorResult(check.error!);
  return jsonResult(await waitForBackgroundJob({ ...parsed.data, cwd: check.resolved }));
}
```

- [x] **Step 3: Update README**

Add one example:

```json
{
  "cwd": "/path/to/repo",
  "job_id": "job-123",
  "timeout_ms": 30000
}
```

And update the recommended workflow so `claude_job_wait` appears before manual polling.

- [x] **Step 4: Run focused tests**

Run: `npm test -- tests/schema.test.ts tests/claude-cli.test.ts`

Expected: PASS.

### Task 4: Verify And Hand Off

**Files:**
- Modify: `README.md`
- Test: `tests/schema.test.ts`
- Test: `tests/claude-cli.test.ts`

- [x] **Step 1: Run full verification**

Run: `npm run build`
Expected: PASS

Run: `npm test`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS

- [x] **Step 2: Review the scoped diff**

Run: `git diff -- src/schema.ts src/server.ts src/claude-cli.ts tests/schema.test.ts tests/claude-cli.test.ts README.md`

Expected: only the P0-1 wait-tool changes are present.
