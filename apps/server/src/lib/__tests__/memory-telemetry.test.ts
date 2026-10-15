import { afterEach, describe, expect, it } from 'vitest';
import {
  MEMORY_SAMPLES_KEPT,
  memorySample,
  memoryStatus,
  recordMemorySample,
  resetMemoryTelemetryForTests,
} from '../memory-telemetry.js';

const MB = 1_048_576;
const usage = (rss: number, heapTotal: number, heapUsed: number, external = 50, arrayBuffers = 20): NodeJS.MemoryUsage => ({
  rss: rss * MB,
  heapTotal: heapTotal * MB,
  heapUsed: heapUsed * MB,
  external: external * MB,
  arrayBuffers: arrayBuffers * MB,
});

describe('memory telemetry (measurement only)', () => {
  afterEach(() => resetMemoryTelemetryForTests());

  it('splits resident memory into the reserved heap and what lives outside it', () => {
    const s = memorySample(1, usage(2268, 1400, 1100), 2240 * MB);
    expect(s).toEqual({ at: 1, rssMb: 2268, heapUsedMb: 1100, heapTotalMb: 1400, externalMb: 50, arrayBuffersMb: 20, outsideHeapMb: 868, heapLimitMb: 2240 });
  });

  it('never reports a negative outside-heap figure', () => {
    expect(memorySample(1, usage(500, 600, 400), 2240 * MB).outsideHeapMb).toBe(0);
  });

  it('keeps the last 24 hours of samples and the peak since boot', () => {
    for (let i = 0; i < MEMORY_SAMPLES_KEPT + 10; i++) recordMemorySample(memorySample(i, usage(600 + (i === 5 ? 4000 : i), 500, 400), 2240 * MB));
    const st = memoryStatus(true);
    expect(st.samples).toHaveLength(MEMORY_SAMPLES_KEPT);
    expect(st.samples![0].at).toBe(10);
    expect(st.peakSinceBoot!.at).toBe(5); // the peak survives after its sample has rolled out
    expect(st.peakSinceBoot!.rssMb).toBe(4600);
  });

  it('keeps /api/health light: the full series only when asked', () => {
    recordMemorySample(memorySample(1, usage(700, 500, 400), 2240 * MB));
    expect(memoryStatus()).not.toHaveProperty('samples');
    expect(memoryStatus(true).samples).toHaveLength(1);
  });
});
