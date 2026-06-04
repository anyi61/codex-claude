# Contributing

This project is a TypeScript MCP server that delegates Codex work to Claude
Code. Keep changes small, explicit, and covered by the relevant verification
commands.

## Local Development

```bash
git clone https://github.com/anyi61/codex-claude.git
cd codex-claude
npm install
npm run build
npm test
```

Useful commands:

```bash
npm run dev
npm run typecheck
npm run test:watch
npm run build:plugin
npm run check:plugin
```

The plugin bundle lives under `plugins/codex-claude-delegate/`. Generated files
in `dist/` should come from `npm run build`.

## Documentation and Security Checks

```bash
npm run audit:docs
npm run security:grep
```

`security:grep` scans for sensitive implementation patterns such as shell
execution, environment access, and path-boundary operations. New matches should
be reviewed deliberately.

## Release Checklist

Start from a clean git state:

```bash
git status
```

Run the package release script:

```bash
npm run release
```

The release script bumps the version, syncs plugin metadata, runs
`prepublishOnly`, and publishes to npm.

Confirm registry and local package version:

```bash
npm view @anyi61/codex-claude-delegate-mcp version dist-tags.latest
node -p "require('./package.json').version"
```

Commit, tag, verify metadata, and push the release:

```bash
git add package.json package-lock.json plugins/codex-claude-delegate/.codex-plugin/plugin.json plugins/codex-claude-delegate/.claude-plugin/plugin.json
VERSION=$(node -p "require('./package.json').version")
git commit -m "chore: release v$VERSION"
git tag "v$VERSION"
npm run check:release:metadata
git push origin main --tags
git ls-remote --tags origin "v$VERSION"
```

`HANDOFF.md` is intentionally local-only and ignored in this repository.
