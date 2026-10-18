/**
 * Optional Windows-first launcher/Chrome process-tree sampler.
 *
 * Run while executing the same authenticated Codex workloads under each browser
 * engine. It intentionally does not send ChatGPT messages or read browser state.
 * The results are observations, not a claim that headless is faster.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

export interface ProcessReading {
  pid: number;
  cpuMs: number;
  rssBytes: number;
}

export interface BenchmarkReading {
  at: number;
  processes: ProcessReading[];
}

export function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) throw new Error("Invalid percentile");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

export function summarize(readings: BenchmarkReading[]): {
  samples: number;
  peakCombinedRssBytes: number;
  p50CombinedRssBytes: number | null;
  p95CombinedRssBytes: number | null;
  p50CombinedCpuPercentOfOneCore: number | null;
  p95CombinedCpuPercentOfOneCore: number | null;
} {
  const ordered = [...readings].sort((a, b) => a.at - b.at);
  const rss = ordered.map(row => row.processes.reduce((sum, p) => sum + p.rssBytes, 0));
  const cpu = [];
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1];
    const next = ordered[i];
    const elapsed = next.at - previous.at;
    if (elapsed <= 0) continue;
    const baseline = new Map(previous.processes.map(p => [p.pid, p.cpuMs]));
    // A newly discovered process has no prior baseline and is included in
    // CPU deltas only from its next reading. Exited processes are undersampled.
    const used = next.processes.reduce((total, p) =>
      total + Math.max(0, p.cpuMs - (baseline.get(p.pid) ?? p.cpuMs)), 0);
    cpu.push(used / elapsed * 100);
  }
  return {
    samples: ordered.length,
    peakCombinedRssBytes: rss.length ? Math.max(...rss) : 0,
    p50CombinedRssBytes: percentile(rss, 0.5),
    p95CombinedRssBytes: percentile(rss, 0.95),
    p50CombinedCpuPercentOfOneCore: percentile(cpu, 0.5),
    p95CombinedCpuPercentOfOneCore: percentile(cpu, 0.95),
  };
}

function windowsProcessTree(rootPid: number): ProcessReading[] {
  const script = `
$ErrorActionPreference = 'Stop'
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
$owned = New-Object 'System.Collections.Generic.HashSet[int]'
[void]$owned.Add(${rootPid})
do {
  $before = $owned.Count
  foreach ($p in $all) {
    if ($owned.Contains([int]$p.ParentProcessId)) { [void]$owned.Add([int]$p.ProcessId) }
  }
} while ($owned.Count -ne $before)
$result = @(
  Get-Process -Id @($owned) -ErrorAction SilentlyContinue |
    ForEach-Object { @{ pid = [int]$_.Id; cpuMs = [double]($_.CPU * 1000); rssBytes = [double]$_.WorkingSet64 } }
)
ConvertTo-Json -InputObject $result -Compress -Depth 3
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", timeout: 20_000, windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Process sampling failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
  const data: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(data)) throw new Error("Windows process sampler returned invalid JSON");
  return data.map((row: Record<string, unknown>) => {
    const pid = Number(row.pid), cpuMs = Number(row.cpuMs), rssBytes = Number(row.rssBytes);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(cpuMs) || !Number.isFinite(rssBytes)) {
      throw new Error("Windows process sampler returned invalid process data");
    }
    return { pid, cpuMs, rssBytes };
  });
}

async function main(args: string[]): Promise<void> {
  if (process.platform !== "win32") throw new Error("This process-tree sampler currently supports Windows only");
  const option = (name: string): string => {
    const i = args.indexOf(name);
    if (i < 0 || i + 1 >= args.length) throw new Error(`Missing ${name}`);
    const value = args[i + 1];
    args.splice(i, 2);
    return value;
  };
  const engine = option("--engine");
  const rootPid = Number(option("--root-pid"));
  const seconds = Number(option("--seconds"));
  const output = option("--output");
  if (args.length || !["embedded", "headless"].includes(engine)
    || !Number.isSafeInteger(rootPid) || rootPid < 1
    || !Number.isInteger(seconds) || seconds < 2 || seconds > 900) {
    throw new Error("Usage: bun scripts/headless-benchmark.ts --engine embedded|headless --root-pid PID --seconds 60 --output measurements.json");
  }
  const readings: BenchmarkReading[] = [];
  for (let i = 0; i <= seconds; i++) {
    readings.push({ at: Date.now(), processes: windowsProcessTree(rootPid) });
    if (i < seconds) await Bun.sleep(1000);
  }
  const report = {
    engine, rootPid, elapsedMs: readings.at(-1)!.at - readings[0].at,
    ...summarize(readings),
    note: "Samples include launcher descendants. CPU excludes exited processes; combined working sets can double-count shared memory. Real browser turn correctness and DOM stalls must be assessed separately.",
  };
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.main) main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
