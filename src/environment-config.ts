import { readFile } from "node:fs/promises";
import path from "node:path";

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
  errors: EnvironmentConfigIssue[];
  warnings: EnvironmentConfigIssue[];
}

// ---- Constants ----

const VALID_FIELDS = new Set(["install", "test", "start", "symlink_directories", "sparse_paths"]);
const COMMAND_MAX_LENGTH = 1000;
const SUPPORTED_COMMAND_FIELDS = ["install", "test", "start"] as const;

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
  // Check for raw ".." segments before normalization resolves them
  const segments = p.split("/").filter(Boolean);
  if (segments.some((s) => s === "..")) return true;
  // Also check normalized path for leading ".." (e.g. "foo/../../bar" → "../../bar")
  const normSegments = normalized.split("/").filter(Boolean);
  if (normSegments[0] === "..") return true;
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

  if (!VALID_FIELDS.has(key)) {
    return { errors: [], warnings: [{ field: key, message: `Unknown field "${key}"` }], ok: true };
  }

  const kind = fieldKind(key);
  if (kind === FieldKind.Command) {
    if (value === undefined || value === null) {
      // Field exists but is null — no issue, just absent
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

export interface ReadEnvironmentConfigResult {
  summary: EnvironmentConfigSummary;
  /** Internal-only: raw sanitized config (no public exposure of command values) */
  _raw?: Record<string, unknown>;
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

  return { summary, _raw: sanitized };
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
