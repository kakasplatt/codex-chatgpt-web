import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lockfile = readFileSync(join(root, "bun.lock"), "utf8");

// GHSA-mrhx-c7xc-m3w5 affects zod < 4.6.6. The only 3.x copy came from chromium-bidi, which is no
// longer a dependency, so the root audit runs without ignores and must stay that way.
function zodFixed(version: string): boolean {
  const [major, minor, patch] = version.split(".").map(Number);
  return major > 4 || (major === 4 && (minor > 6 || (minor === 6 && patch >= 6)));
}

test("the root audit ignores no advisory", () => {
  expect(manifest.scripts.audit).toBe("bun audit");
  expect(manifest.dependencies["chromium-bidi"]).toBeUndefined();
});

test("no package resolves a zod release affected by GHSA-mrhx-c7xc-m3w5", () => {
  const entries = [...lockfile.matchAll(/^\s*"([^"]+)": \["zod@([^"]+)"/gm)].map(([, key, version]) => ({ key, version }));
  expect(entries.find(entry => entry.key === "zod")?.version).toBeDefined();
  expect(entries.filter(entry => !zodFixed(entry.version)).map(entry => entry.key)).toEqual([]);
});
