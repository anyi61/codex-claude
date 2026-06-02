# Configuration Reference

This page collects setup and configuration details that are useful after the
quickstart path in `README.md`.

## Setup Options

```bash
codex-claude setup --write
codex-claude setup --write --allow-root "$(pwd)"
codex-claude setup --write --project
codex-claude setup --write --print
```

| Option | Use |
|--------|-----|
| `--force` | Replace an existing `claude_delegate` config after creating a timestamped backup. |
| `--allow-root <path>` | Add a repository root to global `CODEX_CLAUDE_ALLOW_ROOTS`. |
| `--project` | Write `./.codex/config.toml` instead of global Codex config. |
| `--print` | Print the config without writing it. |

`--project` and `--allow-root` target different configuration scopes. To use
both, first run `setup --write --allow-root <path>`, then run
`setup --write --project`.

## Print Config

```bash
codex-claude print-config
codex-claude print-config --source /path/to/repo
codex-claude print-config --project
```

## Allow Roots

Default allow roots are `~/projects`, `~/work`, and `~/codex-claude`.
If `CODEX_CLAUDE_ALLOW_ROOTS` is set, it replaces that default list.

```toml
# ~/.codex/config.toml
[shell_environment_policy.set]
CODEX_CLAUDE_ALLOW_ROOTS = "/Users/you/projects:/Users/you/work:/Users/you/my-repo"
```

Use concrete repository directories. Exact dangerous roots such as `/`, `/tmp`,
`/etc`, and `$HOME` are rejected.

## Environment Passthrough

Claude child processes run with a sanitized environment. The default forwarded
variables are:

```text
PATH, HOME, SHELL, LANG, LC_ALL, LC_CTYPE, TERM, USER,
TMPDIR, TEMP, TMP, NODE_ENV, HTTP_PROXY, HTTPS_PROXY, NO_PROXY, ANTHROPIC_BASE_URL
```

To allow additional non-secret variables:

```toml
# ~/.codex/config.toml
[shell_environment_policy.set]
CODEX_CLAUDE_ENV_PASSTHROUGH = "MY_ORG_API_URL,CI_PIPELINE_ID"
```

Names must match `[A-Za-z_][A-Za-z0-9_]*`. Names containing sensitive markers
such as `AUTH`, `COOKIE`, `SESSION`, `PRIVATE`, `KEY`, `SECRET`, `TOKEN`,
`CREDENTIAL`, `PASSWORD`, `API_KEY`, `DATABASE_URL`, or `DSN` are blocked.

`codex-claude doctor` reports counts and variable names for allowlisted,
passthrough, and blocked entries without exposing values.

## Environment File

A repository can define `.codex-claude-delegate/environment.json` to describe
local setup intent and narrow verification behavior.

```json
{
  "install": "npm ci",
  "test": "npm run typecheck",
  "start": "npm run dev",
  "symlink_directories": ["/absolute/cache/path"],
  "sparse_paths": ["src", "tests"],
  "verification": {
    "allowedScripts": ["typecheck", "lint", "test:unit"],
    "timeoutSec": 180
  },
  "artifacts": {
    "retentionDays": 30
  },
  "environment": {
    "passthrough": ["MY_CUSTOM_VAR", "NODE_OPTIONS"]
  }
}
```

| Field | Effect |
|-------|--------|
| `install`, `test`, `start` | Diagnostic only. These commands are displayed but not executed. |
| `symlink_directories`, `sparse_paths` | Diagnostic only. No symlinks or sparse checkouts are created. |
| `verification.allowedScripts` | Restricts `npm run`, `yarn run`, and `pnpm run` script names used by server-side verification. It does not expand the command allowlist. |
| `verification.timeoutSec` | Sets verification timeout, 10-300 seconds. |
| `artifacts.retentionDays` | Diagnostic only. |
| `environment.passthrough` | Diagnostic only. It does not change env forwarding. |

Forbidden script names such as `install`, `deploy`, `publish`, `start`,
`serve`, `add`, `remove`, and `uninstall` stay blocked.

## Local State Cleanup

```bash
codex-claude cleanup-artifacts
codex-claude cleanup-artifacts --dry-run --older-than-hours 24 --limit 50
codex-claude cleanup-artifacts --execute
```

`cleanup-artifacts` removes terminal background job records, old run logs, and
expired artifact-index entries only after `--execute`. Delegated worktrees are
cleaned separately with `claude_cleanup`.
