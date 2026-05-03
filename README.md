# codex-claude-delegate-mcp

MCP server that lets Codex CLI delegate tasks to Claude Code.

**Phase 1: One-shot task delegation.** Codex plans, Claude executes in an isolated worktree, Codex reviews the result.

## How it works

```
Codex CLI plans a task
  -> calls MCP tool (claude_query / claude_review / claude_implement)
    -> MCP server spawns `claude -p` with security constraints
      -> Claude runs in an isolated git worktree (implement) or read-only mode
        -> structured result returned to Codex
```

## Tools

| Tool | Mode | Modifies Files | Uses Worktree |
|---|---|---|---|
| `claude_status` | Read-only | No | No |
| `claude_query` | Read-only | No | No |
| `claude_review` | Read-only | No | No |
| `claude_implement` | Full agent | Yes (in worktree) | Yes |

## Setup

### 1. Prerequisites

- Node.js >= 20
- Claude Code CLI installed (`claude` in PATH)
- Codex CLI installed
- Git repository (required for `claude_implement`)

### 2. Install

```bash
cd /path/to/codex-claude-delegate-mcp
npm install
npm run build
```

### 3. Configure Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.claude_delegate]
command = "node"
args = ["/path/to/codex-claude-delegate-mcp/dist/server.js"]
tool_timeout_sec = 600
startup_timeout_sec = 20
enabled_tools = ["claude_status", "claude_query", "claude_review", "claude_implement"]
```

### 4. Configure allowed roots

Set the `ALLOW_ROOTS` env var or edit `src/guard.ts`:

```bash
export CODEX_CLAUDE_ALLOW_ROOTS="/Users/you/projects:/Users/you/work"
```

By default, `~/projects`, `~/work`, and the install directory are allowed.

### 5. Verify

In Codex:

```
/claude_status
```

## Security

- `--tools` restricts which tools Claude can access
- `--allowedTools` pre-approves safe commands (no permission prompts in non-interactive mode)
- `--disallowedTools` hard-blocks dangerous commands (rm, sudo, curl, git push, etc.)
- `--permission-mode dontAsk` auto-denies any unapproved tool call
- `--worktree` isolates file changes from the main working tree
- `BRIDGE_DEPTH` prevents recursive delegation loops
- Environment variables are sanitized — secrets are not passed to Claude subprocesses
- `cwd` is validated against an allowlist with realpath resolution to prevent path traversal
- Server-side git diff observation verifies Claude's self-reported changes

## Architecture

```
src/
├── server.ts       # MCP server entry point (stdio transport)
├── claude-cli.ts   # Claude CLI spawn wrapper
├── guard.ts        # Security: cwd validation, env sanitization, recursion guard
└── schema.ts       # Types, JSON schemas, prompt builders
```

## Development

```bash
npm run dev    # Run with tsx (no build step)
npm run build  # Compile TypeScript
npm start      # Run compiled output
```
