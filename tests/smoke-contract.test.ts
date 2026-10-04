import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("cancellation smoke derives its user-visible message from the production error factory", () => {
  const smoke = readFileSync("scripts/smoke-codex-cancel.ts", "utf8");

  expect(smoke).toContain('import { chatGptBrowserTabClosedError } from "../src/adapters/chatgpt-web/adapter-error";');
  expect(smoke).toContain("const cancellation = chatGptBrowserTabClosedError();");
  expect(smoke).not.toContain("The ChatGPT browser tab was closed, so the Codex turn was cancelled.");
});
