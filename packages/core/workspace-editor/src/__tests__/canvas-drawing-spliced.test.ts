import { describe, test, expect, vi, beforeEach } from 'vitest';
import { drawAnnotations } from '../canvas-drawing';
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

interface OpRecord {
  op: string;
  args?: unknown[];
  alpha?: number;
}

interface MockContext {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  globalAlpha: number;
  ops: OpRecord[];
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
}

function createMockContext(): MockContext & CanvasRenderingContext2D {
  const stack: Array<{ globalAlpha: number }> = [];
  const ctx: MockContext = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    globalAlpha: 1,
    ops: [],
    save() {
      stack.push({ globalAlpha: this.globalAlpha });
    },
    restore() {
      const s = stack.pop();
      if (s) this.globalAlpha = s.globalAlpha;
    },
    fillRect(...args: unknown[]) {
      this.ops.push({ op: 'fillRect', args, alpha: this.globalAlpha });
    },
    strokeRect(...args: unknown[]) {
      this.ops.push({ op: 'strokeRect', args, alpha: this.globalAlpha });
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
      this.ops.push({ op: 'stroke', alpha: this.globalAlpha });
    },
    fill() {
      this.ops.push({ op: 'fill', alpha: this.globalAlpha });
    },
    measureText(text: string) {
      return { width: text.length * 6 };
    },
    fillText(...args: unknown[]) {
      this.ops.push({ op: 'fillText', args });
    },
    setLineDash(_dash: number[]) {},
    roundRect(...args: unknown[]) {
      this.ops.push({ op: 'roundRect', args });
    },
  };
  return ctx as unknown as MockContext & CanvasRenderingContext2D;
}

const config: WorkspaceEditorConfig = { ...DEFAULT_EDITOR_CONFIG, charWidth: 10 };

function makeSplicedCDS(): Annotation & { lane: number } {
  return {
    name: 'HBB',
    type: 'CDS',
    start: 10,
    end: 250,
    direction: 1,
    color: '#3b82f6',
    lane: 0,
    segments: [
      { start: 10, end: 50 },
      { start: 100, end: 150 },
      { start: 200, end: 250 },
    ],
  };
}

function makeUnsplicedCDS(): Annotation & { lane: number } {
  return {
    name: 'AmpR',
    type: 'CDS',
    start: 10,
    end: 250,
    direction: 1,
    color: '#3b82f6',
    lane: 0,
  };
}

describe('drawAnnotations — DNA-TG1 spliced rendering (Phase 3)', () => {
  let ctx: MockContext & CanvasRenderingContext2D;
  beforeEach(() => {
    ctx = createMockContext();
  });

  test('spliced CDS draws an intron connector line across the bbox', () => {
    drawAnnotations(ctx, [makeSplicedCDS()], 0, 300, 0, 0, 1, config);

    const intronStroke = ctx.ops.find(
      (o, i) =>
        o.op === 'stroke' &&
        (o.alpha ?? 1) === 0.7 &&
        i > 0 &&
        ctx.ops.slice(0, i).some((p) => p.op === 'moveTo') &&
        ctx.ops.slice(0, i).some((p) => p.op === 'lineTo')
    );
    expect(intronStroke).toBeDefined();
  });

  test('spliced CDS draws one directional block per visible exon', () => {
    drawAnnotations(ctx, [makeSplicedCDS()], 0, 300, 0, 0, 1, config);

    const blocks = ctx.ops.filter((o) => o.op === 'fill');
    expect(blocks).toHaveLength(3);
    expect(ctx.ops.filter((o) => o.op === 'fillRect')).toHaveLength(0);
    for (const tipX of [500, 1500, 2500]) {
      expect(
        ctx.ops.some((o) => o.op === 'lineTo' && o.args?.[0] === tipX && o.args?.[1] === 7)
      ).toBe(true);
    }
  });

  test('unspliced CDS still takes the legacy single-bar (rich CDS pill) path', () => {
    drawAnnotations(ctx, [makeUnsplicedCDS()], 0, 300, 0, 0, 1, config);

    const roundRectCount = ctx.ops.filter((o) => o.op === 'roundRect').length;
    expect(roundRectCount).toBeGreaterThanOrEqual(1);

    const introns = ctx.ops.filter((o) => o.op === 'stroke' && (o.alpha ?? 1) < 0.5);
    expect(introns.length).toBe(0);
  });

  test('skips a spliced annotation entirely when no exons land on the line', () => {
    drawAnnotations(ctx, [makeSplicedCDS()], 0, 5, 0, 0, 1, config);
    expect(ctx.ops.filter((o) => o.op === 'fillRect').length).toBe(0);
    expect(ctx.ops.filter((o) => o.op === 'stroke').length).toBe(0);
    expect(ctx.ops.filter((o) => o.op === 'roundRect').length).toBe(0);
  });

  test('label is drawn exactly once on the largest visible exon', () => {
    drawAnnotations(ctx, [makeSplicedCDS()], 0, 300, 0, 0, 1, config);
    const labelTexts = ctx.ops.filter(
      (o) => o.op === 'fillText' && (o.args?.[0] as string) === 'HBB'
    );
    expect(labelTexts.length).toBe(1);
  });

  test('intron stroke endpoints span the visible bbox of the transcript', () => {
    drawAnnotations(ctx, [makeSplicedCDS()], 0, 300, 0, 0, 1, config);
    const moveTo = ctx.ops.find((o) => o.op === 'moveTo' && (o.args?.[0] as number) === 90);
    const lineTo = ctx.ops.find((o) => o.op === 'lineTo' && (o.args?.[0] as number) === 2500);
    expect(moveTo).toBeDefined();
    expect(lineTo).toBeDefined();
  });

  test.each([
    ['overlapping', 149],
    ['one-base overlap', 150],
    ['adjacent', 151],
    ['one-base gap', 152],
  ])('does not paint a genome-length intron for %s exon segments', (_name, nextStart) => {
    const cds = makeSplicedCDS();
    cds.segments = [
      { start: 10, end: 150 },
      { start: nextStart, end: 250 },
    ];
    drawAnnotations(ctx, [cds], 100, 200, 0, 0, 1, config, 300);

    expect(ctx.ops.filter((op) => op.op === 'stroke')).toHaveLength(0);
  });

  test('keeps a genuine origin-spanning intron clipped to the wrapped row', () => {
    const cds: Annotation & { lane: number } = {
      ...makeSplicedCDS(),
      start: 451,
      end: 250,
      segments: [
        { start: 451, end: 558 },
        { start: 101, end: 250 },
      ],
    };
    drawAnnotations(ctx, [cds], 540, 40, 0, 0, 1, config, 603);
    expect(ctx.ops.filter((op) => op.op === 'stroke').length).toBeGreaterThan(0);
    const lineXs = ctx.ops
      .filter((op) => op.op === 'moveTo' || op.op === 'lineTo')
      .map((op) => Number(op.args?.[0]));
    expect(Math.min(...lineXs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...lineXs)).toBeLessThanOrEqual(1032);
  });
});
