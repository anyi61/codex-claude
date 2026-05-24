import { readFile } from "node:fs/promises";
import path from "node:path";
import { isSensitiveName } from "./guard.js";

// ---- Types ----

export interface EnvironmentConfigIssue {
  field: string;
  message: string;
}

export interface EnvironmentConfigSummary {
  exists: boolean;
  path: string;
  ok: boolean;
  fields_present: string[];
  install: boolean;
  test: boolean;
  start: boolean;
  symlink_directories_count: number;
  sparse_paths_count: number;
  // Phase 2 — safe summary (no command/secret values)
  verification_allowed_scripts_count?: number;
  verification_allowed_scripts?: string[];
  verification_timeout_sec?: number;
  artifacts_retention_days?: number;
  environment_passthrough_count?: number;
  environment_passthrough?: string[];
  errors: EnvironmentConfigIssue[];
  warnings: EnvironmentConfigIssue[];
}

// ---- Constants ----

const VALID_FIELDS = new Set(["install", "test", "start", "symlink_directories", "sparse_paths"]);
const PHASE2_TOP_KEYS = new Set(["verification", "artifacts", "environment"]);
const COMMAND_MAX_LENGTH = 1000;
const SUPPORTED_COMMAND_FIELDS = ["install", "test", "start"] as const;

const FORBIDDEN_SCRIPT_NAMES = new Set([
  "add",
  "deploy",
  "install",
  "publish",
  "remove",
  "serve",
  "start",
  "uninstall",
]);

const SCRIPT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;
const MAX_ALLOWED_SCRIPTS = 50;
const MAX_SCRIPT_NAME_LENGTH = 100;
const MAX_PASSTHROUGH_ENTRIES = 100;
const PASSTHROUGH_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_PASSTHROUGH_NAME_LENGTH = 256;

const SHELL_TOKENS = new Set(["&&", "||", ";", "|", ">", ">>", "<", "&", "$", "`", "!", "(", ")", "{", "}", "\\", "'", "\"", "\n", "\r", " "]);

// ---- Helpers ----

function makeSummary(configPath: string): EnvironmentConfigSummary {
  return {
    exists: true,
    path: configPath,
    ok: true,
    fields_present: [],
    install: false,
    test: false,
    start: false,
    symlink_directories_count: 0,
    sparse_paths_count: 0,
    errors: [],
    warnings: [],
  };
}

function isAbsolutePath(p: string): boolean {
  return path.isAbsolute(p);
}

function hasParentDirTraversal(p: string): boolean {
  const normalized = path.normalize(p);
  const segments = p.split("/").filter(Boolean);
  if (segments.some((s) => s === "..")) return true;
  const normSegments = normalized.split("/").filter(Boolean);
  if (normSegments[0] === "..") return true;
  return false;
}

function hasShellTokens(name: string): boolean {
  for (const ch of name) {
    if (SHELL_TOKENS.has(ch)) return true;
  }
  return false;
}

// ---- Read & validate ----

const enum FieldKind {
  Command = "command",
  StringArray = "string_array",
}

function fieldKind(field: string): FieldKind | null {
  if ((SUPPORTED_COMMAND_FIELDS as readonly string[]).includes(field)) return FieldKind.Command;
  if (field === "symlink_directories" || field === "sparse_paths") return FieldKind.StringArray;
  return null;
}

function validateField(
  key: string,
  value: unknown,
): { errors: EnvironmentConfigIssue[]; warnings: EnvironmentConfigIssue[]; ok: boolean } {
  const errors: EnvironmentConfigIssue[] = [];
  const warnings: EnvironmentConfigIssue[] = [];

  if (!VALID_FIELDS.has(key) && !PHASE2_TOP_KEYS.has(key)) {
    return { errors: [], warnings: [{ field: key, message: `Unknown field "${key}"` }], ok: true };
  }

  const kind = fieldKind(key);
  if (kind === FieldKind.Command) {
    if (value === undefined || value === null) {
      return { errors: [], warnings: [], ok: true };
    }
    if (typeof value !== "string") {
      errors.push({ field: key, message: `"${key}" must be a string` });
      return { errors, warnings, ok: false };
    }
    if (value === "") {
      errors.push({ field: key, message: `"${key}" must not be empty` });
      return { errors, warnings, ok: false };
    }
    if (value.length > COMMAND_MAX_LENGTH) {
      errors.push({ field: key, message: `"${key}" exceeds maximum length of ${COMMAND_MAX_LENGTH} characters` });
      return { errors, warnings, ok: false };
    }
  }

  if (kind === FieldKind.StringArray) {
    if (!Array.isArray(value)) {
      errors.push({ field: key, message: `"${key}" must be an array of strings` });
      return { errors, warnings, ok: false };
    }

    const seen = new Set<string>();
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (typeof item !== "string" || item === "") {
        errors.push({ field: `${key}[${i}]`, message: `"${key}[${i}]" must be a non-empty string` });
      } else if (key === "symlink_directories") {
        if (!isAbsolutePath(item)) {
          errors.push({ field: `${key}[${i}]`, message: `"${key}[${i}]" must be an absolute path` });
        } else if (seen.has(item)) {
          // Dedup — mark but don't error
        } else {
          seen.add(item);
        }
      } else if (key === "sparse_paths") {
        if (isAbsolutePath(item)) {
          errors.push({ field: `${key}[${i}]`, message: `"${key}[${i}]" must be a relative path, not absolute` });
        } else if (hasParentDirTraversal(item)) {
          errors.push({ field: `${key}[${i}]`, message: `"${key}[${i}]" must not contain ".." segments` });
        } else if (seen.has(item)) {
          // Dedup — mark but don't error
        } else {
          seen.add(item);
        }
      }
    }

    if (errors.length > 0) {
      return { errors, warnings, ok: false };
    }
  }

  return { errors, warnings, ok: true };
}

// ---- Phase 2 validation ----

function validatePhase2Field(
  key: string,
  value: unknown,
): { errors: EnvironmentConfigIssue[]; warnings: EnvironmentConfigIssue[]; ok: boolean } {
  const errors: EnvironmentConfigIssue[] = [];
  const warnings: EnvironmentConfigIssue[] = [];

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push({ field: key, message: `"${key}" must be an object` });
    return { errors, warnings, ok: false };
  }

  const obj = value as Record<string, unknown>;

  if (key === "verification") {
    return validateVerification(obj);
  }
  if (key === "artifacts") {
    return validateArtifacts(obj);
  }
  if (key === "environment") {
    return validateEnvironment(obj);
  }

  return { errors, warnings, ok: true };
}

function validateVerification(
  obj: Record<string, unknown>,
): { errors: EnvironmentConfigIssue[]; warnings: EnvironmentConfigIssue[]; ok: boolean } {
  const errors: EnvironmentConfigIssue[] = [];
  const warnings: EnvironmentConfigIssue[] = [];
  let ok = true;

  for (const [subKey, subValue] of Object.entries(obj)) {
    if (subKey === "allowedScripts") {
      if (!Array.isArray(subValue)) {
        errors.push({ field: "verification.allowedScripts", message: `"verification.allowedScripts" must be an array of strings` });
        ok = false;
        continue;
      }
      if (subValue.length > MAX_ALLOWED_SCRIPTS) {
        errors.push({ field: "verification.allowedScripts", message: `"verification.allowedScripts" exceeds maximum of ${MAX_ALLOWED_SCRIPTS} entries` });
        ok = false;
        continue;
      }
      const seen = new Set<string>();
      for (let i = 0; i < subValue.length; i++) {
        const item = subValue[i];
        if (typeof item !== "string" || item === "") {
          errors.push({ field: `verification.allowedScripts[${i}]`, message: `"verification.allowedScripts[${i}]" must be a non-empty string` });
          ok = false;
          continue;
        }
        if (item.length > MAX_SCRIPT_NAME_LENGTH) {
          errors.push({ field: `verification.allowedScripts[${i}]`, message: `"verification.allowedScripts[${i}]" exceeds maximum length of ${MAX_SCRIPT_NAME_LENGTH} characters` });
          ok = false;
          continue;
        }
        if (hasShellTokens(item)) {
          errors.push({ field: `verification.allowedScripts[${i}]`, message: `"verification.allowedScripts[${i}]" contains shell-ish tokens` });
          ok = false;
          continue;
        }
        if (FORBIDDEN_SCRIPT_NAMES.has(item)) {
          errors.push({ field: `verification.allowedScripts[${i}]`, message: `"verification.allowedScripts[${i}]" is a forbidden script name: "${item}"` });
          ok = false;
          continue;
        }
        if (!SCRIPT_NAME_RE.test(item)) {
          errors.push({ field: `verification.allowedScripts[${i}]`, message: `"verification.allowedScripts[${i}]" contains invalid characters (allowed: alphanumeric, :, _, -)` });
          ok = false;
          continue;
        }
        if (seen.has(item)) {
          warnings.push({ field: `verification.allowedScripts[${i}]`, message: `Duplicate script name "${item}"` });
        } else {
          seen.add(item);
        }
      }
    } else if (subKey === "timeoutSec") {
      if (typeof subValue !== "number" || !Number.isInteger(subValue)) {
        errors.push({ field: "verification.timeoutSec", message: `"verification.timeoutSec" must be an integer` });
        ok = false;
      } else if (subValue < 10 || subValue > 300) {
        errors.push({ field: "verification.timeoutSec", message: `"verification.timeoutSec" must be between 10 and 300` });
        ok = false;
      }
    } else {
      warnings.push({ field: `verification.${subKey}`, message: `Unknown subfield "verification.${subKey}"` });
    }
  }

  return { errors, warnings, ok };
}

function validateArtifacts(
  obj: Record<string, unknown>,
): { errors: EnvironmentConfigIssue[]; warnings: EnvironmentConfigIssue[]; ok: boolean } {
  const errors: EnvironmentConfigIssue[] = [];
  const warnings: EnvironmentConfigIssue[] = [];
  let ok = true;

  for (const [subKey, subValue] of Object.entries(obj)) {
    if (subKey === "retentionDays") {
      if (typeof subValue !== "number" || !Number.isInteger(subValue)) {
        errors.push({ field: "artifacts.retentionDays", message: `"artifacts.retentionDays" must be an integer` });
        ok = false;
      } else if (subValue < 1 || subValue > 365) {
        errors.push({ field: "artifacts.retentionDays", message: `"artifacts.retentionDays" must be between 1 and 365` });
        ok = false;
      }
    } else {
      warnings.push({ field: `artifacts.${subKey}`, message: `Unknown subfield "artifacts.${subKey}"` });
    }
  }

  return { errors, warnings, ok };
}

function validateEnvironment(
  obj: Record<string, unknown>,
): { errors: EnvironmentConfigIssue[]; warnings: EnvironmentConfigIssue[]; ok: boolean } {
  const errors: EnvironmentConfigIssue[] = [];
  const warnings: EnvironmentConfigIssue[] = [];
  let ok = true;

  for (const [subKey, subValue] of Object.entries(obj)) {
    if (subKey === "passthrough") {
      if (!Array.isArray(subValue)) {
        errors.push({ field: "environment.passthrough", message: `"environment.passthrough" must be an array of strings` });
        ok = false;
        continue;
      }
      if (subValue.length > MAX_PASSTHROUGH_ENTRIES) {
        errors.push({ field: "environment.passthrough", message: `"environment.passthrough" exceeds maximum of ${MAX_PASSTHROUGH_ENTRIES} entries` });
        ok = false;
        continue;
      }
      const seen = new Set<string>();
      for (let i = 0; i < subValue.length; i++) {
        const item = subValue[i];
        if (typeof item !== "string" || item === "") {
          errors.push({ field: `environment.passthrough[${i}]`, message: `"environment.passthrough[${i}]" must be a non-empty string` });
          ok = false;
          continue;
        }
        if (item.length > MAX_PASSTHROUGH_NAME_LENGTH) {
          errors.push({ field: `environment.passthrough[${i}]`, message: `"environment.passthrough[${i}]" exceeds maximum length of ${MAX_PASSTHROUGH_NAME_LENGTH} characters` });
          ok = false;
          continue;
        }
        if (!PASSTHROUGH_NAME_RE.test(item)) {
          errors.push({ field: `environment.passthrough[${i}]`, message: `"environment.passthrough[${i}]" is not a valid environment variable name` });
          ok = false;
          continue;
        }
        if (isSensitiveName(item)) {
          errors.push({ field: `environment.passthrough[${i}]`, message: `"environment.passthrough[${i}]" matches a sensitive name pattern` });
          ok = false;
          continue;
        }
        if (seen.has(item)) {
          warnings.push({ field: `environment.passthrough[${i}]`, message: `Duplicate passthrough name "${item}"` });
        } else {
          seen.add(item);
        }
      }
    } else {
      warnings.push({ field: `environment.${subKey}`, message: `Unknown subfield "environment.${subKey}"` });
    }
  }

  return { errors, warnings, ok };
}

// ---- Extract Phase 2 config for execution use ----

export interface Phase2VerificationConfig {
  allowedScripts?: string[];
  timeoutSec?: number;
}

export interface Phase2ArtifactsConfig {
  retentionDays?: number;
}

export interface Phase2EnvironmentConfig {
  passthrough?: string[];
}

export interface Phase2Config {
  verification?: Phase2VerificationConfig;
  artifacts?: Phase2ArtifactsConfig;
  environment?: Phase2EnvironmentConfig;
}

function extractPhase2Config(config: Record<string, unknown>, summaryOk: boolean): Phase2Config | undefined {
  if (!summaryOk) return undefined;

  const result: Phase2Config = {};
  let hasAny = false;

  const verification = config["verification"];
  if (verification && typeof verification === "object" && !Array.isArray(verification)) {
    const v = verification as Record<string, unknown>;
    const vConfig: Phase2VerificationConfig = {};

    if (Array.isArray(v.allowedScripts)) {
      const scripts = v.allowedScripts.filter((s): s is string => typeof s === "string" && s.length > 0 && s.length <= MAX_SCRIPT_NAME_LENGTH && SCRIPT_NAME_RE.test(s) && !FORBIDDEN_SCRIPT_NAMES.has(s) && !hasShellTokens(s));
      const deduped = [...new Set(scripts)].slice(0, MAX_ALLOWED_SCRIPTS);
      vConfig.allowedScripts = deduped;
    }
    if (typeof v.timeoutSec === "number" && Number.isInteger(v.timeoutSec) && v.timeoutSec >= 10 && v.timeoutSec <= 300) {
      vConfig.timeoutSec = v.timeoutSec;
    }

    if (vConfig.allowedScripts || vConfig.timeoutSec !== undefined) {
      result.verification = vConfig;
      hasAny = true;
    }
  }

  const artifacts = config["artifacts"];
  if (artifacts && typeof artifacts === "object" && !Array.isArray(artifacts)) {
    const a = artifacts as Record<string, unknown>;
    if (typeof a.retentionDays === "number" && Number.isInteger(a.retentionDays) && a.retentionDays >= 1 && a.retentionDays <= 365) {
      result.artifacts = { retentionDays: a.retentionDays };
      hasAny = true;
    }
  }

  const environment = config["environment"];
  if (environment && typeof environment === "object" && !Array.isArray(environment)) {
    const e = environment as Record<string, unknown>;
    if (Array.isArray(e.passthrough)) {
      const names = e.passthrough.filter((n): n is string =>
        typeof n === "string" &&
        n.length > 0 &&
        n.length <= MAX_PASSTHROUGH_NAME_LENGTH &&
        PASSTHROUGH_NAME_RE.test(n) &&
        !isSensitiveName(n),
      );
      const deduped = [...new Set(names)].slice(0, MAX_PASSTHROUGH_ENTRIES);
      if (deduped.length > 0) {
        result.environment = { passthrough: deduped };
        hasAny = true;
      }
    }
  }

  return hasAny ? result : undefined;
}

// ---- Populate Phase 2 summary ----

function populatePhase2Summary(
  summary: EnvironmentConfigSummary,
  config: Record<string, unknown>,
): void {
  const verification = config["verification"];
  if (verification && typeof verification === "object" && !Array.isArray(verification)) {
    const v = verification as Record<string, unknown>;

    if (Array.isArray(v.allowedScripts)) {
      const valid = v.allowedScripts.filter((s): s is string =>
        typeof s === "string" &&
        s.length > 0 &&
        s.length <= MAX_SCRIPT_NAME_LENGTH &&
        SCRIPT_NAME_RE.test(s) &&
        !FORBIDDEN_SCRIPT_NAMES.has(s) &&
        !hasShellTokens(s),
      );
      summary.verification_allowed_scripts_count = valid.length;
      summary.verification_allowed_scripts = [...new Set(valid)].slice(0, MAX_ALLOWED_SCRIPTS);
    }

    if (typeof v.timeoutSec === "number" && Number.isInteger(v.timeoutSec)) {
      summary.verification_timeout_sec = v.timeoutSec;
    }
  }

  const artifacts = config["artifacts"];
  if (artifacts && typeof artifacts === "object" && !Array.isArray(artifacts)) {
    const a = artifacts as Record<string, unknown>;
    if (typeof a.retentionDays === "number" && Number.isInteger(a.retentionDays)) {
      summary.artifacts_retention_days = a.retentionDays;
    }
  }

  const environment = config["environment"];
  if (environment && typeof environment === "object" && !Array.isArray(environment)) {
    const e = environment as Record<string, unknown>;
    if (Array.isArray(e.passthrough)) {
      const names = e.passthrough.filter((n): n is string =>
        typeof n === "string" &&
        n.length > 0 &&
        n.length <= MAX_PASSTHROUGH_NAME_LENGTH &&
        PASSTHROUGH_NAME_RE.test(n) &&
        !isSensitiveName(n),
      );
      summary.environment_passthrough_count = names.length;
      summary.environment_passthrough = [...new Set(names)].slice(0, MAX_PASSTHROUGH_ENTRIES);
    }
  }
}

// ---- Main export ----

export interface ReadEnvironmentConfigResult {
  summary: EnvironmentConfigSummary;
  /** Internal-only: raw sanitized config (no public exposure of command values) */
  _raw?: Record<string, unknown>;
  /** Phase 2 config for execution use (only populated when summary.ok is true) */
  phase2?: Phase2Config;
}

/**
 * Read and validate `.codex-claude-delegate/environment.json` in the given directory.
 * Returns a safe summary suitable for public output, plus optional internal raw data.
 * Returns `null` when the file does not exist.
 */
export async function readEnvironmentConfig(cwd: string): Promise<ReadEnvironmentConfigResult | null> {
  const configPath = path.join(cwd, ".codex-claude-delegate", "environment.json");
  const summary = makeSummary(configPath);

  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "ENOENT") {
      return null;
    }
    summary.ok = false;
    summary.errors.push({ field: "file", message: "Unable to read environment config file" });
    return { summary };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    summary.ok = false;
    summary.errors.push({ field: "file", message: "File is not valid JSON" });
    return { summary };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    summary.ok = false;
    summary.errors.push({ field: "file", message: "File must contain a JSON object" });
    return { summary };
  }

  const config = parsed as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(config)) {
    // Phase 2: validate sub-objects
    if (PHASE2_TOP_KEYS.has(key)) {
      const result = validatePhase2Field(key, value);
      for (const err of result.errors) summary.errors.push(err);
      for (const warn of result.warnings) summary.warnings.push(warn);
      if (!result.ok) {
        summary.ok = false;
      }
      continue;
    }

    const result = validateField(key, value);
    for (const err of result.errors) summary.errors.push(err);
    for (const warn of result.warnings) summary.warnings.push(warn);
    if (!result.ok) {
      summary.ok = false;
    }

    if (VALID_FIELDS.has(key)) {
      summary.fields_present.push(key);
    }

    // Track boolean flags for command fields
    if ((SUPPORTED_COMMAND_FIELDS as readonly string[]).includes(key) && typeof value === "string" && value.length > 0 && value.length <= COMMAND_MAX_LENGTH) {
      summary[key as "install" | "test" | "start"] = true;
    }

    // Track array counts
    if (key === "symlink_directories" && Array.isArray(value)) {
      summary.symlink_directories_count = new Set(value.filter((item): item is string => typeof item === "string" && isAbsolutePath(item))).size;
    }
    if (key === "sparse_paths" && Array.isArray(value)) {
      summary.sparse_paths_count = new Set(value.filter((item): item is string => typeof item === "string" && item !== "" && !isAbsolutePath(item) && !hasParentDirTraversal(item))).size;
    }

    // For internal raw use: store only known fields, never values
    if (VALID_FIELDS.has(key)) {
      sanitized[key] = true;
    }
  }

  // Populate Phase 2 summary fields
  populatePhase2Summary(summary, config);

  // Extract Phase 2 config for execution (only if no errors)
  const phase2 = summary.ok ? extractPhase2Config(config, summary.ok) : undefined;

  return { summary, _raw: sanitized, phase2 };
}

/**
 * Build a safe public summary from field presence. Used when the raw config data
 * has already been validated but only metadata should be exposed.
 */
export function buildConfigSummaryFromFields(fields: string[]): EnvironmentConfigSummary {
  const summary: EnvironmentConfigSummary = {
    exists: true,
    path: "",
    ok: true,
    fields_present: [...fields],
    install: fields.includes("install"),
    test: fields.includes("test"),
    start: fields.includes("start"),
    symlink_directories_count: 0,
    sparse_paths_count: 0,
    errors: [],
    warnings: [],
  };
  return summary;
}
