/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnnotatedSequence, Annotation } from '@waypoint/sequence-utils';
import {
  annotationSegmentArrowFlags,
  buildAnnotationSegmentPath,
  drawAnnotationSegment,
  drawAnnotations,
} from '../canvas-drawing';
import { renderSequence } from '../canvas-renderer';
import { computeSequenceLayoutImpl } from '../useSequenceLayout';
import { computeLineTrackPositions } from '../line-track-layout';
import { DEFAULT_EDITOR_CONFIG } from '../types';
import { detectCDSLabelHit } from '../hit-detection/annotation';
import { calculateLineTrackBounds } from '../hit-detection/track-bounds';
import {
  getRecordingLog,
  installRecordingCanvas,
  uninstallRecordingCanvas,
  type CanvasOp,
} from '../testing/recording-canvas-context';

const color = '#3478F6';
function paints(log: CanvasOp[]) {
  let fill = '',
    alpha = 1;
  const stack: { fill: string; alpha: number }[] = [];
  let path: CanvasOp[] = [];
  const result: unknown[] = [];
  for (const op of log) {
    if (op.op === 'save') stack.push({ fill, alpha });
    if (op.op === 'restore') ({ fill, alpha } = stack.pop() ?? { fill, alpha });
    if (op.op === 'set' && op.prop === 'fillStyle') fill = String(op.value);
    if (op.op === 'set' && op.prop === 'globalAlpha') alpha = Number(op.value);
    if (op.op === 'beginPath') path = [];
    if (['moveTo', 'lineTo', 'arc', 'rect', 'closePath'].includes(op.op)) path.push(op);
    if (op.op === 'fill' && fill === color) result.push({ fill, alpha, path: [...path] });
    if (op.op === 'fillText' && !/^[\d.,\s]+$/.test(op.text))
      result.push({ fill, alpha, text: op.text, x: op.x, y: op.y });
  }
  return result;
}

beforeEach(installRecordingCanvas);
afterEach(uninstallRecordingCanvas);

it('emits the exact compact contour without changing label or continuation geometry', () => {
  const config = { ...DEFAULT_EDITOR_CONFIG, charWidth: 0.73 };
  const x = 1000;
  const left = 0.1;
  const width = 92.81 - left;
  const y = 12.375;
  const height = 8.625;
  const visibleStart = 100;
  const visibleEnd = 227;
  const charIndexStart = (left - x) / config.charWidth;

  expect(x + charIndexStart * config.charWidth).not.toBe(left);
  expect((visibleEnd - visibleStart) * config.charWidth).not.toBe(width);

  for (const subject of [
    { direction: 1 as const, terminal: true, draft: false },
    { direction: -1 as const, terminal: true, draft: false },
    { direction: 1 as const, terminal: false, draft: true },
  ]) {
    const annotation: Annotation = {
      name: 'gene',
      type: 'CDS',
      start: 1,
      end: 500,
      direction: subject.direction,
      color,
      ...(subject.draft ? { qualifiers: { source: ['annotation-draft'] } } : {}),
    };
    const flags = annotationSegmentArrowFlags({
      isStartOfAnnotation: subject.terminal,
      isEndOfAnnotation: subject.terminal,
      direction: subject.direction,
      barWidth: width,
      annotationHeight: height,
      suppressStartTear: false,
      suppressEndTear: false,
    });
    const contour: { x: number; y: number }[] = [];
    buildAnnotationSegmentPath(
      {
        beginPath: () => {},
        moveTo: (x, y) => contour.push({ x, y }),
        lineTo: (x, y) => contour.push({ x, y }),
        closePath: () => {},
      },
      left,
      y,
      width,
      height,
      flags
    );
    const draw = (direct: boolean) => {
      const canvas = document.createElement('canvas');
      drawAnnotationSegment(
        canvas.getContext('2d')!,
        annotation,
        visibleStart,
        visibleEnd,
        0,
        x,
        y,
        config,
        height,
        0,
        true,
        subject.terminal,
        subject.terminal,
        charIndexStart,
        false,
        'default',
        true,
        {
          lane: 0,
          colorOverride: color,
          colorIsAdapted: true,
          surfaceOpacity: 0.65,
          ...(direct
            ? {
                traceContour: (context: Parameters<typeof buildAnnotationSegmentPath>[0]) =>
                  buildAnnotationSegmentPath(context, left, y, width, height, flags),
              }
            : { contour }),
        }
      );
      return getRecordingLog(canvas);
    };
    const expected = draw(false);
    expect(expected.some((op) => op.op === 'fill')).toBe(true);
    expect(expected.some((op) => op.op === 'fillText' && op.text === 'gene')).toBe(true);
    if (subject.draft) {
      expect(expected.some((op) => op.op === 'stroke')).toBe(true);
      expect(expected.filter((op) => op.op === 'fillText' && op.text === '»')).toHaveLength(2);
    }
    expect(draw(true)).toEqual(expected);
  }
});

describe('original zoomed-out wrapped annotation shapes', () => {
  const subjects: {
    name: string;
    annotations: Annotation[];
    circular?: boolean;
    start?: number;
  }[] = [
    {
      name: 'forward terminal arrow',
      annotations: [{ name: 'forward', type: 'CDS', start: 31, end: 180, direction: 1, color }],
    },
    {
      name: 'reverse terminal arrow',
      annotations: [{ name: 'reverse', type: 'CDS', start: 31, end: 180, direction: -1, color }],
    },
    {
      name: 'row-edge cuts',
      annotations: [{ name: 'clipped', type: 'CDS', start: 1, end: 500, direction: 1, color }],
      start: 150,
    },
    {
      name: 'spliced exon bodies and original intron',
      annotations: [
        {
          name: 'spliced',
          type: 'CDS',
          start: 31,
          end: 250,
          direction: 1,
          color,
          segments: [
            { start: 31, end: 90 },
            { start: 190, end: 250 },
          ],
        },
      ],
    },
    {
      name: 'circular origin fragments',
      circular: true,
      start: 950,
      annotations: [{ name: 'origin', type: 'CDS', start: 901, end: 120, direction: -1, color }],
    },
    {
      name: 'short and overlapping CDS',
      annotations: [
        { name: 'short', type: 'CDS', start: 31, end: 33, direction: 1, color },
        { name: 'overlap', type: 'CDS', start: 32, end: 130, direction: -1, color },
      ],
    },
    {
      name: 'authored draft',
      annotations: [
        {
          name: 'draft',
          type: 'CDS',
          start: 31,
          end: 180,
          direction: 1,
          color,
          qualifiers: { source: ['annotation-draft'] },
        },
      ],
    },
  ];
  it.each(subjects)(
    'matches the existing painter for $name',
    ({ annotations, circular = false, start = 0 }) => {
      const subject: AnnotatedSequence = {
        name: 'original shape reference',
        sequence: 'ATG'.repeat(400),
        circular,
        annotations,
      };
      const config = {
        ...DEFAULT_EDITOR_CONFIG,
        charsPerLine: 300,
        charWidth: 4,
        rowHeight: 10,
        marginLeft: 4,
        lodLevel: 'feature' as const,
        cdsDetailProgress: 0,
        showTranslation: false,
        showReverseComplement: false,
        annotationColorMode: 'manual' as const,
      };
      const layout = computeSequenceLayoutImpl(subject, config, start, 0, [], false, [], 0, {
        firstRowIndex: 0,
        lastRowIndex: 0,
        emitOnlyViewportLines: true,
      });
      const line = layout.lines[0],
        positions = computeLineTrackPositions(line, config);

      const bounds = calculateLineTrackBounds(line, config, false, false, false);
      line.classifiedCDSs[0]._cdsPillBounds = [{ x: 1250, w: 140, y: line.y + 7, h: 14 }];
      expect(detectCDSLabelHit(1300, line.y + 10, line, bounds, config, 1200)).not.toBeNull();
      const original = document.createElement('canvas');
      drawAnnotations(
        original.getContext('2d')!,
        line.annotations,
        line.startPos,
        line.endPos,
        config.marginLeft,
        positions.annotationY,
        line.annotationLaneCount,
        config,
        subject.sequence.length,
        undefined,
        undefined,
        true
      );
      const actual = document.createElement('canvas');
      renderSequence(actual.getContext('2d')!, {
        linePositions: [positions],
        config,
        layout,
        canvasWidth: 1400,
        canvasHeight: 1000,
        sequenceLength: subject.sequence.length,
        fullSequence: subject.sequence,
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
        viewport: { scrollTop: 0, height: 1000 },
      });
      expect(paints(getRecordingLog(original)).length).toBeGreaterThan(0);
      expect(paints(getRecordingLog(actual))).toEqual(paints(getRecordingLog(original)));
      expect(detectCDSLabelHit(1300, line.y + 10, line, bounds, config, 1200)).toBeNull();
    }
  );
});
