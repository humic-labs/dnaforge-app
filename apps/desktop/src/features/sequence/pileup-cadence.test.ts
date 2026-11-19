// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startCadence, stopCadence } from '../../../scripts/lib/pileup-performance-journey.mjs';

const page = { evaluate: (fn: (value?: unknown) => unknown, value?: unknown) => fn(value) };
type Frame = {
  startTime: number;
  duration: number;
  blockingDuration: number;
  scripts: { sourceURL: string; sourceFunctionName?: string; duration: number }[];
};
let observers: TestObserver[];
let now: number;
let failFrames: boolean;
class TestObserver {
  static supportedEntryTypes = ['longtask', 'long-animation-frame'];
  records: Frame[] = [];
  type?: string;
  disconnect = vi.fn();
  constructor(public callback: (list: { getEntries: () => Frame[] }) => void) {
    observers.push(this);
  }
  observe({ type }: { type: string }) {
    this.type = type;
    if (failFrames && type === 'long-animation-frame') throw new Error('unavailable');
  }
  takeRecords() {
    return this.records.splice(0);
  }
}

beforeEach(() => {
  vi.stubGlobal('window', {});
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('location', new URL('http://localhost:1420'));
  observers = [];
  failFrames = false;
  now = 100;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1)
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  TestObserver.supportedEntryTypes = ['longtask', 'long-animation-frame'];
  vi.stubGlobal('PerformanceObserver', TestObserver);
});

afterEach(() => {
  const capture = Reflect.get(window, '__pileupPerformanceCapture');
  if (capture) document.removeEventListener('wheel', capture.onWheel, true);
  Reflect.deleteProperty(window, '__pileupPerformanceCapture');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('pileup cadence receipt', () => {
  it('records trusted delivery relative to the existing renderer start', async () => {
    await startCadence(page);
    const capture = Reflect.get(window, '__pileupPerformanceCapture');
    now = 120;
    capture.onWheel({ isTrusted: false, deltaY: 5 });
    expect(capture.wheel.firstTrustedEventMs).toBeNull();
    now = 140;
    capture.onWheel({ isTrusted: true, deltaY: 10 });
    now = 170;
    capture.onWheel({ isTrusted: true, deltaY: 10 });
    now = 190;
    const result = await stopCadence(page, 25);
    expect(result.durationMs).toBe(90);
    expect(result.wheel).toEqual({
      eventCount: 3,
      deltaY: 25,
      untrustedCount: 1,
      firstTrustedEventMs: 40,
      lastTrustedEventMs: 70,
    });
    expect(observers.every((observer) => observer.disconnect.mock.calls.length === 1)).toBe(true);
  });

  it('bounds attribution and retains only application script names', async () => {
    await startCadence(page);
    const frame = observers.find((observer) => observer.type === 'long-animation-frame');
    if (!frame) throw new Error('Frame observer missing');
    const script = (sourceURL: string, sourceFunctionName = 'paintReads') => ({
      sourceURL,
      sourceFunctionName,
      duration: 80,
    });
    const entry = {
      startTime: 110,
      duration: 100,
      blockingDuration: 50,
      scripts: [
        script(`${location.origin}/src/renderer.ts?token=secret`),
        script('file:///Users/private/project/private.js', '/Users/private/project'),
        script('https://other.example/src/private.js?token=secret'),
        script(`${location.origin}/user-files/private.js`, undefined),
        script(`${location.origin}/assets/extra.js`),
      ],
    };
    frame.callback({ getEntries: () => [{ ...entry, startTime: 99 }, ...Array(10).fill(entry)] });
    frame.records.push(entry);
    now = 300;
    const result = await stopCadence(page, 0);
    expect(result.wheel.firstTrustedEventMs).toBeNull();
    expect(result.wheel.lastTrustedEventMs).toBeNull();
    expect(result.longAnimationFrames.status).toBe('available');
    expect(result.longAnimationFrames.entries).toHaveLength(8);
    expect(result.longAnimationFrames.omittedEntries).toBe(3);
    expect(result.longAnimationFrames.entries[0]).toEqual({
      startMs: 10,
      durationMs: 100,
      blockingDurationMs: 50,
      omittedScripts: 1,
      scripts: [
        { filename: 'renderer.ts', functionName: 'paintReads', durationMs: 80 },
        { filename: null, functionName: null, durationMs: 80 },
        { filename: null, functionName: null, durationMs: 80 },
        { filename: null, functionName: null, durationMs: 80 },
      ],
    });
    const serialized = JSON.stringify(result.longAnimationFrames);
    for (const privateValue of ['://', '/Users/', 'private', 'secret', '?']) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('reports unsupported attribution without replacing existing cadence', async () => {
    TestObserver.supportedEntryTypes = ['longtask'];
    await startCadence(page);
    const result = await stopCadence(page, 0);
    expect(result.longAnimationFrames).toEqual({
      status: 'unsupported',
      entries: [],
      omittedEntries: 0,
    });
    expect(result.longTaskDurationsMs).toEqual([]);
  });

  it('reports observer registration failure without failing the gesture', async () => {
    failFrames = true;
    await startCadence(page);
    const result = await stopCadence(page, 0);
    expect(result.longAnimationFrames).toEqual({
      status: 'unavailable',
      entries: [],
      omittedEntries: 0,
    });
    expect(result.longTaskDurationsMs).toEqual([]);
  });
});
