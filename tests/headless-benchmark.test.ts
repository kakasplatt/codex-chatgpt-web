import { expect, test } from "bun:test";
import { percentile, summarize } from "../scripts/headless-benchmark";

test("percentiles never mutate the input and empty samples remain explicit", () => {
  const values = [90, 10, 40, 20, 60];
  expect(percentile(values, 0.5)).toBe(40);
  expect(percentile(values, 0.95)).toBe(90);
  expect(values).toEqual([90, 10, 40, 20, 60]);
  expect(percentile([], 0.95)).toBeNull();
  expect(() => percentile([1], 2)).toThrow("Invalid percentile");
  expect(summarize([])).toEqual({ samples: 0, peakCombinedRssBytes: 0,
    p50CombinedRssBytes: null, p95CombinedRssBytes: null,
    p50CombinedCpuPercentOfOneCore: null, p95CombinedCpuPercentOfOneCore: null });
});

test("process-tree benchmark uses CPU deltas and total working sets without sampling its own process", () => {
  const result = summarize([
    { at: 1000, processes: [{ pid: 1, cpuMs: 100, rssBytes: 20 }, { pid: 2, cpuMs: 50, rssBytes: 30 }] },
    { at: 2000, processes: [{ pid: 1, cpuMs: 200, rssBytes: 40 }, { pid: 2, cpuMs: 100, rssBytes: 35 }] },
    { at: 3000, processes: [{ pid: 1, cpuMs: 300, rssBytes: 50 }, { pid: 3, cpuMs: 25, rssBytes: 5 }] },
  ]);
  expect(result).toEqual({ samples: 3, peakCombinedRssBytes: 75,
    p50CombinedRssBytes: 55, p95CombinedRssBytes: 75,
    p50CombinedCpuPercentOfOneCore: 10, p95CombinedCpuPercentOfOneCore: 15 });
});
