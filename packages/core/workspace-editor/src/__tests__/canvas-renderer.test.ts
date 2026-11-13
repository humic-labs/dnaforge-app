import { describe, test, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderSequence, type RenderSequenceParams } from '../canvas-renderer';
import { drawRuler } from '../canvas-drawing';
import { DEFAULT_EDITOR_CONFIG } from '../types';
import type { ClassifiedCDS, Layout2DRow, LinePositions } from '../types';
import { cdsReplacementZoomPresentation } from '@waypoint/platform';

function createMinimalParams(overrides: Partial<RenderSequenceParams> = {}): RenderSequenceParams {
  return {
    linePositions: [],
    config: { ...DEFAULT_EDITOR_CONFIG },
    canvasWidth: 800,
    canvasHeight: 600,
    sequenceLength: 100,
    fullSequence: 'ATCG'.repeat(25),
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
    coordinateSpace: undefined,
    junctionIndicators: undefined,
    layout: { totalWidth: 800, totalHeight: 600, isCircular: false, lines: [] },
    ...overrides,
  };
}

function createMockContext(records?: {
  fillRects?: Array<{ x: number; y: number; width: number; height: number; fillStyle: unknown }>;
  strokes?: Array<{ strokeStyle: unknown; lineWidth: number; globalAlpha: number }>;
}): CanvasRenderingContext2D {
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    globalAlpha: 1,
    setTransform: () => {},
    fillRect(x: number, y: number, width: number, height: number) {
      records?.fillRects?.push({ x, y, width, height, fillStyle: this.fillStyle });
    },
    clearRect: () => {},
    strokeRect: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    setLineDash: () => {},
    bezierCurveTo: () => {},
    quadraticCurveTo: () => {},
    stroke() {
      records?.strokes?.push({
        strokeStyle: this.strokeStyle,
        lineWidth: this.lineWidth,
        globalAlpha: this.globalAlpha,
      });
    },
    fill: () => {},
    arc: () => {},
    save: () => {},
    restore: () => {},
    measureText: () => ({ width: 0 }),
    fillText: () => {},
    strokeText: () => {},
    translate: () => {},
    scale: () => {},
    rotate: () => {},
    clip: () => {},
    rect: () => {},
    roundRect: () => {},
    createLinearGradient: () => ({
      addColorStop: () => {},
    }),
  } as unknown as CanvasRenderingContext2D;
}

describe('SequenceCanvas Decomposition', () => {
  test('A-16: renderSequence handles null/undefined canvas context without throwing', () => {
    const params = createMinimalParams();
    expect(() => renderSequence(null, params)).not.toThrow();
  });

  test('A-17: renderSequence handles empty sequence input without throwing', () => {
    const ctx = createMockContext();
    const params = createMinimalParams({
      sequenceLength: 0,
      fullSequence: '',
    });
    expect(() => renderSequence(ctx, params)).not.toThrow();
  });

  test('renderSequence fills the full canvas background before drawing rows', () => {
    const records = { fillRects: [] };
    const ctx = createMockContext(records);
    const params = createMinimalParams({
      canvasWidth: 801,
      canvasHeight: 603,
    });

    renderSequence(ctx, params);

    expect(records.fillRects[0]).toMatchObject({
      x: 0,
      y: 0,
      width: 801,
      height: 603,
    });
  });

  test.each([0, 45])(
    'keeps extension arrows inside the visible pane with row offset %s',
    (xOffset) => {
      const fullSequence = `${'CCC'.repeat(18)}TAA${'CCC'.repeat(3)}`;
      const cds = {
        name: 'edge runner',
        type: 'CDS',
        start: 4,
        end: 42,
        direction: 1,
        cdsType: 'full',
        translationLane: 0,
      } as ClassifiedCDS;
      const line = {
        lineIndex: 0,
        startPos: 0,
        endPos: 42,
        sequence: fullSequence.slice(0, 42),
        complementSequence: 'G'.repeat(42),
        y: 0,
        xOffset,
        annotations: [],
        annotationLaneCount: 0,
        classifiedCDSs: [cds],
        translationLaneCount: 1,
      } as Layout2DRow;
      const lp = {
        line,
        annotationY: 20,
        translationY: 40,
        translationLaneCount: 1,
        sequenceY: 0,
        complementY: 0,
        rulerY: 0,
        lineEndY: 80,
      } as LinePositions;
      const params = createMinimalParams({
        linePositions: [lp],
        config: {
          ...DEFAULT_EDITOR_CONFIG,
          charWidth: 8,
          charsPerLine: 42,
          marginLeft: 70,
          showAnnotations: false,
          showTranslation: true,
          lodLevel: 'detail',
          cdsZoomPresentation: cdsReplacementZoomPresentation(8, 400),
        },
        canvasWidth: 528,
        sequenceLength: fullSequence.length,
        fullSequence,
        layout: { totalWidth: 528, totalHeight: 80, isCircular: false, lines: [line] },
      });
      const result = renderSequence(createMockContext(), params);
      const arrow = result.renderedCdsExtensionArrows.find((a) => a.direction === 'three-prime');
      expect(arrow).toBeDefined();
      expect(arrow?.anchorBp).toBe(41);
      expect(arrow?.width).toBe(12);
      expect((arrow?.x ?? Infinity) + (arrow?.width ?? 0)).toBeLessThanOrEqual(400);
      expect(arrow?.x).toBe(388);
    }
  );

  test('A-15: canvas-renderer.ts has zero React dependencies', () => {
    const filePath = path.resolve(__dirname, '../canvas-renderer.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).not.toMatch(/from ['"]react['"]/);
    expect(content).not.toMatch(/from ['"]react-dom['"]/);
    expect(content).not.toMatch(/import\s.*\buse[A-Z]\w+/);
  });

  test('A-14: useCanvasWorkerDraw hook imports and calls renderSequence from canvas-renderer', () => {
    const filePath = path.resolve(__dirname, '../hooks/useCanvasWorkerDraw.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toMatch(/import.*renderSequence.*from.*canvas-renderer/);
    expect(content).toMatch(/renderSequence\(/);
  });

  test('drawRuler consumes app-authored provenance width and alpha', () => {
    const records = { strokes: [] };
    const ctx = createMockContext(records);
    drawRuler(
      ctx,
      [
        {
          line: {
            lineIndex: 0,
            startPos: 0,
            endPos: 12,
            sequence: 'ATCGATCGATCG',
            complementSequence: 'TAGCTAGCTAGC',
            y: 0,
            annotations: [],
            annotationLaneCount: 0,
          },
          annotationY: 0,
          translationY: 0,
          translationLaneCount: 0,
          sequenceY: 0,
          complementY: 0,
          mutationTrackY: 0,
          hasMutationTrack: false,
          rulerY: 16,
          forwardPrimerY: 0,
          reversePrimerY: 0,
          lineEndY: 0,
          hasPrimers: false,
          hasForwardPrimers: false,
          hasReversePrimers: false,
          absoluteLineY: 0,
          forwardOrfY: 0,
          reverseOrfY: 0,
          forwardOrfLaneCount: 0,
          reverseOrfLaneCount: 0,
        },
      ],
      0,
      { ...DEFAULT_EDITOR_CONFIG, charWidth: 10 },
      12,
      [{ start: 2, end: 6, color: '#8bb680', rulerStrokeWidth: 3, alpha: 0.64 }]
    );

    expect(records.strokes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          strokeStyle: '#8bb680',
          lineWidth: 3,
          globalAlpha: 0.64,
        }),
      ])
    );
  });
});
