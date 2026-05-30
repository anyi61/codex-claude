# STATE-MACHINE-002 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden state-machine fault coverage for artifact index writes, background job crash recovery, and review gate bindings after delegated worktree mutation.

**Architecture:** Keep this as a conservative reliability slice. Prefer tests around existing behavior first, then add minimal metadata or helper functions only where a test exposes an actual trust gap. Artifact index behavior should remain best-effort for parent workflows; job recovery should remain fail-closed for dead processes and conservative for ambiguous live PIDs; review gate clearing should require explicit matching metadata.

**Tech Stack:** TypeScript, Vitest, Node fs/process APIs, existing JSON stores under `.codex-claude-delegate`.

---

## 1. Background And Goal

Current state:

- `writeArtifactIndex()` writes through a temporary file and `rename()`, while `addArtifactEntry()` intentionally swallows errors so parent workflows can continue.
- `recoverCrashedJobs()` marks stale queued/running jobs as crashed when their PID is gone or heartbeat is old, and currently treats any live PID as active.
- `review-gate` stores `pending_run_id`, `pending_worktree_path`, and `pending_fingerprint`; clearing only succeeds when caller-provided binding fields match stored pending metadata.

Problem:

- The state-machine edge cases around interrupted artifact writes, stale job PID metadata, and delegated worktree mutation are mostly implicit. They need targeted fault-injection tests so future changes do not weaken recovery or review-gate safety.

Target behavior:

- Interrupted artifact index writes must preserve the last valid index and tolerate stale `.tmp.*` files.
- Artifact registration must not add an index entry when the referenced artifact file cannot be read or hashed.
- Crash recovery must mark dead/stale jobs as crashed while preserving active or ambiguous jobs.
- PID reuse ambiguity must be represented as conservative behavior with explicit tests: a live PID alone keeps the job active in this slice.
- Review gate clearing must fail when a review supplies an old fingerprint after the delegated worktree content changed.
- Review gate clearing must still succeed when the caller supplies the current fingerprint for the pending run/worktree.

Out of scope:

- A strong OS-level process identity check using process start time. This requires platform-specific `/proc` or `ps` parsing and is deferred unless the implementation finds a small cross-platform helper already available.
- A new persistent artifact database.
- Automatic review-gate fingerprint recomputation inside `clearReviewGatePendingIfMatches()`.
- Worktree naming changes.
- Manual edits under `dist/` or `plugins/codex-claude-delegate/server/*.js`.

## 2. File Impact Scope

Modify:

- `tests/artifact-index.test.ts`
  - Add fault-injection tests for tmp residue, rename/write failure, unreadable artifact files, and index preservation.

- `tests/background-jobs.test.ts`
  - Add tests documenting PID reuse ambiguity and stale/dead recovery behavior.

- `tests/review-gate.test.ts`
  - Add tests proving stale worktree fingerprint bindings do not clear pending review.

Modify only if a failing test requires it:

- `src/artifact-index.ts`
  - Keep `addArtifactEntry()` best-effort.
  - If needed, make tmp cleanup best-effort after failed `writeArtifactIndex()` without deleting the canonical index.

- `src/background-jobs.ts`
  - Keep live-PID behavior conservative.
  - If adding process identity metadata, keep it optional and backward-compatible.

- `src/review-gate.ts`
  - Keep clearing based on explicit caller-provided binding fields.
  - If adding helper exports for fingerprint calculation, keep them small and covered.

Do not modify:

- `dist/`.
- `plugins/codex-claude-delegate/server/*.js` by hand.
- Dedupe fingerprint semantics.
- `claude_apply` preview token semantics.

## 3. Positive Acceptance Cases

### PA1: Artifact Index Survives Stale Temporary Files

Setup:

- Existing `.codex-claude-delegate/artifacts/artifacts.json` contains one valid entry.
- A stale sibling file such as `artifacts.json.tmp.leftover` contains invalid or partial JSON.

Expected:

- `readArtifactIndex(cwd)` returns the valid canonical entry.
- `getArtifactSummary(cwd)` counts only the canonical entry.
- No stale tmp content is treated as a real index entry.

### PA2: Artifact Index Preserves Last Valid State On Write Failure

Setup:

- Existing canonical index contains one valid entry.
- Inject an `fs/promises.rename` or equivalent write-path failure during a new index write.

Expected:

- `addArtifactEntry(cwd, newEntry)` does not throw.
- The canonical `artifacts.json` remains parseable.
- The original entry remains present.
- The failed new entry is absent.

### PA3: Verification Artifact Registration Skips Unreadable Artifact Files

Setup:

- Force the stdout or stderr artifact file read/hash step to fail after file write.

Expected:

- `registerVerificationArtifacts()` completes without throwing.
- The unreadable artifact is not indexed.
- Any successfully written and hashed sibling artifact can still be indexed.

### PA4: Crash Recovery Marks Dead PID Jobs As Crashed

Setup:

- A running job is older than `RECOVERY_MIN_AGE_MS`.
- `pid` points to a definitely dead PID.
- `heartbeat_at` is stale.

Expected:

- `recoverCrashedJobs()` returns `1`.
- The job status becomes `crashed`.
- The error explains server restart crash recovery.
- Later dedupe does not reuse the crashed job.

### PA5: PID Reuse Ambiguity Is Conservative

Setup:

- A running job is old and stale.
- `pid` is `process.pid`, representing a live process that may be unrelated.

Expected:

- `recoverCrashedJobs()` returns `0`.
- The job remains `running`.
- A test comment records that live PID wins in this slice because cross-platform start-time verification is deferred.

### PA6: Review Gate Clears With Current Fingerprint

Setup:

- Review gate is enabled.
- Pending metadata stores `run_id`, `worktree_path`, and a fingerprint representing the current delegated worktree content.

Expected:

- `clearReviewGatePendingIfMatches()` with matching `reviewed_run_id`, `reviewed_worktree_path`, and `reviewed_fingerprint` returns `{ cleared: true, reason: "cleared" }`.
- Pending metadata is removed.

## 4. Negative Acceptance Cases

### NA1: Corrupt Canonical Artifact Index Fails Closed To Empty

Setup:

- Canonical `artifacts.json` contains invalid JSON.

Expected:

- `readArtifactIndex(cwd)` returns an empty index.
- It does not merge stale tmp files or partial data.

### NA2: Artifact Registration Does Not Partially Index Failed Files

Setup:

- `registerPatchArtifact()` points to a missing `patch_path`.

Expected:

- The function returns without throwing.
- No patch entry is added.

### NA3: Young Jobs Are Not Recovered As Crashed

Setup:

- A queued or running job is younger than `RECOVERY_MIN_AGE_MS`.
- `pid` is missing or dead.

Expected:

- `recoverCrashedJobs()` returns `0`.
- The job stays active.

### NA4: Stale Review Fingerprint Does Not Clear Pending Gate

Setup:

- Pending review stores fingerprint `fp-current`.
- Caller attempts to clear the gate with the same `reviewed_run_id` and `reviewed_worktree_path` but `reviewed_fingerprint: "fp-old"`.

Expected:

- `clearReviewGatePendingIfMatches()` returns `{ cleared: false, reason: "fingerprint_mismatch" }`.
- `pending_review` remains true.
- `pending_run_id`, `pending_worktree_path`, and `pending_fingerprint` remain unchanged.

### NA5: Missing Binding Does Not Clear Pending Gate

Setup:

- Pending review has run/worktree/fingerprint metadata.
- Caller supplies only `review_run_id`.

Expected:

- Result reason is `no_binding`.
- Pending state remains true.

## 5. Forbidden Behaviors

- Do not make artifact registration failures crash implement/apply workflows.
- Do not read stale `.tmp.*` files as canonical artifact index data.
- Do not delete or rewrite the canonical artifact index after a failed write unless a new valid index is fully committed.
- Do not mark a job crashed solely because its heartbeat is old when `process.kill(pid, 0)` says the PID is alive.
- Do not introduce platform-specific PID start-time logic without isolated tests and a fallback for macOS/Linux differences.
- Do not clear review gate pending state from a stale fingerprint, wrong run id, or wrong worktree path.
- Do not recompute review fingerprints by scanning arbitrary worktree files inside `clearReviewGatePendingIfMatches()`.
- Do not manually edit generated `dist/` or plugin server bundles.

## 6. Test Plan

### `tests/artifact-index.test.ts`

Add or update these tests:

- `readArtifactIndex ignores stale temporary index files`
  - Writes a valid canonical `artifacts.json`.
  - Writes invalid `artifacts.json.tmp.leftover`.
  - Expects one valid canonical entry.

- `addArtifactEntry preserves existing index when index write fails`
  - Mocks or injects a failure in the write/rename path.
  - Expects no throw and original canonical index remains valid.

- `registerPatchArtifact skips missing patch file`
  - Calls `registerPatchArtifact()` with `patch_path` and `diff_sha256` for a missing file.
  - Expects zero entries.

- `registerVerificationArtifacts skips failed hash reads without indexing partial artifacts`
  - Uses a targeted fs mock or filesystem setup that makes one written artifact unreadable at hash time.
  - Expects successful sibling entries preserved and failed artifact absent.

Run:

```bash
npx vitest run tests/artifact-index.test.ts
```

Expected:

- All artifact-index tests pass.

### `tests/background-jobs.test.ts`

Add or update these tests:

- `recovery keeps stale running job active when pid is alive`
  - Uses `pid: process.pid` and stale heartbeat.
  - Expects no crash.

- `recovery documents pid reuse ambiguity as conservative`
  - Same behavior as above with explicit assertion and comment.

- `recovery marks stale running job with dead pid as crashed and dedupe ignores it`
  - Reuse existing helpers where possible.
  - Expects status `crashed` and a later enqueue with same fingerprint creates a new job.

Run:

```bash
npx vitest run tests/background-jobs.test.ts
```

Expected:

- Background job tests pass without relying on real Claude CLI.

### `tests/review-gate.test.ts`

Add or update these tests:

- `clearReviewGatePendingIfMatches keeps pending when reviewed fingerprint is stale after worktree mutation`
  - Enable gate.
  - Mark pending with `run_id`, `worktree_path`, and `fingerprint: "fp-current"`.
  - Clear with matching run/worktree but `reviewed_fingerprint: "fp-old"`.
  - Expects `fingerprint_mismatch` and pending state preserved.

- `clearReviewGatePendingIfMatches clears when run worktree and current fingerprint match`
  - Uses the same pending metadata.
  - Clears with exact metadata.
  - Expects pending state removed.

Run:

```bash
npx vitest run tests/review-gate.test.ts
```

Expected:

- Review gate tests pass.

### Final Verification

Run after implementation:

```bash
npm run typecheck
npm run audit:docs
npx vitest run tests/artifact-index.test.ts tests/background-jobs.test.ts tests/review-gate.test.ts
git diff --check
```

Run full `npm test` if any production code changes touch shared recovery behavior outside the above modules.

## 7. Documentation Consistency Check

Check:

- `docs/product/2026-05-30-handoff.md`
  - Mark `STATE-MACHINE-002` completed after tests pass.
  - Record the verification commands.

- `docs/product/2026-05-20-comprehensive-review.md`
  - Update only if production behavior changes, or if the status of a review-roadmap item becomes more precise.

- `README.md`
  - Update only if user-visible behavior changes.

Documentation must not claim strong PID reuse protection if implementation only documents conservative live-PID behavior.

## 8. Delivery Requirements

Implementation report must include:

- Files changed.
- Which acceptance cases are covered by which tests.
- Exact verification commands and results.
- Any production behavior left intentionally unchanged.
- Whether docs were updated.

Expected commit shape:

- One implementation commit, for example:

```bash
git commit -m "test: harden state-machine fault coverage"
```

- If docs are updated separately after commit hash recording, use:

```bash
git commit -m "docs: record state-machine fault coverage"
```

