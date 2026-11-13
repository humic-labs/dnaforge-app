import { describe, it, expect, beforeEach, vi } from 'vitest';

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__enableDiag = true;
  vi.resetModules();
});

describe('diagnostics', () => {
  it('samples the visible part of a clipped chip rather than its offscreen center', async () => {
    const { visiblePaintedBandMidpoint } = await import('../diagnostics');
    expect(visiblePaintedBandMidpoint(-10.4147647167474, 14, 688, 2)).toBe(2);
    expect(visiblePaintedBandMidpoint(685, 14, 688, 2)).toBe(686.5);
    expect(visiblePaintedBandMidpoint(-20, 14, 688, 2)).toBeNull();
    expect(visiblePaintedBandMidpoint(688, 14, 688, 2)).toBeNull();
    expect(visiblePaintedBandMidpoint(687.8, 0.2, 688, 2)).toBeNull();
  });
  it('captures events with monotonic timestamps', async () => {
    const { diag } = await import('../diagnostics');
    diag.clear();
    diag.enable();
    diag.capture({ type: 'marker', label: 'a' });
    diag.capture({ type: 'marker', label: 'b' });
    diag.capture({ type: 'marker', label: 'c' });
    const events = diag.events();
    expect(events.length).toBe(3);
    expect(events[0].type).toBe('marker');
    expect(events[0].t).toBeGreaterThanOrEqual(0);
    expect(events[1].t).toBeGreaterThanOrEqual(events[0].t);
    expect(events[2].t).toBeGreaterThanOrEqual(events[1].t);
  });

  it('captures typed events with full payload', async () => {
    const { diag } = await import('../diagnostics');
    diag.clear();
    diag.enable();
    diag.capture({
      type: 'scroll',
      scrollTop: 1234,
      scrollHeight: 5000,
      clientHeight: 800,
    });
    diag.capture({
      type: 'layout',
      totalHeight: 4000,
      totalLineCount: 200,
      lineH: 20,
      lazyMode: false,
      computeRangeFirst: 0,
      computeRangeLast: 199,
      sequenceLength: 2686,
      isCircular: true,
    });
    diag.capture({
      type: 'worker-viewport-post',
      requestSeq: 1,
      viewportSeq: 1,
      scrollTop: 1200,
      height: 700,
      reason: 'scroll',
      queueDelayMs: 0.4,
    });
    const scrollEvents = diag.eventsOfType('scroll');
    const layoutEvents = diag.eventsOfType('layout');
    const workerPosts = diag.eventsOfType('worker-viewport-post');
    expect(scrollEvents.length).toBe(1);
    expect(scrollEvents[0].scrollTop).toBe(1234);
    expect(layoutEvents.length).toBe(1);
    expect(layoutEvents[0].sequenceLength).toBe(2686);
    expect(workerPosts[0].queueDelayMs).toBe(0.4);
  });

  it('respects enabled flag', async () => {
    const { diag } = await import('../diagnostics');
    diag.clear();
    diag.disable();
    diag.capture({ type: 'marker', label: 'suppressed' });
    expect(diag.events().length).toBe(0);
    diag.enable();
    diag.capture({ type: 'marker', label: 'kept' });
    expect(diag.events().length).toBe(1);
  });

  it('ring buffer evicts oldest when full', async () => {
    const { diag } = await import('../diagnostics');
    diag.clear();
    diag.enable();
    for (let i = 0; i < 50_050; i++) {
      diag.capture({ type: 'marker', label: `m${i}` });
    }
    const events = diag.events();
    expect(events.length).toBe(50_000);
    const first = events[0] as { type: 'marker'; label: string };
    const last = events[events.length - 1] as { type: 'marker'; label: string };
    expect(first.label).toBe('m50');
    expect(last.label).toBe('m50049');
  });

  it('captures console.log/warn/error when enabled', async () => {
    const { diag } = await import('../diagnostics');
    diag.clear();
    diag.enable();
    console.log('hello', 1);
    console.warn('warn-msg');
    console.error('err-msg');
    const consoleEvents = diag.eventsOfType('console');
    expect(consoleEvents.length).toBeGreaterThanOrEqual(3);
    const log = consoleEvents.find((e) => e.level === 'log');
    const warn = consoleEvents.find((e) => e.level === 'warn');
    const err = consoleEvents.find((e) => e.level === 'error');
    expect(log?.msg).toContain('hello');
    expect(warn?.msg).toBe('warn-msg');
    expect(err?.msg).toBe('err-msg');
  });

  it('snapshot returns ordered events and counts by type', async () => {
    const { diag } = await import('../diagnostics');
    diag.clear();
    diag.enable();
    diag.capture({ type: 'marker', label: 'a' });
    diag.capture({
      type: 'scroll',
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 500,
    });
    diag.capture({ type: 'marker', label: 'b' });
    const snap = diag.snapshot();
    expect(snap.events.length).toBe(3);
    expect(snap.eventCounts.marker).toBe(2);
    expect(snap.eventCounts.scroll).toBe(1);
    expect(snap.firstT).not.toBeNull();
    expect(snap.lastT).toBeGreaterThanOrEqual(snap.firstT!);
  });

  it('subscribe fires synchronously on capture and can be unsubscribed', async () => {
    const { diag } = await import('../diagnostics');
    diag.clear();
    diag.enable();
    const received: string[] = [];
    const unsub = diag.subscribe((e) => {
      if (e.type === 'marker') received.push(e.label);
    });
    diag.capture({ type: 'marker', label: 'alpha' });
    diag.capture({ type: 'marker', label: 'beta' });
    expect(received).toEqual(['alpha', 'beta']);
    unsub();
    diag.capture({ type: 'marker', label: 'gamma' });
    expect(received).toEqual(['alpha', 'beta']);
  });

  it('subscribe: errors in one subscriber do not block others', async () => {
    const { diag } = await import('../diagnostics');
    diag.clear();
    diag.enable();
    let reachedSecond = false;
    const unsubA = diag.subscribe(() => {
      throw new Error('subscriber-A boom');
    });
    const unsubB = diag.subscribe(() => {
      reachedSecond = true;
    });
    diag.capture({ type: 'marker', label: 'test' });
    expect(reachedSecond).toBe(true);
    unsubA();
    unsubB();
  });

  it('subscribe fan-out respects enabled flag', async () => {
    const { diag } = await import('../diagnostics');
    diag.clear();
    diag.disable();
    let count = 0;
    const unsub = diag.subscribe(() => {
      count++;
    });
    diag.capture({ type: 'marker', label: 'noop' });
    expect(count).toBe(0);
    diag.enable();
    diag.capture({ type: 'marker', label: 'fire' });
    expect(count).toBe(1);
    unsub();
  });
});
