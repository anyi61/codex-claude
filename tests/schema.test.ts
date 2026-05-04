import { describe, expect, it } from "vitest";
import {
  IMPLEMENT_SCHEMA,
  QUERY_SCHEMA,
  REVIEW_SCHEMA,
  claudeImplementInputSchema,
} from "../src/schema.js";

describe("schema definitions", () => {
  it("defines implement structured output fields", () => {
    expect(IMPLEMENT_SCHEMA.required).toEqual([
      "status",
      "summary",
      "changed_files",
      "commands_run",
      "tests",
      "risks",
      "next_steps",
    ]);
  });

  it("limits implement status values", () => {
    expect(IMPLEMENT_SCHEMA.properties.status.enum).toEqual([
      "success",
      "failed",
      "partial",
      "needs_user",
    ]);
  });

  it("defines review output fields", () => {
    expect(REVIEW_SCHEMA.required).toEqual(["findings", "recommendations", "severity"]);
  });

  it("defines query answer output", () => {
    expect(QUERY_SCHEMA.required).toEqual(["answer"]);
  });

  it("rejects invalid implement inputs", () => {
    expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", task: "" }).success).toBe(false);
    expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", task: "x", timeout_sec: 3601 }).success).toBe(false);
    expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", task: "x", worktreeName: "../bad" }).success).toBe(false);
    expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", task: "x", files: "src" }).success).toBe(false);
    expect(claudeImplementInputSchema.safeParse({ cwd: "/repo", task: "x", max_changed_files: 101 }).success).toBe(false);
  });
});
