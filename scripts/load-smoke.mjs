import { performance } from "node:perf_hooks";

const origin = process.env.SNAPPYDIFF_LOAD_ORIGIN;
if (!origin) throw new Error("SNAPPYDIFF_LOAD_ORIGIN is required");
const durationSeconds = Number(process.env.SNAPPYDIFF_LOAD_SECONDS ?? 30);
const concurrency = Number(process.env.SNAPPYDIFF_LOAD_CONCURRENCY ?? 20);
const path = process.env.SNAPPYDIFF_LOAD_PATH ?? "/health";
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 200) throw new Error("Concurrency must be 1..200");
if (!Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 900) throw new Error("Duration must be 1..900 seconds");

const deadline = performance.now() + durationSeconds * 1000;
const latencies = [];
let failures = 0;
let requests = 0;
async function worker() {
  while (performance.now() < deadline) {
    const started = performance.now();
    try {
      const response = await fetch(new URL(path, origin), { redirect: "manual" });
      if (!response.ok) failures++;
      await response.arrayBuffer();
    } catch {
      failures++;
    }
    latencies.push(performance.now() - started);
    requests++;
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
latencies.sort((a, b) => a - b);
const percentile = (value) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * value))] ?? 0;
const result = {
  requests, failures, failureRate: requests ? failures / requests : 1,
  requestsPerSecond: requests / durationSeconds,
  latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
};
console.log(JSON.stringify(result, null, 2));
if (result.failureRate > 0.01) process.exitCode = 1;
