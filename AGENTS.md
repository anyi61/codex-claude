# Repository Guidelines

## Project Structure & Module Organization
This repository implements `codex-claude-delegate-mcp`, a TypeScript MCP server that lets Codex delegate work to Claude Code.

- `src/server.ts`: MCP stdio server, tool registration, and request dispatch.
- `src/claude-cli.ts`: Claude CLI spawning and result collection.
- `src/guard.ts`: cwd allowlist checks, environment sanitization, and recursion protection.
- `src/schema.ts`: shared types, JSON result helpers, and prompt/schema definitions.
- `debug/`: ad hoc TypeScript scripts for MCP and implementation-flow checks.
- `dist/`: generated build output. Do not hand-edit; regenerate with `npm run build`.
- `README.md`, `SPEC.md`, `CLAUDE.md`: user docs, implementation spec, and agent-oriented project notes.

## Build, Test, and Development Commands

- `npm install`: install runtime and TypeScript tooling dependencies.
- `npm run dev`: run the MCP server from `src/server.ts` with `tsx` for local development.
- `npm run build`: compile strict TypeScript into `dist/`, including declarations and source maps.
- `npm start`: run the compiled server from `dist/server.js`.
- `npx tsx debug/mcp-test.ts`: run the debug MCP smoke script when validating tool behavior.
- `npx tsx debug/test-implement.ts`: exercise the implementation delegation path.

## Coding Style & Naming Conventions
Use TypeScript ES modules with explicit `.js` extensions in relative imports, matching Node16 module resolution. Keep `strict` TypeScript clean and prefer typed result objects over loosely shaped JSON. Use two-space indentation, double quotes, semicolons, and `camelCase` for variables/functions. Use `PascalCase` for exported types and classes. Keep security-sensitive checks centralized in `guard.ts` rather than duplicating policy in handlers.

## Testing Guidelines
There is no formal test runner configured yet. Treat `npm run build` as the required baseline check before submitting changes. For behavior changes, add or update a targeted script under `debug/` and document the exact command used. Name debug scripts by scenario, for example `debug/test-worktree.ts` or `debug/mcp-status.ts`.

## Commit & Pull Request Guidelines
Recent history uses Conventional Commits: `feat: ...`, `fix: ...`, and `docs: ...`. Keep commit subjects imperative and scoped to one logical change. Pull requests should include a short problem statement, summary of changes, verification commands run, linked issue if applicable, and any security implications for subprocess execution, allowed roots, worktrees, or environment handling.

## Security & Configuration Tips
Do not pass secrets to Claude subprocesses. Preserve environment sanitization, dangerous-command blocking, and `BRIDGE_DEPTH` recursion protection. Configure allowed roots with `CODEX_CLAUDE_ALLOW_ROOTS` instead of hard-coding local paths when possible.
