import { describe, it, expect, beforeEach } from 'vitest';
import { createTrackedRef, summarize } from '../useTrackedRef';
import { diag } from '../../diagnostics';

describe('createTrackedRef', () => {
  beforeEach(() => {
    diag.enable();
    diag.clear();
  });

  it('behaves like MutableRefObject', () => {
    const ref = createTrackedRef('test', 0);
    expect(ref.current).toBe(0);
    ref.current = 42;
    expect(ref.current).toBe(42);
  });

  it('emits ref-update event on write', () => {
    const ref = createTrackedRef('myRef', 0);
    diag.clear();
    ref.current = 10;
    const events = diag.eventsOfType('ref-update');
    expect(events.length).toBe(1);
    expect(events[0].name).toBe('myRef');
    expect(events[0].prev).toBe(0);
    expect(events[0].next).toBe(10);
  });

  it('does not emit when value unchanged', () => {
    const ref = createTrackedRef('myRef', 5);
    diag.clear();
    ref.current = 5;
    expect(diag.eventsOfType('ref-update').length).toBe(0);
  });

  it('emits multiple events on multiple writes', () => {
    const ref = createTrackedRef('myRef', 0);
    diag.clear();
    ref.current = 1;
    ref.current = 2;
    ref.current = 3;
    const events = diag.eventsOfType('ref-update');
    expect(events.length).toBe(3);
    expect(events.map((e) => e.next)).toEqual([1, 2, 3]);
  });

  it('uses summarizer when provided', () => {
    const ref = createTrackedRef('viewport', { scrollTop: 0, height: 800 }, summarize.viewport);
    diag.clear();
    ref.current = { scrollTop: 1000, height: 800 };
    const events = diag.eventsOfType('ref-update');
    expect(events.length).toBe(1);
    expect(events[0].prev).toEqual({ scrollTop: 0, height: 800 });
    expect(events[0].next).toEqual({ scrollTop: 1000, height: 800 });
  });

  it('summarize.viewport projects {scrollTop, height}', () => {
    expect(summarize.viewport({ scrollTop: 100, height: 500 })).toEqual({
      scrollTop: 100,
      height: 500,
    });
    expect(summarize.viewport(null)).toBe(null);
  });

  it('summarize.layout projects lines array to counts', () => {
    const layout = {
      lines: [{ y: 32 }, { y: 64 }, { y: 96 }],
      totalHeight: 1000,
      sequenceLength: 50000,
      isCircular: true,
    };
    expect(summarize.layout(layout)).toEqual({
      lineCount: 3,
      firstY: 32,
      lastY: 96,
      totalHeight: 1000,
      sequenceLength: 50000,
      isCircular: true,
    });
  });

  it('summarize.layout handles null', () => {
    expect(summarize.layout(null)).toBe(null);
  });

  it('summarize.identity passes through', () => {
    expect(summarize.identity(42)).toBe(42);
    expect(summarize.identity('hello')).toBe('hello');
    const obj = { a: 1 };
    expect(summarize.identity(obj)).toBe(obj);
  });
});
