// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from 'vitest';

import type { VariantRecord } from '@waypoint/genome-data';

import { webglThemeForMode } from '../shared/theme';
import type { TrackPaintArgs } from './types';
import type { VariantTrackData } from './variant-track-renderer';

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = ((contextId: string) => {
    if (contextId !== '2d') return null;
    return {
      font: '',
      fillStyle: '',
      textBaseline: '',
      scale: () => undefined,
      measureText: (text: string) => ({ width: text.length * 6 }),
      fillText: () => undefined,
      clearRect: () => undefined,
    } as unknown as CanvasRenderingContext2D;
  }) as typeof HTMLCanvasElement.prototype.getContext;
});

describe('PixiVariantTrackRenderer', () => {
  it('paints normalized calls as retained variant-marker geometry with diagnostics', async () => {
    const { PixiVariantTrackRenderer } = await import('./variant-track-renderer');
    const renderer = new PixiVariantTrackRenderer({ type: 'variant' });
    const chromosome = { id: 'chr1', displayName: 'chr1', length: 1_000, cytobands: [] };
    const container = renderer.mount({ chromosome, theme: webglThemeForMode('light') });
    const records: VariantRecord[] = [
      {
        id: 'call-1',
        recordId: 'rs1',
        chrom: 'chr1',
        start: 99,
        end: 100,
        position: 100,
        ref: 'A',
        alts: ['T'],
        quality: 60,
        filters: ['PASS'],
        variantClass: 'substitution',
        genotypes: { tumor: '0/1' },
      },
    ];
    renderer.paint({
      container,
      data: { records },
      presentation: { rowHeightPx: 12, maxRows: 8 },
      chromosome,
      pathMapper: { pixelsPerBp: 0.02, bpLeftX: (bp: number) => bp * 0.02 },
      viewportBpRange: { start: 0, end: 1_000 },
      viewportWidthPx: 1_000,
      viewportHeightPx: 600,
      layoutEntry: {
        id: 'variant-track',
        top: 0,
        height: 24,
        contentClipped: false,
        hidden: false,
      },
      containerTopPx: 0,
      theme: webglThemeForMode('light'),
    } as unknown as TrackPaintArgs<VariantTrackData>);

    expect(renderer.getDiagnostics(container)).toMatchObject({
      rendererKind: 'variant-marker',
      recordCount: 1,
      visibleRecordCount: 1,
      vertexCount: 6,
      overflow: false,
    });
  });
});
