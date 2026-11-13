import { describe, it, expect } from 'vitest';
import { compute1DLayout, create1DLayoutAdapter } from '../layout-1d';

describe('compute1DLayout / getRulerTicks — gapped mode (Phase 2)', () => {
  const GAPPED = 'ACGT--ACGT--ACGT';

  const baseInput = {
    annotations: [],
    columnCount: GAPPED.length,
    pxPerBase: 4,
    fullSequence: GAPPED,
    gappedSequence: GAPPED,
    isCircular: false,
    showReverseComplement: false,
  } as const;

  it('skips gap columns entirely — no tick at column 4, 5, 10, or 11', () => {
    const layout = compute1DLayout({ ...baseInput });
    const adapter = create1DLayoutAdapter(layout);
    const ticks = adapter.getRulerTicks(0, GAPPED.length);

    const tickColumns = new Set(ticks.map((t) => t.position));
    expect(tickColumns.has(4)).toBe(false);
    expect(tickColumns.has(5)).toBe(false);
    expect(tickColumns.has(10)).toBe(false);
    expect(tickColumns.has(11)).toBe(false);
  });

  it('emits a "1" tick at column 0 (the first non-gap base)', () => {
    const layout = compute1DLayout({ ...baseInput });
    const adapter = create1DLayoutAdapter(layout);
    const ticks = adapter.getRulerTicks(0, GAPPED.length);

    const first = ticks.find((t) => t.position === 0);
    expect(first).toBeDefined();
    expect(first?.label).toBe('1');
  });

  it('tick labels are biological positions, not column indices', () => {
    const dense = 'A'.repeat(50);
    const layout = compute1DLayout({
      ...baseInput,
      columnCount: dense.length,
      gappedSequence: dense,
      fullSequence: dense,
      pxPerBase: 4,
    });
    const adapter = create1DLayoutAdapter(layout);
    const ticks = adapter.getRulerTicks(0, dense.length);

    const tickAt9 = ticks.find((t) => t.position === 9);
    expect(tickAt9?.label).toBe('10');
    const tickAt19 = ticks.find((t) => t.position === 19);
    expect(tickAt19?.label).toBe('20');
  });

  it('biological mode (no gappedSequence) keeps the legacy step-multiple algorithm', () => {
    const layout = compute1DLayout({
      ...baseInput,
      gappedSequence: undefined,
    });
    const adapter = create1DLayoutAdapter(layout);
    const ticks = adapter.getRulerTicks(0, GAPPED.length);

    const labels = ticks.map((t) => t.label);
    expect(labels).toContain('1');
  });

  it('respects viewport window — only emits ticks for visible columns', () => {
    const layout = compute1DLayout({ ...baseInput });
    const adapter = create1DLayoutAdapter(layout);
    const ticks = adapter.getRulerTicks(6, 12);

    for (const t of ticks) {
      expect(t.position).toBeGreaterThanOrEqual(6);
      expect(t.position).toBeLessThan(12);
    }
  });
});
