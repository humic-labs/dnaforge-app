// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createRef } from 'react';
import { useScrollCoordinator } from '../use-scroll-coordinator';
import type { LayoutSnapshot2D } from '../types';

const LINE_HEIGHT = 20;
const CLIENT_HEIGHT = 600;

function buildLayout(seqLength: number, charsPerLine: number): LayoutSnapshot2D {
  const lines: Array<{ startPos: number; endPos: number; y: number; sequence: string }> = [];
  const bases = 'ATCGATCGATCG';
  for (let i = 0; i < seqLength; i += charsPerLine) {
    const len = Math.min(charsPerLine, seqLength - i);
    let sequence = '';
    for (let k = 0; k < len; k++) sequence += bases[(i + k) % bases.length];
    lines.push({ startPos: i, endPos: i + len - 1, y: lines.length * LINE_HEIGHT, sequence });
  }
  return {
    lines,
    sequenceLength: seqLength,
    totalHeight: lines.length * LINE_HEIGHT,
  } as unknown as LayoutSnapshot2D;
}

function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientHeight', { value: CLIENT_HEIGHT, configurable: true });
  el.scrollTop = 0;
  return el;
}

describe('useScrollCoordinator placement ', () => {
  const layout = buildLayout(12000, 80);
  const targetBp = 4000;

  it("'top' places the bp at the viewport top (scrollTop = rowY)", () => {
    const containerRef = createRef<HTMLElement>();
    (containerRef as { current: HTMLElement }).current = makeContainer();
    const { result } = renderHook(() => useScrollCoordinator({ containerRef, layout }));
    result.current.setScrollToBp(targetBp, 'tab-restore', { placement: 'top' });
    expect(containerRef.current!.scrollTop).toBe(1000);
  });

  it("'center' places the bp at the viewport center (scrollTop = rowY - clientHeight/2)", () => {
    const containerRef = createRef<HTMLElement>();
    (containerRef as { current: HTMLElement }).current = makeContainer();
    const { result } = renderHook(() => useScrollCoordinator({ containerRef, layout }));
    result.current.setScrollToBp(targetBp, 'center-preserve', { placement: 'center' });
    expect(containerRef.current!.scrollTop).toBe(1000 - CLIENT_HEIGHT / 2);
  });

  it("'anchor' places the bp at a caller-supplied screen-y (scrollTop = rowY - anchorOffsetPx)", () => {
    const containerRef = createRef<HTMLElement>();
    (containerRef as { current: HTMLElement }).current = makeContainer();
    const { result } = renderHook(() => useScrollCoordinator({ containerRef, layout }));
    result.current.setScrollToBp(targetBp, 'center-preserve', {
      placement: 'anchor',
      anchorOffsetPx: 80,
    });
    expect(containerRef.current!.scrollTop).toBe(1000 - 80);
  });

  it("'anchor' clamps scrollTop to >= 0 when the offset exceeds rowY", () => {
    const containerRef = createRef<HTMLElement>();
    (containerRef as { current: HTMLElement }).current = makeContainer();
    const { result } = renderHook(() => useScrollCoordinator({ containerRef, layout }));
    result.current.setScrollToBp(40, 'center-preserve', {
      placement: 'anchor',
      anchorOffsetPx: 500,
    });
    expect(containerRef.current!.scrollTop).toBe(0);
  });
});
