/** Periodic structure-only probe of a multipart acknowledgement wait; never carries page text. */
export interface AckWaitProbeSample {
  /** Round trip of a trivial page evaluate; null when it timed out or failed. */
  evaluateLatencyMs: number | null;
  stopVisible: boolean;
  boundTurnCount: number;
  responsePresent: boolean;
  completionActionVisible: boolean;
  textChars: number;
}

export class AckWaitProbeSchedule {
  private nextAt: number;

  constructor(private readonly intervalMs: number, private readonly now: () => number = Date.now) {
    this.nextAt = now() + intervalMs;
  }

  due(): boolean {
    const now = this.now();
    if (now < this.nextAt) return false;
    this.nextAt = now + this.intervalMs;
    return true;
  }
}

export async function measureEvaluateLatency(
  evaluate: () => Promise<unknown>,
  timeoutMs: number,
): Promise<number | null> {
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      evaluate(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("evaluate probe timed out")), timeoutMs);
      }),
    ]);
    return Math.round(performance.now() - startedAt);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function formatAckWaitProbe(
  context: { stage: number; elapsedMs: number },
  sample: AckWaitProbeSample,
): string {
  return `[chatgpt-web] ack_wait_probe ${JSON.stringify({ ...context, ...sample })}`;
}
