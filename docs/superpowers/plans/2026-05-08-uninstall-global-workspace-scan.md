# Uninstall Global Workspace Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npm run uninstall:dry-run` and `npm run uninstall` model uninstall as two subjects: global Codex/plugin configuration and every known setup workspace, so uninstall scans all relevant repositories instead of only the current repository.

**Architecture:** Keep `scripts/uninstall-plugin.mjs` as the orchestration entrypoint, but make the scan result explicit: `globalResources` for Codex/plugin config and `workspaceResources` for every discovered workspace. Workspace discovery is deterministic and bounded: it uses configured allow roots, environment allow roots, repo-local state records, and one-level state-directory discovery under explicitly configured roots; it never recursively scans the whole filesystem. Destructive behavior remains conservative: global Codex config is cleaned by uninstall, workspace state follows existing `--keep-state` behavior across all known workspaces, and delegated worktrees are reported only unless users explicitly run `claude_cleanup` or manual git cleanup per workspace.

**Tech Stack:** Node.js ESM script, TypeScript/Vitest tests, Codex config TOML helpers, filesystem scanning with `node:fs/promises`, path handling with `node:path`.

---

## Agreement From Claude Review

Claude reviewed the first draft via `claude_task` job `job-2d76c2bb-4b35-4cca-ba6f-122a6b3f728c`. This revision incorporates the critical and high-severity feedback:

- Include every discovered workspace in `workspaceResources`, even if it currently has no state directory or worktree.
- Add safety tests for dangerous scan roots such as `/`, `/tmp`, `/etc`, and `$HOME`.
- Make `dangerousScanRoot()` self-contained by resolving paths internally.
- Continue scanning one level below an allow root even when the root itself is also a workspace.
- Add `stateExists` to workspace resource records so output does not imply a missing state directory exists.
- Remove the now-orphaned `scanDelegatedWorktrees()` helper after `scanWorkspaceResources()` owns worktree discovery.
- Add non-dry-run tests for multi-workspace state cleanup.
- Add direct-child workspace discovery tests.
- Cover both `[mcp_servers.claude_delegate.env]` and `[shell_environment_policy.set]` allow-root cleanup paths.

## Assumptions And Decisions

- `setup workspace` means a workspace has been added to `CODEX_CLAUDE_ALLOW_ROOTS`, contains `.codex-claude-delegate/`, or is referenced by a state JSON record created by this MCP.
- All discovered workspaces must be shown in dry-run output, even if no workspace-local resources are currently present, because their allow-root config may still need removal.
- The script may inspect explicitly configured allow roots and their direct child directories only. It must not recursively scan arbitrary parent trees.
- Dangerous broad roots are ignored as scan roots: `/`, `/etc`, `/tmp`, and the exact user home directory. The script may still handle a specific subdirectory under home, such as `/Users/you/project`.
- Global Codex/plugin config is cleaned once per uninstall run.
- Workspace-local `.codex-claude-delegate/` cleanup applies to each known workspace using the existing `--keep-state` semantics.
- Delegated worktrees are never removed by uninstall. The script reports absolute paths and instructs users to run `claude_cleanup(cwd="...", dry_run=true)` then `dry_run=false` for each workspace after inspection. If the MCP is no longer available, users can remove worktrees manually with `git worktree remove` from the owning repository.
- `dry-run` must remain side-effect free and must work before `dist/` exists.

## Files To Modify

- Modify: `scripts/uninstall-plugin.mjs`
  - Add explicit global/workspace scan data structures.
  - Replace current single-repo state/worktree scan with bounded workspace discovery and per-workspace resource scanning.
  - Remove `scanDelegatedWorktrees()` after its logic moves into `scanWorkspaceResources()`.
  - Update TOML allow-root cleanup to remove every discovered workspace root, not only `repoRoot`.
  - Update state handling to iterate all workspace resources.
  - Update output and summary wording to distinguish global resources from workspace resources.
- Modify: `tests/uninstall-plugin.test.ts`
  - Add tests for grouped dry-run output.
  - Add tests for dangerous-root filtering.
  - Add tests for one-level child workspace discovery under configured allow roots.
  - Add tests for multi-root allow-root cleanup in both MCP env and shell env config locations.
  - Add tests for multi-workspace state cleanup and non-destructive worktree reporting.
- Modify: `README.md`
  - Document the two-subject uninstall model and per-workspace worktree cleanup guidance.
- Modify: `docs/development-overview.md`
  - Document workspace discovery sources, bounded scan limits, and non-destructive worktree behavior.

## Target Data Shape

Use plain objects in `scripts/uninstall-plugin.mjs`:

```js
const globalResources = {
  configScan,
  marketplaceName,
  hookInstalled,
  hookManifest,
};

const workspaceResource = {
  workspace,
  stateDir,
  stateExists,
  stateItems,
  delegatedWorktrees,
};
```

`scanResources()` should return:

```js
return {
  configScan,
  marketplaceName,
  hookInstalled,
  globalResources,
  workspaceResources,
  delegatedWorktrees: workspaceResources.flatMap((workspace) => workspace.delegatedWorktrees),
};
```

Compatibility fields `stateDir` and `stateItems` should be removed from new phase code. If a legacy helper still needs them during the refactor, remove that fallback before final verification.

## Target Dry-Run Output

```text
[scan] Scanning resources...

  Global resources:
    Config:      /Users/you/.codex/config.toml
    Allow roots: /repo-a:/repo-b
    MCP origin:  auto
    Marketplace: codex-claude-delegate
    Hooks:       /plugin/hooks/hooks.json

  Workspace resources:
    - /repo-a
      State dir: /repo-a/.codex-claude-delegate (4 items)
        - sessions.json
        - jobs
        - runs
        - review-gate.json
      Worktrees:
        - /repo-a/.claude/worktrees/codex-delegated-aaa
    - /repo-b
      State dir: (not found)
      Worktrees: (none detected)
```

## Target Non-Dry-Run Behavior

```text
[phase] Cleaning Codex TOML remainders...
  Removed /repo-a from CODEX_CLAUDE_ALLOW_ROOTS.
  Removed /repo-b from CODEX_CLAUDE_ALLOW_ROOTS.

[phase] Handling workspace state directories...
  Workspace: /repo-a
  --yes mode: keeping all state files.
  Workspace: /repo-b
  State directory does not exist; nothing to clean.

[phase] Checking delegated worktrees...
  Found 1 delegated worktree(s):
    /repo-a/.claude/worktrees/codex-delegated-aaa
  These are not automatically deleted.
```

---

## Task 1: Add Multi-Workspace Dry-Run Test

**Files:**
- Modify: `tests/uninstall-plugin.test.ts`

- [ ] **Step 1: Add failing test for grouped global/workspace output**

Add this test under `describe("output messages", ...)`:

```ts
it("groups dry-run resources by global config and known workspaces", async () => {
  const repoA = repoRoot;
  const repoB = path.join(tmpDir, "repo-b");
  const repoC = path.join(tmpDir, "repo-c");

  await mkdir(path.join(repoA, ".claude", "worktrees", "codex-delegated-a"), { recursive: true });
  await mkdir(path.join(repoB, ".codex-claude-delegate", "runs"), { recursive: true });
  await writeFile(
    path.join(repoB, ".codex-claude-delegate", "runs", "run-b.json"),
    JSON.stringify({ type: "implement", input: { cwd: repoB }, observed: { worktree_path: ".claude/worktrees/codex-delegated-b" } }),
    "utf8",
  );
  await mkdir(path.join(repoB, ".claude", "worktrees", "codex-delegated-b"), { recursive: true });
  await mkdir(path.join(repoC, ".codex-claude-delegate"), { recursive: true });
  await writeFile(path.join(repoC, ".codex-claude-delegate", "review-gate.json"), JSON.stringify({ workspace_root: repoC, enabled: true }), "utf8");

  const configPath = path.join(codexHome, "config.toml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, [
    "[mcp_servers.claude_delegate]",
    'command = "node"',
    'args = ["./server/server.js"]',
    "",
    "[mcp_servers.claude_delegate.env]",
    `CODEX_CLAUDE_ALLOW_ROOTS = "${repoA}:${repoB}:${repoC}"`,
    "",
  ].join("\n"), "utf8");

  const { stdout, exitCode } = runScript(["--dry-run"], {
    CODEX_HOME: codexHome,
    CODEX_UNINSTALL_REPO_ROOT: repoA,
  });

  expect(exitCode).toBe(0);
  expect(stdout).toContain("Global resources:");
  expect(stdout).toContain("Workspace resources:");
  expect(stdout).toContain(repoA);
  expect(stdout).toContain(repoB);
  expect(stdout).toContain(repoC);
  expect(stdout).toContain(path.join(repoA, ".claude", "worktrees", "codex-delegated-a"));
  expect(stdout).toContain(path.join(repoB, ".claude", "worktrees", "codex-delegated-b"));
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
npx vitest run tests/uninstall-plugin.test.ts -t "groups dry-run resources"
```

Expected: FAIL before implementation because output is not yet grouped by global/workspace resources.

---

## Task 2: Add Bounded Workspace Discovery

**Files:**
- Modify: `scripts/uninstall-plugin.mjs`
- Modify: `tests/uninstall-plugin.test.ts`

- [ ] **Step 1: Add failing test for dangerous-root filtering**

Add this dry-run test:

```ts
it("ignores dangerous broad allow roots during workspace discovery", async () => {
  const configPath = path.join(codexHome, "config.toml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, [
    "[mcp_servers.claude_delegate.env]",
    `CODEX_CLAUDE_ALLOW_ROOTS = "/:/tmp:/etc:${process.env.HOME ?? os.homedir()}:${repoRoot}"`,
    "",
  ].join("\n"), "utf8");

  const { stdout, exitCode } = runScript(["--dry-run"], {
    CODEX_HOME: codexHome,
    CODEX_UNINSTALL_REPO_ROOT: repoRoot,
    HOME: process.env.HOME ?? os.homedir(),
  });

  expect(exitCode).toBe(0);
  expect(stdout).toContain(repoRoot);
  expect(stdout).not.toContain("    - /");
  expect(stdout).not.toContain("    - /tmp");
  expect(stdout).not.toContain("    - /etc");
});
```

- [ ] **Step 2: Add failing test for direct-child workspace discovery**

Add:

```ts
it("discovers direct child workspaces under configured allow roots", async () => {
  const projectsRoot = path.join(tmpDir, "projects");
  const childRepo = path.join(projectsRoot, "child-repo");
  await mkdir(path.join(childRepo, ".codex-claude-delegate", "runs"), { recursive: true });
  await writeFile(path.join(childRepo, ".codex-claude-delegate", "runs", "child.json"), JSON.stringify({ input: { cwd: childRepo } }), "utf8");

  const configPath = path.join(codexHome, "config.toml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, [
    "[mcp_servers.claude_delegate.env]",
    `CODEX_CLAUDE_ALLOW_ROOTS = "${projectsRoot}"`,
    "",
  ].join("\n"), "utf8");

  const { stdout } = runScript(["--dry-run"], {
    CODEX_HOME: codexHome,
    CODEX_UNINSTALL_REPO_ROOT: repoRoot,
  });

  expect(stdout).toContain(childRepo);
  expect(stdout).toContain("child.json");
});
```

- [ ] **Step 3: Implement self-contained dangerous root guard and discovery helpers**

In `scripts/uninstall-plugin.mjs`, replace the current workspace discovery helpers with:

```js
function dangerousScanRoot(rawPath) {
  const resolved = path.resolve(rawPath);
  const home = process.env.HOME ? path.resolve(process.env.HOME) : "";
  return resolved === "/" || resolved === "/etc" || resolved === "/tmp" || (!!home && resolved === home);
}

function addCandidateWorkspace(candidates, rawPath) {
  if (!rawPath || typeof rawPath !== "string") return;
  const resolved = path.resolve(rawPath);
  if (dangerousScanRoot(resolved)) return;
  candidates.add(resolved);
}

async function addWorkspaceCandidatesFromJsonFile(candidates, filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    addCandidateWorkspace(candidates, parsed?.cwd);
    addCandidateWorkspace(candidates, parsed?.input?.cwd);
    addCandidateWorkspace(candidates, parsed?.workspace_root);
    addCandidateWorkspace(candidates, parsed?.repo_root);
  } catch {
    // Ignore malformed or concurrently written state files.
  }
}

async function discoverStateDirsUnderRoot(rawRoot) {
  const root = path.resolve(rawRoot);
  if (dangerousScanRoot(root)) return [];

  const discovered = [];
  if (existsSync(path.join(root, STATE_DIR_NAME))) {
    discovered.push(root);
  }

  let children = [];
  try {
    children = await readdir(root, { withFileTypes: true });
  } catch {
    return discovered;
  }

  for (const child of children) {
    if (!child.isDirectory()) continue;
    const workspace = path.join(root, child.name);
    if (existsSync(path.join(workspace, STATE_DIR_NAME))) {
      discovered.push(workspace);
    }
  }

  return discovered;
}

async function discoverWorkspaceCandidates(configScan, rootStateDir) {
  const candidates = new Set();
  addCandidateWorkspace(candidates, repoRoot);

  const allowRoots = [];
  if (configScan.allowRootsValue) allowRoots.push(...splitAllowRootsValue(configScan.allowRootsValue));
  if (process.env.CODEX_CLAUDE_ALLOW_ROOTS) allowRoots.push(...splitAllowRootsValue(process.env.CODEX_CLAUDE_ALLOW_ROOTS));

  for (const root of allowRoots) {
    addCandidateWorkspace(candidates, root);
    for (const workspace of await discoverStateDirsUnderRoot(root)) {
      addCandidateWorkspace(candidates, workspace);
    }
  }

  const jobsDir = path.join(rootStateDir, "jobs");
  try {
    const jobs = await readdir(jobsDir);
    await Promise.all(jobs.filter((name) => name.endsWith(".json")).map((name) => addWorkspaceCandidatesFromJsonFile(candidates, path.join(jobsDir, name))));
  } catch {}

  const runsDir = path.join(rootStateDir, "runs");
  try {
    const runs = await readdir(runsDir);
    await Promise.all(runs.filter((name) => name.endsWith(".json")).map((name) => addWorkspaceCandidatesFromJsonFile(candidates, path.join(runsDir, name))));
  } catch {}

  await addWorkspaceCandidatesFromJsonFile(candidates, path.join(rootStateDir, "review-gate.json"));
  return [...candidates].sort();
}
```

Do not add unused helpers.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npx vitest run tests/uninstall-plugin.test.ts -t "dangerous broad allow roots|direct child workspaces"
```

Expected: FAIL until Task 3 groups and prints every workspace, then PASS.

---

## Task 3: Split Scan Into Global And Workspace Resources

**Files:**
- Modify: `scripts/uninstall-plugin.mjs`
- Test: `tests/uninstall-plugin.test.ts`

- [ ] **Step 1: Add `scanWorkspaceResources()`**

Add:

```js
async function scanWorkspaceResources(configScan, rootStateDir) {
  const workspaces = await discoverWorkspaceCandidates(configScan, rootStateDir);
  const resources = [];

  for (const workspace of workspaces) {
    const stateDir = path.join(workspace, STATE_DIR_NAME);
    const stateExists = existsSync(stateDir);
    let stateItems = [];
    if (stateExists) {
      try {
        stateItems = await readdir(stateDir);
      } catch {}
    }

    const worktreesDir = path.join(workspace, ".claude", "worktrees");
    const delegatedWorktrees = [];
    if (existsSync(worktreesDir)) {
      try {
        const entries = await readdir(worktreesDir);
        for (const name of entries.filter((entry) => entry.startsWith("codex-delegated-")).sort()) {
          delegatedWorktrees.push({ workspace, name, path: path.join(worktreesDir, name) });
        }
      } catch {}
    }

    resources.push({ workspace, stateDir, stateExists, stateItems, delegatedWorktrees });
  }

  return resources;
}
```

This intentionally pushes every discovered workspace, including workspaces with no state and no worktrees.

- [ ] **Step 2: Remove old `scanDelegatedWorktrees()`**

Delete the old `scanDelegatedWorktrees(configScan, stateDir)` helper after `scanWorkspaceResources()` is wired into `scanResources()`.

- [ ] **Step 3: Update `scanResources()` output**

In `scanResources()`, compute:

```js
const rootStateDir = path.join(repoRoot, STATE_DIR_NAME);
const workspaceResources = await scanWorkspaceResources(configScan, rootStateDir);
const delegatedWorktrees = workspaceResources.flatMap((workspace) => workspace.delegatedWorktrees);
const globalResources = { configScan, marketplaceName, hookInstalled, hookManifest };
```

Print global resources:

```js
console.log(`  Global resources:`);
console.log(`    Config:      ${configScan.exists ? configScan.configPath : "(not found)"}`);
if (configScan.hasAllowRoots) console.log(`    Allow roots: ${configScan.allowRootsValue}`);
if (configScan.mcpClassification) console.log(`    MCP origin:  ${configScan.mcpClassification.origin}`);
console.log(`    Marketplace: ${marketplaceName ?? "(not detected)"}`);
console.log(`    Hooks:       ${hookInstalled ? hookManifest : "(not found)"}`);
```

Print workspace resources:

```js
console.log(`\n  Workspace resources:`);
for (const workspace of workspaceResources) {
  console.log(`    - ${workspace.workspace}`);
  if (workspace.stateExists) {
    console.log(`      State dir: ${workspace.stateDir} (${workspace.stateItems.length} items)`);
    for (const item of workspace.stateItems) console.log(`        - ${item}`);
  } else {
    console.log(`      State dir: (not found)`);
  }
  if (workspace.delegatedWorktrees.length > 0) {
    console.log(`      Worktrees:`);
    for (const wt of workspace.delegatedWorktrees) console.log(`        - ${wt.path}`);
  } else {
    console.log(`      Worktrees: (none detected)`);
  }
}
```

Return:

```js
return { configScan, marketplaceName, hookInstalled, globalResources, workspaceResources, delegatedWorktrees };
```

- [ ] **Step 4: Run focused dry-run tests**

Run:

```bash
npx vitest run tests/uninstall-plugin.test.ts -t "groups dry-run resources|dangerous broad allow roots|direct child workspaces"
```

Expected: PASS.

---

## Task 4: Clean Allow Roots For Every Discovered Workspace

**Files:**
- Modify: `scripts/uninstall-plugin.mjs`
- Modify: `tests/uninstall-plugin.test.ts`

- [ ] **Step 1: Add test for MCP env allow-root cleanup**

Add under `describe("non-dry-run", ...)`:

```ts
it("removes all discovered workspace roots from MCP env CODEX_CLAUDE_ALLOW_ROOTS", async () => {
  const repoA = repoRoot;
  const repoB = path.join(tmpDir, "repo-b");
  await mkdir(repoB, { recursive: true });

  const configPath = path.join(codexHome, "config.toml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, [
    "[mcp_servers.claude_delegate]",
    'command = "node"',
    'args = ["./server/server.js"]',
    "",
    "[mcp_servers.claude_delegate.env]",
    `CODEX_CLAUDE_ALLOW_ROOTS = "${repoA}:${repoB}:/keep-me"`,
    "",
  ].join("\n"), "utf8");

  const { stdout, exitCode } = runScript(["--yes"], {
    CODEX_HOME: codexHome,
    CODEX_UNINSTALL_REPO_ROOT: repoA,
  });

  expect(exitCode).toBe(0);
  expect(stdout).toContain(`Removed ${repoA}`);
  expect(stdout).toContain(`Removed ${repoB}`);
  const after = await readFile(configPath, "utf8");
  expect(after).not.toContain(repoA);
  expect(after).not.toContain(repoB);
  expect(after).toContain("/keep-me");
});
```

- [ ] **Step 2: Add test for shell env allow-root cleanup**

Add:

```ts
it("removes all discovered workspace roots from shell env CODEX_CLAUDE_ALLOW_ROOTS", async () => {
  const repoA = repoRoot;
  const repoB = path.join(tmpDir, "repo-b");
  await mkdir(repoB, { recursive: true });

  const configPath = path.join(codexHome, "config.toml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, [
    "[shell_environment_policy.set]",
    `CODEX_CLAUDE_ALLOW_ROOTS = "${repoA}:${repoB}:/keep-me"`,
    "",
  ].join("\n"), "utf8");

  const { exitCode } = runScript(["--yes"], {
    CODEX_HOME: codexHome,
    CODEX_UNINSTALL_REPO_ROOT: repoA,
  });

  expect(exitCode).toBe(0);
  const after = await readFile(configPath, "utf8");
  expect(after).not.toContain(repoA);
  expect(after).not.toContain(repoB);
  expect(after).toContain("/keep-me");
});
```

- [ ] **Step 3: Update allow-root cleanup loop**

In `phaseCleanTomlRemainders(scan)`, replace `removeAllowRootFn(repoRoot)` with:

```js
if (freshScan.hasAllowRoots && removeAllowRootFn) {
  const rootsToRemove = scan.workspaceResources.map((workspace) => workspace.workspace);
  for (const root of rootsToRemove) {
    try {
      const result = await removeAllowRootFn(root);
      if (result.changed) {
        console.log(`  ${result.message}`);
        recordSuccess("toml-allow-root", result.message);
      } else {
        console.log(`  Allow roots: ${result.message}`);
        recordSkipped("toml-allow-root", result.message);
      }
    } catch (err) {
      console.log(`  Failed to remove allow root ${root}: ${err.message}`);
      recordFailed("toml-allow-root", err.message);
    }
  }
} else {
  console.log("  No allow-roots remainder for discovered workspaces.");
  recordSkipped("toml-allow-root", "None");
}
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
npx vitest run tests/uninstall-plugin.test.ts -t "removes all discovered workspace roots"
```

Expected: PASS.

---

## Task 5: Handle State Directories Across All Workspaces

**Files:**
- Modify: `scripts/uninstall-plugin.mjs`
- Modify: `tests/uninstall-plugin.test.ts`

- [ ] **Step 1: Add dry-run state reporting test**

Add:

```ts
it("reports state directories for every known workspace in dry-run", async () => {
  const repoB = path.join(tmpDir, "repo-b");
  await mkdir(path.join(repoB, ".codex-claude-delegate", "jobs"), { recursive: true });
  await writeFile(path.join(repoB, ".codex-claude-delegate", "jobs", "job-b.json"), JSON.stringify({ cwd: repoB }), "utf8");

  const configPath = path.join(codexHome, "config.toml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, [
    "[mcp_servers.claude_delegate.env]",
    `CODEX_CLAUDE_ALLOW_ROOTS = "${repoRoot}:${repoB}"`,
    "",
  ].join("\n"), "utf8");

  const { stdout } = runScript(["--dry-run"], {
    CODEX_HOME: codexHome,
    CODEX_UNINSTALL_REPO_ROOT: repoRoot,
  });

  expect(stdout).toContain(path.join(repoRoot, ".codex-claude-delegate"));
  expect(stdout).toContain(path.join(repoB, ".codex-claude-delegate"));
  expect(stdout).toContain("job-b.json");
});
```

- [ ] **Step 2: Add non-dry-run multi-workspace cleanup test**

Add:

```ts
it("cleans state directories for every known workspace when keep-state is none", async () => {
  const repoB = path.join(tmpDir, "repo-b");
  await mkdir(path.join(repoB, ".codex-claude-delegate", "jobs"), { recursive: true });
  await writeFile(path.join(repoB, ".codex-claude-delegate", "jobs", "job-b.json"), JSON.stringify({ cwd: repoB }), "utf8");

  const configPath = path.join(codexHome, "config.toml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, [
    "[mcp_servers.claude_delegate.env]",
    `CODEX_CLAUDE_ALLOW_ROOTS = "${repoRoot}:${repoB}"`,
    "",
  ].join("\n"), "utf8");

  const { exitCode } = runScript(["--yes", "--keep-state=none"], {
    CODEX_HOME: codexHome,
    CODEX_UNINSTALL_REPO_ROOT: repoRoot,
  });

  expect(exitCode).toBe(0);
  expect(existsSync(path.join(repoRoot, ".codex-claude-delegate"))).toBe(false);
  expect(existsSync(path.join(repoB, ".codex-claude-delegate"))).toBe(false);
});
```

- [ ] **Step 3: Extract single-workspace state handling**

Refactor `phaseHandleStateDir(scan)` into:

```js
async function handleSingleStateDir(workspaceResource) {
  if (dryRun) {
    if (workspaceResource.stateExists && workspaceResource.stateItems.length > 0) {
      console.log(`  (dry-run) ${workspaceResource.stateDir} has ${workspaceResource.stateItems.length} item(s):`);
      for (const item of workspaceResource.stateItems) console.log(`    - ${item}`);
    } else {
      console.log(`  (dry-run) ${workspaceResource.stateDir} does not exist or is empty.`);
    }
    return;
  }

  if (!workspaceResource.stateExists) {
    console.log("  State directory does not exist; nothing to clean.");
    recordSkipped("state-dir", `${workspaceResource.workspace}: not found`);
    return;
  }

  // Reuse the existing item selection and deletion logic here,
  // replacing scan.stateDir with workspaceResource.stateDir and scan.stateItems with workspaceResource.stateItems.
}

async function phaseHandleStateDir(scan) {
  console.log("\n[phase] Handling workspace state directories...");
  for (const workspaceResource of scan.workspaceResources) {
    console.log(`  Workspace: ${workspaceResource.workspace}`);
    await handleSingleStateDir(workspaceResource);
  }
  if (dryRun) recordSkipped("state-dir", "dry-run");
}
```

Do not keep fallback code for missing `scan.workspaceResources`; Task 3 makes it required.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npx vitest run tests/uninstall-plugin.test.ts -t "state directories for every known workspace|keep-state is none"
```

Expected: PASS.

---

## Task 6: Preserve Non-Destructive Worktree Reporting

**Files:**
- Modify: `scripts/uninstall-plugin.mjs`
- Modify: `tests/uninstall-plugin.test.ts`

- [ ] **Step 1: Add non-dry-run worktree preservation test**

Add:

```ts
it("does not delete delegated worktrees during non-dry-run uninstall", async () => {
  const worktreePath = path.join(repoRoot, ".claude", "worktrees", "codex-delegated-keep");
  await mkdir(worktreePath, { recursive: true });

  const { stdout, exitCode } = runScript(["--yes", "--keep-state=all"], {
    CODEX_HOME: codexHome,
    CODEX_UNINSTALL_REPO_ROOT: repoRoot,
  });

  expect(exitCode).toBe(0);
  expect(stdout).toContain(worktreePath);
  expect(existsSync(worktreePath)).toBe(true);
});
```

- [ ] **Step 2: Update `phaseReportWorktrees()` wording**

Use:

```js
console.log("  These are not automatically deleted.");
console.log("  To clean up through this MCP before uninstall finishes, run claude_cleanup(cwd=<workspace>, dry_run=true) then claude_cleanup(cwd=<workspace>, dry_run=false).");
console.log("  If the MCP has already been removed, inspect the owning repository and remove stale worktrees manually with git worktree remove.");
```

- [ ] **Step 3: Run focused test**

Run:

```bash
npx vitest run tests/uninstall-plugin.test.ts -t "does not delete delegated worktrees"
```

Expected: PASS.

---

## Task 7: Update Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/development-overview.md`

- [ ] **Step 1: Update README uninstall section**

Replace the current uninstall behavior paragraph with:

```markdown
卸载脚本按两个主体工作：

- **全局 Codex/plugin 配置**：插件市场条目、MCP server、`~/.codex/config.toml` 中的 `claude_delegate` 配置和 `CODEX_CLAUDE_ALLOW_ROOTS`。
- **所有已知 workspace**：当前卸载仓库、`CODEX_CLAUDE_ALLOW_ROOTS` 中配置的仓库、其直接子目录中带 `.codex-claude-delegate/` 的仓库、以及 `.codex-claude-delegate/jobs`、`runs`、`review-gate.json` 中引用过的仓库。

`uninstall:dry-run` 会完整报告两个主体，不修改 TOML、不删除文件、不执行 remove 命令。`uninstall` 会清理全局配置；workspace-local `.codex-claude-delegate/` 按交互或 `--keep-state` 处理。delegated worktree 只报告绝对路径，不自动删除；如需清理，先按 workspace 检查，再运行 `claude_cleanup(cwd="...", dry_run=true)` 确认，随后用 `dry_run=false` 删除。若 MCP 已被移除，则在对应仓库中手动使用 git worktree 命令清理。
```

- [ ] **Step 2: Update development overview resource section**

Add:

```markdown
卸载模型分为 global resources 和 workspace resources。Global resources 只处理一次；workspace resources 会按已知 workspace 分组扫描。已知 workspace 来源包括当前卸载仓库、`CODEX_CLAUDE_ALLOW_ROOTS`、配置根目录直接子目录中的 `.codex-claude-delegate/`、以及 state JSON 中记录的 `cwd` / `input.cwd` / `workspace_root` / `repo_root`。扫描是有界的：只检查明确配置的路径及其直接子目录，不递归扫整个磁盘，并跳过 `/`、`/tmp`、`/etc` 和用户 home 这类过宽根目录。
```

- [ ] **Step 3: Check docs diff**

Run:

```bash
git diff -- README.md docs/development-overview.md
```

Expected: Diff only describes the two-subject uninstall model, bounded workspace discovery, and worktree non-deletion behavior.

---

## Task 8: Final Verification

**Files:**
- No code changes beyond prior tasks.

- [ ] **Step 1: Run uninstall tests**

Run:

```bash
npx vitest run tests/uninstall-plugin.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run full tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 4: Run build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 5: Inspect final diff**

Run:

```bash
git diff --stat && git diff -- scripts/uninstall-plugin.mjs tests/uninstall-plugin.test.ts README.md docs/development-overview.md
```

Expected: Changes are limited to uninstall scanning, tests, and matching docs. No generated `dist/` or plugin server bundle is modified unless a separate release step explicitly requires it.

---

## Review Checklist

- [ ] Dry-run is side-effect free.
- [ ] Global Codex/plugin config is reported and cleaned once.
- [ ] Every discovered workspace appears in `workspaceResources`, even with no local state or worktrees.
- [ ] `CODEX_CLAUDE_ALLOW_ROOTS` cleanup covers every discovered workspace root, not only `repoRoot`.
- [ ] State directory handling applies to every known workspace.
- [ ] Delegated worktrees are reported with absolute paths and are not deleted by uninstall.
- [ ] Workspace discovery is bounded and skips dangerous broad roots.
- [ ] Direct child workspaces under configured allow roots are discovered.
- [ ] Existing `--yes` and `--keep-state` semantics are preserved across workspaces.
- [ ] Tests cover current repo, configured external repo, state-discovered repo, child workspace discovery, dangerous-root filtering, and both allow-root config locations.
