import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lockfile = readFileSync(join(root, "bun.lock"), "utf8");

// GHSA-mrhx-c7xc-m3w5 (zod < 4.6.6) has no fixed 3.x release. chromium-bidi 12.1.0, pinned to
// match playwright-core 1.62, requires zod ^3.24.1 and is loaded only by Playwright's BiDi
// Chromium channel, which this project never launches. The audit ignore is keyed on the advisory,
// not the path, so this test keeps it from hiding a vulnerable zod anywhere else.
const zodAdvisory = "GHSA-mrhx-c7xc-m3w5";

function zodFixed(version: string): boolean {
  const [major, minor, patch] = version.split(".").map(Number);
  return major > 4 || (major === 4 && (minor > 6 || (minor === 6 && patch >= 6)));
}

test("the root audit ignores only the zod advisory that chromium-bidi cannot fix", () => {
  expect(manifest.scripts.audit).toBe(`bun audit --ignore=${zodAdvisory}`);
  expect(manifest.dependencies["chromium-bidi"]).toBe("12.1.0");
});

test("only chromium-bidi resolves a zod release affected by the ignored advisory", () => {
  const entries = [...lockfile.matchAll(/^\s*"([^"]+)": \["zod@([^"]+)"/gm)].map(([, key, version]) => ({ key, version }));
  expect(entries.find(entry => entry.key === "zod")?.version).toBeDefined();
  expect(entries.filter(entry => !zodFixed(entry.version)).map(entry => entry.key)).toEqual(["chromium-bidi/zod"]);
});
