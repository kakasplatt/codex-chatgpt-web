/** Window over which a retained tab's animation frames are counted. */
export const RETAINED_TAB_FRAME_WINDOW_MS = 500;
/** Playwright's click stability check needs two consecutive animation frames. */
export const RETAINED_TAB_MIN_FRAMES = 2;

/**
 * Count the frames a retained tab produced. A renderer that stopped painting can also stop answering
 * evaluate, so a probe that does not settle within `timeoutMs` counts as zero frames. This module must not
 * import browser-worker.ts, which imports it.
 */
export async function sampleRetainedTabFrames(evaluate: () => Promise<{ count: number }>, timeoutMs: number): Promise<number> {
  const sample = evaluate();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); });
  try {
    const result = await Promise.race([sample, timeout]);
    if (result === null) {
      void sample.catch(() => {});
      return 0;
    }
    return result.count;
  } finally {
    clearTimeout(timer);
  }
}

export const CHATGPT_RETAINED_TAB_NOT_PAINTING_MESSAGE =
  "The retained ChatGPT tab stopped rendering frames; the turn will be retried in a new tab.";

/**
 * Only a saved conversation survives a reload. A temporary chat, or any page outside a conversation, would
 * lose the conversation that the retained lease owns.
 */
export function isReloadableRetainedConversation(url: string, useSavedChats: boolean): boolean {
  if (!useSavedChats) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.origin === "https://chatgpt.com"
    && /^\/(g\/[^/]+\/)?c\/[^/]+\/?$/.test(parsed.pathname)
    && !parsed.searchParams.has("temporary-chat");
}

export type RetainedTabPaintOutcome = "painting" | "repainted" | "reloaded";

function retainedTabAbortError(): DOMException {
  return new DOMException("ChatGPT web turn aborted", "AbortError");
}

/** Settle with `promise`, or reject with an AbortError as soon as `signal` aborts. */
async function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => {});
    throw retainedTabAbortError();
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(retainedTabAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } catch (error) {
    void promise.catch(() => {});
    if (signal.aborted) throw retainedTabAbortError();
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort!);
  }
}

/**
 * Before a reused tab is driven, prove it paints: repaint it, then (saved chats only) reload the same
 * conversation, and otherwise fail fast so the turn is retried in a new tab before any prompt is placed.
 */
export async function ensureRetainedTabPaints(deps: {
  sample: () => Promise<number>;
  refresh: () => Promise<void>;
  reload?: () => Promise<void>;
  signal?: AbortSignal;
  log: (line: string) => void;
  traceId: string;
}): Promise<RetainedTabPaintOutcome> {
  const { signal } = deps;
  const run = async <T>(step: () => Promise<T>): Promise<T> => {
    if (signal?.aborted) throw retainedTabAbortError();
    const value = await untilAborted(step(), signal);
    if (signal?.aborted) throw retainedTabAbortError();
    return value;
  };
  const frames: { first: number | null; afterRepaint: number | null; afterReload: number | null } = {
    first: null, afterRepaint: null, afterReload: null,
  };
  const finish = (outcome: RetainedTabPaintOutcome | "stalled", reloadError?: unknown) => {
    deps.log(`[chatgpt-web] retained_tab_frames ${JSON.stringify({
      traceId: deps.traceId,
      ...frames,
      reloadEligible: deps.reload !== undefined,
      // The error name only: a message can carry page or account text.
      ...(reloadError !== undefined ? { reloadError: reloadError instanceof Error ? reloadError.name : typeof reloadError } : {}),
      outcome,
    })}`);
    if (outcome === "stalled") {
      throw reloadError === undefined
        ? new Error(CHATGPT_RETAINED_TAB_NOT_PAINTING_MESSAGE)
        : new Error(CHATGPT_RETAINED_TAB_NOT_PAINTING_MESSAGE, { cause: reloadError });
    }
    return outcome;
  };

  frames.first = await run(deps.sample);
  if (frames.first >= RETAINED_TAB_MIN_FRAMES) return finish("painting");
  await run(deps.refresh);
  frames.afterRepaint = await run(deps.sample);
  if (frames.afterRepaint >= RETAINED_TAB_MIN_FRAMES) return finish("repainted");
  const { reload } = deps;
  if (!reload) return finish("stalled");
  try {
    await run(reload);
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      throw retainedTabAbortError();
    }
    return finish("stalled", error);
  }
  frames.afterReload = await run(deps.sample);
  return finish(frames.afterReload >= RETAINED_TAB_MIN_FRAMES ? "reloaded" : "stalled");
}
