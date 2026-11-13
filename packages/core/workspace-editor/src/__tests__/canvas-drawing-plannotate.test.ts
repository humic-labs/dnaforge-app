import { describe, test, expect, vi, beforeEach } from 'vitest';
import { drawAnnotationSegment } from '../canvas-drawing';
import { DEFAULT_EDITOR_CONFIG, type WorkspaceEditorConfig } from '../types';
import type { Annotation } from '@waypoint/sequence-utils';

vi.mock('../canvas-theme', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../canvas-theme')>();
  return {
    ...actual,
    getCanvasTheme: () => ({
      isDark: false,
      bg: '#fff',
      bgSubtle: '#eee',
      bgMuted: '#eee',
      fg: '#000',
      fgMuted: '#666',
      fgSubtle: '#999',
      border: '#ccc',
      accent: '#08f',
      error: '#f00',
    }),
  };
});

interface MockContext {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  globalAlpha: number;
  ops: Array<{ op: string; alpha?: number; dash?: number[]; lineWidth?: number; args?: unknown[] }>;
  save: () => void;
  restore: () => void;
  fillRect: (...args: unknown[]) => void;
  strokeRect: (...args: unknown[]) => void;
  beginPath: () => void;
  closePath: () => void;
  moveTo: (...args: unknown[]) => void;
  lineTo: (...args: unknown[]) => void;
  stroke: () => void;
  fill: () => void;
  measureText: (text: string) => { width: number };
  fillText: (...args: unknown[]) => void;
  setLineDash: (dash: number[]) => void;
  roundRect: (...args: unknown[]) => void;
  _currentDash: number[];
}

function createMockContext(): MockContext & CanvasRenderingContext2D {
  const stack: Array<{ globalAlpha: number; dash: number[] }> = [];
  const ctx: MockContext = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    globalAlpha: 1,
    ops: [],
    _currentDash: [],
    save() {
      stack.push({ globalAlpha: this.globalAlpha, dash: [...this._currentDash] });
    },
    restore() {
      const s = stack.pop();
      if (s) {
        this.globalAlpha = s.globalAlpha;
        this._currentDash = s.dash;
      }
    },
    fillRect(...args: unknown[]) {
      this.ops.push({ op: 'fillRect', alpha: this.globalAlpha, args });
    },
    strokeRect() {
      this.ops.push({
        op: 'strokeRect',
        alpha: this.globalAlpha,
        dash: [...this._currentDash],
        lineWidth: this.lineWidth,
      });
    },
    beginPath() {
      this.ops.push({ op: 'beginPath' });
    },
    closePath() {
      this.ops.push({ op: 'closePath' });
    },
    moveTo(...args: unknown[]) {
      this.ops.push({ op: 'moveTo', args });
    },
    lineTo(...args: unknown[]) {
      this.ops.push({ op: 'lineTo', args });
    },
    stroke() {
      this.ops.push({
        op: 'stroke',
        alpha: this.globalAlpha,
        dash: [...this._currentDash],
        lineWidth: this.lineWidth,
      });
    },
    fill() {
      this.ops.push({ op: 'fill', alpha: this.globalAlpha });
    },
    measureText(text: string) {
      return { width: text.length * 6 };
    },
    fillText(...args: unknown[]) {
      this.ops.push({ op: 'fillText', alpha: this.globalAlpha, args });
    },
    setLineDash(dash: number[]) {
      this._currentDash = [...dash];
    },
    roundRect(...args: unknown[]) {
      this.ops.push({ op: 'roundRect', args });
    },
  };
  return ctx as unknown as MockContext & CanvasRenderingContext2D;
}

const config: WorkspaceEditorConfig = { ...DEFAULT_EDITOR_CONFIG, charWidth: 10 };

function wrapQualifiers(
  raw: Record<string, string> | undefined
): Record<string, string[]> | undefined {
  if (!raw) return undefined;
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, [v]]));
}

function makeCDS(
  qualifiers?: Record<string, string>,
  direction: 1 | -1 | 0 = 1
): Annotation & { lane: number } {
  return {
    name: 'AmpR',
    type: 'CDS',
    start: 1,
    end: 200,
    direction,
    color: '#3b82f6',
    qualifiers: wrapQualifiers(qualifiers),
    lane: 0,
  };
}

function makeNonCDS(qualifiers?: Record<string, string>): Annotation & { lane: number } {
  return {
    name: 'AmpR promoter',
    type: 'promoter',
    start: 1,
    end: 200,
    direction: 1,
    color: '#f97316',
    qualifiers: wrapQualifiers(qualifiers),
    lane: 0,
  };
}

const RENDER_ARGS = [0, 200, 0, 0, 0, config, 12, 16, true, true, true] as const;

const solidStrokeMatcher = (op: { op: string; dash?: number[] }) =>
  op.op === 'stroke' && (!op.dash || op.dash.length === 0);
const draftOutlineStrokeMatcher = (op: { op: string; dash?: number[] }) =>
  op.op === 'stroke' && op.dash?.join(',') === '2,2';

describe('drawAnnotationSegment — Plannotate two-state rendering', () => {
  let ctx: MockContext & CanvasRenderingContext2D;
  beforeEach(() => {
    ctx = createMockContext();
  });

  describe('REGRESSION: existing CDS', () => {
    test('takes rich label-block path: roundRect+fill, fillRect connector', () => {
      drawAnnotationSegment(ctx, makeCDS(), ...RENDER_ARGS);

      expect(ctx.ops.find((o) => o.op === 'roundRect')?.args?.[4]).toBe(3);
      expect(ctx.ops.filter((o) => o.op === 'fillRect').length).toBeGreaterThanOrEqual(1);
      expect(ctx.ops.filter((o) => o.op === 'fill').length).toBeGreaterThanOrEqual(1);
    });

    test('uses identical opacity for the CDS label pill and thin connector', () => {
      drawAnnotationSegment(ctx, makeCDS(), ...RENDER_ARGS);

      const labelPillFill = ctx.ops.find((o) => o.op === 'fill');
      const connectorFill = ctx.ops.find((o) => o.op === 'fillRect');

      expect(labelPillFill?.alpha).toBe(1);
      expect(connectorFill?.alpha).toBe(labelPillFill?.alpha);
    });

    test('keeps the reverse CDS direction glyph separate from the truncatable label', () => {
      drawAnnotationSegment(ctx, makeCDS(undefined, -1), ...RENDER_ARGS);

      const connectorFill = ctx.ops.find((o) => o.op === 'fillRect');
      const labelTexts = ctx.ops.filter((o) => o.op === 'fillText').map((o) => o.args?.[0]);

      expect(connectorFill?.args?.[0]).toBe(45);
      expect(labelTexts).toContain('«');
      expect(labelTexts).toContain('AmpR');
    });
  });

  describe('accepted draft', () => {
    test('renders filled with a dotted draft outline', () => {
      drawAnnotationSegment(
        ctx,
        makeCDS({ source: 'pLannotate-draft', status: 'accepted' }),
        ...RENDER_ARGS
      );
      expect(ctx.ops.filter((o) => o.op === 'fillRect').length).toBeGreaterThanOrEqual(1);
      expect(ctx.ops.find(draftOutlineStrokeMatcher)).toBeTruthy();
    });

    test('accepted-AND-suppressed: status wins, still renders filled', () => {
      drawAnnotationSegment(
        ctx,
        makeCDS({
          source: 'pLannotate-draft',
          status: 'accepted',
          suppressedBy: 'AmpR promoter',
        }),
        ...RENDER_ARGS
      );
      expect(ctx.ops.filter((o) => o.op === 'fillRect').length).toBeGreaterThanOrEqual(1);
      expect(ctx.ops.find(draftOutlineStrokeMatcher)).toBeTruthy();
    });
  });

  describe('unchecked draft (status !== accepted)', () => {
    test('CDS unchecked: rich path with outlined label pill (no fill on the pill), still emits connector fillRect', () => {
      drawAnnotationSegment(
        ctx,
        makeCDS({ source: 'pLannotate-draft', status: 'rejected' }),
        ...RENDER_ARGS
      );

      expect(ctx.ops.filter((o) => o.op === 'fillRect').length).toBeGreaterThanOrEqual(1);

      expect(ctx.ops.find(solidStrokeMatcher)).toBeTruthy();
      expect(ctx.ops.find(draftOutlineStrokeMatcher)).toBeTruthy();
    });

    test('non-CDS unchecked: hollow with dotted draft outline, no fill', () => {
      drawAnnotationSegment(
        ctx,
        makeNonCDS({ source: 'pLannotate-draft', status: 'rejected' }),
        ...RENDER_ARGS
      );
      expect(ctx.ops.filter((o) => o.op === 'fill')).toHaveLength(0);
      expect(ctx.ops.find(solidStrokeMatcher)).toBeTruthy();
      expect(ctx.ops.find(draftOutlineStrokeMatcher)).toBeTruthy();
    });

    test('novelty has NO visual effect: with suppressedBy renders identically to without', () => {
      const withoutSup = createMockContext();
      drawAnnotationSegment(
        withoutSup,
        makeCDS({ source: 'pLannotate-draft', status: 'rejected' }),
        ...RENDER_ARGS
      );

      const withSup = createMockContext();
      drawAnnotationSegment(
        withSup,
        makeCDS({
          source: 'pLannotate-draft',
          status: 'rejected',
          suppressedBy: 'AmpR promoter',
        }),
        ...RENDER_ARGS
      );

      const summarize = (c: typeof withoutSup) => ({
        fills: c.ops.filter((o) => o.op === 'fill').length,
        fillRects: c.ops.filter((o) => o.op === 'fillRect').length,
        strokes: c.ops.filter((o) => o.op === 'stroke').length,
      });
      expect(summarize(withSup)).toEqual(summarize(withoutSup));
    });
  });

  describe('committed annotation : source = pLannotate, not a draft)', () => {
    const summarize = (c: MockContext) => ({
      fills: c.ops.filter((o) => o.op === 'fill').length,
      fillRects: c.ops.filter((o) => o.op === 'fillRect').length,
      solidStrokes: c.ops.filter(solidStrokeMatcher).length,
    });

    test('CDS committed annotation renders IDENTICALLY to a real existing CDS (filled)', () => {
      const committed = createMockContext();
      drawAnnotationSegment(committed, makeCDS({ source: 'pLannotate' }), ...RENDER_ARGS);
      const real = createMockContext();
      drawAnnotationSegment(real, makeCDS(), ...RENDER_ARGS);

      expect(summarize(committed)).toEqual(summarize(real));
      expect(summarize(committed).fills + summarize(committed).fillRects).toBeGreaterThan(0);
    });

    test('non-CDS committed annotation renders IDENTICALLY to a real existing annotation (not the outlined-draft signature)', () => {
      const committed = createMockContext();
      drawAnnotationSegment(committed, makeNonCDS({ source: 'pLannotate' }), ...RENDER_ARGS);
      const real = createMockContext();
      drawAnnotationSegment(real, makeNonCDS(), ...RENDER_ARGS);

      expect(summarize(committed)).toEqual(summarize(real));
      expect(summarize(committed).fills + summarize(committed).fillRects).toBeGreaterThan(0);
    });
  });

  describe('authored annotation draft', () => {
    test('non-CDS annotation-draft renders with full fill and a dotted draft outline', () => {
      drawAnnotationSegment(ctx, makeNonCDS({ source: 'annotation-draft' }), ...RENDER_ARGS);

      expect(ctx.ops.filter((o) => o.op === 'fill').length).toBeGreaterThan(0);
      expect(ctx.ops.find((o) => o.op === 'fill')?.alpha).toBe(1);
      expect(ctx.ops.find(draftOutlineStrokeMatcher)).toBeTruthy();
    });

    test('non-CDS annotation-draft suppresses selected outline and keeps only draft outline', () => {
      drawAnnotationSegment(
        ctx,
        makeNonCDS({ source: 'annotation-draft' }),
        ...RENDER_ARGS,
        undefined,
        false,
        'selected'
      );

      expect(ctx.ops.find(draftOutlineStrokeMatcher)).toBeTruthy();
      expect(ctx.ops.some((o) => o.op === 'stroke' && o.lineWidth === 2.5)).toBe(false);
    });

    test('CDS annotation-draft renders with the same dotted candidate outline', () => {
      drawAnnotationSegment(ctx, makeCDS({ source: 'annotation-draft' }), ...RENDER_ARGS);

      expect(ctx.ops.filter((o) => o.op === 'fillRect').length).toBeGreaterThanOrEqual(1);
      expect(ctx.ops.find(draftOutlineStrokeMatcher)).toBeTruthy();
    });

    test('legacy ORF candidate source still renders with the dotted candidate outline', () => {
      drawAnnotationSegment(ctx, makeCDS({ source: 'orf-candidate-cds' }), ...RENDER_ARGS);

      expect(ctx.ops.find(draftOutlineStrokeMatcher)).toBeTruthy();
    });
  });
});
