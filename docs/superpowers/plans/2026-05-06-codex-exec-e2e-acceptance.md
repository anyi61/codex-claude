# Codex Exec E2E Acceptance Checklist

> **For agentic workers:** Run this checklist only after the user explicitly says "开始". This is a real-user validation flow, not a unit-test-only plan.

**Goal:** First fix and verify the three known product issues from earlier testing, then validate `codex-claude-delegate-mcp` through the real Codex CLI path using `codex exec`, covering all MCP tools, normal implementation/review/apply flow, branch merge/delete, job cancellation, cleanup, and unexpected failure recovery.

**Execution Mode:** `codex exec` fallback. `Computer Use` cannot control terminal apps in this environment.

**Test Project:** `/Users/anyi/test`

---

## Resolution Status

The first three issues are fixed and verified locally. The remaining work is the real `/Users/anyi/test` Codex CLI E2E pass.

- [x] **Issue 1 fixed:** Durable docs now recommend omitting `enabled_tools` or listing all 18 tools, plugin metadata advertises all 18 tools, a regression test covers `registerToolDefinitions()`, and `debug/mcp-list-tools.ts` verifies `tools/list` without invoking Claude.
- [x] **Issue 2 fixed:** `claude_implement` now returns top-level `partial` for non-zero Claude exits with observed changes, `failed` for non-zero exits with no observed changes, and preserves execution/report/observation details.
- [x] **Issue 3 fixed:** `claude_review` no-output/timeout failures now carry structured `diagnostics` and concrete `next_actions` while remaining MCP `isError: true`.
- [x] **Current E2E issue documented:** Terminal apps cannot be controlled through Computer Use, so E2E uses `codex exec`.

**Execution rule:** Do not start the full `/Users/anyi/test` E2E until Fix Gates 1-3 pass.

---

## Fix Gate 1: Full Tool Exposure

### Problem

Real Codex originally saw only:

```text
claude_status, claude_query, claude_review, claude_implement, claude_apply, claude_cleanup
```

but the server supports all 18 tools.

### Required Fix

- [x] Update durable user-facing configuration guidance so installs expose all 18 tools or intentionally omit `enabled_tools`.
- [x] Update plugin metadata so it no longer advertises only the stale six-tool surface.
- [x] Add a regression test that verifies `registerToolDefinitions()` exposes all expected tool names.
- [x] Add or document a zero-cost list-tools smoke check that starts `dist/server.js` and calls MCP `tools/list` without invoking Claude.

### Acceptance

- [x] `npm test -- tests/server.test.ts` passes.
- [x] `npm run build` passes.
- [x] `codex mcp get claude_delegate` shows all 18 tools in the active E2E environment.
- [x] README/plugin docs tell users how to detect and fix stale six-tool configs.

---

## Fix Gate 2: Correct `claude_implement` Status Semantics

### Problem

Known failing shape:

```json
{
  "status": "success",
  "execution": { "exit_code": 1 },
  "claude_report": {
    "is_error": true,
    "terminal_reason": "max_turns"
  },
  "server_observed": {
    "changed_files": ["tmp-codex-claude-smoke.txt"]
  }
}
```

### Required Fix

- [x] Add a failing test for non-zero Claude output with observed changed files.
- [x] Add a failing test for non-zero Claude output with no observed changed files.
- [x] Normalize top-level status:

```text
partial  if Claude failed but useful changed files exist
failed   if Claude failed and no useful changed files exist
success  only if Claude completed cleanly
```

- [x] Preserve `execution`, `claude_report`, and `server_observed` on partial/failed results.
- [x] Add warnings/next actions that tell Codex to inspect or resume instead of blindly applying partial work.

### Acceptance

- [x] `max_turns` with changed files returns top-level `status: "partial"`.
- [x] `max_turns` with no changed files returns top-level `status: "failed"`.
- [x] `execution.exit_code !== 0` never produces top-level `status: "success"` unless there is an explicit documented exception.
- [x] `npm test -- tests/claude-cli.test.ts` passes.

---

## Fix Gate 3: Actionable `claude_review` Timeout/No-Output Errors

### Problem

Known failure:

```text
Claude produced no output (exit 143, signal none, timeout_sec=90, stdoutLen=0, stderrLen=0, stderrTail="")
```

### Required Fix

- [x] Add a failing test for empty stdout/no-output review failure.
- [x] Return structured error payload with:

```json
{
  "error": "Claude produced no output...",
  "diagnostics": {
    "timeout_sec": 90,
    "stdout_len": 0,
    "stderr_len": 0
  },
  "next_actions": [
    { "tool": "claude_review", "reason": "Retry with a higher timeout_sec." },
    { "tool": "claude_review", "args": { "background": true }, "reason": "Run broad review in the background." },
    { "tool": "claude_status", "reason": "Check Claude CLI auth and environment diagnostics." }
  ]
}
```

- [x] Keep MCP response `isError: true`.
- [x] Preserve existing redaction behavior for environment and stderr diagnostics.

### Acceptance

- [x] Empty-output review failures include `diagnostics`.
- [x] Empty-output review failures include at least three concrete `next_actions`.
- [x] `npm test -- tests/claude-cli.test.ts tests/server.test.ts` passes.

---

## Current Permission Findings

### Finding 1: Computer Use Cannot Control Terminal Apps

**Observed:** `Computer Use` rejects Ghostty, iTerm, and macOS Terminal:

```text
Computer Use is not allowed to use the app 'com.mitchellh.ghostty' for safety reasons.
Computer Use is not allowed to use the app 'com.googlecode.iterm2' for safety reasons.
Computer Use is not allowed to use the app 'com.apple.Terminal' for safety reasons.
```

**Permission check:** macOS permissions appear enabled:

```text
Accessibility: Codex Computer Use = on, Ghostty = on
Screen Recording: Codex = on, Codex Computer Use = on
```

**Conclusion:** This is a Computer Use plugin safety policy, not a missing macOS permission.

**Decision:** Use `codex exec` for E2E testing.

### Finding 2: `/Users/anyi/test` Was Outside MCP Allowed Roots

**Observed before config change:**

```text
Path "/Users/anyi/test" is outside allowed roots: /Users/anyi/projects, /Users/anyi/work, /Users/anyi/codex-claude
```

**Temporary fix applied:** `~/.codex/config.toml` was backed up to:

```text
/Users/anyi/.codex/config.toml.codex-claude-e2e-backup-20260506-084738
```

and `mcp_servers.claude_delegate.env.CODEX_CLAUDE_ALLOW_ROOTS` now includes `/Users/anyi/test`.

**Acceptance result:** Restored the backup after E2E. `codex mcp get claude_delegate` now shows the original restored six-tool user config and no temporary MCP env override.

### Finding 3: Real Codex Config Had Only 6 Enabled Tools

**Observed before config change:**

```text
enabled_tools: claude_status, claude_query, claude_review, claude_implement, claude_apply, claude_cleanup
```

**Temporary fix applied:** Enabled all 18 tools:

```text
claude_status, claude_setup, claude_runs, claude_run_inspect, claude_result,
claude_workspace_status, claude_task, claude_review_gate, claude_query,
claude_review, claude_implement, claude_jobs, claude_job_result,
claude_job_cancel, claude_job_wait, claude_job_cleanup, claude_apply,
claude_cleanup
```

**Acceptance requirement:** This is covered by Fix Gate 1 before starting E2E.

**Acceptance result:** Fix Gate 1 passed before E2E. After final config restore, the active user config intentionally returned to the original six-tool state.

### Finding 4: Prior E2E Was Paused Mid-Run

**Current `/Users/anyi/test` state may include:**

```text
.claude/
.codex-claude-delegate/
```

and a delegated worktree from the paused run:

```text
.claude/worktrees/codex-delegated-60ef06c1
```

**Acceptance result:** Pre-existing paused artifacts were cleaned before the successful E2E pass.

---

## E2E Product Issues To Watch For

### Issue C: Cleanup Is Bulk-Oriented

**Observed:** `claude_cleanup` can dry-run or clean by age, but there is no obvious single-worktree cleanup command.

**Expected E2E behavior:** The acceptance flow must avoid accidentally deleting unrelated delegated worktrees and must record what it cleans.

---

## Start Preconditions

- [x] User explicitly says `开始`.
- [x] Fix Gate 1 is complete.
- [x] Fix Gate 2 is complete.
- [x] Fix Gate 3 is complete.
- [x] `/Users/anyi/test` operation permission remains granted.
- [x] Temporary `~/.codex/config.toml` change is allowed during the test.
- [x] Permission to terminate only test-started Codex/Claude jobs remains granted.
- [x] `codex mcp get claude_delegate` shows all 18 enabled tools.
- [x] `/Users/anyi/test` is a git repo with passing baseline `npm test`.
- [x] Any pre-existing `.claude/` or `.codex-claude-delegate/` artifacts are recorded or cleaned with user-approved scope.

---

## Tool Coverage Matrix

The E2E pass must call every tool at least once:

- [x] `claude_status`
- [x] `claude_setup`
- [x] `claude_runs`
- [x] `claude_run_inspect`
- [x] `claude_result`
- [x] `claude_workspace_status`
- [x] `claude_task`
- [x] `claude_review_gate`
- [x] `claude_query`
- [x] `claude_review`
- [x] `claude_implement`
- [x] `claude_jobs`
- [x] `claude_job_result`
- [x] `claude_job_cancel`
- [x] `claude_job_wait`
- [x] `claude_job_cleanup`
- [x] `claude_apply`
- [x] `claude_cleanup`

For each tool, record:

```text
tool name
scenario
success/failure/cancelled
important returned fields
unexpected behavior, if any
```

---

## E2E Scenario

### Phase 1: Baseline Project And Readiness

- [x] Run `git status --short --branch` in `/Users/anyi/test`.
- [x] Run `npm test`.
- [x] Run `codex mcp get claude_delegate`.
- [x] Use `codex exec` to call `claude_status`, `claude_setup`, and `claude_workspace_status`.
- [x] Confirm `cwd_valid=true`, `cwd_is_git_repo=true`, `worktree_capable=true`.

### Phase 2: Planning And Review Gate

- [x] Use `codex exec` prompt that asks Codex to create a brief plan before implementation.
- [x] Enable review gate with `claude_review_gate action=enable`.
- [x] Check review gate with `claude_review_gate action=status`.
- [x] Confirm `claude_setup` reflects the enabled gate.

### Phase 3: Delegated Implementation

- [x] Create or switch to test branch `codex/e2e-farewell`.
- [x] Ask Codex to use `claude_task mode=write` or `claude_implement`.
- [x] Feature: add `farewell(name)` returning `Goodbye, ${name}!`.
- [x] Test: extend `test.js` to verify `farewell("Claude")`.
- [x] Inspect output using `claude_result`.
- [x] List runs using `claude_runs`.
- [x] Inspect the relevant run with `claude_run_inspect`.

### Phase 4: Review And Apply

- [x] Run `claude_review` on the delegated diff or changed files.
- [x] Run `claude_apply preview=true`.
- [x] Confirm planned changes are only `index.js` and `test.js`.
- [x] Run `claude_apply cleanup=true` if review is safe.
- [x] Run `npm test`.
- [x] Confirm `git diff` shows only intended changes before commit/merge decisions.

### Phase 5: Branch Merge And Delete

- [x] Commit the applied feature on `codex/e2e-farewell`.
- [x] Switch back to `main`.
- [x] Merge with `git merge --no-ff codex/e2e-farewell`.
- [x] Run `npm test`.
- [x] Delete branch with `git branch -d codex/e2e-farewell`.
- [x] Confirm final `git status --short --branch` is clean except approved MCP state artifacts.

### Phase 6: Background Job Success Path

- [x] Start `claude_query background=true`.
- [x] Use `claude_jobs` to find it.
- [x] Use `claude_job_wait` to wait for terminal state.
- [x] Use `claude_job_result` to inspect the answer.
- [x] Confirm status is `succeeded`.

### Phase 7: Intentional Cancellation Path

- [x] Start a long/broad `claude_review background=true`.
- [x] Immediately call `claude_job_cancel`.
- [x] Call `claude_job_result`.
- [x] Call `claude_jobs status=cancelled`.
- [x] Confirm cancelled job is represented as `cancelled`, not `failed` or `succeeded`.

### Phase 8: Job And Worktree Cleanup

- [x] Run `claude_job_cleanup dry_run=true`.
- [x] If safe, run `claude_job_cleanup dry_run=false` only for test-created terminal jobs.
- [x] Run `claude_cleanup dry_run=true`.
- [x] If safe, clean only E2E-created delegated worktrees.
- [x] Confirm no unexpected worktrees are deleted.

### Phase 9: Config Restore

- [x] Restore `/Users/anyi/.codex/config.toml.codex-claude-e2e-backup-20260506-084738` to `~/.codex/config.toml`, unless the user asks to keep the test config.
- [x] Run `codex mcp get claude_delegate` and record the restored state.

---

## Final Acceptance Criteria

- [x] All 18 MCP tools are exercised and recorded.
- [x] Codex uses Claude delegation for implementation, not direct edits.
- [x] Review gate is enabled, checked, and disabled or cleaned up.
- [x] Delegated implementation is reviewed before apply.
- [x] `claude_apply preview=true` is used before actual apply.
- [x] Feature tests pass after apply and after merge.
- [x] Test branch is merged and deleted.
- [x] At least one background job succeeds and is inspected.
- [x] At least one background job is cancelled and inspected.
- [x] Job cleanup and worktree cleanup are tested safely.
- [x] Any unexpected behavior is written down with observed output, expected behavior, root cause guess, and fix recommendation.
- [x] Any product bug found is fixed and the E2E loop rerun until no open issue remains.
- [x] Temporary Codex config is restored or explicitly kept by user request.

---

## E2E Findings Log

### Finding A: Shell Expanded `${name}` In A `codex exec` Prompt

**Observed:** A double-quoted shell prompt changed the intended string `Goodbye, ${name}!` into `Goodbye, !`.

**Expected:** Test prompts that contain JavaScript template syntax must arrive at Codex unchanged.

**Root cause:** The outer shell expanded `${name}` before `codex exec` received the prompt.

**Resolution:** Terminated only the test-started `codex exec`/MCP server process, cleaned the partial worktree, and reran with single quotes/backticks so `${name}` was preserved.

### Finding B: Claude Wrote Main Workspace Instead Of Delegated Worktree

**Observed:** `claude_task mode=write` reported success, but server observation showed no delegated worktree diff while `/Users/anyi/test/index.js` and `test.js` were modified directly.

**Expected:** Claude implementation writes only inside `.claude/worktrees/codex-delegated-*` until `claude_apply`.

**Root cause:** The server created a worktree but still spawned Claude with `cwd` set to the main repo and passed `-w`; combined with absolute file paths in the prompt, Claude edited the main workspace.

**Resolution:** Changed implement execution to spawn Claude with `cwd` set directly to the server-created delegated worktree, removed `-w` from implement spawn args, and passed normalized relative file paths to Claude. Added regression coverage confirming the main workspace remains untouched and the delegated worktree records the observed changes. Reran the E2E implementation successfully.

### Finding C: Long `codex exec` Prompts Can Stall Before Tool Use

**Observed:** Two long review/apply prompts produced no visible tool calls for several minutes. Process inspection showed the test-started `codex exec` and MCP server were alive, but no Claude process or background job had started.

**Expected:** Codex should either call tools or provide progress/failure promptly.

**Root cause guess:** Prompt complexity/length caused Codex to stall before tool execution, not an MCP server failure.

**Resolution:** Terminated only the test-started `codex exec` process and reran the same workflow as smaller real-user steps. Short prompts reliably called `claude_review`, `claude_jobs`, `claude_job_wait`, `claude_job_result`, and `claude_apply`.

### Final E2E Evidence

- Fix verification: `npm test` passed with 71 tests, `npm run build` passed, and `debug/mcp-list-tools.ts` returned 18 tools with no missing entries.
- Successful implementation run: `2d12340c-c064-4ec5-a46f-f5f530a54887`, worktree `.claude/worktrees/codex-delegated-2d12340c`, observed changed files `index.js`, `test.js`, exit code `0`.
- Review job: `job-a7a257cb-ea9a-4a74-b50a-0f5666f95223`, status `succeeded`, review run `75d9c665-58f1-4acc-bb16-3cb44f6ee0f0`, severity `low`, no blocking findings.
- Apply: preview planned only `index.js` and `test.js`; actual apply copied both files and `cleanup_performed=true`.
- Merge: feature commit `d1449f7`, merged into `main` with `--no-ff`, branch `codex/e2e-farewell` deleted, `npm test` passed after merge.
- Background success: query job `job-ad1ada67-8aea-41ef-9481-9a892106e82a` succeeded and was inspected.
- Cancellation: review job `job-4bdb515f-7816-417c-832a-1195f8a7e366` and explicit implement job `job-76cb9995-fa76-400e-b7c4-9b05b3daf365` were cancelled and inspected.
- Cleanup: `claude_job_cleanup` removed 4 test-created terminal jobs; `claude_cleanup` removed 1 test-created delegated worktree; final delegated worktree count was `0`.
- Final `/Users/anyi/test` state: `main` branch, tests passing, only approved `.codex-claude-delegate/` metadata remains untracked.
- Config restore: `/Users/anyi/.codex/config.toml` restored from backup; restored `codex mcp get claude_delegate` shows the original six enabled tools and no temporary env override.
