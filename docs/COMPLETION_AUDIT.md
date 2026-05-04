# Completion Audit

Objective: complete the instructions in `goal.md` and move the MCP server from core functionality to engineering-quality acceptance without rewriting the project.

## Checklist

| Requirement | Evidence | Status |
|---|---|---|
| Initial commands run (`pwd`, branch, status, log, node/npm, build, test) | Commands were run. Build passed. Test initially had no script. | Partial |
| Read required files | `package.json`, `tsconfig.json`, `src/*`, `README.md`, `SPEC.md`, `CLAUDE.md`, `AGENTS.md` were inspected. | Done |
| Write current status to `docs/PROJECT_STATUS.md` | `docs/PROJECT_STATUS.md` exists and records branch, build/test state, dirty worktree, plan, and blockers. | Done |
| Do not rewrite project | Existing modules and CLI architecture are preserved. | Done |
| Add `.gitignore` entries | `.gitignore` includes `/dist/`, `*.tsbuildinfo`, `.claude/`, `.codex-claude-delegate/`, `node_modules/`, `coverage/`. | Done |
| Remove `dist` from git tracking | `git ls-files dist` still lists 15 files. `git rm --cached dist` fails because `.git/index.lock` cannot be created. | Blocked |
| Phase commits | `git add`/`git commit` fail because `.git/` is not writable in this sandbox. | Blocked |
| Install Vitest | `npm install -D vitest` fails with `EPERM` connecting to `127.0.0.1:7890`; offline install also fails. | Blocked |
| Add test scripts | `package.json` has `test`, `test:watch`, and `typecheck`. | Done |
| Add Vitest config | `vitest.config.ts` exists. | Done |
| Guard tests | `tests/guard.test.ts` covers allow roots, outside roots, symlink traversal, dangerous roots, file escape, env sanitization, recursion depth, and child depth. | Added, not runnable |
| Schema tests | `tests/schema.test.ts` covers JSON Schema fields/enums and zod input boundaries. | Added, not runnable |
| Claude CLI wrapper tests | `tests/claude-cli.test.ts` covers args arrays, read-only tools, implement write tools, dangerous disallowed tools, safe env, and truncation. | Added, not runnable |
| Standardize tool result envelope | `runClaudeQuery`, `runClaudeReview`, and `runClaudeImplement` return envelope-style objects with `status`, `execution`, and `warnings`; implement includes `claude_report` and `server_observed`. `claude_status`, `claude_apply`, and `claude_cleanup` keep their existing fields and append `execution`/`warnings`. | Done |
| Execution metadata | Claude spawn result includes `exit_code`, `duration_ms`, `timed_out`, truncated `stdout_tail`, redacted `stderr_tail`. | Done for Claude calls |
| Input schema validation | zod schemas exist and server handlers parse inputs before execution. | Done |
| Enrich git observed fields | `ServerObserved` includes `repo_root`, `worktree_name`, `git_status_short`, `base_commit`, and `head_commit`. | Done |
| Worktree cleanup docs | README documents dry-run cleanup, real cleanup, logs, and retained worktrees. | Done |
| README/docs update | README and `docs/DECISIONS.md` cover architecture, setup, tools, safety, tests, cleanup, logs, known limits, and decisions. | Partial |
| Final acceptance commands | `npm run build` and `npm run typecheck` pass. `npm test` fails because Vitest binary is unavailable. | Blocked |
| `dist` no longer pollutes git | `.gitignore` is updated, but tracked `dist` entries remain due to git-index write blocker. | Blocked |

## Current Verification

- `npm run build`: passing after local tool envelope update.
- `npm run typecheck`: passing after local tool envelope update.
- `npm test`: failing with `vitest: command not found`.
- `git status --short`: dirty worktree with source/docs/tests changes plus tracked `dist` changes.
- `.git` write probe: `touch .git/codex-write-test` fails with `Operation not permitted`.

## Required Environment Fixes

1. Allow writes to `.git/` so `git rm --cached dist`, staging, and commits can run.
2. Fix npm/network/cache permissions so `npm install` can install Vitest and regenerate `package-lock.json`.
3. After those fixes, run `npm install`, `npm run build`, `npm test`, `npm run typecheck`, remove tracked `dist`, and make the required phase commits.
