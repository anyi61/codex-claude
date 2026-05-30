import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { resolveRepoLocalPath } from "./guard.js";
import type {
  BackgroundJobType,
  ClaudeReviewGateInput,
  ClaudeReviewGateResult,
  ClaudeSetupInput,
  ClaudeSetupResult,
  ClaudeStatusResult,
  ReviewGateState,
} from "./schema.js";
import {
  createTaskFingerprint as createTaskFingerprintCore,
  buildWaitMetadata as buildBackgroundWaitMetadata,
} from "./background-jobs.js";

const REVIEW_GATE_RELATIVE_PATH = path.join(".codex-claude-delegate", "review-gate.json");
const REVIEW_GATE_HOOK_COMMAND = "node '${CLAUDE_PLUGIN_ROOT}/hooks/review-gate-stop.mjs'";

function getRepoRootFromModule(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function resolvePluginRootFromModule(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const envPluginRoot = process.env.CLAUDE_PLUGIN_ROOT ? path.resolve(process.env.CLAUDE_PLUGIN_ROOT) : null;

  const candidates = [
    envPluginRoot,
    path.resolve(moduleDir, ".."),
    path.join(getRepoRootFromModule(), "plugins", "codex-claude-delegate"),
  ].filter((candidate): candidate is string => typeof candidate === "string");

  for (const candidate of candidates) {
    const hooksDir = path.join(candidate, "hooks");
    if (existsSync(path.join(hooksDir, "hooks.json")) || existsSync(path.join(hooksDir, "review-gate-stop.mjs"))) {
      return candidate;
    }
  }

  // Fallback to the repository layout used during source development.
  return path.join(getRepoRootFromModule(), "plugins", "codex-claude-delegate");
}

function getHookManifestPath(): string {
  return path.join(resolvePluginRootFromModule(), "hooks", "hooks.json");
}

function getHookScriptPath(): string {
  return path.join(resolvePluginRootFromModule(), "hooks", "review-gate-stop.mjs");
}

function getReviewGateStatePath(cwd: string): string {
  return path.join(cwd, REVIEW_GATE_RELATIVE_PATH);
}

async function readReviewGateState(cwd: string): Promise<ReviewGateState | null> {
  const filePath = getReviewGateStatePath(cwd);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as ReviewGateState;
  } catch {
    return null;
  }
}

async function writeReviewGateState(cwd: string, enabled: boolean): Promise<ReviewGateState> {
  const pathCheck = resolveRepoLocalPath(cwd, REVIEW_GATE_RELATIVE_PATH);
  if (!pathCheck.ok) {
    throw new Error(pathCheck.error);
  }
  await mkdir(path.dirname(pathCheck.resolved), { recursive: true });
  const next: ReviewGateState = {
    workspace_root: cwd,
    config_path: pathCheck.resolved,
    hook_manifest_path: getHookManifestPath(),
    hook_script_path: getHookScriptPath(),
    hook_installed: existsSync(getHookManifestPath()) && existsSync(getHookScriptPath()),
    enabled,
    mode: "soft-stop",
    pending_review: false,
    updated_at: new Date().toISOString(),
  };
  await writeFile(pathCheck.resolved, JSON.stringify(next, null, 2), "utf8");
  return next;
}

export interface ReviewGatePendingMetadata {
  activity: "write" | "apply";
  run_id: string;
  worktree_path?: string;
  fingerprint?: string;
}

export interface ClearReviewGateInput {
  review_run_id: string;
  reviewed_run_id?: string;
  reviewed_worktree_path?: string;
  reviewed_fingerprint?: string;
}

export interface ClearReviewGateResult {
  cleared: boolean;
  reason: string;
}

export async function markReviewGatePending(cwd: string, metadata: ReviewGatePendingMetadata): Promise<void> {
  const current = await readReviewGateState(cwd);
  if (!current?.enabled) return;
  const pathCheck = resolveRepoLocalPath(cwd, REVIEW_GATE_RELATIVE_PATH);
  if (!pathCheck.ok) {
    throw new Error(pathCheck.error);
  }
  const now = new Date().toISOString();
  const next: ReviewGateState = {
    ...current,
    config_path: pathCheck.resolved,
    hook_manifest_path: getHookManifestPath(),
    hook_script_path: getHookScriptPath(),
    hook_installed: existsSync(getHookManifestPath()) && existsSync(getHookScriptPath()),
    pending_review: true,
    pending_activity: metadata.activity,
    pending_run_id: metadata.run_id,
    pending_worktree_path: metadata.worktree_path,
    pending_fingerprint: metadata.fingerprint,
    updated_at: now,
    last_write_at: now,
  };
  await mkdir(path.dirname(pathCheck.resolved), { recursive: true });
  await writeFile(pathCheck.resolved, JSON.stringify(next, null, 2), "utf8");
}

export async function clearReviewGatePendingIfMatches(cwd: string, input: ClearReviewGateInput): Promise<ClearReviewGateResult> {
  const current = await readReviewGateState(cwd);
  if (!current?.enabled) {
    return { cleared: false, reason: "gate_not_enabled" };
  }
  if (!current.pending_review) {
    return { cleared: false, reason: "no_pending" };
  }

  const hasReviewedBinding =
    input.reviewed_run_id !== undefined ||
    input.reviewed_worktree_path !== undefined ||
    input.reviewed_fingerprint !== undefined;
  if (!hasReviewedBinding) {
    return { cleared: false, reason: "no_binding" };
  }

  if (input.reviewed_run_id !== undefined && input.reviewed_run_id !== current.pending_run_id) {
    return { cleared: false, reason: "run_id_mismatch" };
  }
  if (input.reviewed_worktree_path !== undefined && input.reviewed_worktree_path !== current.pending_worktree_path) {
    return { cleared: false, reason: "worktree_path_mismatch" };
  }
  if (input.reviewed_fingerprint !== undefined && input.reviewed_fingerprint !== current.pending_fingerprint) {
    return { cleared: false, reason: "fingerprint_mismatch" };
  }

  const pathCheck = resolveRepoLocalPath(cwd, REVIEW_GATE_RELATIVE_PATH);
  if (!pathCheck.ok) {
    throw new Error(pathCheck.error);
  }
  const now = new Date().toISOString();
  const next: ReviewGateState = {
    ...current,
    config_path: pathCheck.resolved,
    hook_manifest_path: getHookManifestPath(),
    hook_script_path: getHookScriptPath(),
    hook_installed: existsSync(getHookManifestPath()) && existsSync(getHookScriptPath()),
    pending_review: false,
    pending_activity: undefined,
    pending_run_id: undefined,
    pending_worktree_path: undefined,
    pending_fingerprint: undefined,
    last_cleared_by_review_run_id: input.review_run_id,
    updated_at: now,
    last_review_at: now,
  };
  await mkdir(path.dirname(pathCheck.resolved), { recursive: true });
  await writeFile(pathCheck.resolved, JSON.stringify(next, null, 2), "utf8");
  return { cleared: true, reason: "cleared" };
}

async function ensureReviewGateHookManifest(): Promise<void> {
  const manifestPath = getHookManifestPath();
  await mkdir(path.dirname(manifestPath), { recursive: true });
  const existingRaw = existsSync(manifestPath) ? await readFile(manifestPath, "utf8").catch(() => "") : "";
  let parsed: { hooks?: Record<string, unknown> } = {};
  if (existingRaw.trim()) {
    try {
      parsed = JSON.parse(existingRaw) as { hooks?: Record<string, unknown> };
    } catch {
      parsed = {};
    }
  }
  const hooksRoot = parsed.hooks && typeof parsed.hooks === "object"
    ? parsed.hooks as Record<string, unknown>
    : {};
  const stopEntries = Array.isArray(hooksRoot.Stop) ? [...hooksRoot.Stop as Array<Record<string, unknown>>] : [];
  const alreadyInstalled = stopEntries.some((entry) => {
    const hookEntries = Array.isArray(entry.hooks) ? entry.hooks as Array<Record<string, unknown>> : [];
    return hookEntries.some((hook) => hook.type === "command" && hook.command === REVIEW_GATE_HOOK_COMMAND);
  });
  if (!alreadyInstalled) {
    stopEntries.push({
      matcher: ".*",
      hooks: [
        {
          type: "command",
          command: REVIEW_GATE_HOOK_COMMAND,
          async: false,
        },
      ],
    });
  }
  hooksRoot.Stop = stopEntries;
  await writeFile(manifestPath, JSON.stringify({ hooks: hooksRoot }, null, 2), "utf8");
}

function getReviewGateNextSteps(enabled: boolean, hookInstallable: boolean, pendingReview = false): string[] {
  if (!hookInstallable) {
    return ["Review gate hook assets are missing. Restore the plugin hook files before enabling the gate."];
  }
  if (enabled) {
    return [
      "Review gate is enabled for this workspace.",
      pendingReview
        ? "A review is pending for the latest write-oriented workflow in this workspace."
        : "No pending review is currently tracked for this workspace.",
      "Verify the plugin loads hooks/hooks.json and that the stop hook script is reachable.",
      "Before finishing a coding session, expect a stop-time reminder to run claude_review or claude_task with mode=review.",
    ];
  }
  return [
    "Review gate is disabled for this workspace.",
    "Call claude_review_gate with action=enable to persist the local gate state and install/update the stop-hook manifest.",
  ];
}

function buildReviewGateState(cwd: string, state: Partial<ReviewGateState> | null, hookInstalled: boolean): ReviewGateState {
  return {
    workspace_root: cwd,
    config_path: getReviewGateStatePath(cwd),
    hook_manifest_path: getHookManifestPath(),
    hook_script_path: getHookScriptPath(),
    hook_installed: hookInstalled,
    enabled: state?.enabled === true,
    mode: "soft-stop",
    pending_review: state?.pending_review === true,
    updated_at: state?.updated_at,
    last_write_at: state?.last_write_at,
    last_review_at: state?.last_review_at,
    pending_activity: state?.pending_activity,
    pending_run_id: state?.pending_run_id,
    pending_worktree_path: state?.pending_worktree_path,
    pending_fingerprint: state?.pending_fingerprint,
    last_cleared_by_review_run_id: state?.last_cleared_by_review_run_id,
  };
}

export function createTaskFingerprint(input: {
  cwd: string;
  type: BackgroundJobType;
  payload: Record<string, unknown>;
}): string {
  return createTaskFingerprintCore(input);
}

export function buildWaitMetadata(input: {
  mode?: "block" | "background";
  timeoutSec?: number;
  completedInline?: boolean;
  waiting?: boolean;
  timedOut?: boolean;
  doNotStartDuplicateJob?: boolean;
}) {
  return buildBackgroundWaitMetadata(input);
}

export async function runClaudeSetup(
  input: ClaudeSetupInput,
  checkStatus: (cwd: string) => Promise<ClaudeStatusResult>,
): Promise<ClaudeSetupResult> {
  const hookManifestPath = getHookManifestPath();
  const hookScriptPath = getHookScriptPath();
  const hookInstalled = existsSync(hookManifestPath) && existsSync(hookScriptPath);
  const gateState = await readReviewGateState(input.cwd);
  const status = await checkStatus(input.cwd);
  const reviewGate = buildReviewGateState(input.cwd, gateState, hookInstalled);
  const authStatus =
    status.auth_status === "authenticated"
      ? "ok"
      : status.auth_status === "not authenticated" || status.auth_status === "unauthenticated or unknown"
        ? "missing"
        : "unknown";

  return {
    workspace_root: input.cwd,
    review_gate: reviewGate,
    claude_available: status.claude_available,
    claude_version: status.claude_version,
    auth_status: authStatus,
    git_available: status.git_available,
    worktree_capable: status.worktree_capable,
    cwd_valid: status.cwd_valid,
    cwd_is_git_repo: status.cwd_is_git_repo,
    errors: status.errors,
    next_steps: [
      ...(status.claude_available && status.git_available && status.cwd_valid
        ? []
        : ["Run claude_status and fix Claude CLI, git, or workspace readiness issues before using the review gate."]),
      ...getReviewGateNextSteps(reviewGate.enabled, hookInstalled, reviewGate.pending_review),
    ],
  };
}

export async function manageClaudeReviewGate(input: ClaudeReviewGateInput): Promise<ClaudeReviewGateResult> {
  const hookManifestPath = getHookManifestPath();
  const hookScriptPath = getHookScriptPath();
  const hookInstallable = existsSync(hookScriptPath);
  const current = await readReviewGateState(input.cwd);
  const action = input.action ?? "status";
  const hookInstalled = existsSync(hookManifestPath) && hookInstallable;

  if (action === "status") {
    const reviewGate = buildReviewGateState(input.cwd, current, hookInstalled);
    return {
      ...reviewGate,
      action,
      changed: false,
      summary: reviewGate.enabled
        ? (reviewGate.pending_review ? "Review gate is enabled and a review is pending." : "Review gate is enabled for this workspace.")
        : "Review gate is disabled for this workspace.",
      next_steps: getReviewGateNextSteps(reviewGate.enabled, hookInstalled, reviewGate.pending_review),
    };
  }

  if (!hookInstallable) {
    throw new Error(`Review gate hook script is missing: ${hookScriptPath}`);
  }

  if (action === "enable") {
    await ensureReviewGateHookManifest();
  }
  const nextState = await writeReviewGateState(input.cwd, action === "enable");
  const reviewGate = buildReviewGateState(input.cwd, nextState, existsSync(hookManifestPath) && hookInstallable);

  return {
    ...reviewGate,
    action,
    changed: current?.enabled !== nextState.enabled || !current,
    summary: nextState.enabled
      ? "Review gate enabled for this workspace and stop-hook manifest is ready."
      : "Review gate disabled for this workspace. Hook asset is left installed but locally inactive.",
    next_steps: getReviewGateNextSteps(nextState.enabled, existsSync(hookManifestPath) && hookInstallable, reviewGate.pending_review),
  };
}
