// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Application, Container } from 'pixi.js';
import type { TranscriptRecord } from '@waypoint/genome-data';

import type { Feature, Genome, RenderState } from '../../../types';
import type { Track } from '../../../tracks/types';
import { IndexedPixiLinearRenderer } from '../indexed-linear-renderer';
import { LinearPathMapper } from '../shared/path-mapper';
import { ANNOTATION_LANE_TOTAL, webglThemeForMode } from '../shared/theme';
import { CodonTrack } from '../tracks/codon-track';
import * as glyphs from './transcript-track-glyphs';
import { PixiTranscriptTrackRenderer, type TranscriptTrackData } from './transcript-track-renderer';
import type { TrackPaintArgs } from './types';

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = ((id: string) =>
    id === '2d'
      ? {
          font: '',
          measureText: (text: string) => ({ width: text.length * 6 }),
        }
      : null) as typeof HTMLCanvasElement.prototype.getContext;
});
afterEach(() => vi.restoreAllMocks());

const chromosome = { id: 'chr8', displayName: 'chr8', length: 3_000, cytobands: [] };
const theme = webglThemeForMode('light');
const renderState: RenderState = {
  morph: 0,
  viewOffset: 120 / 3_000,
  zoom: 20,
  width: 800,
  height: 600,
  selectedIds: new Set(),
  hoveredId: null,
  viewportRange: null,
  highlightRange: null,
  cursorPosition: null,
  hoveredCutSiteId: null,
  perfPanelVisible: false,
};
const genome: Genome = {
  name: 'indexed coding window',
  length: 3_000,
  circular: false,
  features: [],
  sourceIdentity: 'shared-window',
  sequenceAvailable: true,
  sequenceWindow: { startBp: 0, bases: 'ATG'.repeat(200) },
};
const codingRecord: TranscriptRecord = {
  chrom: 'chr8',
  start: 90,
  end: 180,
  transcriptId: 'chr8.1377',
  strand: '+',
  exons: [
    { start: 90, end: 135 },
    { start: 150, end: 180 },
  ],
  cds: [
    { start: 99, end: 130 },
    { start: 150, end: 176 },
  ],
};

function paintArgs(
  container: Container,
  records: TranscriptRecord[]
): TrackPaintArgs<TranscriptTrackData> {
  const pathMapper = new LinearPathMapper({
    viewportWidth: 800,
    viewportHeight: 600,
    bpPerPixel: 0.1,
    viewStartBp: 90,
    viewEndBp: 170,
    annotationLanes: 1,
    translationLanes: 1,
    hasSequence: true,
  });
  return {
    container,
    pathMapper,
    viewportBpRange: { start: 90, end: 170 },
    viewportWidthPx: 800,
    viewportHeightPx: 600,
    containerTopPx: 250,
    layoutEntry: {
      id: 'ucsc:hg38-genscan',
      top: 0,
      height: 64,
      hidden: false,
      contentClipped: false,
    },
    data: { records },
    presentation: { maxRows: 32 },
    chromosome,
    theme,
    cdsRendering: { genome, state: renderState, detailProgress: 1 },
  } as unknown as TrackPaintArgs<TranscriptTrackData>;
}

describe('imported transcript codon rendering', () => {
  it.each(['+', '-'] as const)(
    'uses production codons in the owning lane on strand %s',
    (strand) => {
      const renderer = new PixiTranscriptTrackRenderer({ type: 'imported-transcript' });
      const container = renderer.mount({ chromosome, theme });
      const record = { ...codingRecord, strand };
      const calls = vi.spyOn(CodonTrack.prototype, 'renderCodons');
      renderer.paint(paintArgs(container, [record]));

      expect(calls).toHaveBeenCalledTimes(1);
      const [feature, codons, path, offset] = calls.mock.calls[0];
      expect(feature).toMatchObject({
        direction: strand === '+' ? 'forward' : 'reverse',
        cds: [
          { start: 100, end: 130 },
          { start: 151, end: 176 },
        ],
      });
      expect(codons.some((codon) => codon.isPartialPreIntron)).toBe(true);
      expect(codons.some((codon) => codon.isPartialPostIntron)).toBe(true);
      expect(path.featureLabelPosAt(120, offset).y).toBe(ANNOTATION_LANE_TOTAL / 2);
      expect(renderer.getDiagnostics(container)).toMatchObject({
        cdsDetailProgress: 1,
        codonTrack: { translationMismatchCount: 0 },
      });
      calls.mockRestore();
      renderer.unmount(container);
    }
  );

  it('keeps untranslated and lane-dropped models out of the codon pass', () => {
    const renderer = new PixiTranscriptTrackRenderer({ type: 'imported-transcript', maxLanes: 1 });
    const container = renderer.mount({ chromosome, theme });
    const calls = vi.spyOn(CodonTrack.prototype, 'renderCodons');
    const args = paintArgs(container, [
      { ...codingRecord, cds: [], transcriptId: 'noncoding' },
      { ...codingRecord, transcriptId: 'dropped' },
    ]);
    renderer.paint({ ...args, presentation: { maxRows: 1 } });
    expect(calls).not.toHaveBeenCalled();
    calls.mockRestore();
    renderer.unmount(container);
  });

  it('preserves the source reading frame and translation qualifiers', () => {
    const adapt = (
      glyphs as unknown as {
        importedTranscriptFeature: (record: TranscriptRecord, id: number, lane: number) => Feature;
      }
    ).importedTranscriptFeature;
    expect(adapt).toBeTypeOf('function');
    const record = {
      ...codingRecord,
      cds: [
        { start: 99, end: 130, phase: 1 as const },
        { start: 150, end: 176 },
      ],
      extra: { exonFrames: '1,0,', transl_table: '2' },
    };
    expect(adapt(record, 3, 0).qualifiers).toMatchObject({ codon_start: '3', transl_table: '2' });
    expect(adapt({ ...record, extra: { codon_start: '2' } }, 3, 0).qualifiers?.codon_start).toBe(
      '2'
    );
    expect(
      adapt(
        {
          ...record,
          strand: '-',
          cds: [
            { start: 99, end: 130, phase: 0 },
            { start: 150, end: 176, phase: 1 },
          ],
        },
        3,
        0
      ).qualifiers?.codon_start
    ).toBe('3');
    expect(adapt({ ...record, extra: {} }, 3, 0).qualifiers?.codon_start).toBe('2');
  });

  it('refreshes amino acids when the indexed reference window is replaced', () => {
    const renderer = new PixiTranscriptTrackRenderer({ type: 'imported-transcript' });
    const container = renderer.mount({ chromosome, theme });
    const args = paintArgs(container, [{ ...codingRecord, cds: [{ start: 99, end: 129 }] }]);
    renderer.paint(args);
    expect(renderer.getDiagnostics(container)).toMatchObject({
      codonTrack: { letterSample: Array(10).fill('M') },
    });
    renderer.paint({
      ...args,
      cdsRendering: {
        ...args.cdsRendering!,
        genome: { ...genome, sequenceWindow: { startBp: 0, bases: 'AAA'.repeat(200) } },
      },
    });
    expect(renderer.getDiagnostics(container)).toMatchObject({
      codonTrack: { letterSample: Array(10).fill('K') },
    });
    renderer.paint({
      ...args,
      cdsRendering: { ...args.cdsRendering!, detailProgress: 0 },
      pathMapper: new LinearPathMapper({
        viewportWidth: 800,
        viewportHeight: 600,
        bpPerPixel: 10,
        viewStartBp: 0,
        viewEndBp: 8000,
        annotationLanes: 1,
        translationLanes: 1,
        hasSequence: true,
      }),
    });
    expect(renderer.getDiagnostics(container)).toMatchObject({
      cdsDetailProgress: 0,
      codonTrack: { hitCount: 0, letterCount: 0 },
    });
    renderer.unmount(container);
  });

  it('uses the reference reveal progress before nucleotide letters become visible', () => {
    const renderer = new PixiTranscriptTrackRenderer({ type: 'imported-transcript' });
    const container = renderer.mount({ chromosome, theme });
    const args = paintArgs(container, [codingRecord]);
    renderer.paint({
      ...args,
      cdsRendering: { ...args.cdsRendering!, detailProgress: 0.4 },
      pathMapper: new LinearPathMapper({
        viewportWidth: 800,
        viewportHeight: 600,
        bpPerPixel: 10,
        viewStartBp: 0,
        viewEndBp: 8000,
        annotationLanes: 1,
        translationLanes: 1,
        hasSequence: true,
      }),
    });
    expect(renderer.getDiagnostics(container)).toMatchObject({
      cdsDetailProgress: 0.4,
      codonTrack: null,
    });
    renderer.unmount(container);
  });

  it('receives reference sequence windows through the real registered-track dispatch', async () => {
    const renderer = new IndexedPixiLinearRenderer();
    const app = { stage: new Container(), canvas: document.createElement('canvas') } as Application;
    await renderer.init(app, genome, () => renderState);
    renderer.setChromosome(chromosome);
    const trackRenderer = new PixiTranscriptTrackRenderer({ type: 'imported-transcript' });
    renderer.registerTrack(trackRenderer);
    renderer.setTrackInstances([
      {
        id: 'ucsc:hg38-genscan',
        type: 'imported-transcript',
        visible: true,
        assemblyId: 'test',
        order: 0,
        zone: 'below-legacy',
        maxRows: 32,
      } as Track,
    ]);
    renderer.setTrackData('ucsc:hg38-genscan', { records: [codingRecord] });
    const referenceFeature = glyphs.importedTranscriptFeature(codingRecord, 10, 0);
    expect(
      renderer.setAnnotationPresentationSnapshot({
        contract: 'annotation-presentation-snapshot.v1',
        sourceIdentity: 'shared-window',
        genomeLengthBp: genome.length,
        policyKey: 'shared-codon-carriers',
        generation: 1,
        features: [referenceFeature],
        requestedLayerTypes: ['mRNA'],
        layout: { maxAnnotationLane: 0, maxCdsLane: -1 },
        exactCoverage: [{ startBp: 0, endBp: 600 }],
      }).status
    ).toBe('applied');
    const calls = vi.spyOn(CodonTrack.prototype, 'renderCodons');
    renderer.render(renderState);
    expect(calls).toHaveBeenCalledTimes(2);
    expect(calls.mock.calls[1][1]).toEqual(calls.mock.calls[0][1]);
    expect(calls.mock.calls[0][1].some((codon) => codon.aa === 'M')).toBe(true);
    expect(renderer.getTrackDiagnostics('ucsc:hg38-genscan')).toMatchObject({
      codonTrack: { translationMismatchCount: 0 },
    });
    calls.mockRestore();
  });
});
