import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGenBankFull, findORFs } from '@waypoint/sequence-utils';
import { computeSequenceLayoutImpl } from '../useSequenceLayout';
import { buildCanvasContentReportCounts } from '../content-report';
import { DEFAULT_EDITOR_CONFIG, type WorkspaceEditorConfig } from '../types';
import type { SequenceLodLevel } from '../zoom-math';

const PUC19 = parseGenBankFull(
  readFileSync(join(__dirname, '../../../../../test-fixtures/sequences/circular/pUC19.gb'), 'utf-8')
);
const ORFS = findORFs(PUC19.sequence, 100);

const AUTO_LODS: Exclude<SequenceLodLevel, 'density'>[] = ['detail', 'feature'];

function countsFor(lod: SequenceLodLevel) {
  const config: WorkspaceEditorConfig = {
    ...DEFAULT_EDITOR_CONFIG,
    lodLevel: lod,
    charsPerLine: 120,
    charWidth: lod === 'feature' ? 2 : 9,
    rowHeight: lod === 'feature' ? 14 : 20,
    showAnnotations: true,
  };
  const layout = computeSequenceLayoutImpl(PUC19, config, 0, 0, [], false, ORFS);
  return buildCanvasContentReportCounts(layout);
}

describe('render content-report invariant — Canvas2D × LOD (real pipeline)', () => {
  it('the fixture actually has every category (guards the test itself)', () => {
    const d = countsFor('detail');
    expect(ORFS.length).toBeGreaterThan(0);
    expect(d.totalAnnotations).toBeGreaterThan(0);
    expect(d.cdsLineCount).toBeGreaterThan(0);
    expect(d.complementLineCount).toBeGreaterThan(0);
    expect(d.totalForwardOrfs + d.totalReverseOrfs).toBeGreaterThan(0);
  });

  describe.each(AUTO_LODS)('LOD = %s', (lod) => {
    const c = countsFor(lod);

    it('ORFs are carried (the exact regression that shipped — pinned)', () => {
      expect(
        c.totalForwardOrfs + c.totalReverseOrfs,
        `ORFs vanished at ${lod} LOD: ${JSON.stringify(c)}`
      ).toBeGreaterThan(0);
    });

    it('complement payload matches whether nucleotide text is painted', () => {
      if (lod === 'detail') expect(c.complementLineCount).toBeGreaterThan(0);
      else expect(c.complementLineCount).toBe(0);
    });

    it('annotations are carried', () => {
      expect(c.totalAnnotations).toBeGreaterThan(0);
    });
  });

  it('CDS folds into annotations at feature LOD (not dropped)', () => {
    const detail = countsFor('detail');
    const feature = countsFor('feature');
    expect(detail.cdsLineCount).toBeGreaterThan(0);
    expect(feature.totalAnnotations).toBeGreaterThanOrEqual(detail.totalAnnotations);
  });
});
