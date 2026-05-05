#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const cwd = process.env.PWD ? path.resolve(process.env.PWD) : process.cwd();
const statePath = path.join(cwd, ".codex-claude-delegate", "review-gate.json");

if (!existsSync(statePath)) {
  process.exit(0);
}

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
