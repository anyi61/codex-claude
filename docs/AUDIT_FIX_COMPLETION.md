# Audit Fix Completion

Date: 2026-05-13

## Issue To Evidence Mapping

| Audit item | Status | Evidence |
|---|---|---|
| MCP metadata for default 5 tools | done | `src/server.ts` adds `title`, `annotations`, `outputSchema`, and `additionalProperties: false`; `tests/schema.test.ts` verifies default tool metadata. |
| `structuredContent` for success and error results | done | `src/schema.ts` updates `jsonResult()` and `errorResult()`; `tests/schema.test.ts` verifies text JSON compatibility and structured content. |
| Keep old text JSON compatibility | done | `jsonResult()` / `errorResult()` still emit text JSON; tests parse `content[0].text`. |
| Default tools remain exactly 5 | done | `src/codex-config.ts` keeps `DEFAULT_ENABLED_TOOLS`; schema tests assert the exact list and exclude `claude_job_wait`. |
| `claude_job_wait` stays Advanced / Recovery | done | Tool description remains Advanced / Recovery; README and doc audit enforce classification. |
| Block wait productization | done | `ClaudeWaitMetadata` added to task/wait results; tests verify completed and running `claude_task` metadata, continuation via `claude_task(job_id=...)`, and duplicate warning. |
| Progress notification | deferred with mitigation | Current handler does not receive a usable MCP progress token from this SDK path; structured wait metadata includes `progress_notifications="not_available"` and a reason. |
| Doctor timeout check | done | `scanClaudeDelegateConfig()` parses `tool_timeout_sec`; `doctor` flags values below 600; CLI tests cover too-low timeout. |
| Apply/cleanup/worktree locking | done | New `src/lock.ts`; apply and cleanup use stale-safe filesystem locks; JobStore updates use per-job lock. Tests cover lock contention, stale replacement, and concurrent job update preservation. |
| Doctor Problem/Fix/Next step | done | `src/cli.ts` emits `problems[]` JSON and human Problem/Fix/Next step blocks; CLI tests cover both. |
| Claude auth/availability | done | Doctor checks `claude --version`, tries conservative `claude auth status`, and reports `ok` / `missing` / `unknown` with confidence. Tests assert unknown is not falsely authenticated. |
| MCP launch/smoke | done | Doctor now runs a bounded local `codex-claude` MCP initialize smoke and reports failure as not ready; `tests/cli.test.ts` covers success/failure with a fake launcher. `tests/mcp-e2e.test.ts` still performs initialize/tools/list/tools/call over stdio with fake Claude. |
| Wrong command / missing enabled tools / allow roots | done | Existing and updated CLI tests cover wrong command, missing tools, missing enabled_tools, allow roots. |
| Fix `npm run audit:docs` | done | `scripts/audit-docs.mjs` replaces missing debug script and is wired in `package.json`; `tests/audit-docs.test.ts` covers stale default-6 docs, stale doctor `enabled_count: 6`, default `claude_job_wait`, and legacy polling claims; command passes. |
| Documentation consistency | done | README updated for non-official risk, Ready means, One Message To Codex, global install, `instruction_files` vs deprecated `files`, block wait recovery, Advanced `claude_job_wait`, and security profiles. Product PRD stale default-6 / `claude_job_wait` polling examples were updated to default 5 and `claude_task(job_id=...)`, including doctor JSON examples. Doc audit enforces current docs. |
| Security profile / remove default `npx *` | done | `security_profile` schema added; default and strict exclude `Bash(npx *)`, permissive includes it; tests cover all profiles. |
| Run/job log rotation | done | `cleanupDelegateArtifacts()` dry-runs/removes old terminal jobs and old run logs while excluding active job run logs; tests cover dry-run active exclusion. |
| E2E / CI | done | `tests/mcp-e2e.test.ts` added; `.github/workflows/ci.yml` runs install/build/typecheck/test/plugin/doc audit. |

## P0/P1/P2 Status

| Priority | Item | Status |
|---|---|---|
| P0 | MCP structured output and metadata | done |
| P0 | workspace/job locks | done |
| P0 | doc audit and default tool count consistency | done |
| P1 | block wait metadata / duplicate prevention / timeout doctor | done |
| P1 | doctor upgrade | done |
| P1 | security profile | done |
| P2 | run/job cleanup rotation | done |
| P2 | MCP E2E smoke + CI | done |
| Long-term | MCP Tasks adapter, realtime bridge, dashboard | deferred, intentionally not implemented |

## Modified Files

- `.github/workflows/ci.yml`
- `README.md`
- `package.json`
- `plugins/codex-claude-delegate/server/job-runner.js`
- `plugins/codex-claude-delegate/server/server.js`
- `scripts/audit-docs.mjs`
- `src/claude-cli.ts`
- `src/cli.ts`
- `src/codex-config.ts`
- `src/jobs.ts`
- `src/lock.ts`
- `src/schema.ts`
- `src/server.ts`
- `tests/claude-cli.test.ts`
- `tests/cli.test.ts`
- `tests/codex-config.test.ts`
- `tests/audit-docs.test.ts`
- `tests/jobs.test.ts`
- `tests/lock.test.ts`
- `tests/mcp-e2e.test.ts`
- `tests/schema.test.ts`
- `tests/server.test.ts`
- `docs/AUDIT_FIX_PLAN.md`
- `docs/AUDIT_FIX_COMPLETION.md`
- `docs/product/2026-05-09-installation-ux-prd.md`

Note: `docs/` is ignored by this repository's `.gitignore`, but the audit plan and completion files exist at the requested paths.

## Verification Results

Final verification results are recorded after the final command run:

| Command | Result |
|---|---|
| `npm run build` | pass, exit 0 |
| `npm run typecheck` | pass, exit 0 |
| `npm test` | pass, exit 0; 15 test files, 286 tests |
| `npm run build:plugin` | pass, exit 0 |
| `npm run check:plugin` | pass, exit 0; `check:plugin ok` |
| `npm run audit:docs` | pass, exit 0; `doc audit ok (9 files)` |
| E2E smoke | pass, included in `npm test` as `tests/mcp-e2e.test.ts` |

## Deferred / Not Applicable

- MCP progress notifications: deferred because the current SDK handler path used by this server does not expose a progress token to `handleToolCall`. The replacement evidence is structured wait metadata plus tests.
- Multi-provider routing, realtime channels, direct main-workspace writes, heavy resident services, and MCP Tasks adapter: not applicable to the current audit fix scope and explicitly forbidden or long-term.

## Final Confirmations

- Default tools are exactly `claude_setup`, `claude_task`, `claude_result`, `claude_apply`, `claude_cleanup`.
- `claude_job_wait` is not in the default enabled tools and remains Advanced / Recovery.
- `claude_task` keeps default block wait and `claude_task(job_id=...)` is the normal continuation path.
- `claude_apply preview=true` remains non-mutating.
- Non-preview `claude_apply` still requires `confirmed_by_user=true`.
- Advanced tools remain hidden from the default config.

## Follow-up Correction, 2026-05-16

- Fixed a stale product PRD doctor JSON example that still reported `"enabled_count": 6`.
- Added a regression audit fixture so future `enabled_count: 6` examples fail `npm run audit:docs`.
