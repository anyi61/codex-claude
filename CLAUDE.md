# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

MCP server that lets Codex CLI delegate tasks to Claude Code. Codex calls MCP tools exposed by this server; the server spawns `claude -p` with security constraints and returns structured results.

Phase 1 (one-shot delegation + worktree isolation) and Phase 2 (session reuse) complete. Codex config at `~/.codex/config.toml` (`[mcp_servers.claude_delegate]`). Codex skill at `.agents/skills/claude-delegate.md`. Full spec at `SPEC.md`.

Session strategy: query auto-resumes recent sessions, review uses `--no-session-persistence`, implement only resumes on explicit `session_key`.

## Commands

```bash
npm run build          # Compile TypeScript (tsc)
npm run dev            # Run directly via tsx (no build step)
npm start              # Run compiled output (node dist/server.js)
```

## Architecture

Five modules in `src/`:

- **server.ts** — MCP stdio entry point. Registers 4 tools, routes calls, rejects on `BRIDGE_DEPTH >= 2`.
- **claude-cli.ts** — Spawns `claude -p` with mode-specific args and schemas. `runClaudeQuery` (QUERY_SCHEMA, auto-resume, maxTurns=4), `runClaudeReview` (REVIEW_SCHEMA, `--no-session-persistence`, maxTurns=10), `runClaudeImplement` (IMPLEMENT_SCHEMA, worktree, explicit `session_key`, maxTurns=15). `observeResult()` ground-truths with `git diff` + `git status --short`. Non-zero exit codes that produce valid stdout JSON are still resolved (handles `error_max_turns`).
- **session.ts** — `SessionStore` class with atomic `sessions.json` read/write, `getRecent` (20-min window), `upsert`, `markExpired`, `prune`.
- **guard.ts** — Security: `validateCwd` (realpath + allowRoots + git check), `sanitizeEnv` (strips secrets, sets BRIDGE_DEPTH=1), `checkRecursion`, `execCapture` / `execStream` (safe spawn helpers). ALLOW_ROOTS is hardcoded to `~/projects`, `~/work`, `~/codex-claude`.
- **schema.ts** — Three JSON Schemas (`QUERY_SCHEMA`, `REVIEW_SCHEMA`, `IMPLEMENT_SCHEMA`), TypeScript interfaces, `SessionLog` type, and prompt builders with anti-delegation constraints.

## Debug harness

```bash
npx tsx debug/mcp-test.ts        # Full MCP protocol test: init → status → query
npx tsx debug/test-implement.ts  # Isolated implement test with worktree
```

Run logs appear in `.codex-claude-delegate/runs/<uuid>.json`.

## Critical rules when editing this codebase

### stdout is reserved for MCP protocol

This is a stdio MCP server. `console.log` / `process.stdout.write` will corrupt the JSON-RPC stream and break the Codex ↔ MCP connection. All logging MUST go to `process.stderr` or to files under `.codex-claude-delegate/runs/`.

### Never use shell string concatenation to spawn claude

```ts
// WRONG — command injection risk
exec(`claude -p -w ${name} "${prompt}"`)

// CORRECT
spawn("claude", ["-p", "-w", name, prompt])
```

### --tools vs --allowedTools vs --disallowedTools are distinct

- `--tools` — hard tool allowlist (Claude can't even see tools not listed)
- `--allowedTools` — auto-approve list (no permission prompt in non-interactive mode)
- `--disallowedTools` — hard block (removed from context entirely)

The `claude -p` non-interactive mode needs all three: `--tools` to restrict capability, `--allowedTools` so Claude can actually use them without hanging, `--disallowedTools` to hard-block dangerous patterns. Always pair with `--permission-mode dontAsk`.

### Environment must be sanitized before spawning Claude

`sanitizeEnv()` in guard.ts is the canonical implementation. Any new spawn path must use it. Sensitive vars (API keys, tokens, SSH agent) must never leak into the Claude subprocess.

### BRIDGE_DEPTH must be propagated

Every spawn of Claude must pass `BRIDGE_DEPTH` incremented by 1 via `sanitizeEnv()`. The MCP server refuses to start at depth ≥ 2. This prevents Codex → Claude → Codex → … loops.

### cwd must be validated

Always call `validateCwd()` before operating on user-supplied paths. It resolves symlinks, checks allowRoots, and for `claude_implement` confirms the path is inside a git repo (required for `--worktree`).

### --json-schema must be the last flag before the prompt

The Claude CLI has a parsing quirk: `--json-schema` consumes all subsequent arguments as its value unless it is placed as the last flag before the positional prompt. The arg order in `spawnClaude` must be:

```
-p -w <name> --permission-mode dontAsk --tools ... --max-turns ... --output-format json
  --allowedTools ... --disallowedTools ... --json-schema <schema> <prompt>
```

If `--json-schema` is placed before `--allowedTools` or `--disallowedTools`, the CLI reports "Input must be provided either through stdin or as a prompt argument".
