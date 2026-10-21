import { expect, test } from "bun:test";
import {
  CHATGPT_RETAINED_TAB_NOT_PAINTING_MESSAGE,
  ensureRetainedTabPaints,
  isReloadableRetainedConversation,
  sampleRetainedTabFrames,
} from "../src/adapters/chatgpt-web/retained-tab-paint";

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

function ladder(samples: number[], options: { reload?: () => Promise<void>; reloadable?: boolean; signal?: AbortSignal } = {}) {
  const calls: string[] = [];
  const lines: string[] = [];
  const queue = [...samples];
  const reloadable = options.reloadable ?? true;
  const deps = {
    sample: async () => { calls.push("sample"); return queue.shift() ?? 0; },
    refresh: async () => { calls.push("refresh"); },
    ...(reloadable
      ? { reload: options.reload ?? (async () => { calls.push("reload"); }) }
      : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    log: (line: string) => { lines.push(line); },
    traceId: "trace_1",
  };
  return { deps, calls, lines };
}

function loggedFrames(lines: string[]): Record<string, unknown> {
  expect(lines).toHaveLength(1);
  const prefix = "[chatgpt-web] retained_tab_frames ";
  expect(lines[0]!.startsWith(prefix)).toBe(true);
  return JSON.parse(lines[0]!.slice(prefix.length));
}

test("continues without refresh when the retained tab paints", async () => {
  const { deps, calls, lines } = ladder([84]);
  expect(await ensureRetainedTabPaints(deps)).toBe("painting");
  expect(calls).toEqual(["sample"]);
  expect(lines[0]).toContain("\"outcome\":\"painting\"");
  expect(loggedFrames(lines)).toEqual({
    traceId: "trace_1", first: 84, afterRepaint: null, afterReload: null, reloadEligible: true, outcome: "painting",
  });
});

test("recovers after one repaint", async () => {
  const { deps, calls, lines } = ladder([0, 60]);
  expect(await ensureRetainedTabPaints(deps)).toBe("repainted");
  expect(calls).toEqual(["sample", "refresh", "sample"]);
  expect(loggedFrames(lines)).toMatchObject({ first: 0, afterRepaint: 60, afterReload: null, outcome: "repainted" });
});

test("reloads when the repaint is not enough", async () => {
  const { deps, calls, lines } = ladder([0, 0, 70]);
  expect(await ensureRetainedTabPaints(deps)).toBe("reloaded");
  expect(calls).toEqual(["sample", "refresh", "sample", "reload", "sample"]);
  expect(loggedFrames(lines)).toMatchObject({ first: 0, afterRepaint: 0, afterReload: 70, outcome: "reloaded" });
});

test("never reloads a temporary conversation", async () => {
  const { deps, calls, lines } = ladder([0, 0], { reloadable: false });
  await expect(ensureRetainedTabPaints(deps)).rejects.toThrow(CHATGPT_RETAINED_TAB_NOT_PAINTING_MESSAGE);
  expect(calls).toEqual(["sample", "refresh", "sample"]);
  expect(lines[0]).toContain("\"reloadEligible\":false");
  expect(lines[0]).toContain("\"outcome\":\"stalled\"");
  expect(loggedFrames(lines)).toMatchObject({ first: 0, afterRepaint: 0, afterReload: null });
});

test("fails fast when the reloaded tab still does not paint", async () => {
  const { deps, lines } = ladder([0, 0, 1]);
  const failure = await ensureRetainedTabPaints(deps).catch(error => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure.constructor).toBe(Error);
  expect(failure.message).toBe(CHATGPT_RETAINED_TAB_NOT_PAINTING_MESSAGE);
  expect(lines[0]).toContain("\"afterReload\":1");
  expect(loggedFrames(lines)).toMatchObject({ outcome: "stalled" });
});

test("a failed reload fails fast", async () => {
  const { deps, calls, lines } = ladder([0, 0], { reload: async () => { throw new Error("net::ERR_ABORTED"); } });
  const failure = await ensureRetainedTabPaints(deps).catch(error => error);
  expect(failure.message).toBe(CHATGPT_RETAINED_TAB_NOT_PAINTING_MESSAGE);
  expect(failure.message).not.toContain("ERR_ABORTED");
  expect(calls).toEqual(["sample", "refresh", "sample"]);
  expect(loggedFrames(lines)).toMatchObject({ afterReload: null, reloadEligible: true, outcome: "stalled" });
});

test("abort wins over the ladder", async () => {
  const controller = new AbortController();
  const { deps } = ladder([0, 0], {
    signal: controller.signal,
    reload: () => {
      setTimeout(() => controller.abort(), 5);
      return new Promise<void>(() => {});
    },
  });
  const failure = await ensureRetainedTabPaints(deps).catch(error => error);
  expect(failure.name).toBe("AbortError");
});

test("abort wins over a reload that fails because the turn was aborted", async () => {
  const controller = new AbortController();
  const { deps, lines } = ladder([0, 0], {
    signal: controller.signal,
    reload: async () => {
      controller.abort();
      throw new Error("net::ERR_ABORTED");
    },
  });
  const failure = await ensureRetainedTabPaints(deps).catch(error => error);
  expect(failure.name).toBe("AbortError");
  expect(lines).toHaveLength(0);
});

test("an already aborted signal never samples", async () => {
  const controller = new AbortController();
  controller.abort();
  const { deps, calls } = ladder([84], { signal: controller.signal });
  const failure = await ensureRetainedTabPaints(deps).catch(error => error);
  expect(failure.name).toBe("AbortError");
  expect(calls).toEqual([]);
});

test("isReloadableRetainedConversation accepts only saved conversations", () => {
  expect(isReloadableRetainedConversation("https://chatgpt.com/c/abc", true)).toBe(true);
  expect(isReloadableRetainedConversation("https://chatgpt.com/g/g-x/c/abc", true)).toBe(true);
  expect(isReloadableRetainedConversation("https://chatgpt.com/c/abc", false)).toBe(false);
  expect(isReloadableRetainedConversation("https://chatgpt.com/?temporary-chat=true", true)).toBe(false);
  expect(isReloadableRetainedConversation("https://chatgpt.com/c/abc?temporary-chat=true", true)).toBe(false);
  expect(isReloadableRetainedConversation("https://chatgpt.com/", true)).toBe(false);
  expect(isReloadableRetainedConversation("https://example.com/c/abc", true)).toBe(false);
  expect(isReloadableRetainedConversation("not a url", true)).toBe(false);
});
