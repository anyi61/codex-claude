#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function findReviewGateState(cwd) {
  const marker = path.join(".codex-claude-delegate", "review-gate.json");
  let current = path.resolve(cwd);
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(current, marker);
    if (existsSync(candidate)) return { cwd: current, statePath: candidate };
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

// Try workspace paths in priority order: hook payload hint, PWD, then cwd.
const candidates = [
  process.env.CODEX_WORKSPACE_ROOT,
  process.env.PWD,
  process.cwd(),
].filter(Boolean);

let resolved = null;
for (const candidate of candidates) {
  resolved = findReviewGateState(path.resolve(candidate));
  if (resolved) break;
}

if (!resolved) {
  // Quiet exit is correct for workspaces without a review gate.
  // If PWD hints exist but no gate state was found, emit
  // a brief diagnostic to stderr for troubleshooting.
  if (process.env.CODEX_WORKSPACE_ROOT && !existsSync(path.resolve(process.env.CODEX_WORKSPACE_ROOT))) {
    process.stderr.write(`[codex-claude-review-gate] CODEX_WORKSPACE_ROOT="${process.env.CODEX_WORKSPACE_ROOT}" does not exist; no review gate check performed.\n`);
  }
  process.exit(0);
}

const { cwd, statePath } = resolved;

try {
  const parsed = JSON.parse(readFileSync(statePath, "utf8"));
  if (parsed?.enabled !== true || parsed?.pending_review !== true) {
    process.exit(0);
  }

  const message = "Review gate is enabled for this workspace and a review is still pending. Run claude_review or claude_task with mode=review before finalizing your work.";
  const payload = {
    review_gate: {
      enabled: true,
      pending_review: true,
      workspace_root: cwd,
      state_path: statePath,
      suggested_tools: ["claude_review", "claude_task"],
    },
    systemMessage: message,
    additional_context: message,
  };

  process.stdout.write(`${JSON.stringify(payload)}\n`);
} catch (error) {
  process.stderr.write(`[codex-claude-review-gate] ${error instanceof Error ? error.message : String(error)}\n`);
}
