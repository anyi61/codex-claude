# Run Inspect And Resume Latest Implement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single-run inspection tool and a high-level way to continue the latest implement session for the current repository.

**Architecture:** Extend the existing run-log model instead of introducing a separate persistence layer. `claude_run_inspect` should reuse the same log parsing primitives as `claude_runs`, while `resume_latest` should reuse current implement/session plumbing and derive the latest resumable implement run from existing logs.

**Tech Stack:** TypeScript, MCP SDK, zod, Vitest, existing run-log JSON files under `.codex-claude-delegate/`

---

## File Map

- Modify: `src/schema.ts`
  Add tool input/output types and zod schemas for run inspection and resume-latest implement.
- Modify: `src/server.ts`
  Register the new MCP tool and wire the new implement input path.
- Modify: `src/claude-cli.ts`
  Add helpers to load a run by id, expose normalized inspect output, and resolve the latest resumable implement session.
- Modify: `tests/schema.test.ts`
  Cover new schema validation rules.
- Modify: `tests/claude-cli.test.ts`
  Cover inspect behavior and resume-latest selection rules.
- Modify: `README.md`
  Document the new tool and the new resume path for implement.

### Task 1: Add Run Inspect Types And Tool Surface

**Files:**
- Modify: `src/schema.ts`
- Modify: `src/server.ts`
- Test: `tests/schema.test.ts`

- [ ] **Step 1: Add failing schema tests for run inspect and resume-latest**

Add test cases in `tests/schema.test.ts` that assert:

```ts
expect(claudeRunInspectInputSchema.safeParse({ cwd: "/repo", run_id: "abc" }).success).toBe(true);
expect(claudeRunInspectInputSchema.safeParse({ cwd: "/repo", run_id: "" }).success).toBe(false);
expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", task: "x", resume_latest: true }).success).toBe(true);
expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", resume_latest: true }).success).toBe(false);
expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", task: "", resume_latest: true }).success).toBe(false);
```

- [ ] **Step 2: Run schema tests to confirm failure**

Run: `npm test -- tests/schema.test.ts`

Expected: FAIL because `claudeRunInspectInputSchema` and `resume_latest` support do not exist yet.

- [ ] **Step 3: Add schema types and zod validation**

In `src/schema.ts`:

```ts
export interface ClaudeRunInspectInput {
  cwd: string;
  run_id: string;
}

export interface ClaudeRunInspectResult {
  entry: RunLogEntrySummary;
  raw: Record<string, unknown>;
  related_runs?: {
    apply_run_id?: string;
    cleanup_run_id?: string;
  };
}
```

Extend `ClaudeImplementInput` with:

```ts
resume_latest?: boolean;
```

Add:

```ts
export const claudeRunInspectInputSchema = z.object({
  cwd: cwdSchema,
  run_id: z.string().trim().min(1, "run_id is required"),
});
```

Extend `claudeImplementInputSchema` to accept `resume_latest: z.boolean().optional()` while keeping the existing `fork_session` + `session_key` refinement intact.

- [ ] **Step 4: Register tool surface in the MCP server**

In `src/server.ts`:

```ts
{
  name: "claude_run_inspect",
  description: "Inspect a single delegated run log by run id, including normalized details and lifecycle metadata.",
  inputSchema: {
    type: "object",
    required: ["cwd", "run_id"],
    properties: {
      cwd: { type: "string", description: "Working directory (must be within allowed roots)" },
      run_id: { type: "string", description: "Run log id without the .json suffix" },
    },
  },
}
```

Also update the `claude_implement` tool description/schema to mention `resume_latest`.

- [ ] **Step 5: Re-run schema-focused tests**

Run: `npm test -- tests/schema.test.ts`

Expected: PASS.

### Task 2: Implement `claude_run_inspect`

**Files:**
- Modify: `src/claude-cli.ts`
- Modify: `src/server.ts`
- Test: `tests/claude-cli.test.ts`

- [ ] **Step 1: Add failing inspect test**

Add a Vitest case in `tests/claude-cli.test.ts` that writes a fake implement run log with downstream metadata and then asserts:

```ts
const result = await reloaded.getRunLogById({ cwd: "/repo-a", run_id: "run-implement" });
expect(result.entry.run_id).toBe("run-implement");
expect(result.entry.lifecycle).toBe("applied");
expect(result.related_runs).toEqual({ apply_run_id: "apply-1", cleanup_run_id: "cleanup-1" });
expect(result.raw.downstream).toBeDefined();
```

- [ ] **Step 2: Run the targeted test to confirm failure**

Run: `npm test -- tests/claude-cli.test.ts`

Expected: FAIL because `getRunLogById` does not exist.

- [ ] **Step 3: Add reusable run-log loading helper**

In `src/claude-cli.ts`, add a helper that loads one file directly instead of scanning all logs:

```ts
async function readRunLogFile(runId: string): Promise<GenericRunLog | null> {
  const file = path.join(LOG_DIR, `${runId}.json`);
  try {
    return JSON.parse(await readFile(file, "utf8")) as GenericRunLog;
  } catch {
    return null;
  }
}
```

Then add:

```ts
export async function getRunLogById(input: ClaudeRunInspectInput): Promise<ClaudeRunInspectResult | null> {
  const raw = await readRunLogFile(input.run_id);
  if (!raw) return null;
  const summary = summarizeRunLog(input.run_id, raw);
  if (summary.cwd && summary.cwd !== input.cwd) return null;
  return {
    entry: summary,
    raw: raw as Record<string, unknown>,
    related_runs: {
      apply_run_id: typeof raw.downstream?.last_apply_run_id === "string" ? raw.downstream.last_apply_run_id : undefined,
      cleanup_run_id: typeof raw.downstream?.last_cleanup_run_id === "string" ? raw.downstream.last_cleanup_run_id : undefined,
    },
  };
}
```

- [ ] **Step 4: Wire the server handler**

In `src/server.ts`, add:

```ts
case "claude_run_inspect": {
  const parsed = claudeRunInspectInputSchema.safeParse(args);
  if (!parsed.success) return errorResult(validationErrorMessage(parsed.error));
  const check = await validateCwd(parsed.data.cwd);
  if (!check.ok) return errorResult(check.error!);
  const result = await getRunLogById({ cwd: check.resolved, run_id: parsed.data.run_id });
  if (!result) return errorResult(`Run not found: ${parsed.data.run_id}`);
  return jsonResult(result);
}
```

- [ ] **Step 5: Re-run the targeted inspect test**

Run: `npm test -- tests/claude-cli.test.ts`

Expected: PASS, including the new inspect test.

### Task 3: Add `resume_latest` For `claude_implement`

**Files:**
- Modify: `src/claude-cli.ts`
- Modify: `src/server.ts`
- Test: `tests/claude-cli.test.ts`

- [ ] **Step 1: Add failing resume-latest tests**

Add tests that create multiple implement run logs and assert:

```ts
const resolved = await reloaded.resolveLatestImplementSession({ cwd: repo });
expect(resolved?.run_id).toBe("implement-newest");
expect(resolved?.session_id).toBe("sess-latest");
```

Also add a negative case:

```ts
await expect(
  reloaded.resolveLatestImplementSession({ cwd: repoWithoutSession })
).resolves.toBeNull();
```

- [ ] **Step 2: Run the targeted test to confirm failure**

Run: `npm test -- tests/claude-cli.test.ts`

Expected: FAIL because resolver logic does not exist.

- [ ] **Step 3: Implement latest-session resolution**

In `src/claude-cli.ts`, add:

```ts
export async function resolveLatestImplementSession(input: { cwd: string }): Promise<{ run_id: string; session_id: string } | null> {
  const runs = await listRunLogs({ cwd: input.cwd, type: "implement", limit: 50 });
  for (const run of runs.entries) {
    const raw = await readRunLogFile(run.run_id);
    const sessionId = raw && typeof raw.session?.returned_session_id === "string" ? raw.session.returned_session_id : null;
    if (sessionId) {
      return { run_id: run.run_id, session_id: sessionId };
    }
  }
  return null;
}
```

Then update implement flow so that when `resume_latest === true` and `session_key` is absent:

```ts
const latest = await resolveLatestImplementSession({ cwd: input.cwd });
if (!latest) {
  return failedResult("No resumable implement session found for this repository.");
}
input = { ...input, session_key: latest.session_id };
```

Use an explicit error path if the caller provides both `resume_latest` and `session_key`; prefer refusing ambiguous input over silently picking one.

- [ ] **Step 4: Wire `resume_latest` through the server**

In `src/server.ts`, pass `resume_latest` from validated input into `runClaudeImplement(...)`.

- [ ] **Step 5: Re-run implement-related tests**

Run: `npm test -- tests/claude-cli.test.ts`

Expected: PASS, including the new resolver tests.

### Task 4: Document And Verify End-To-End

**Files:**
- Modify: `README.md`
- Test: `tests/schema.test.ts`
- Test: `tests/claude-cli.test.ts`

- [ ] **Step 1: Update README usage**

Document:

```md
- `claude_run_inspect` for loading one run by id
- `claude_implement` with `resume_latest: true` to continue the latest implement session for the repo
```

Add one small JSON example for each.

- [ ] **Step 2: Run the focused test suite**

Run: `npm test -- tests/schema.test.ts tests/claude-cli.test.ts`

Expected: PASS.

- [ ] **Step 3: Run full verification**

Run: `npm run build`
Expected: PASS

Run: `npm test`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Review changed files**

Run: `git diff -- src/schema.ts src/server.ts src/claude-cli.ts tests/schema.test.ts tests/claude-cli.test.ts README.md`

Expected: Only the planned files changed, and the diff shows no unrelated refactors.
