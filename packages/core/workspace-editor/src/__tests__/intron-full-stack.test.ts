/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGenBankFull, type AnnotatedSequence } from '@waypoint/sequence-utils';
import { computeSequenceLayoutImpl } from '../useSequenceLayout';
import { computeLineTrackPositions } from '../line-track-layout';
import { renderSequence, type RenderSequenceParams } from '../canvas-renderer';
import { DEFAULT_EDITOR_CONFIG, type WorkspaceEditorConfig } from '../types';
import {
  TRANSLATION_AA_HEIGHT_RATIO,
  TRANSLATION_LABEL_HEIGHT,
  ANNOTATION_BAR_HEIGHT,
} from '../layout-constants';
import { ANNOTATION_CANVAS_CONSTANTS } from '../canvas-constants';
import {
  getRecordingLog,
  installRecordingCanvas,
  uninstallRecordingCanvas,
  type CanvasOp,
} from '../testing/recording-canvas-context';

const mg1655 = parseGenBankFull(
  readFileSync(
    join(__dirname, '../../../../../test-fixtures/sequences/circular/ecoli-mg1655-complete.gb'),
    'utf8'
  )
);

function connectionYs(log: CanvasOp[], gapX: number) {
  const ys: number[] = [];
  let previous: { x: number; y: number } | undefined;
  let segments: Array<{ a: { x: number; y: number }; b: { x: number; y: number } }> = [];
  for (const op of log) {
    if (op.op === 'beginPath') {
      previous = undefined;
      segments = [];
    }
    if (op.op === 'moveTo') previous = op;
    if (op.op === 'lineTo') {
      if (previous) segments.push({ a: previous, b: op });
      previous = op;
    }
    if (op.op === 'stroke') {
      for (const { a, b } of segments)
        if (a.y === b.y && Math.min(a.x, b.x) < gapX && Math.max(a.x, b.x) > gapX) ys.push(a.y);
    }
  }
  return ys;
}

const observedConfig: WorkspaceEditorConfig = {
  ...DEFAULT_EDITOR_CONFIG,
  charsPerLine: 286,
  charWidth: 4.675108994244971,
  rowHeight: 11.687772485612427,
  fontSize: 6.428274867086834,
  marginLeft: 4,
  lodLevel: 'detail',
  showResidueNumbers: false,
};

function paint(
  sequence: AnnotatedSequence,
  config: WorkspaceEditorConfig,
  topBp = 0,
  annotationRenderStateInput?: RenderSequenceParams['annotationRenderStateInput']
) {
  const layout = computeSequenceLayoutImpl(sequence, config, topBp, 0, [], false, [], 0, {
    firstRowIndex: 0,
    lastRowIndex: 12,
    emitOnlyViewportLines: true,
  });
  const canvas = document.createElement('canvas');
  const positions = layout.lines.map((line) => computeLineTrackPositions(line, config));
  const result = renderSequence(canvas.getContext('2d')!, {
    linePositions: positions,
    config,
    layout,
    canvasWidth: 1400,
    canvasHeight: 4000,
    sequenceLength: sequence.sequence.length,
    fullSequence: sequence.sequence,
    cutSites: [],
    scannedCutSites: [],
    primers: [],
    mutations: [],
    rulerSegments: [],
    insertedRanges: [],
    deletedRanges: [],
    showCutSites: false,
    highlightedRange: null,
    hoveredCodon: null,
    viewCursor: null,
    hoveredCutSite: null,
    hoveredGGProductLabel: null,
    hoveredEnzymeName: null,
    hoveredPositionInfo: null,
    captureIntronConnectors: true,
    annotationRenderStateInput,
  });
  return { layout, positions, result, log: getRecordingLog(canvas) };
}

beforeEach(installRecordingCanvas);
afterEach(uninstallRecordingCanvas);

describe('complete MG1655 insN intron stack through the real parser, layout and renderer', () => {
  for (const config of [
    observedConfig,
    { ...observedConfig, charsPerLine: 48, charWidth: 8, rowHeight: 20 },
  ]) {
    it(`paints exactly the lower connection with ${config.charsPerLine} bases per row`, () => {
      const layout = computeSequenceLayoutImpl(mg1655, config, 270530, 0, [], false, [], 0, {
        firstRowIndex: 0,
        lastRowIndex: 12,
        emitOnlyViewportLines: true,
      });
      const line = layout.lines.find((line) => line.startPos <= 271000 && line.endPos > 271000)!;
      expect(line, 'a real insN intron row must exist').toBeDefined();
      const gene = line.annotations.find((ann) => ann.name === 'insN' && ann.type === 'gene')!;
      const cds = line.classifiedCDSs.find((ann) => ann.name === 'insN')!;
      expect(gene.segments).toEqual([
        { start: 270278, end: 270540 },
        { start: 271764, end: 272190 },
      ]);
      expect(cds, 'the corresponding CDS must actually occupy the lower track').toBeDefined();
      expect(line.annotations.some((ann) => ann.name === 'insI1')).toBe(true);
      const positions = computeLineTrackPositions(line, config);
      const canvas = document.createElement('canvas');
      const result = renderSequence(canvas.getContext('2d')!, {
        linePositions: [positions],
        config,
        layout,
        canvasWidth: 1400,
        canvasHeight: positions.lineEndY + 100,
        sequenceLength: mg1655.sequence.length,
        fullSequence: mg1655.sequence,
        cutSites: [],
        scannedCutSites: [],
        primers: [],
        mutations: [],
        rulerSegments: [],
        insertedRanges: [],
        deletedRanges: [],
        showCutSites: false,
        highlightedRange: null,
        hoveredCodon: null,
        viewCursor: null,
        hoveredCutSite: null,
        hoveredGGProductLabel: null,
        hoveredEnzymeName: null,
        hoveredPositionInfo: null,
      });
      const x = config.marginLeft + (271000 - line.startPos) * config.charWidth;
      const lowerY =
        positions.translationY +
        TRANSLATION_LABEL_HEIGHT +
        (config.rowHeight * TRANSLATION_AA_HEIGHT_RATIO) / 2;
      const ys = connectionYs(getRecordingLog(canvas), x).filter((y) => y <= lowerY);
      expect(ys, 'no duplicate connector may survive in ANY upper annotation or CDS lane').toEqual([
        lowerY,
      ]);
      expect(
        result.lineCodonUpdates.get(line.lineIndex)!.length,
        'overlapping insI1 codons must remain'
      ).toBeGreaterThan(0);
    });
  }
});

describe('connector ownership preserves exon and non-coding content', () => {
  for (const direction of [1, -1] as const) {
    const sequence: AnnotatedSequence = {
      name: 'Gene, UTR transcript and CDS',
      sequence: 'ATG'.repeat(32),
      circular: false,
      annotations: [
        {
          name: 'gene',
          type: 'gene',
          start: 13,
          end: 84,
          direction,
          qualifiers: { gene: ['shared'] },
        },
        {
          name: 'transcript',
          type: 'mRNA',
          start: 1,
          end: 84,
          direction,
          segments: [
            { start: 1, end: 6 },
            { start: 13, end: 36 },
            { start: 61, end: 84 },
          ],
          qualifiers: { gene: ['shared'] },
        },
        {
          name: 'coding',
          type: 'CDS',
          start: 13,
          end: 84,
          direction,
          segments: [
            { start: 13, end: 36 },
            { start: 61, end: 84 },
          ],
          qualifiers: { gene: ['shared'] },
        },
        {
          name: 'noncoding',
          type: 'mRNA',
          start: 17,
          end: 80,
          direction,
          segments: [
            { start: 17, end: 33 },
            { start: 64, end: 80 },
          ],
        },
      ],
    };
    const config = {
      ...DEFAULT_EDITOR_CONFIG,
      charsPerLine: 96,
      charWidth: 8,
      showResidueNumbers: false,
    };

    it(`delegates only the matching coding gap, retaining UTR/noncoding gaps and exon labels on strand ${direction}`, () => {
      const { result, log, positions } = paint(sequence, config);
      const strokes = result.intronConnectors!;
      expect(
        strokes.filter((s) => s.intronStart === 36 && s.intronEnd === 60).map((s) => s.source)
      ).toEqual(['amino-acid']);
      expect(
        strokes
          .filter((s) => s.annotationName === 'transcript')
          .map((s) => [s.intronStart, s.intronEnd])
      ).toEqual([[6, 12]]);
      expect(
        strokes
          .filter((s) => s.annotationName === 'noncoding')
          .map((s) => [s.intronStart, s.intronEnd])
      ).toEqual([[33, 63]]);
      expect(result.lineCodonUpdates.get(positions[0].line.lineIndex)).toHaveLength(16);
      expect(log.some((op) => op.op === 'fillText' && op.text === 'transcript')).toBe(true);
      const gene = positions[0].line.annotations.find((ann) => ann.name === 'gene')!;
      const geneTop =
        positions[0].annotationY +
        gene.lane * (ANNOTATION_BAR_HEIGHT + ANNOTATION_CANVAS_CONSTANTS.LANE_SPACING);
      expect(log.some((op) => op.op === 'moveTo' && op.y === geneTop)).toBe(true);
    });

    it(`keeps primary connections when amino-acid tracks are hidden on strand ${direction}`, () => {
      const { result } = paint(sequence, { ...config, showTranslation: false });
      const strokes = result.intronConnectors!.filter(
        (s) => s.intronStart === 36 && s.intronEnd === 60
      );
      expect(strokes.map((s) => s.annotationName).sort()).toEqual(['gene', 'transcript']);
      expect(strokes.every((s) => s.source === 'annotation')).toBe(true);
    });

    it(`hover and selection outlines do not reintroduce the gene intron on strand ${direction}`, () => {
      for (const state of ['hovered', 'selected'] as const) {
        const { result, log, positions } = paint(sequence, config, 0, {
          [state]: sequence.annotations![0],
        });
        const gapStrokes = result.intronConnectors!.filter(
          (s) => s.intronStart === 36 && s.intronEnd === 60
        );
        expect(gapStrokes.map((s) => s.source)).toEqual(['amino-acid']);
        const gene = positions[0].line.annotations.find((ann) => ann.name === 'gene')!;
        const midY =
          positions[0].annotationY +
          gene.lane * (ANNOTATION_BAR_HEIGHT + ANNOTATION_CANVAS_CONSTANTS.LANE_SPACING) +
          ANNOTATION_BAR_HEIGHT / 2;
        expect(connectionYs(log, config.marginLeft + 48 * config.charWidth)).not.toContain(midY);
      }
    });

    it(`keeps primary connections at feature zoom on strand ${direction}`, () => {
      const { result } = paint(sequence, { ...config, lodLevel: 'feature' });
      const strokes = result.intronConnectors!.filter(
        (s) => s.intronStart === 36 && s.intronEnd === 60
      );
      expect(strokes.map((s) => s.annotationName).sort()).toEqual(['gene · coding', 'transcript']);
      expect(strokes.every((s) => s.source === 'annotation')).toBe(true);
    });
  }
});
