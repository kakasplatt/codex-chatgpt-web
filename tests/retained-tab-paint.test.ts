import { expect, test } from "bun:test";
import { sampleRetainedTabFrames } from "../src/adapters/chatgpt-web/retained-tab-paint";

test("sampleRetainedTabFrames returns the page frame count", async () => {
  expect(await sampleRetainedTabFrames(async () => ({ count: 84 }), 1_000)).toBe(84);
});

test("sampleRetainedTabFrames times out as zero frames", async () => {
  expect(await sampleRetainedTabFrames(() => new Promise<{ count: number }>(() => {}), 20)).toBe(0);
});

test("sampleRetainedTabFrames rethrows non-timeout errors", async () => {
  await expect(sampleRetainedTabFrames(async () => { throw new Error("Target closed"); }, 1_000)).rejects.toThrow("Target closed");
});

test("sampleRetainedTabFrames swallows late rejections of a timed-out evaluate", async () => {
  let rejectLate: (error: Error) => void = () => {};
  const evaluate = () => new Promise<{ count: number }>((_, reject) => { rejectLate = reject; });
  expect(await sampleRetainedTabFrames(evaluate, 10)).toBe(0);
  rejectLate(new Error("Target closed"));
  await new Promise(resolve => setTimeout(resolve, 10));
});
