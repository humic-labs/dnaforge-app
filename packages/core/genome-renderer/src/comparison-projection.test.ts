import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { comparisonFixture } from './test-support/comparison-projection-fixture';
import { parseGenomeComparisonPaf } from '@waypoint/genome-data';
import {
  comparisonColumnLoci,
  comparisonLocusColumns,
  comparisonPlot,
  createComparisonProjection,
  hitTestComparison,
  panComparisonCamera,
  resolveComparisonCamera,
  zoomComparisonCamera,
} from './comparison-projection';

describe('sparse native comparison projection', () => {
  it('preserves each actual insertion and deletion without inventing a biological base', () => {
    const p = comparisonFixture();
    expect(comparisonColumnLoci(p, 2)).toMatchObject({
      target: { kind: 'gap', boundary: 2 },
      query: { kind: 'base', position: 2 },
    });
    expect(comparisonColumnLoci(p, 6)).toMatchObject({
      target: { kind: 'base', position: 4 },
      query: { kind: 'gap', boundary: 6 },
    });
    expect(comparisonLocusColumns(p, 'target', 2)).toEqual([4]);
    expect(comparisonLocusColumns(p, 'query', 2)).toEqual([2]);
  });
  it('marks between-block joins explicitly and reverses the query coordinate direction', () => {
    const p = comparisonFixture();
    expect(comparisonColumnLoci(p, 12)).toMatchObject({
      blockId: null,
      target: { kind: 'unaligned', interval: { start: 7, end: 10 } },
    });
    expect(comparisonColumnLoci(p, 41)).toMatchObject({
      strand: '-',
      query: { kind: 'base', position: 12 },
      target: { kind: 'base', position: 10 },
    });
    expect(comparisonLocusColumns(p, 'query', 10)).toEqual([43]);
    expect(comparisonColumnLoci(p, p.layout.columnLength)).toBeNull();
  });
  it('keeps the exact column under zoom and bounds native pan without altering gaps', () => {
    const p = comparisonFixture(),
      plot = comparisonPlot(1000, 600);
    const camera = resolveComparisonCamera(p);
    const zoom = zoomComparisonCamera(p, camera, 4, plot.x + plot.width / 2, plot);
    expect((zoom.startColumn + zoom.endColumn) / 2).toBe(22);
    expect(zoom.endColumn - zoom.startColumn).toBe(11);
    expect(panComparisonCamera(p, zoom, 1e9, plot).endColumn).toBe(44);
    const precise = { projectionId: p.id, startColumn: 0, endColumn: 9 };
    expect(
      hitTestComparison(p, precise, plot, plot.x + (plot.width * 2.5) / 9, plot.targetY)
    ).toMatchObject({
      side: 'target',
      target: { kind: 'gap', referenceId: 'target', boundary: 2 },
      query: { kind: 'base', referenceId: 'query', position: 2 },
    });
  });
  it('retains overlapping mappings as multiple columns instead of pretending the layout is a bijection', () => {
    const p = comparisonFixture();
    const duplicate = { ...p.comparison.blocks[0], id: 'duplicate' };
    const projected = createComparisonProjection({
      id: 'overlap',
      comparison: { ...p.comparison, blocks: [p.comparison.blocks[0], duplicate] },
    });
    expect(comparisonLocusColumns(projected, 'target', 0)).toEqual([0, 41]);
  });
  it('accepts the actual 261 CIGAR blocks as sparse operations and refuses a wrong sequence length', () => {
    const path = fileURLToPath(
      new URL(
        '../../../../test-fixtures/genome-view-prototypes/MG1655-Shigella2457T-gapped.paf',
        import.meta.url
      )
    );
    const comparison = parseGenomeComparisonPaf(readFileSync(path, 'utf8'), {
      target: { id: 'NC_000913.3', length: 4_641_652 },
      query: { id: 'NC_004741.1', length: 4_599_354 },
      minimumAlignmentColumns: 1000,
    });
    const p = createComparisonProjection({ id: 'MG1655-Shigella', comparison });
    expect(p.comparison.blocks).toHaveLength(261);
    expect(p.layout.entries).toHaveLength(521);
    expect(comparison.blocks.reduce((sum, block) => sum + block.segments.length, 0)).toBe(1864);
    expect(() =>
      createComparisonProjection({ id: 'invalid', comparison, targetSequence: 'ACGT' })
    ).toThrow('reference length');
  });
});
