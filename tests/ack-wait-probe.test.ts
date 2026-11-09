import { expect, test } from "bun:test";
import { AckWaitProbeSchedule, formatAckWaitProbe, measureEvaluateLatency } from "../src/adapters/chatgpt-web/ack-wait-probe";

test("the probe is due once per interval, not on every poll", () => {
  let now = 1_000;
  const schedule = new AckWaitProbeSchedule(15_000, () => now);
  expect(schedule.due()).toBe(false);
  now += 14_999;
  expect(schedule.due()).toBe(false);
  now += 1;
  expect(schedule.due()).toBe(true);
  expect(schedule.due()).toBe(false);
  now += 15_000;
  expect(schedule.due()).toBe(true);
});

test("latency of a fast evaluate is reported in milliseconds", async () => {
  const latency = await measureEvaluateLatency(async () => 1, 200);
  expect(latency).not.toBeNull();
  expect(latency!).toBeLessThan(200);
});

test("an evaluate that never answers reports null instead of hanging or throwing", async () => {
  expect(await measureEvaluateLatency(() => new Promise(() => {}), 20)).toBeNull();
  expect(await measureEvaluateLatency(async () => { throw new Error("detached"); }, 20)).toBeNull();
});

test("the probe line names every fact needed to separate the stall hypotheses", () => {
  const line = formatAckWaitProbe(
    { stage: 8, elapsedMs: 30_000 },
    { evaluateLatencyMs: null, stopVisible: true, boundTurnCount: 0, responsePresent: false, completionActionVisible: false, textChars: 0 },
  );
  expect(line.startsWith("[chatgpt-web] ack_wait_probe ")).toBe(true);
  expect(JSON.parse(line.slice("[chatgpt-web] ack_wait_probe ".length))).toEqual({
    stage: 8, elapsedMs: 30_000, evaluateLatencyMs: null, stopVisible: true,
    boundTurnCount: 0, responsePresent: false, completionActionVisible: false, textChars: 0,
  });
});
