// ============================================================
// MEMORY TELEMETRY — what the backend process holds (2026-10-15)
// ============================================================
// Measurement only. Nothing reads these samples to decide anything.
//
// Why: Railway bills memory held over time, and this process climbs from
// ~0.6 GB after a restart to 2-4 GB by the end of a market day, falling back
// only on a redeploy. Its peak (4.1 GB) is above V8's own heap limit (2.24 GB),
// so part of it lives outside the JavaScript heap: buffers, or the C allocator's
// per-thread arenas that never shrink (the container reports 48 CPUs;
// MALLOC_ARENA_MAX caps them). These samples split the two, so the fix can be
// aimed at what actually grows.
//
// What: process.memoryUsage() + the V8 heap limit every 15 minutes, the last 24
// hours kept in memory (96 samples), the peak since boot, and one log line per
// sample. Served at GET /api/health/memory; /api/health carries the latest.
// ============================================================

import v8 from 'node:v8';
import { logger } from './logger.js';

export const MEMORY_SAMPLE_MS = 15 * 60_000;
/** 24 hours of 15-minute samples. */
export const MEMORY_SAMPLES_KEPT = 96;

export interface MemorySample {
  at: number;
  /** Resident memory of the whole process: what the container (and the bill) sees. */
  rssMb: number;
  /** Live JavaScript objects. */
  heapUsedMb: number;
  /** Heap V8 has reserved, used or not. */
  heapTotalMb: number;
  /** Memory of C++ objects bound to JavaScript (includes arrayBuffers). */
  externalMb: number;
  /** Buffers and ArrayBuffers (HTTP bodies, socket frames). */
  arrayBuffersMb: number;
  /** Resident memory outside the reserved heap: buffers, code, and allocator arenas. */
  outsideHeapMb: number;
  /** The most V8 will let the heap grow to. */
  heapLimitMb: number;
}

const mb = (bytes: number) => Math.round(bytes / 1_048_576);

/** Pure: one sample from the given readings. */
export function memorySample(
  at: number = Date.now(),
  usage: NodeJS.MemoryUsage = process.memoryUsage(),
  heapLimitBytes: number = v8.getHeapStatistics().heap_size_limit
): MemorySample {
  return {
    at,
    rssMb: mb(usage.rss),
    heapUsedMb: mb(usage.heapUsed),
    heapTotalMb: mb(usage.heapTotal),
    externalMb: mb(usage.external),
    arrayBuffersMb: mb(usage.arrayBuffers),
    outsideHeapMb: Math.max(0, mb(usage.rss) - mb(usage.heapTotal)),
    heapLimitMb: mb(heapLimitBytes),
  };
}

const samples: MemorySample[] = [];
let peak: MemorySample | null = null;
let timer: NodeJS.Timeout | null = null;

/** Keep a sample (the oldest beyond MEMORY_SAMPLES_KEPT is dropped) and track the peak by resident memory. */
export function recordMemorySample(sample: MemorySample = memorySample()): MemorySample {
  samples.push(sample);
  if (samples.length > MEMORY_SAMPLES_KEPT) samples.splice(0, samples.length - MEMORY_SAMPLES_KEPT);
  if (!peak || sample.rssMb > peak.rssMb) peak = sample;
  return sample;
}

export function memoryStatus(full = false) {
  return {
    now: memorySample(),
    peakSinceBoot: peak,
    mallocArenaMax: process.env.MALLOC_ARENA_MAX ?? null,
    nodeOptions: process.env.NODE_OPTIONS ?? null,
    ...(full ? { sampleEveryMinutes: MEMORY_SAMPLE_MS / 60_000, samples: [...samples] } : {}),
  };
}

export function startMemoryTelemetry(): void {
  if (timer) return;
  const tick = () => logger.info(recordMemorySample(), 'Memory');
  tick();
  timer = setInterval(tick, MEMORY_SAMPLE_MS);
  timer.unref();
}

export function stopMemoryTelemetry(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Tests only. */
export function resetMemoryTelemetryForTests(): void {
  stopMemoryTelemetry();
  samples.length = 0;
  peak = null;
}
