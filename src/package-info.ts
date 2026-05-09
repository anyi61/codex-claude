import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let cached: { name: string; version: string } | undefined;

export async function getPackageInfo(): Promise<{ name: string; version: string }> {
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = resolve(here, "..", "package.json");
  const raw = await readFile(packageJsonPath, "utf8");
  cached = JSON.parse(raw) as { name: string; version: string };
  return cached;
}
