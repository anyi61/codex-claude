# Audit Fix Implementation Plan

## 1. Background And Goal

User goal: turn `docs/审查报告.md` into verified engineering fixes, not another review.

Current behavior:
- Default tools are already 5, but default tool definitions lack MCP `title`, `annotations`, and `outputSchema`.
- Tool calls return JSON text only; structured MCP clients cannot read `structuredContent`.
- `claude_task` already defaults to block wait, but results do not expose a stable wait metadata object and doctor does not verify `tool_timeout_sec >= 600`.
- `claude_apply` and `claude_cleanup` can operate on the same worktree concurrently.
- `codex-claude doctor` is useful but does not present Problem/Fix/Next step, auth confidence, timeout config, or launch smoke clearly enough.
- `npm run audit:docs` points at a missing script.
- Default implement permissions include `Bash(npx *)`.
- Job cleanup exists, but run log cleanup/rotation does not.
- There is no real MCP initialize/tools/list/tools/call smoke test or GitHub Actions workflow.

Target behavior:
- Default 5 tools remain exactly `claude_setup`, `claude_task`, `claude_result`, `claude_apply`, `claude_cleanup`.
- `claude_job_wait` remains Advanced / Recovery and is not in default enabled tools.
- Default tools expose MCP metadata and structured results while preserving text JSON.
- `claude_task` returns stable wait metadata that discourages duplicate starts and supports `claude_task(job_id=...)`.
- Apply/cleanup/worktree operations are serialized by stale-safe locks.
- Doctor produces clear human and JSON diagnostics for config, command, enabled tools, allow roots, timeout, Claude availability/auth confidence, and MCP launch smoke.
- Documentation, plugin skills, and doc audit agree with actual defaults and normal workflow.
- Default security posture is conservative, with strict/default/permissive profiles and no default `npx *`.
- Dry-run cleanup can report old runs/jobs without touching active jobs.
- CI and E2E smoke cover MCP protocol compatibility with fake Claude.

This plan does not implement multi-provider routing, Claude Code Channels, a realtime bridge, direct main-workspace writes by Claude, relaxed apply confirmation, or a resident dashboard/service.

## 2. File Impact Scope

`src/schema.ts`
- Add `structuredContent` to success and error tool results.
- Add wait metadata types.
- Add optional `security_profile` input validation.
- Keep text JSON output unchanged.

`src/server.ts`
- Add MCP metadata to the 5 default tools.
- Add `additionalProperties: false` to input schemas where Zod rejects extra fields, and keep manual schemas aligned with Zod.
- Keep `claude_job_wait` Advanced / Recovery only.

`src/claude-cli.ts`
- Add wait metadata to `claude_task` and `claude_job_wait` responses.
- Add security profile handling and remove `npx *` from default.
- Add lock usage around apply/cleanup and worktree lifecycle operations.
- Add run log cleanup helper.

`src/jobs.ts`
- Add per-job lock around read-modify-write updates.
- Ensure cleanup only targets terminal jobs.

`src/lock.ts`
- New stale-safe filesystem lock helper with atomic directory creation and stale lock replacement.

`src/cli.ts`, `src/codex-config.ts`
- Upgrade doctor result shape and output.
- Parse/check `tool_timeout_sec`.
- Add conservative Claude auth availability probe and MCP launch smoke status.
- Add CLI command for dry-run cleanup/rotation if needed.

`scripts/audit-docs.mjs`
- New doc audit script replacing missing `debug/doc-audit.ts`.

`tests/*.test.ts`
- Add focused tests for each changed behavior before implementation.
- Use fake filesystem/env/Claude; do not depend on real user config or real Claude.

`README.md`, `docs/product/*`, `plugins/codex-claude-delegate/skills/*.md`
- Align default tool count to 5.
- Document local execution risk, Ready means, One Message To Codex, `instruction_files` vs deprecated `files`, global install as main path, block wait recovery, Advanced / Recovery `claude_job_wait`, and security profiles.

`.github/workflows/ci.yml`
- New CI workflow.

Do not manually edit `dist/`. Plugin bundled server files may change only through `npm run build:plugin`.

## 3. Positive Acceptance Cases

- `tools/list` returns the default tools with `title`, `annotations`, and `outputSchema`; default enabled tools remain exactly 5.
- A successful `claude_setup`, `claude_task`, `claude_result`, `claude_apply`, or `claude_cleanup` call has both JSON text content and identical `structuredContent`.
- A validation or runtime error has `isError: true`, JSON text content, and matching `structuredContent`.
- `claude_task` without `wait_strategy` reports `wait.mode = "block"`, `wait.timeout_sec = 540`, and either `completed_inline=true` or `waiting=true` with `do_not_start_duplicate_job=true`.
- `claude_task(job_id=...)` waits on the existing job without creating a duplicate.
- Concurrent apply/cleanup targeting the same worktree cannot both mutate it; one waits or receives a lock-busy result.
- Stale locks older than the configured threshold are replaced.
- `doctor --json` reports config path, command, enabled tools, allow roots, tool timeout, Claude availability, auth status/confidence, MCP launch smoke, problems, fixes, next steps, and ready meaning.
- `npm run audit:docs` exits 0 after docs are aligned.
- Default implement options do not include `Bash(npx *)`; permissive profile can include it explicitly.
- Cleanup/rotation dry-run lists old terminal jobs/runs and excludes active jobs.
- MCP E2E smoke initializes the server, lists tools, and calls a default tool using fake `CLAUDE_BIN`.

## 4. Negative Acceptance Cases

- `claude_job_wait` must not appear in `DEFAULT_ENABLED_TOOLS`.
- `claude_apply preview=true` must not modify the main workspace.
- Non-preview `claude_apply` without `confirmed_by_user=true` must remain refused.
- Missing implement metadata must keep apply fail-closed.
- Unknown input properties must be rejected for strict Zod schemas and reflected in JSON schema.
- A wrong MCP command such as `npx` must make doctor not ready and produce a concrete fix.
- Missing `enabled_tools` must be diagnosed, not silently treated as ready.
- `tool_timeout_sec < 600` must be diagnosed because it cannot cover the default 540 second wait window plus buffer.
- Claude auth that cannot be proven must be `unknown`, not falsely reported as ok.
- Cleanup must not delete queued/running jobs or active worktrees.
- Strict/default security profiles must not allow remote package execution paths such as `npx *`.

## 5. Forbidden Behaviors

- Do not add providers.
- Do not add realtime channels or an agent bridge.
- Do not let Claude write directly to the main workspace.
- Do not weaken preview/apply confirmation.
- Do not expose all Advanced tools by default.
- Do not revert default block wait to short polling.
- Do not introduce a heavy resident background service.
- Do not redefine deprecated `claude_task.files` as strict apply scope.
- Do not make npx the main installation path.
- Do not hand-edit generated `dist/`.

## 6. Test Plan

`tests/schema.test.ts`
- `jsonResult returns text JSON and structuredContent`
- `errorResult returns structuredContent with isError`
- `claude_task rejects unknown security_profile values`

`tests/server.test.ts`
- `default MCP tools expose title annotations outputSchema`
- `default tool input schemas use additionalProperties false`
- `claude_job_wait remains advanced and outside DEFAULT_ENABLED_TOOLS`
- `tool result structuredContent matches text payload`

`tests/job-wait.test.ts`
- `claude_task default block wait includes wait metadata`
- `claude_task job_id continuation includes wait metadata and duplicate warning`

`tests/claude-cli.test.ts`
- `default implement security profile excludes npx`
- `permissive implement security profile includes npx`
- `apply operations serialize by worktree lock`
- `cleanup operations serialize by workspace lock`
- `stale lock is replaced`
- `run cleanup dry-run excludes active job artifacts`

`tests/jobs.test.ts`
- `job update preserves concurrent patches under per-job lock`
- `job cleanup skips active jobs`

`tests/cli.test.ts`
- `doctor reports Problem/Fix/Next step in human output`
- `doctor --json reports wrong command`
- `doctor --json reports missing enabled_tools`
- `doctor --json reports too-low tool_timeout_sec`
- `doctor --json reports Claude auth unknown conservatively`
- `doctor --json reports MCP smoke result`

`tests/mcp-e2e.test.ts`
- `server handles initialize tools/list and tools/call using fake CLAUDE_BIN`

`npm run audit:docs`
- Verifies docs contain 5 default tools, do not claim 6 defaults, classify `claude_job_wait` as Advanced / Recovery, and keep README required sections.

## 7. Documentation Consistency Checks

- README claims about doctor must match the actual `DoctorResult` shape.
- README must say global install is the supported main path and explain why `npx` is not recommended.
- README must highlight `instruction_files` for plan/task files and keep `files` deprecated/context-only.
- Plugin skills must route normal users to `claude_task`, not low-level Advanced tools.
- Any mention of default tools must list exactly the current 5.

## 8. Delivery Requirements

Before completion, create/update `docs/AUDIT_FIX_COMPLETION.md` with:
- Audit issue to fix evidence mapping.
- P0/P1/P2 status: done/deferred/not applicable.
- Modified file list.
- Verification command results.
- Deferred items and reasons.
- Final confirmation of default 5 tools, block wait, apply preview, confirmed apply, and Advanced tools hiding.

Required final verification:
- `npm run build`
- `npm run typecheck`
- `npm test`
- `npm run build:plugin`
- `npm run check:plugin`
- `npm run audit:docs`
- E2E smoke command if not included in `npm test`
