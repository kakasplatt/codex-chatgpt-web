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
