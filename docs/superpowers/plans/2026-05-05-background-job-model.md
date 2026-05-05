# Background Job Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent background job model for long-running delegated `review` and `implement` tasks, with list/result/cancel workflows and no regression for existing synchronous calls.

**Architecture:** Keep the current synchronous tool implementations intact and add a parallel background execution path. Persist job state in `.codex-claude-delegate/jobs`, launch a detached worker process to execute one job at a time, and expose status/result/cancel through MCP tools that read the persisted job records.

**Tech Stack:** TypeScript, Node.js child processes, MCP SDK, zod, Vitest, existing `claude-cli.ts` task runners

---

## Scope

This plan covers:

- `claude_review` with optional `background: true`
- `claude_implement` with optional `background: true`
- New read/write tools:
  - `claude_jobs`
  - `claude_job_result`
  - `claude_job_cancel`
- Persistent job files and a detached worker entrypoint

This plan does **not** cover:

- background support for `claude_query`
- background support for `claude_apply` or `claude_cleanup`
- streaming partial output to the client
- cross-host or multi-machine coordination

## File Map

- Create: `src/jobs.ts`
  Own job state types, file layout, persistence, lookup, and cancellation helpers.
- Create: `src/job-runner.ts`
  Detached worker entrypoint that loads one persisted job and executes the correct task runner.
- Modify: `src/schema.ts`
  Add job-related types and zod schemas; add `background?: boolean` to review and implement inputs.
- Modify: `src/server.ts`
  Register new job tools and route `background: true` requests into the job launcher.
- Modify: `src/claude-cli.ts`
  Add background launch helpers and any reusable result normalization needed by the worker.
- Modify: `tests/schema.test.ts`
  Cover the new schemas and invalid combinations.
- Modify: `tests/claude-cli.test.ts`
  Cover job persistence, listing, result loading, cancellation, and background request setup.
- Modify: `README.md`
  Document the new background workflow.

### Task 1: Define Job Types And MCP Surface

**Files:**
- Modify: `src/schema.ts`
- Modify: `src/server.ts`
- Test: `tests/schema.test.ts`

- [ ] **Step 1: Write failing schema tests for background job inputs**

Add tests to `tests/schema.test.ts` that assert:

```ts
expect(claudeReviewInputSchema.safeParse({ cwd: "/repo", task: "review this", background: true }).success).toBe(true);
expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", task: "ship it", background: true }).success).toBe(true);
expect(claudeJobsInputSchema.safeParse({ cwd: "/repo", limit: 10 }).success).toBe(true);
expect(claudeJobResultInputSchema.safeParse({ cwd: "/repo", job_id: "job-123" }).success).toBe(true);
expect(claudeJobCancelInputSchema.safeParse({ cwd: "/repo", job_id: "job-123" }).success).toBe(true);
expect(claudeJobResultInputSchema.safeParse({ cwd: "/repo", job_id: "" }).success).toBe(false);
```

- [ ] **Step 2: Run schema tests to confirm failure**

Run: `npm test -- tests/schema.test.ts`

Expected: FAIL because the job schemas and `background` fields do not exist yet.

- [ ] **Step 3: Add job-related types and zod schemas**

In `src/schema.ts`, add:

```ts
export type BackgroundJobType = "review" | "implement";
export type BackgroundJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface BackgroundJobSummary {
  job_id: string;
  type: BackgroundJobType;
  status: BackgroundJobStatus;
  cwd: string;
  created_at: string;
  updated_at: string;
  pid?: number;
  run_id?: string;
  worktree_name?: string;
  summary?: string;
  error?: string;
}

export interface ClaudeJobsInput {
  cwd: string;
  limit?: number;
  status?: BackgroundJobStatus;
  type?: BackgroundJobType;
}

export interface ClaudeJobsResult {
  entries: BackgroundJobSummary[];
}

export interface ClaudeJobResultInput {
  cwd: string;
  job_id: string;
}

export interface ClaudeJobCancelInput {
  cwd: string;
  job_id: string;
}
```

Add zod schemas:

```ts
export const claudeJobsInputSchema = z.object({
  cwd: cwdSchema,
  limit: z.number().int().positive().max(200).optional().default(20),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]).optional(),
  type: z.enum(["review", "implement"]).optional(),
});

export const claudeJobResultInputSchema = z.object({
  cwd: cwdSchema,
  job_id: z.string().trim().min(1, "job_id is required"),
});

export const claudeJobCancelInputSchema = z.object({
  cwd: cwdSchema,
  job_id: z.string().trim().min(1, "job_id is required"),
});
```

Extend review/implement input schemas with:

```ts
background: z.boolean().optional(),
```

- [ ] **Step 4: Register the MCP tool surface**

In `src/server.ts`, add tool definitions for:

```ts
{
  name: "claude_jobs",
  description: "List recent background review/implement jobs for this repository.",
  inputSchema: { ... }
},
{
  name: "claude_job_result",
  description: "Load one background job record, including final result when available.",
  inputSchema: { ... }
},
{
  name: "claude_job_cancel",
  description: "Cancel a running or queued background job by id.",
  inputSchema: { ... }
}
```

Update `claude_review` and `claude_implement` tool descriptions to mention `background`.

- [ ] **Step 5: Re-run schema tests**

Run: `npm test -- tests/schema.test.ts`

Expected: PASS.

### Task 2: Build Persistent Job Storage

**Files:**
- Create: `src/jobs.ts`
- Modify: `tests/claude-cli.test.ts`

- [ ] **Step 1: Write failing persistence tests**

Add tests to `tests/claude-cli.test.ts` for a new job store API:

```ts
const store = new JobStore(stateDir);
await store.init();
await store.create({
  job_id: "job-1",
  type: "review",
  status: "queued",
  cwd: "/repo-a",
  created_at: "2026-05-05T00:00:00.000Z",
  updated_at: "2026-05-05T00:00:00.000Z",
});
const listed = await store.list({ cwd: "/repo-a", limit: 10 });
expect(listed).toHaveLength(1);
expect(listed[0]?.status).toBe("queued");
```

Also add a cancellation-state test:

```ts
await store.update("job-1", { status: "running", pid: 12345 });
const job = await store.get("job-1");
expect(job?.pid).toBe(12345);
```

- [ ] **Step 2: Run the targeted test to confirm failure**

Run: `npm test -- tests/claude-cli.test.ts`

Expected: FAIL because `JobStore` does not exist.

- [ ] **Step 3: Implement `src/jobs.ts`**

Create `src/jobs.ts` with:

```ts
export interface BackgroundJobRecord extends BackgroundJobSummary {
  payload: Record<string, unknown>;
  result?: Record<string, unknown>;
}

export class JobStore {
  constructor(private readonly baseDir: string) {}
  async init(): Promise<void> { ... }
  async create(record: BackgroundJobRecord): Promise<void> { ... }
  async get(jobId: string): Promise<BackgroundJobRecord | null> { ... }
  async update(jobId: string, patch: Partial<BackgroundJobRecord>): Promise<BackgroundJobRecord | null> { ... }
  async list(input: { cwd: string; limit: number; status?: BackgroundJobStatus; type?: BackgroundJobType }): Promise<BackgroundJobRecord[]> { ... }
}
```

Use one file per job under:

```ts
path.join(baseDir, "jobs", `${jobId}.json`)
```

Use atomic write via temp file + rename for updates.

- [ ] **Step 4: Re-run the targeted job store tests**

Run: `npm test -- tests/claude-cli.test.ts`

Expected: PASS for the new persistence tests.

### Task 3: Add Detached Worker Execution

**Files:**
- Create: `src/job-runner.ts`
- Modify: `src/claude-cli.ts`
- Modify: `tests/claude-cli.test.ts`

- [ ] **Step 1: Write failing tests for job creation and launch metadata**

Add a test around a new launcher helper:

```ts
const created = await reloaded.enqueueBackgroundJob({
  cwd: "/repo-a",
  type: "review",
  payload: { cwd: "/repo-a", task: "review this" },
});
expect(created.job.status).toBe("queued");
expect(created.job.job_id).toBeTruthy();
expect(created.job.pid).toBeDefined();
```

Mock the child-process launcher so the test does not need a real detached worker.

- [ ] **Step 2: Run the targeted test to confirm failure**

Run: `npm test -- tests/claude-cli.test.ts`

Expected: FAIL because the launcher helper does not exist.

- [ ] **Step 3: Implement job enqueue and detached worker launch**

In `src/claude-cli.ts`, add:

```ts
export async function enqueueBackgroundJob(input: {
  cwd: string;
  type: BackgroundJobType;
  payload: Record<string, unknown>;
}): Promise<{ job: BackgroundJobSummary }> { ... }
```

Implementation requirements:

- create the queued job record in `JobStore`
- spawn a detached worker:

```ts
spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "job-runner.js"), jobId], {
  cwd: input.cwd,
  detached: true,
  stdio: "ignore",
  env: sanitizeEnv(),
}).unref();
```

- patch the job with `pid` and `updated_at`

In `src/job-runner.ts`:

- parse `jobId` from argv
- load the job record
- mark it `running`
- route `review` to `runClaudeReview(...)`
- route `implement` to `runClaudeImplement(...)`
- persist final `result`, `summary`, `run_id`, and terminal `status`
- catch thrown errors and persist `failed`
- on `SIGTERM`, persist `cancelled` before exit

- [ ] **Step 4: Re-run the launcher tests**

Run: `npm test -- tests/claude-cli.test.ts`

Expected: PASS for the enqueue/launch metadata tests.

### Task 4: Wire Background Paths Into MCP Tools

**Files:**
- Modify: `src/server.ts`
- Modify: `src/claude-cli.ts`
- Modify: `tests/claude-cli.test.ts`

- [ ] **Step 1: Write failing tests for background request behavior**

Add tests that assert:

```ts
const result = await reloaded.startBackgroundReview({
  cwd: "/repo-a",
  task: "review this",
  background: true,
});
expect(result.job.status).toBe("queued");
```

And for implement:

```ts
const result = await reloaded.startBackgroundImplement({
  cwd: "/repo-a",
  task: "ship it",
  background: true,
});
expect(result.job.type).toBe("implement");
```

- [ ] **Step 2: Run the targeted test to confirm failure**

Run: `npm test -- tests/claude-cli.test.ts`

Expected: FAIL because the background dispatch helpers do not exist.

- [ ] **Step 3: Add background-aware entry helpers**

In `src/claude-cli.ts`, add thin wrappers:

```ts
export async function startBackgroundReview(input: ClaudeReviewInput): Promise<{ job: BackgroundJobSummary }> {
  return enqueueBackgroundJob({ cwd: input.cwd, type: "review", payload: input as Record<string, unknown> });
}

export async function startBackgroundImplement(input: ClaudeImplementInput): Promise<{ job: BackgroundJobSummary }> {
  return enqueueBackgroundJob({ cwd: input.cwd, type: "implement", payload: input as Record<string, unknown> });
}
```

In `src/server.ts`:

- if `claude_review.background === true`, return `jsonResult(await startBackgroundReview(...))`
- if `claude_implement.background === true`, return `jsonResult(await startBackgroundImplement(...))`
- otherwise keep the current synchronous path unchanged

- [ ] **Step 4: Re-run background dispatch tests**

Run: `npm test -- tests/claude-cli.test.ts`

Expected: PASS.

### Task 5: Implement Job List / Result / Cancel Tools

**Files:**
- Modify: `src/server.ts`
- Modify: `src/claude-cli.ts`
- Modify: `tests/claude-cli.test.ts`

- [ ] **Step 1: Write failing tests for listing, reading, and cancelling jobs**

Add tests that assert:

```ts
const jobs = await reloaded.listBackgroundJobs({ cwd: "/repo-a", limit: 10 });
expect(jobs.entries).toHaveLength(2);
```

```ts
const result = await reloaded.getBackgroundJobResult({ cwd: "/repo-a", job_id: "job-1" });
expect(result?.job.job_id).toBe("job-1");
```

```ts
const cancel = await reloaded.cancelBackgroundJob({ cwd: "/repo-a", job_id: "job-running" });
expect(cancel.cancelled).toBe(true);
```

- [ ] **Step 2: Run the targeted test to confirm failure**

Run: `npm test -- tests/claude-cli.test.ts`

Expected: FAIL because the management helpers do not exist.

- [ ] **Step 3: Implement management helpers**

In `src/claude-cli.ts`, add:

```ts
export async function listBackgroundJobs(input: ClaudeJobsInput): Promise<ClaudeJobsResult> { ... }
export async function getBackgroundJobResult(input: ClaudeJobResultInput): Promise<{ job: BackgroundJobSummary; result?: Record<string, unknown> } | null> { ... }
export async function cancelBackgroundJob(input: ClaudeJobCancelInput): Promise<{ cancelled: boolean; job?: BackgroundJobSummary; error?: string }> { ... }
```

Behavior:

- list reads `JobStore.list(...)` and returns summaries only
- result returns one record scoped to `cwd`
- cancel:
  - if job is `queued`, mark `cancelled`
  - if job is `running` and has `pid`, send `SIGTERM`, then mark `cancelled`
  - if job is already terminal, return `cancelled: false` with an explanatory error

In `src/server.ts`, wire the three new tool handlers.

- [ ] **Step 4: Re-run management tests**

Run: `npm test -- tests/claude-cli.test.ts`

Expected: PASS.

### Task 6: Document And Verify The Background Workflow

**Files:**
- Modify: `README.md`
- Test: `tests/schema.test.ts`
- Test: `tests/claude-cli.test.ts`

- [ ] **Step 1: Update README**

Document:

```md
- `claude_review` / `claude_implement` with `background: true`
- `claude_jobs` to list jobs
- `claude_job_result` to fetch final state and result payload
- `claude_job_cancel` to cancel queued/running jobs
```

Add JSON examples for each call and one short recommended workflow:

```text
1. start background implement
2. poll claude_jobs or claude_job_result
3. cancel if necessary
4. inspect result and then apply
```

- [ ] **Step 2: Run focused tests**

Run: `npm test -- tests/schema.test.ts tests/claude-cli.test.ts`

Expected: PASS.

- [ ] **Step 3: Run full verification**

Run: `npm run build`
Expected: PASS

Run: `npm test`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Review the scoped diff**

Run: `git diff -- src/jobs.ts src/job-runner.ts src/schema.ts src/server.ts src/claude-cli.ts tests/schema.test.ts tests/claude-cli.test.ts README.md`

Expected: only the planned background job model files changed, and synchronous behavior remains intact when `background` is absent or false.
