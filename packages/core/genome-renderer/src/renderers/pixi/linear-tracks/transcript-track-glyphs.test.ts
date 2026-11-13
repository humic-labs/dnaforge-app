import { describe, expect, it } from 'vitest';

import type { TranscriptRecord } from '@waypoint/genome-data';

import { buildTranscriptGlyphBlocks } from '../overview/transcript-glyph-vertices';
import { ANNOTATION_BAR_HEIGHT, ANNOTATION_LANE_TOTAL, webglThemeForMode } from '../shared/theme';
import { buildImportedTranscriptGlyphBlocks } from './transcript-track-glyphs';
import { PixiTranscriptTrackRenderer } from './transcript-track-renderer';
import type { TrackPaintArgs } from './types';

describe('imported transcript glyphs', () => {
  it('delegates to the exact reference-track glyph geometry', () => {
    const record: TranscriptRecord = {
      chrom: 'chr1',
      start: 100,
      end: 450,
      transcriptId: 'tx1',
      geneName: 'GENE1',
      strand: '+',
      exons: [
        { start: 100, end: 180 },
        { start: 300, end: 450 },
      ],
      cds: [
        { start: 130, end: 180 },
        { start: 300, end: 420 },
      ],
    };
    const imported = buildImportedTranscriptGlyphBlocks({
      records: [record],
      chromosomeLength: 1_000,
      maxLanes: 8,
      themeMode: 'light',
    });
    const reference = buildTranscriptGlyphBlocks(
      [
        {
          type: 'mRNA',
          direction: 'forward',
          exons: [
            { start: 101, end: 180 },
            { start: 301, end: 450 },
          ],
          cds: [
            { start: 131, end: 180 },
            { start: 301, end: 420 },
          ],
          qualifiers: {},
        },
      ],
      {
        getOffset: () => ANNOTATION_LANE_TOTAL / 2,
        halfHeight: ANNOTATION_BAR_HEIGHT / 2,
        themeMode: 'light',
        cdsDetail: 0,
      }
    );

    expect(imported.blocks).toEqual(reference);
    expect(imported.assignment).toMatchObject({
      numLanes: 1,
      droppedCount: 0,
    });
  });

  it('measures imported transcript lanes before fit-content layout', () => {
    const records: TranscriptRecord[] = [
      {
        chrom: 'chr1',
        start: 100,
        end: 450,
        transcriptId: 'tx1',
        geneName: 'GENE1',
        strand: '+',
        exons: [{ start: 100, end: 450 }],
        cds: [],
      },
      {
        chrom: 'chr1',
        start: 200,
        end: 500,
        transcriptId: 'tx2',
        geneName: 'GENE1',
        strand: '+',
        exons: [{ start: 200, end: 500 }],
        cds: [],
      },
    ];
    const renderer = new PixiTranscriptTrackRenderer({ type: 'imported-transcript' });

    expect(
      renderer.measureContentHeight?.({
        data: { records },
        presentation: { maxRows: 32 },
        chromosome: { id: 'chr1', displayName: 'chr1', length: 1_000, cytobands: [] },
      })
    ).toBe(2 * ANNOTATION_LANE_TOTAL);
  });

  it('renders transcript identities with the same hard label cap', () => {
    const renderer = new PixiTranscriptTrackRenderer({
      type: 'imported-transcript',
      maxLabels: 1,
    });
    const chromosome = {
      id: 'chr1',
      displayName: 'chr1',
      length: 1_000,
      cytobands: [],
    };
    const container = renderer.mount({ chromosome, theme: webglThemeForMode('light') });
    const records: TranscriptRecord[] = [
      {
        chrom: 'chr1',
        start: 100,
        end: 300,
        transcriptId: 'tx1',
        geneName: 'GENE1',
        strand: '+',
        exons: [{ start: 100, end: 300 }],
        cds: [],
      },
      {
        chrom: 'chr1',
        start: 400,
        end: 650,
        transcriptId: 'tx2',
        geneName: 'GENE2',
        strand: '-',
        exons: [{ start: 400, end: 650 }],
        cds: [],
      },
    ];

    renderer.paint({
      container,
      data: { records },
      presentation: { maxRows: 32 },
      chromosome,
      assembly: {
        id: 'test',
        displayName: 'test',
        totalLengthBp: 1_000,
        chromosomes: [{ chromosome, globalStartBp: 0, globalEndBp: chromosome.length }],
      },
      pathMapper: { pixelsPerBp: 1, bpLeftX: (bp: number) => bp },
      viewportBpRange: { start: 0, end: 1_000 },
      viewportWidthPx: 1_000,
      viewportHeightPx: 600,
      layoutEntry: {
        id: 'imported-transcript',
        top: 0,
        height: 24,
        contentClipped: false,
        hidden: false,
      },
      containerTopPx: 0,
      theme: webglThemeForMode('light'),
    } as unknown as TrackPaintArgs<{ records: ReadonlyArray<TranscriptRecord> }>);

    expect(renderer.getDiagnostics(container)).toMatchObject({ labelCount: 1, labelLimit: 1 });
  });
});
