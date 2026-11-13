/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAAScheme, parseGenBankFull, type AnnotatedSequence } from '@waypoint/sequence-utils';
import { computeSequenceLayoutImpl, computeLaneCountsPerRow } from '../useSequenceLayout';
import { computeLineTrackPositions } from '../line-track-layout';
import { renderSequence } from '../canvas-renderer';
import { cullLinesToViewport } from '../canvas-worker-protocol';
import {
  computeScaledConfig,
  deriveSequenceLodLevel,
  cdsDetailZoomProgress,
  resolveIndexedCdsZoomConfig,
} from '../zoom-math';
import { translationIntronUnderCursor } from '../hooks/canvas-interaction-pointer';
import { detectCodonHit } from '../hit-detection/codon';
import { detectCDSLabelHit } from '../hit-detection/annotation';
import { getHitTarget } from '../hit-detection/resolve';
import { resolvePointerSelection } from '../pointer-selection';
import { calculateLineTrackBounds } from '../hit-detection/track-bounds';
import { cdsReplacementZoomPresentation } from '@waypoint/platform';
import { DEFAULT_EDITOR_CONFIG, type WorkspaceEditorConfig } from '../types';
import type { AnnotationRenderStateInput } from '../annotation-render-state';
import { buildChevronStripOuterPath } from '../rendering/canvas-primitives';
import {
  TRANSLATION_PILL_HEIGHT,
  ANNOTATION_ROW_HEIGHT,
  ANNOTATION_LANE_PADDING,
} from '../layout-constants';
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

const sequence: AnnotatedSequence = {
  name: 'INS complete feature stack',
  sequence: 'ATG'.repeat(500),
  circular: false,
  annotations: [
    { name: 'INS', type: 'gene', start: 1, end: 1500, direction: 1, qualifiers: { gene: ['INS'] } },
    {
      name: 'INS',
      type: 'mRNA',
      start: 1,
      end: 1500,
      direction: 1,
      segments: [
        { start: 1, end: 90 },
        { start: 1201, end: 1500 },
      ],
      qualifiers: { gene: ['INS'] },
    },
    {
      name: 'INS',
      type: 'CDS',
      start: 1,
      end: 1500,
      direction: 1,
      color: '#3478F6',
      segments: [
        { start: 1, end: 90 },
        { start: 1201, end: 1500 },
      ],
      qualifiers: { gene: ['INS'] },
    },
  ],
};

function paint(
  progress = 1,
  start = 0,
  lodLevel: 'detail' | 'feature' = 'detail',
  scrollTop = 0,
  subject = sequence,
  metrics: Partial<WorkspaceEditorConfig> = {},
  annotationRenderStateInput?: AnnotationRenderStateInput
) {
  const config = {
    ...DEFAULT_EDITOR_CONFIG,
    charsPerLine: 200,
    charWidth: 8,
    marginLeft: 4,
    lodLevel,
    annotationColorMode: 'manual',
    showTranslation: lodLevel === 'detail',
    cdsDetailProgress: progress,
    ...metrics,
  } as WorkspaceEditorConfig;
  const layout = computeSequenceLayoutImpl(subject, config, start, 0, [], false, [], 0, {
    firstRowIndex: 0,
    lastRowIndex: 0,
    emitOnlyViewportLines: true,
  });
  const line = layout.lines[0];
  line.y += scrollTop;
  const positions = computeLineTrackPositions(line, config);
  const submittedPositions = { ...positions };
  for (const key of [
    'annotationY',
    'translationY',
    'sequenceY',
    'complementY',
    'mutationTrackY',
    'rulerY',
    'forwardPrimerY',
    'reversePrimerY',
    'forwardOrfY',
    'reverseOrfY',
    'lineEndY',
  ] as const)
    submittedPositions[key] -= scrollTop;
  const log = paintRows(
    subject,
    config,
    layout,
    [submittedPositions],
    scrollTop,
    1000,
    annotationRenderStateInput
  );
  return { config, line, positions, layout, log };
}

function paintRows(
  subject: AnnotatedSequence,
  config: WorkspaceEditorConfig,
  layout: ReturnType<typeof computeSequenceLayoutImpl>,
  linePositions: ReturnType<typeof computeLineTrackPositions>[],
  scrollTop: number,
  height = 1000,
  annotationRenderStateInput?: AnnotationRenderStateInput
) {
  const canvas = document.createElement('canvas');
  renderSequence(canvas.getContext('2d')!, {
    linePositions,
    config,
    layout,
    canvasWidth: 1700,
    canvasHeight: height,
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
    annotationRenderStateInput,
    viewport: { scrollTop, height },
  });
  return getRecordingLog(canvas);
}

function recordedPaints(log: CanvasOp[]) {
  let state = { order: 0, fill: '', stroke: '', lineWidth: 1, alpha: 1 };
  const stack: (typeof state)[] = [];
  let path: { x: number; y: number; w: number; h: number } | undefined;
  let points: { x: number; y: number }[] = [];
  let moves = 0,
    closed = false;
  const fills: (typeof state & {
    x: number;
    y: number;
    w: number;
    h: number;
    points: { x: number; y: number }[];
  })[] = [];
  const texts: (typeof state & { text: string; x: number; y: number })[] = [];
  const rectangles: (typeof state & { x: number; y: number; w: number; h: number })[] = [];
  const strokes: (typeof state & {
    points: { x: number; y: number }[];
    moves: number;
    closed: boolean;
  })[] = [];
  for (const op of log) {
    state.order++;
    if (op.op === 'save') stack.push({ ...state });
    if (op.op === 'restore') state = { ...(stack.pop() ?? state), order: state.order };
    if (op.op === 'set' && op.prop === 'fillStyle') state.fill = String(op.value);
    if (op.op === 'set' && op.prop === 'strokeStyle') state.stroke = String(op.value);
    if (op.op === 'set' && op.prop === 'lineWidth') state.lineWidth = Number(op.value);
    if (op.op === 'set' && op.prop === 'globalAlpha') state.alpha = Number(op.value);
    if (op.op === 'beginPath') {
      path = undefined;
      points = [];
      moves = 0;
      closed = false;
    }
    if (op.op === 'rect') path = op;
    if (op.op === 'moveTo' || op.op === 'lineTo') points.push(op);
    if (op.op === 'moveTo') moves++;
    if (op.op === 'closePath') closed = true;
    if (op.op === 'fill') {
      if (!path && points.length) {
        const xs = points.map((p) => p.x),
          ys = points.map((p) => p.y);
        path = {
          x: Math.min(...xs),
          y: Math.min(...ys),
          w: Math.max(...xs) - Math.min(...xs),
          h: Math.max(...ys) - Math.min(...ys),
        };
      }
      if (path) fills.push({ ...path, ...state, points: [...points] });
    }
    if (op.op === 'fillText') texts.push({ ...op, ...state });
    if (op.op === 'fillRect') rectangles.push({ ...op, ...state });
    if (op.op === 'stroke') strokes.push({ ...state, points: [...points], moves, closed });
  }
  return { fills, texts, rectangles, strokes };
}

beforeEach(installRecordingCanvas);
afterEach(uninstallRecordingCanvas);

describe('CDS chip, bar and intron share a continuous presentation', () => {
  it.each([1, -1] as const)(
    'keeps the overview and visible chevrons symmetric, raising the line only after replacement on strand %i',
    (direction) => {
      const subject: AnnotatedSequence = {
        name: 'symmetric CDS handoff',
        sequence: 'ATG'.repeat(500),
        circular: false,
        annotations: [
          { name: 'protein', type: 'CDS', start: 301, end: 901, direction, color: '#3478F6' },
        ],
      };
      const onset = (840 + 256) / 3000;
      const symmetric = (points: { x: number; y: number }[]) => {
        const top = Math.min(...points.map((p) => p.y));
        const bottom = Math.max(...points.map((p) => p.y));
        for (const point of points)
          expect(
            points.some(
              (other) =>
                Math.abs(other.x - point.x) < 1e-7 &&
                Math.abs(other.y - (top + bottom - point.y)) < 1e-7
            ),
            `every boundary point must have its reflected partner: ${point.x},${point.y}`
          ).toBe(true);
      };
      const colors = new Set(Object.values(getAAScheme('rasmol').colors));
      for (const fraction of [0.7, 0.8, 0.875, 1, 1.125, 1.25, 1.3, 1.375, 2]) {
        const charWidth = onset * fraction;
        const presentation = cdsReplacementZoomPresentation(charWidth, 840);
        const { line, log } = paint(presentation.progress, 0, 'detail', 0, subject, {
          charWidth,
          charsPerLine: 1500,
          cdsZoomPresentation: presentation,
          aaColorScheme: 'rasmol',
        });
        const cds = line.classifiedCDSs[0];
        const pose = cds._paintedPresentation!;
        if (fraction <= 1.25) {
          expect(
            presentation.topLineHeight,
            'line rise must follow complete color replacement'
          ).toBe(0);
          expect(cds._cdsLineBounds).toEqual([]);
        } else {
          expect(presentation.colorAlpha).toBe(1);
          expect(presentation.topLineHeight).toBeGreaterThan(0);
          expect(cds._cdsLineBounds).toHaveLength(1);
        }
        const fills = recordedPaints(log).fills;
        if (presentation.colorAlpha < 1) {
          const overview = fills.find(
            (fill) =>
              fill.fill === '#3478F6' &&
              fill.alpha > 0 &&
              Math.abs(fill.y - pose.barY) < 1e-7 &&
              Math.abs(fill.h - pose.barHeight) < 1e-7
          );
          expect(
            overview,
            'the blue overview must remain a symmetric body while visible'
          ).toBeDefined();
          symmetric(overview!.points);
        }
        if (presentation.colorAlpha > 0) {
          const cells = fills.filter((fill) => colors.has(fill.fill) && fill.alpha > 0);
          expect(
            cells.length,
            'visible cells must have their actual symmetric polygons checked'
          ).toBeGreaterThan(0);
          for (const cell of cells) symmetric(cell.points);
        }
      }
    }
  );

  it.each([1, -1] as const)(
    'compact hover follows the filled directional perimeter on strand %i',
    (direction) => {
      const annotation = {
        name: 'directional',
        type: 'CDS',
        start: 301,
        end: 901,
        direction,
        color: '#3478F6',
      };
      const subject = { ...sequence, annotations: [annotation] };
      for (const charWidth of [0.016, 0.04, 0.12, 0.3]) {
        const presentation = cdsReplacementZoomPresentation(charWidth, 3000);
        expect(presentation.bandProgress).toBe(0);
        const { log, line } = paint(
          0,
          0,
          'detail',
          0,
          subject,
          {
            charWidth,
            charsPerLine: 1500,
            cdsZoomPresentation: presentation,
          },
          { hovered: annotation }
        );
        const fill = recordedPaints(log).fills.find(
          (fill) => fill.fill === annotation.color && fill.alpha > 0
        )!;
        expect(fill.points.length).toBeGreaterThan(4);
        const contours = line.classifiedCDSs[0]._interactionOutlineContours!;
        expect(contours).toHaveLength(1);
        for (const point of contours[0]) {
          const distance = Math.min(
            ...fill.points.map((a, i) => {
              const b = fill.points[(i + 1) % fill.points.length],
                dx = b.x - a.x,
                dy = b.y - a.y;
              const t =
                dx === 0 && dy === 0
                  ? 0
                  : Math.max(
                      0,
                      Math.min(
                        1,
                        ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy)
                      )
                    );
              return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
            })
          );
          expect(
            distance,
            `hover must follow the arrow, pitch ${charWidth}, point ${point.x},${point.y}`
          ).toBeLessThan(1e-6);
        }
      }
    }
  );

  it('keeps strip boundary complexity bounded as residue count grows, regardless of input order', () => {
    for (const count of [2, 100, 10000]) {
      const cells = Array.from({ length: count }, (_, i) => ({
        codonX: i * 0.3,
        visibleWidth: 0.3,
        leftEdge: i === 0 ? ('flat' as const) : ('chevron' as const),
        rightEdge: i === count - 1 ? ('flat' as const) : ('chevron' as const),
      }));
      for (const direction of [1, -1] as const) {
        const capture = (input: typeof cells) => {
          const points: { x: number; y: number }[] = [];
          buildChevronStripOuterPath(
            {
              beginPath: () => {},
              closePath: () => {},
              moveTo: (x, y) => {
                points.push({ x, y });
              },
              lineTo: (x, y) => {
                points.push({ x, y });
              },
            },
            input,
            0,
            9.5,
            2,
            direction
          );
          return points;
        };
        const points = capture(cells);
        expect(points.length).toBeLessThanOrEqual(16);
        expect(capture([...cells].reverse())).toEqual(points);
        expect(Math.max(...points.map((p) => p.x))).toBeGreaterThanOrEqual(count * 0.3 - 1e-7);
        expect(Math.min(...points.map((p) => p.x))).toBeLessThanOrEqual(0);
      }
    }
  });

  it.each(['hovered', 'selected'] as const)(
    '%s perimeter encloses every painted CDS polygon through the morph',
    (state) => {
      const contains = (polygon: { x: number; y: number }[], point: { x: number; y: number }) => {
        let inside = false;
        for (let i = 0; i < polygon.length; i++) {
          const a = polygon[i],
            b = polygon[(i + 1) % polygon.length];
          const dx = b.x - a.x,
            dy = b.y - a.y;
          const t = Math.max(
            0,
            Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy))
          );
          if (Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy) < 1e-5) return true;
          if (a.y > point.y !== b.y > point.y && point.x < a.x + ((point.y - a.y) * dx) / dy)
            inside = !inside;
        }
        return inside;
      };
      for (const direction of [1, -1] as const) {
        const annotation = {
          name: 'protein',
          type: 'CDS',
          start: 2,
          end: 1498,
          direction,
          color: '#3478F6',
        };
        const subject = { ...sequence, annotations: [annotation] };
        for (const start of [0, 299, 1301, 1490]) {
          for (const charWidth of [
            0.3, 0.37, 0.39, 0.4, 0.42, 0.46, 0.54, 0.6, 1, 4.22, 4.23, 8, 9.6,
          ]) {
            const { log, line } = paint(
              1,
              start,
              'detail',
              0,
              subject,
              {
                charWidth,
                cdsZoomPresentation: cdsReplacementZoomPresentation(charWidth, 1200),
              },
              { [state]: annotation }
            );
            const cds = line.classifiedCDSs[0];
            const contours = cds._interactionOutlineContours ?? [];
            const fills = recordedPaints(log).fills.filter(
              (fill) => fill.alpha > 0 && fill.points.length > 2
            );
            expect(fills.length).toBeGreaterThan(0);
            for (const fill of fills)
              for (const point of fill.points) {
                if (!contours.some((contour) => contains(contour, point)))
                  console.log(
                    'CDS enclosure failure',
                    JSON.stringify({ fill, contours, pose: cds._paintedPresentation })
                  );
                expect(
                  contours.some((contour) => contains(contour, point)),
                  `${state}, strand ${direction}, row ${start}, pitch ${charWidth}: painted point ${point.x},${point.y} outside perimeter`
                ).toBe(true);
              }
          }
        }
      }
    }
  );

  it.each([1, -1] as const)(
    'keeps one selection perimeter across the circular origin on strand %i',
    (direction) => {
      const selected = {
        name: 'origin protein',
        type: 'CDS',
        start: 1401,
        end: 300,
        direction,
        color: '#3478F6',
      };
      const subject = { ...sequence, circular: true, annotations: [selected] };
      for (const charWidth of [0.4, 0.54, 8]) {
        const { log, config } = paint(
          1,
          1450,
          'detail',
          0,
          subject,
          {
            charWidth,
            cdsZoomPresentation: cdsReplacementZoomPresentation(charWidth, 1200),
          },
          { selected }
        );
        const outlines = recordedPaints(log).strokes.filter((stroke) => stroke.lineWidth === 2.5);
        expect(outlines).toHaveLength(1);
        expect(outlines[0]).toMatchObject({ moves: 1, closed: true });
        const points = outlines[0].points;
        expect(Math.min(...points.map((p) => p.x))).toBeLessThanOrEqual(config.marginLeft + 1e-6);
        expect(Math.max(...points.map((p) => p.x))).toBeGreaterThanOrEqual(
          config.marginLeft + config.charsPerLine * charWidth - 1e-6
        );
        expect(new Set(points.map((p) => `${p.x}:${p.y}`)).size).toBe(points.length);
      }
    }
  );

  it.each([1, -1] as const)(
    'keeps selection contour diagnostics in document coordinates after scrolling on strand %i',
    (direction) => {
      const selected = {
        name: 'protein',
        type: 'CDS',
        start: 1,
        end: 1500,
        direction,
        color: '#3478F6',
      };
      const scrollTop = 500;
      const { log, line } = paint(
        1,
        0,
        'detail',
        scrollTop,
        { ...sequence, annotations: [selected] },
        { cdsZoomPresentation: cdsReplacementZoomPresentation(8, 1200) },
        { selected }
      );
      const strokes = recordedPaints(log).strokes.filter((stroke) => stroke.lineWidth === 2.5);
      expect(strokes).toHaveLength(1);
      expect(line.classifiedCDSs[0]._interactionOutlineContours).toEqual(
        strokes.map((stroke) => stroke.points.map(({ x, y }) => ({ x, y: y + scrollTop })))
      );
    }
  );

  it.each([1, -1] as const)(
    'selects one complete outside perimeter across the morph on strand %i',
    (direction) => {
      const selected = {
        name: 'protein',
        type: 'CDS',
        start: 1,
        end: 1500,
        direction,
        color: '#3478F6',
      };
      const subject: AnnotatedSequence = {
        name: 'compound perimeter',
        sequence: 'ATG'.repeat(500),
        circular: false,
        annotations: [selected],
      };
      for (const start of [0, 300, 1300]) {
        for (const charWidth of [0.3, 0.4, 0.46, 0.54, 0.6, 0.8, 8]) {
          const { log, line } = paint(
            1,
            start,
            'detail',
            0,
            subject,
            {
              charWidth,
              cdsZoomPresentation: cdsReplacementZoomPresentation(charWidth, 1200),
            },
            { selected, hovered: null }
          );
          const outlines = recordedPaints(log).strokes.filter((stroke) => stroke.lineWidth === 2.5);
          expect(outlines, `one perimeter at row ${start}, pitch ${charWidth}`).toHaveLength(1);
          expect(outlines[0]).toMatchObject({ moves: 1, closed: true });
          const points = outlines[0].points;
          expect(points.length).toBeGreaterThanOrEqual(4);
          const cds = line.classifiedCDSs[0];
          expect(cds._interactionOutlineContours).toEqual([points.map(({ x, y }) => ({ x, y }))]);
          const pose = cds._paintedPresentation!;
          expect(Math.min(...points.map((p) => p.y))).toBeLessThanOrEqual(pose.barY);
          expect(Math.max(...points.map((p) => p.y))).toBeGreaterThanOrEqual(
            pose.aaY + pose.aaHeight - 1e-6
          );
          for (const pill of cds._cdsPillBounds ?? []) {
            expect(Math.min(...points.map((p) => p.y))).toBeLessThanOrEqual(pill.y! + 1e-6);
          }

          const cross = (
            a: (typeof points)[number],
            b: (typeof points)[number],
            c: (typeof points)[number]
          ) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
          for (let i = 0; i < points.length; i++)
            for (let j = i + 2; j < points.length; j++) {
              if (i === 0 && j === points.length - 1) continue;
              const a = points[i],
                b = points[(i + 1) % points.length];
              const c = points[j],
                d = points[(j + 1) % points.length];
              expect(
                cross(a, b, c) * cross(a, b, d) < -1e-8 && cross(c, d, a) * cross(c, d, b) < -1e-8
              ).toBe(false);
            }
        }
      }
    }
  );

  it('keeps the early betA color morph filled without a premature top line', () => {
    const charWidth = 0.3165413144733205;
    const presentation = cdsReplacementZoomPresentation(charWidth, 655);
    const { line, log, config } = paint(presentation.progress, 324642, 'detail', 0, mg1655, {
      charWidth,
      charsPerLine: 2056,
      cdsZoomPresentation: presentation,
      annotationColorMode: 'auto-type',
      aaColorScheme: 'rasmol',
    });
    const cds = line.classifiedCDSs.find((c) => c.name === 'betA')!;
    const pose = cds._paintedPresentation!;
    expect(pose.colorAlpha).toBeCloseTo(0.07652656257212584);
    expect(cds._cdsLineBounds).toEqual([]);
    const joinX = config.marginLeft + (325576 - 324642) * charWidth;
    const body = recordedPaints(log).fills.find(
      (f) =>
        f.fill === pose.color &&
        Math.abs(f.alpha - pose.barAlpha) < 1e-8 &&
        Math.abs(f.y - pose.aaY) < 1e-8 &&
        f.x < joinX + 1 &&
        f.x + f.w > joinX + 20
    )!;
    expect(body, 'the still-visible blue body must fill its symmetric contour').toBeTruthy();
    const p = { x: joinX + 2, y: pose.aaY + 2 };
    let inside = false;
    for (let i = 0, j = body.points.length - 1; i < body.points.length; j = i++) {
      const a = body.points[i],
        b = body.points[j];
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
        inside = !inside;
    }
    expect(inside, 'no near-white triangle may remain as codon colors appear').toBe(true);
  });

  it('ends the narrow insN top edge where the continued body diagonals intersect', () => {
    const charWidth = 0.5092807663474926;
    const presentation = cdsReplacementZoomPresentation(charWidth, 814);
    const { line, log } = paint(presentation.progress, 272187, 'detail', 0, mg1655, {
      charWidth,
      charsPerLine: 1590,
      cdsZoomPresentation: presentation,
      aaColorScheme: 'rasmol',
    });
    const cds = line.classifiedCDSs.find((cds) => cds.name === 'insN')!;
    const pose = cds._paintedPresentation!;
    expect(pose.topLineHeight).toBe(4.5);
    const edges = recordedPaints(log).fills.filter(
      (fill) =>
        fill.fill === cds._paintedPresentation!.color &&
        fill.alpha === 1 &&
        fill.points.length === 3 &&
        Math.abs(fill.y + fill.h - pose.aaY) < 1e-8 &&
        fill.h <= pose.topLineHeight
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].h).toBeGreaterThan(0);
    expect(edges[0].h).toBeLessThan(pose.topLineHeight);
    expect(edges[0].points.every((point) => Number.isFinite(point.x + point.y))).toBe(true);
    const [apex, ...base] = [...edges[0].points].sort((a, b) => a.y - b.y);
    const body = recordedPaints(log).fills.find(
      (fill) =>
        base.every((join) =>
          fill.points.some(
            (point) => Math.abs(point.x - join.x) < 1e-8 && Math.abs(point.y - join.y) < 1e-8
          )
        ) && fill.points.some((point) => point.y > pose.aaY + 1e-8)
    )!;
    expect(body).toBeTruthy();
    const side = (join: (typeof base)[number]) => {
      const i = body.points.findIndex(
        (point) => Math.abs(point.x - join.x) < 1e-8 && Math.abs(point.y - join.y) < 1e-8
      );
      expect(i).toBeGreaterThanOrEqual(0);
      const adjacent = [
        body.points[(i + 1) % body.points.length],
        body.points[(i + body.points.length - 1) % body.points.length],
      ].find((point) => point.y > join.y + 1e-8)!;
      expect(adjacent).toBeTruthy();
      return { x: adjacent.x - join.x, y: adjacent.y - join.y };
    };
    const a = side(base[0]);
    const b = side(base[1]);
    const cross = (u: typeof a, v: typeof a) => u.x * v.y - u.y * v.x;
    const separation = { x: base[1].x - base[0].x, y: base[1].y - base[0].y };
    const t = cross(separation, b) / cross(a, b);
    expect(apex.x).toBeCloseTo(base[0].x + t * a.x, 8);
    expect(apex.y).toBeCloseTo(base[0].y + t * a.y, 8);
  });

  it.each([1, -1, 0] as const)(
    'joins the selectable top line to the final base and continues the end diagonal on strand %i',
    (direction) => {
      const subject: AnnotatedSequence = {
        name: 'CDS top edge',
        sequence: 'ATG'.repeat(500),
        circular: false,
        annotations: [
          { name: 'protein', type: 'CDS', start: 1, end: 1500, direction, color: '#3478F6' },
        ],
      };

      for (const start of [0, 300, 1300])
        for (const charWidth of [0.3, 0.46, 0.54, 0.6, 0.8, 8, 0.6, 0.46, 0.3]) {
          const presentation = cdsReplacementZoomPresentation(charWidth, 1342);
          const { line, log, config } = paint(presentation.progress, start, 'detail', 0, subject, {
            charWidth,
            charsPerLine: 200,
            cdsZoomPresentation: presentation,
            aaColorScheme: 'rasmol',
          });
          const cds = line.classifiedCDSs[0],
            pose = cds._paintedPresentation!;
          const paints = recordedPaints(log);
          const edges = [
            ...paints.fills,
            ...paints.rectangles.map((r) => ({
              ...r,
              points: [
                { x: r.x, y: r.y },
                { x: r.x + r.w, y: r.y },
                { x: r.x + r.w, y: r.y + r.h },
                { x: r.x, y: r.y + r.h },
              ],
            })),
          ].filter(
            (r) =>
              r.fill === '#3478F6' &&
              r.alpha === 1 &&
              Math.abs(r.y + r.h - pose.aaY) < 1e-8 &&
              r.h <= 4.5
          );
          if (presentation.topLineHeight === 0) {
            expect(edges).toEqual([]);
            continue;
          }
          expect(edges).toHaveLength(1);
          const edge = edges[0];
          expect(edge.h).toBeCloseTo(presentation.topLineHeight, 10);
          const width = config.charsPerLine * charWidth;
          const bounds = calculateLineTrackBounds(line, config, true, false, false);
          for (const fraction of [0.1, 0.5, 0.9]) {
            const x = edge.x + edge.w * fraction;
            expect(
              detectCDSLabelHit(x, edge.y + edge.h / 2, line, bounds, config, 1500)
            ).toMatchObject({ type: 'annotation', annotation: cds, start: 0, end: 1499 });
          }

          const lower = edge.points.filter((p) => Math.abs(p.y - pose.aaY) < 1e-8);
          expect(lower).toHaveLength(2);
          if (pose.colorAlpha > 0) {
            expect(Math.min(...lower.map((p) => p.x))).toBeCloseTo(config.marginLeft, 10);
            expect(Math.max(...lower.map((p) => p.x))).toBeCloseTo(config.marginLeft + width, 10);
          }
          for (const side of ['left', 'right'] as const) {
            const join = lower.reduce((a, b) =>
              (side === 'left' ? a.x < b.x : a.x > b.x) ? a : b
            );
            const upper = edge.points
              .filter((p) => Math.abs(p.y - edge.y) < 1e-8)
              .reduce((a, b) => ((side === 'left' ? a.x < b.x : a.x > b.x) ? a : b));
            const adjoining = paints.fills.filter(
              (fill) =>
                Math.abs(fill.y - pose.aaY) < 1e-8 &&
                Math.abs(fill.h - pose.aaHeight) < 1e-8 &&
                fill.points.some(
                  (p) => Math.abs(p.x - join.x) < 1e-8 && Math.abs(p.y - join.y) < 1e-8
                )
            );
            expect(adjoining.length).toBeGreaterThan(0);
            const followsEdge = adjoining.some((fill) =>
              fill.points.some((p, i) => {
                const next = fill.points[(i + 1) % fill.points.length];
                const atJoin = Math.abs(p.x - join.x) < 1e-8 && Math.abs(p.y - join.y) < 1e-8;
                const nextAtJoin =
                  Math.abs(next.x - join.x) < 1e-8 && Math.abs(next.y - join.y) < 1e-8;
                const below = atJoin ? next : nextAtJoin ? p : null;
                return (
                  below &&
                  below.y > join.y &&
                  Math.abs(
                    (join.x - upper.x) * (below.y - join.y) -
                      (join.y - upper.y) * (below.x - join.x)
                  ) < 1e-7
                );
              })
            );
            expect(
              followsEdge,
              `${side} end must continue the painted diagonal without a notch`
            ).toBe(true);
          }
          if (presentation.progress === 1) {
            const name = cds._cdsPillBounds![0];
            expect(name.y! + name.h!).toBeCloseTo(edge.y + edge.h, 10);
            expect(name.x).toBeGreaterThanOrEqual(edge.x);
            expect(name.x + name.w).toBeLessThanOrEqual(edge.x + edge.w);
            expect(pose.barAlpha).toBe(0);
          }
        }
    }
  );
  it.each([1, -1] as const)(
    'keeps the retained line on the annotation target after scrolling across the origin on strand %i',
    (direction) => {
      const subject: AnnotatedSequence = {
        ...sequence,
        circular: true,
        annotations: [
          { name: 'protein', type: 'CDS', start: 1401, end: 300, direction, color: '#3478F6' },
        ],
      };
      const scrollTop = 500;
      const { line, layout, config, log } = paint(1, 1450, 'detail', scrollTop, subject, {
        cdsZoomPresentation: cdsReplacementZoomPresentation(8, 1342),
      });
      const cds = line.classifiedCDSs[0];
      expect(cds._cdsLineBounds).toHaveLength(1);
      const edge = cds._cdsLineBounds![0];
      expect(edge.w).toBeCloseTo(config.charsPerLine * config.charWidth);
      expect([...recordedPaints(log).fills, ...recordedPaints(log).rectangles]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            x: edge.x,
            y: edge.y - scrollTop,
            w: edge.w,
            h: edge.h,
            fill: '#3478F6',
          }),
        ])
      );
      const x = edge.x + edge.w * 0.1;
      expect(cds._cdsPillBounds!.some((p) => x >= p.x && x <= p.x + p.w)).toBe(false);
      const pick = (y: number) =>
        getHitTarget(
          x,
          y - scrollTop,
          scrollTop,
          [line],
          layout.totalHeight + scrollTop,
          config,
          1500,
          null,
          true,
          []
        );
      const hit = pick(edge.y + edge.h / 2);
      expect(hit).toMatchObject({ type: 'annotation', annotation: cds, start: 1400, end: 299 });
      if (hit.type !== 'annotation') throw Error('Missing retained-line annotation target');
      expect(
        resolvePointerSelection({
          annotationHit: hit.annotation,
          parentCdsForCodon: null,
          classifiedCDSs: line.classifiedCDSs,
          position: null,
          showAnnotations: true,
          showTranslation: true,
          orfHit: null,
        })
      ).toMatchObject({ annotation: { name: 'protein', start: 1401, end: 300 }, orf: null });
      expect(pick(edge.y - 0.25).type).not.toBe('annotation');
      const pose = cds._paintedPresentation!;
      expect(pick(pose.aaY + pose.aaHeight / 2).type).toBe('codon');
    }
  );

  it.each([1, -1] as const)(
    'paints one opaque name before and throughout color replacement on strand %i',
    (direction) => {
      const subject: AnnotatedSequence = {
        name: 'opaque name',
        sequence: 'ATG'.repeat(500),
        circular: false,
        annotations: [
          { name: 'protein', type: 'CDS', start: 1, end: 1500, direction, color: '#3478F6' },
        ],
      };
      const onset = (1342 + 256) / 3000;
      for (const start of [0, 300, 1200])
        for (const scale of [0.7, 0.8, 0.9, 1, 1.01, 1.125, 1.25, 1.1, 0.9]) {
          const charWidth = onset * scale;
          const presentation = cdsReplacementZoomPresentation(charWidth, 1342);
          const { line, log } = paint(presentation.progress, start, 'detail', 0, subject, {
            charWidth,
            charsPerLine: 300,
            cdsZoomPresentation: presentation,
          });
          const names = recordedPaints(log).texts.filter((t) => t.text === 'protein');
          expect(names, `row ${start}, density ${scale}`).toHaveLength(1);
          expect(names[0].alpha).toBe(1);
          const cds = line.classifiedCDSs[0],
            pose = cds._paintedPresentation!;
          if (presentation.colorAlpha > 0) {
            expect(pose.labelY + pose.labelHeight).toBeCloseTo(pose.aaY, 10);
            expect(names[0].y).toBeCloseTo(pose.labelY + 7, 10);
          }
          if (scale > 0.75) {
            expect(cds._cdsPillBounds).toHaveLength(1);
            const pill = cds._cdsPillBounds![0];
            const fills = recordedPaints(log).fills.filter(
              (f) =>
                Math.abs(f.x - pill.x) < 1e-8 &&
                Math.abs(f.y - pill.y!) < 1e-8 &&
                Math.abs(f.w - pill.w) < 1e-8 &&
                f.h === 14
            );
            expect(fills).toHaveLength(1);
            expect(fills[0].alpha).toBe(1);
          }
        }
    }
  );

  it.each([0.27, 0.3356431256950442, 0.37])(
    'keeps one opaque name at the same row position through repeated culling and row-window rebuilds at %s pixels/base',
    (charWidth) => {
      const presentation = cdsReplacementZoomPresentation(charWidth, 655);
      const config = {
        ...DEFAULT_EDITOR_CONFIG,
        charWidth,
        charsPerLine: 1939,
        rowHeight: 0.8391078142376105,
        fontSize: 0.4615092978306857,
        marginLeft: 4,
        lodLevel: 'detail',
        showTranslation: true,
        cdsDetailProgress: presentation.progress,
        cdsZoomPresentation: presentation,
      } as WorkspaceEditorConfig;
      const build = (firstRowIndex: number) =>
        computeSequenceLayoutImpl(mg1655, config, 15660, 0, [], false, [], 0, {
          firstRowIndex,
          lastRowIndex: 2,
          emitOnlyViewportLines: true,
        });
      const layout = build(0);
      const positions = layout.lines.map((line) => computeLineTrackPositions(line, config));
      const cache: typeof positions = [];
      const seen = new Map<number, { x: number; y: number; w: number }>();
      const check = (current: typeof layout, scrollTop: number, height: number) => {
        cullLinesToViewport(
          current.lines.map((line) => computeLineTrackPositions(line, config)),
          scrollTop,
          height,
          cache
        );
        const log = paintRows(mg1655, config, current, cache, scrollTop, height);
        const names = recordedPaints(log).texts.filter((t) => t.text === 'nhaA');
        const fragments = cache.filter(({ line }) =>
          line.classifiedCDSs.some((c) => c.name === 'nhaA')
        );
        expect(fragments.length).toBeGreaterThan(0);
        expect(names).toHaveLength(fragments.length);
        for (const { line } of fragments) {
          const cds = line.classifiedCDSs.find((c) => c.name === 'nhaA')!;
          expect(cds._cdsPillBounds).toHaveLength(1);
          const pill = cds._cdsPillBounds![0];
          const text = names.find((t) => Math.abs(t.y + scrollTop - pill.y! - 7) < 1e-6)!;
          expect(text).toBeDefined();
          expect(text.alpha).toBe(1);
          const position = { x: text.x, y: text.y + scrollTop, w: pill.w };
          const previous = seen.get(line.lineIndex);
          if (previous) expect(position).toEqual(previous);
          else seen.set(line.lineIndex, position);
        }
      };
      check(layout, positions[0].annotationY, 400);
      check(layout, positions[1].annotationY + 101, 50);
      check(layout, positions[0].annotationY, 400);
      check(build(1), positions[1].annotationY, 400);
      expect(seen.size).toBe(2);
    }
  );
  it('uses the original inside-shape compact name with ellipsis or hides it when it cannot fit', () => {
    const subject: AnnotatedSequence = {
      name: 'compact label fit',
      sequence: 'ATG'.repeat(1000),
      circular: false,
      annotations: [
        {
          name: 'a very long annotation name that must fit its own shape',
          type: 'CDS',
          start: 1,
          end: 3000,
          direction: 1,
          color: '#3478F6',
        },
      ],
    };
    for (const charsPerLine of [3000, 200, 20]) {
      const charWidth = 0.2;
      const { line, log } = paint(0, 0, 'feature', 0, subject, {
        charsPerLine,
        charWidth,
        showTranslation: true,
        cdsZoomPresentation: cdsReplacementZoomPresentation(charWidth, 1342),
      });
      const cds = line.classifiedCDSs[0],
        pose = cds._paintedPresentation!;
      expect(cds._cdsPillBounds).toEqual([]);
      const labels = recordedPaints(log).texts.filter((t) => t.text.startsWith('a'));
      if (charsPerLine === 20) expect(labels).toEqual([]);
      else {
        expect(labels).toHaveLength(1);
        expect(labels[0].y).toBeCloseTo(pose.barY + pose.barHeight / 2);
        expect(labels[0].x).toBeGreaterThanOrEqual(4);
        expect(labels[0].x).toBeLessThanOrEqual(4 + charsPerLine * charWidth);
        if (charsPerLine === 200) expect(labels[0].text).toMatch(/…$/);
        else expect(labels[0].text).toBe(subject.annotations![0].name);
      }
    }
  });
  it('holds the original body until color onset, then replaces it in the same vertical band', () => {
    for (const charWidth of [0.3, 0.4]) {
      const metrics = {
        ...DEFAULT_EDITOR_CONFIG,
        charWidth,
        showAnnotations: true,
        showTranslation: true,
        cdsZoomPresentation: cdsReplacementZoomPresentation(charWidth, 840),
      };
      const config = { ...metrics, ...resolveIndexedCdsZoomConfig(metrics, 840) };
      const { line } = paint(config.cdsDetailProgress, 0, config.lodLevel, 0, sequence, {
        ...config,
        charsPerLine: 1500,
      });
      const pose = line.classifiedCDSs[0]._paintedPresentation!;
      if (pose.colorAlpha === 0) expect(pose.barHeight).toBeCloseTo(14, 10);
      else {
        expect(pose.barHeight).toBeCloseTo(pose.aaHeight, 10);
        expect(pose.barY).toBeCloseTo(pose.aaY, 10);
        expect(pose.intronY).toBeCloseTo(pose.aaY + pose.aaHeight / 2, 10);
      }
    }
  });
  it('removes exon and intron pills at every zoom while retaining the gene label', () => {
    for (const progress of [0, 0.2, 0.8, 1]) {
      const { line, log } = paint(progress, 0, 'detail', 0, sequence, { charsPerLine: 1500 });
      const texts = recordedPaints(log).texts.map((t) => t.text);
      expect(texts.some((text) => /\b(?:exon|intron)\b/i.test(text))).toBe(false);
      expect(texts).toContain('INS');
      expect(line.classifiedCDSs[0]._exonPillBounds).toEqual([]);
      expect(line.classifiedCDSs[0]._intronPillBounds).toEqual([]);
      expect(line.classifiedCDSs[0]._cdsPillBounds).toHaveLength(1);
    }
  });
  it('strokes indexed cell separators once, instead of outlining every adjacent cell twice', () => {
    const subject: AnnotatedSequence = {
      name: 'contiguous CDS',
      sequence: 'ATG'.repeat(100),
      circular: false,
      annotations: [
        { name: 'protein', type: 'CDS', start: 1, end: 300, direction: 1, color: '#3478F6' },
      ],
    };
    const { log } = paint(1, 0, 'detail', 0, subject, {
      charsPerLine: 300,
      charWidth: 3,
      fontSize: 4.125,
      rowHeight: 7.5,
      cdsZoomPresentation: cdsReplacementZoomPresentation(3, 1342),
      aaColorScheme: 'rasmol',
    });
    expect(
      recordedPaints(log).strokes.filter(
        (s) => s.stroke === 'rgba(156, 163, 175, 0.38)' && s.lineWidth === 1.25
      )
    ).toHaveLength(2);
  });
  it('keeps one height for the line and chevrons, anchored above the nucleotide row', () => {
    const subject = {
      ...sequence,
      annotations: [
        { name: 'protein', type: 'CDS', start: 1, end: 300, direction: -1, color: '#3478F6' },
      ],
    };
    const bottomGaps: number[] = [];
    for (const charWidth of [0.247, 0.27, 0.3165413144733205, 0.4, 1, 4, 9.5 / 2.25, 4.23, 8]) {
      const presentation = cdsReplacementZoomPresentation(charWidth, 655);
      const { line, positions } = paint(presentation.progress, 0, 'detail', 0, subject, {
        charWidth,
        rowHeight: (charWidth * 20) / 8,
        fontSize: (charWidth * 11) / 8,
        charsPerLine: 300,
        cdsZoomPresentation: presentation,
      });
      const cds = line.classifiedCDSs[0];
      const pose = cds._paintedPresentation!;
      const edge = cds._cdsLineBounds![0];
      const bottom = pose.aaY + pose.aaHeight;
      const height = Math.max(14, charWidth * 2.25 + presentation.topLineHeight);
      if (edge) expect(edge.y! + edge.h!).toBeCloseTo(pose.aaY, 10);
      else expect(presentation.topLineHeight).toBe(0);
      expect(bottom - (edge?.y ?? pose.aaY)).toBeCloseTo(height, 10);
      bottomGaps.push(positions.sequenceY - bottom);
    }

    expect(Math.max(...bottomGaps) - Math.min(...bottomGaps)).toBeLessThan(1e-8);
  });
  it('preserves the symmetric blue body without a line until the color fade starts', () => {
    const viewportSpanPx = 1342;
    for (const charWidth of [0.3, 0.38666666666666666, 0.46]) {
      const cdsZoomPresentation = cdsReplacementZoomPresentation(charWidth, viewportSpanPx);
      const progress = cdsZoomPresentation.progress;
      expect(progress).toBe(0);
      expect(cdsZoomPresentation.topLineHeight).toBe(0);
      expect(cdsZoomPresentation.barHeight).toBeCloseTo(14, 10);
      const metrics = {
        charWidth,
        fontSize: (charWidth * 11) / 8,
        rowHeight: (charWidth * 20) / 8,
        charsPerLine: 1500,
        aaColorScheme: 'rasmol',
        cdsZoomPresentation,
      };
      const { line, log } = paint(progress, 0, 'detail', 0, sequence, metrics);
      expect(line.classifiedCDSs[0]._paintedPresentation!.barHeight).toBeCloseTo(
        cdsZoomPresentation.barHeight,
        10
      );
      const colors = getAAScheme('rasmol').colors;
      const paints = recordedPaints(log);
      expect(
        [...paints.fills, ...paints.rectangles].filter(
          (p) => Object.values(colors).includes(p.fill) && p.alpha > 0
        )
      ).toEqual([]);
    }
  });
  it.each([1, -1] as const)(
    'replaces the body in place and paints its chips above the blend on strand %i',
    (direction) => {
      const subject = {
        ...sequence,
        annotations: sequence.annotations.map((a) => ({ ...a, direction })),
      };
      for (const charWidth of [0.3, 0.46, 0.54, 0.6, 0.8, 2.66, 2.68, 8]) {
        const presentation = cdsReplacementZoomPresentation(charWidth, 1342);
        const { line, log, config, positions } = paint(
          presentation.progress,
          0,
          'detail',
          0,
          subject,
          {
            charWidth,
            fontSize: (charWidth * 11) / 8,
            rowHeight: (charWidth * 20) / 8,
            charsPerLine: 1500,
            aaColorScheme: 'rasmol',
            cdsZoomPresentation: presentation,
          }
        );
        const paints = recordedPaints(log),
          cds = line.classifiedCDSs[0];
        const blue = [...paints.fills, ...paints.rectangles].filter(
          (p) => p.fill === '#3478F6' && p.alpha === 1
        );
        const colors = [...paints.fills, ...paints.rectangles].filter(
          (p) => Object.values(getAAScheme('rasmol').colors).includes(p.fill) && p.alpha > 0
        );
        if (presentation.colorAlpha === 0) expect(colors).toHaveLength(0);
        else {
          expect(colors.length).toBeGreaterThan(0);
          for (const color of colors) {
            expect(color.y).toBeCloseTo(cds._paintedPresentation!.aaY, 10);
            expect(color.h).toBeCloseTo(cds._paintedPresentation!.aaHeight, 10);
            expect(color.y + color.h).toBeLessThanOrEqual(positions.sequenceY + 1e-8);
            for (const chip of blue) {
              const intersects =
                color.x + color.w > chip.x &&
                color.x < chip.x + chip.w &&
                color.y + color.h > chip.y + 1e-8 &&
                color.y < chip.y + chip.h - 1e-8;
              if (intersects) {
                const pose = cds._paintedPresentation!;
                expect(
                  Math.min(Math.abs(chip.y - pose.labelY), Math.abs(chip.y - (pose.intronY - 7)))
                ).toBeLessThan(1e-8);
                expect(chip.h).toBe(14);

                expect(chip.order).toBeGreaterThan(color.order);
              }
            }
          }
        }
        const pose = cds._paintedPresentation!;
        expect(
          detectCodonHit(
            config.marginLeft + charWidth / 2,
            pose.aaY + pose.aaHeight / 2,
            line,
            calculateLineTrackBounds(line, config, true, false, false),
            config,
            1500
          )?.type
        ).toBe(presentation.colorAlpha > 0 ? 'codon' : undefined);
      }
    }
  );
  it('can paint early CDS colors without rendering unreadable nucleotide glyphs', () => {
    const metrics = computeScaledConfig({ charWidth: 8, fontSize: 11, rowHeight: 20 }, 32);
    const { positions, log } = paint(cdsDetailZoomProgress(metrics), 0, 'detail', 0, sequence, {
      ...metrics,
      aaColorScheme: 'rasmol',
      showNucleotideLetters: false,
      cdsZoomPresentation: cdsReplacementZoomPresentation(metrics.charWidth, 1342),
    } as Partial<WorkspaceEditorConfig>);
    const paints = recordedPaints(log);
    expect(
      [...paints.fills, ...paints.rectangles].some(
        (r) => r.fill === getAAScheme('rasmol').colors.M && r.alpha > 0
      )
    ).toBe(true);
    expect(
      paints.texts.filter(
        (t) => t.y >= positions.sequenceY && t.y < positions.rulerY && /^[atgc]$/i.test(t.text)
      )
    ).toHaveLength(0);
  });
  it.each([10, 32, 34])(
    'paints the indexed color/letter presentation at %s percent zoom',
    (zoom) => {
      const metrics = computeScaledConfig({ charWidth: 8, fontSize: 11, rowHeight: 20 }, zoom);
      const { line, positions, log } = paint(
        cdsDetailZoomProgress(metrics),
        0,
        deriveSequenceLodLevel(metrics),
        0,
        sequence,
        {
          ...metrics,
          aaColorScheme: 'rasmol',
          cdsZoomPresentation: cdsReplacementZoomPresentation(metrics.charWidth, 1342),
        }
      );
      const pose = line.classifiedCDSs[0]._paintedPresentation;
      expect(pose).toBeDefined();
      const paints = recordedPaints(log);
      if (zoom < 34) {
        expect(
          [...paints.fills, ...paints.rectangles].some(
            (r) =>
              r.fill === getAAScheme('rasmol')!.colors.M &&
              r.h > 2 &&
              Math.abs(r.alpha - 0.6) < 1e-8
          )
        ).toBe(true);
        expect(
          paints.texts.filter((t) => t.text === 'M' && t.y < positions.sequenceY)
        ).toHaveLength(0);
      } else {
        const residue = paints.texts.find((t) => t.text === 'M' && t.y < positions.sequenceY);
        expect(residue).toBeDefined();
        expect(residue!.alpha).toBeGreaterThan(0);
        expect(residue!.alpha).toBeCloseTo(0.85, 10);
      }
    }
  );
  it.each([1, -1] as const)(
    'keeps a gene label above circular-origin coding geometry without exon pills on strand %i',
    (direction) => {
      const subject: AnnotatedSequence = {
        name: 'origin-crossing exon',
        sequence: 'ATG'.repeat(100),
        circular: true,
        annotations: [
          {
            name: 'INS',
            type: 'CDS',
            start: 240,
            end: 180,
            direction,
            color: '#3478F6',
            segments: [
              { start: 240, end: 30 },
              { start: 61, end: 180 },
            ],
          },
        ],
      };
      const { line, config, log } = paint(1, 250, 'detail', 0, subject, {
        charsPerLine: 120,
        charWidth: 8,
      });
      const cds = line.classifiedCDSs[0];
      expect(recordedPaints(log).texts.some((t) => t.text === 'INS')).toBe(true);
      expect(cds._exonPillBounds).toEqual([]);
      expect(cds._intronPillBounds).toEqual([]);
      const name = cds._cdsPillBounds![0];
      expect(name.x + name.w / 2).toBeCloseTo(config.marginLeft + 60 * config.charWidth, 8);
      expect(name.y).toBe(cds._paintedPresentation!.labelY);
    }
  );
  it('keeps gene labels clear of the full-genome annotation stack during early growth', () => {
    for (let start = 270533; start < 271763; start += 202) {
      const { line, positions, log } = paint(0.15625, start, 'detail', 0, mg1655, {
        charsPerLine: 202,
        charWidth: 4,
        rowHeight: 10,
      });
      const annotationTops = line.annotations.map(
        (ann) =>
          positions.annotationY + ann.lane * (ANNOTATION_ROW_HEIGHT + ANNOTATION_LANE_PADDING)
      );
      const bodies = recordedPaints(log).fills.filter(
        (f) => f.h === 14 && annotationTops.some((top) => Math.abs(f.y - top) < 1e-8)
      );
      for (const cds of line.classifiedCDSs)
        for (const chip of cds._cdsPillBounds ?? [])
          for (const body of bodies)
            expect(
              body.x + body.w <= chip.x ||
                body.x >= chip.x + chip.w ||
                body.y + body.h <= chip.y! ||
                body.y >= chip.y! + chip.h!,
              `row ${start}: ${cds.name} gene label intersects annotation body at y=${body.y}`
            ).toBe(true);
    }
  });
  it.each([1, -1] as const)(
    'paints only the lower intron connections and centered direction arrows on strand %i',
    (direction) => {
      const subject: AnnotatedSequence = {
        name: 'multiple coding gaps',
        sequence: 'ATG'.repeat(100),
        circular: false,
        annotations: [
          {
            name: 'INS',
            type: 'CDS',
            start: 1,
            end: 300,
            direction,
            color: '#3478F6',
            segments: [
              { start: 1, end: 30 },
              { start: 121, end: 150 },
              { start: 241, end: 300 },
            ],
          },
        ],
      };
      const { line, config, log } = paint(1, 0, 'detail', 0, subject, {
        charsPerLine: 300,
        charWidth: 4.5,
      });
      const cds = line.classifiedCDSs[0],
        pose = cds._paintedPresentation!;
      const { rectangles, strokes } = recordedPaints(log);
      const headers = rectangles.filter(
        (r) => r.fill === '#3478F6' && r.h === 5 && r.y === pose.barY
      );
      expect(headers).toHaveLength(3);
      const gaps = [
        [30, 120],
        [150, 240],
      ];
      expect(cds._intronPillBounds).toEqual([]);
      for (const [start, end] of gaps) {
        const left = config.marginLeft + start * config.charWidth,
          right = config.marginLeft + end * config.charWidth;
        expect(headers.some((h) => h.x < right && h.x + h.w > left)).toBe(false);
      }
      const blueStrokes = strokes.filter((s) => s.stroke === '#3478F6' && s.lineWidth === 1);
      const connections = blueStrokes.filter((s) => s.points.length === 2);
      expect(connections).toHaveLength(2);
      for (const connection of connections)
        expect(connection.points.every((p) => Math.abs(p.y - pose.intronY) < 1e-8)).toBe(true);
      const arrows = blueStrokes.filter((s) => s.points.length >= 3);
      expect(arrows).toHaveLength(2);
      for (const arrow of arrows)
        for (let i = 0; i < arrow.points.length; i += 3) {
          const [top, tip, bottom] = arrow.points.slice(i, i + 3);
          expect(tip.y).toBeCloseTo(pose.intronY, 8);
          expect((top.y + bottom.y) / 2).toBeCloseTo(pose.intronY, 8);
          expect(Math.sign(tip.x - top.x)).toBe(direction);
        }
    }
  );
  it.each([1, -1] as const)(
    'retains one connector and an ordinary centered gene label on clipped intron rows on strand %i',
    (direction) => {
      const subject = {
        ...sequence,
        annotations: sequence.annotations.map((a) => ({ ...a, direction })),
      };
      for (const start of [0, 300, 1100]) {
        const { line, config, log } = paint(1, start, 'detail', 500, subject);
        const cds = line.classifiedCDSs[0],
          pose = cds._paintedPresentation!;
        const name = cds._cdsPillBounds![0];
        expect(cds._intronPillBounds).toEqual([]);
        expect(cds._exonPillBounds).toEqual([]);
        expect(name.x + name.w / 2).toBeCloseTo(
          config.marginLeft + (config.charsPerLine * config.charWidth) / 2,
          8
        );
        expect(name.y).toBe(pose.labelY);
        const connections = recordedPaints(log).strokes.filter(
          (stroke) =>
            stroke.stroke === '#3478F6' && stroke.lineWidth === 1 && stroke.points.length === 2
        );
        expect(connections).toHaveLength(1);
        expect(
          connections[0].points.every((p) => Math.abs(p.y - (pose.intronY - 500)) < 1e-8)
        ).toBe(true);
        expect(
          detectCDSLabelHit(
            name.x + name.w / 2,
            name.y! + 7,
            line,
            calculateLineTrackBounds(line, config, true, false, false),
            config,
            1500
          )
        ).toMatchObject({ type: 'annotation', start: 0, end: 1499 });
      }
    }
  );
  it.each([1, -1] as const)(
    'retains origin-crossing intron geometry without inline pills on strand %i',
    (direction) => {
      const subject: AnnotatedSequence = {
        name: 'origin-crossing coding gap',
        sequence: 'ATG'.repeat(100),
        circular: true,
        annotations: [
          {
            name: 'INS',
            type: 'CDS',
            start: 240,
            end: 120,
            direction,
            color: '#3478F6',
            segments: [
              { start: 240, end: 270 },
              { start: 31, end: 120 },
            ],
          },
        ],
      };
      const { line, config } = paint(1, 250, 'detail', 0, subject, {
        charsPerLine: 120,
        charWidth: 8,
      });
      const cds = line.classifiedCDSs[0],
        pose = cds._paintedPresentation!;
      expect(cds._intronPillBounds).toEqual([]);
      expect(cds._exonPillBounds).toEqual([]);
      const name = cds._cdsPillBounds![0];
      expect(name.x + name.w / 2).toBeCloseTo(config.marginLeft + 60 * config.charWidth, 8);
      expect(name.y).toBe(pose.labelY);
      expect(
        translationIntronUnderCursor({
          line,
          position: 0,
          y: pose.intronY,
          scrollTop: 0,
          hitDetectionConfig: config,
          showReverseComplement: true,
          hasForwardPrimers: false,
          hasReversePrimers: false,
          sequenceLength: 300,
        })
      ).toBe(true);
    }
  );
  it.each([1, -1] as const)(
    'retains one ordinary gene label for crowded exon/intron geometry on strand %i',
    (direction) => {
      const subject: AnnotatedSequence = {
        name: 'crowded indexed arrangement',
        sequence: 'ATG'.repeat(100),
        circular: false,
        annotations: [
          {
            name: 'INS',
            type: 'CDS',
            start: 1,
            end: 300,
            direction,
            color: '#3478F6',
            segments: [
              { start: 1, end: 18 },
              { start: 43, end: 300 },
            ],
          },
        ],
      };
      const { line, config, log } = paint(1, 0, 'detail', 0, subject, {
        charsPerLine: 300,
        charWidth: 4.5,
      });
      const cds = line.classifiedCDSs[0],
        pose = cds._paintedPresentation!;
      expect(cds._intronPillBounds).toEqual([]);
      expect(cds._exonPillBounds).toEqual([]);
      const name = cds._cdsPillBounds![0];
      expect(name.y! + name.h!).toBeCloseTo(pose.aaY, 8);
      expect(name.x + name.w / 2).toBeCloseTo(config.marginLeft + 150 * config.charWidth, 8);
      const names = recordedPaints(log).texts.filter((t) => t.text === 'INS');
      expect(names).toHaveLength(1);
    }
  );
  it('leaves compact rendering to the original filled annotation shapes', () => {
    const { line, log } = paint(0, 0, 'feature');
    expect(line.classifiedCDSs[0]._paintedPresentation).toBeUndefined();
    expect(
      recordedPaints(log).fills.some(
        (fill) => fill.fill === '#3478F6' && fill.h === 14 && fill.w > 500
      )
    ).toBe(true);
  });

  it('centers one gene name on a row containing exons and an intron', () => {
    const { line, positions, log } = paint(1, 0, 'detail', 0, sequence, {
      charsPerLine: 1500,
      charWidth: 1,
    });
    const texts = recordedPaints(log).texts.filter(
      (t) => t.y >= positions.translationY && t.y < positions.sequenceY
    );
    const names = texts.filter((t) => t.text === 'INS');
    expect(names).toHaveLength(1);
    const name = line.classifiedCDSs[0]._cdsPillBounds![0];
    expect(name.x + name.w / 2).toBeCloseTo(4 + 750, 8);
    expect(texts.some((t) => /(?:exon|intron)/i.test(t.text))).toBe(false);
  });

  it('starts with a visible thin color band before any amino-acid letters emerge', () => {
    const { line, positions, log } = paint(0.1, 0, 'detail', 0, sequence, {
      aaColorScheme: 'rasmol',
    });
    const pose = line.classifiedCDSs[0]._paintedPresentation!;
    expect(pose.aaHeight).toBeGreaterThanOrEqual(2);
    expect(pose.aaHeight).toBeLessThan(5);
    expect(
      recordedPaints(log).texts.filter((t) => t.text === 'M' && t.y < positions.sequenceY)
    ).toHaveLength(0);
  });

  it('keeps residue letters absent through the rectangular-bar growth stage', () => {
    const { positions, log } = paint(0.5);
    expect(
      recordedPaints(log).texts.filter((t) => t.text === 'M' && t.y < positions.sequenceY)
    ).toHaveLength(0);
  });

  it('paints rectangular amino-acid colors before the cutoff and protects the label interior', () => {
    const { line, log } = paint(0.2, 0, 'detail', 0, sequence, { aaColorScheme: 'rasmol' });
    const paintOps = recordedPaints(log);
    const methionine = getAAScheme('rasmol').colors.M;
    const cells = paintOps.rectangles.filter((f) => f.fill === methionine && f.alpha > 0);
    expect(cells.length).toBeGreaterThan(10);
    expect(paintOps.fills.filter((f) => f.fill === methionine)).toHaveLength(0);
    const cds = line.classifiedCDSs[0];
    const name = cds._cdsPillBounds![0];
    const group = { left: name.x, right: name.x + name.w, top: name.y!, bottom: name.y! + name.h! };
    for (const cell of cells)
      expect(
        cell.x + cell.w <= group.left + 1e-7 ||
          cell.x >= group.right - 1e-7 ||
          cell.y + cell.h <= group.top + 1e-7 ||
          cell.y >= group.bottom - 1e-7
      ).toBe(true);
  });

  it('keeps the original compact body inside its own short CDS', () => {
    const subject: AnnotatedSequence = {
      name: 'short coding feature',
      sequence: 'ATG'.repeat(10),
      circular: false,
      annotations: [{ name: 'INS', type: 'CDS', start: 1, end: 3, direction: 1, color: '#3478F6' }],
    };
    const { log, config } = paint(0, 0, 'feature', 0, subject);
    const body = recordedPaints(log).fills.find((fill) => fill.fill === '#3478F6')!;
    expect(body.h).toBe(14);
    expect(body.x + body.w).toBeLessThanOrEqual(config.marginLeft + 3 * config.charWidth);
  });

  it('keeps the complete-genome insN lane separated from insI1 throughout the morph', () => {
    for (const rowHeight of [7.2, 8, 9.1, 11.68, 20])
      for (const progress of [0.0001, 0.1, 0.25, 0.5, 0.75, 0.8, 0.95, 1]) {
        const { line, positions, layout } = paint(
          progress,
          270941,
          progress === 0 ? 'feature' : 'detail',
          0,
          mg1655,
          { rowHeight, charsPerLine: 82, charWidth: 4.672 }
        );
        const a = line.classifiedCDSs.find((c) => c.name === 'insN')!;
        const b = line.classifiedCDSs.find((c) => c.name === 'insI1')!;
        expect(a).toBeDefined();
        expect(b).toBeDefined();
        const aBottom = Math.max(
          a._paintedPresentation!.aaY + a._paintedPresentation!.aaHeight,
          ...(a._intronPillBounds ?? []).map((p) => p.y! + p.h!)
        );
        const bTop = b._paintedPresentation!.labelY;
        expect(
          bTop - aBottom,
          `progress ${progress} must not overlap neighboring CDS lanes`
        ).toBeGreaterThanOrEqual(-0.00001);
        for (const cds of [a, b])
          expect(
            cds._paintedPresentation!.aaY + cds._paintedPresentation!.aaHeight
          ).toBeLessThanOrEqual(positions.sequenceY + 0.00001);
        expect(positions.lineEndY - line.y).toBeCloseTo(line.naturalHeight!, 6);
        expect(layout.summary!.rowHeights[line.lineIndex]).toBeCloseTo(line.naturalHeight!, 6);
      }
  });

  it('keeps the real low-density gene label and coding band clear of its neighboring CDS', () => {
    const metrics = computeScaledConfig({ charWidth: 8, fontSize: 11, rowHeight: 20 }, 3.2);
    const indexed = cdsReplacementZoomPresentation(metrics.charWidth, 814);
    const { line } = paint(indexed.progress, 270166, 'detail', 0, mg1655, {
      ...metrics,
      charsPerLine: 3164,
      cdsZoomPresentation: indexed,
    });
    const intron = line.classifiedCDSs.find((cds) => cds.name === 'insN')!;
    const neighbor = line.classifiedCDSs.find((cds) => cds.name === 'insI1')!;
    expect(intron._cdsPillBounds).toEqual([]);
    const pose = intron._paintedPresentation!;
    expect(
      neighbor._paintedPresentation!.barY - (pose.barY + pose.barHeight),
      JSON.stringify({
        intronLane: intron._compactLane,
        neighborLane: neighbor._compactLane,
        intronPose: intron._paintedPresentation,
        neighborPose: neighbor._paintedPresentation,
      })
    ).toBeGreaterThanOrEqual(0);
  });

  it.each([1, -1] as const)(
    'keeps gene, codon and intron connector picking attached to the moving shapes on strand %i',
    (direction) => {
      const subject = {
        ...sequence,
        annotations: sequence.annotations.map((a) => ({ ...a, direction })),
      };
      for (const progress of [0.2, 0.8, 1]) {
        const { line, config } = paint(progress, 0, 'detail', 500, subject, { rowHeight: 11.68 });
        const cds = line.classifiedCDSs[0];
        const bounds = calculateLineTrackBounds(line, config, true, false, false);
        const name = cds._cdsPillBounds![0];
        expect(
          detectCDSLabelHit(name.x + name.w / 2, name.y! + 7, line, bounds, config, 1500)
        ).toMatchObject({ type: 'annotation', start: 0, end: 1499 });
        expect(cds._exonPillBounds).toEqual([]);
        const pose = cds._paintedPresentation!;
        expect(
          detectCodonHit(
            config.marginLeft + config.charWidth / 2,
            pose.aaY + pose.aaHeight / 2,
            line,
            bounds,
            config,
            1500
          )
        ).toMatchObject({ type: 'codon', start: 0, end: 2, strand: direction });
        const intronRow = paint(progress, 300, 'detail', 500, subject, { rowHeight: 11.68 });
        const intronPose = intronRow.line.classifiedCDSs[0]._paintedPresentation!;
        expect(
          translationIntronUnderCursor({
            line: intronRow.line,
            position: 500,
            y: intronPose.intronY - 500,
            scrollTop: 500,
            hitDetectionConfig: intronRow.config,
            showReverseComplement: true,
            hasForwardPrimers: false,
            hasReversePrimers: false,
            sequenceLength: 1500,
          })
        ).toBe(true);
        expect(intronRow.line.classifiedCDSs[0]._intronPillBounds).toEqual([]);
      }
    }
  );

  it('shares identical fractional lane patterns across the complete genome', () => {
    const counts = computeLaneCountsPerRow({
      annotations: mg1655.annotations ?? [],
      primers: [],
      orfs: [],
      cpr: 200,
      seqLen: mg1655.sequence.length,
      isCircular: true,
      normalizedBpOffset: 0,
      topBufferCount: 0,
      realRowCount: Math.ceil(mg1655.sequence.length / 200),
      bottomBufferCount: 0,
      showPrimers: false,
      cdsAsFeatureAnnotations: false,
      cdsDetailProgress: 0.5,
    });
    expect(new Set(counts).size, 'equal offscreen patterns must share geometry-cache keys').toBe(
      new Set(counts.map((count) => JSON.stringify(count))).size
    );
  });

  it('fits the complete translation lane when annotations are hidden', () => {
    const { line, positions } = paint(0.2, 0, 'detail', 0, sequence, {
      showAnnotations: false,
      rowHeight: 11.68,
    });
    const pose = line.classifiedCDSs[0]._paintedPresentation!;
    expect(pose.progress).toBe(1);
    expect(pose.aaY + pose.aaHeight).toBeLessThanOrEqual(positions.sequenceY);
  });

  it('picks the painted gene label after a document/viewport offset without a region click target', () => {
    const { line, config } = paint(0.75, 300, 'detail', 500);
    const cds = line.classifiedCDSs[0];
    const bounds = calculateLineTrackBounds(line, config, true, false, false);
    const name = cds._cdsPillBounds![0];
    expect(name.y).toBeGreaterThan(500);
    expect(cds._intronPillBounds).toEqual([]);
    expect(
      detectCDSLabelHit(name.x + name.w / 2, name.y! + 7, line, bounds, config, 1500)
    ).toMatchObject({
      type: 'annotation',
      start: 0,
      end: 1499,
    });
  });
  it('uses the indexed upper label band without filling the space down to the intron line', () => {
    const { positions, log, line } = paint();
    const { fills, texts, rectangles } = recordedPaints(log);
    const name = texts.find((t) => t.text === 'INS' && t.y >= positions.translationY)!;
    expect(name).toBeDefined();
    const pose = line.classifiedCDSs[0]._paintedPresentation!;
    expect(pose.detailStyle).toBe('indexed-bands');
    expect(pose.labelY + TRANSLATION_PILL_HEIGHT).toBeCloseTo(pose.aaY);
    expect(pose.barHeight).toBe(5);
    expect(pose.barCenterY).toBe(name.y);
    expect(
      rectangles.some((f) => f.w > 600 && f.h === 5 && f.y === pose.barY && f.fill === '#3478F6')
    ).toBe(true);
    expect(
      fills.some((f) => f.w > 600 && f.y === pose.labelY && f.h > 14 && f.fill === '#3478F6')
    ).toBe(false);
  });

  it('keeps one centered gene label above an intron-only row without a region pill', () => {
    const { positions, log, config, line } = paint(1, 300);
    const names = recordedPaints(log).texts.filter(
      (t) => t.text === 'INS' && t.y >= positions.translationY && t.y < positions.sequenceY
    );
    expect(names).toHaveLength(1);
    expect(recordedPaints(log).texts.some((t) => /(?:exon|intron)/i.test(t.text))).toBe(false);
    const cds = line.classifiedCDSs[0],
      name = cds._cdsPillBounds![0];
    expect(name.y).toBe(cds._paintedPresentation!.labelY);
    expect(name.x + name.w / 2).toBeCloseTo(
      config.marginLeft + (config.charsPerLine * config.charWidth) / 2
    );
    expect(cds._intronPillBounds).toEqual([]);
  });

  it('has no invisible exon label target at full detail while preserving the compact body target', () => {
    for (const charWidth of [0.2, 8]) {
      const presentation = cdsReplacementZoomPresentation(charWidth, 1342);
      const { line, config } = paint(presentation.progress, 0, 'detail', 500, sequence, {
        charWidth,
        charsPerLine: 1500,
        cdsZoomPresentation: presentation,
      });
      const cds = line.classifiedCDSs[0],
        pose = cds._paintedPresentation!;
      const bounds = calculateLineTrackBounds(line, config, true, false, false);
      const x = config.marginLeft + 20.5 * charWidth;
      if (presentation.colorAlpha === 1) {
        expect(detectCDSLabelHit(x, pose.labelY + 7, line, bounds, config, 1500)).toBeNull();
      } else {
        expect(
          detectCDSLabelHit(x, pose.barY + pose.barHeight / 2, line, bounds, config, 1500)
        ).toMatchObject({ type: 'annotation', start: 0, end: 1499 });
      }
    }
  });

  it('does not repeat identical gene/CDS names in the compact presentation', () => {
    const { line } = paint(0, 0, 'feature');
    expect(line.annotations.find((a) => a.type === 'CDS')?.name).toBe('INS');
  });

  it('grows the CDS band continuously from the compact layout, including the old threshold', () => {
    const compact = paint(0, 0, 'feature');
    const first = paint(0.00001),
      quarter = paint(0.25),
      threeQuarter = paint(0.75),
      full = paint(1);
    expect(Math.abs(first.positions.sequenceY - compact.positions.sequenceY)).toBeLessThan(0.01);
    expect(quarter.positions.sequenceY).toBeGreaterThan(compact.positions.sequenceY);
    expect(threeQuarter.positions.sequenceY).toBeGreaterThan(quarter.positions.sequenceY);
    expect(full.positions.sequenceY).toBeCloseTo(threeQuarter.positions.sequenceY);
  });

  it('fades the actual amino-acid letters over intermediate zoom presentations', () => {
    const alphaAt = (progress: number) => {
      const { positions, log } = paint(progress);
      return (
        recordedPaints(log).texts.find((t) => t.text === 'M' && t.y < positions.sequenceY)?.alpha ??
        0
      );
    };
    expect(alphaAt(0.25)).toBe(0);
    expect(alphaAt(0.65)).toBe(0);
    expect(alphaAt(0.75)).toBeGreaterThan(0);
    expect(alphaAt(0.75)).toBeLessThan(alphaAt(1));
  });
});
