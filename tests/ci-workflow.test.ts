import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");

describe("CI workflow", () => {
  it("runs security:grep after tests", () => {
    const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
    const testIdx = workflow.indexOf("run: npm test");
    const securityIdx = workflow.indexOf("run: npm run security:grep");

    expect(testIdx).toBeGreaterThanOrEqual(0);
    expect(securityIdx).toBeGreaterThan(testIdx);
  });
});
