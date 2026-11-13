import { describe, expect, it } from 'vitest';
import type { SequenceExtraLane, SequenceExtraLanePaintInfo } from '../SequenceViewer1D';
import type { CanvasOp } from './recording-canvas-context';

export interface ContractScenario {
  label: string;
  info: SequenceExtraLanePaintInfo;
}

export interface ContractScenarioOverrides {
  scrollLeft?: number;
  pxPerBase?: number;
  visibleStart?: number;
  visibleEnd?: number;
  viewportWidth?: number;
  laneY?: number;
  laneHeight?: number;
  columnCount?: number;
  isCircular?: boolean;
}

const DEFAULT_HORIZONTAL_PADDING = 8;

export function buildPaintInfo(o: ContractScenarioOverrides = {}): SequenceExtraLanePaintInfo {
  const pxPerBase = o.pxPerBase ?? 4;
  const columnCount = o.columnCount ?? 10_000;
  const viewportWidth = o.viewportWidth ?? 800;
  const scrollLeft = o.scrollLeft ?? 0;

  const computedStart = Math.max(
    0,
    Math.floor((scrollLeft - DEFAULT_HORIZONTAL_PADDING) / pxPerBase)
  );
  const computedEnd = Math.min(
    columnCount,
    Math.ceil((scrollLeft + viewportWidth - DEFAULT_HORIZONTAL_PADDING) / pxPerBase) + 1
  );
  return {
    laneY: o.laneY ?? 200,
    laneHeight: o.laneHeight ?? 56,
    pxPerBase,
    columnCount,
    visibleStart: o.visibleStart ?? computedStart,
    visibleEnd: o.visibleEnd ?? computedEnd,
    isCircular: o.isCircular ?? false,
    scrollLeft,
    horizontalPadding: DEFAULT_HORIZONTAL_PADDING,
    viewportWidth,
  };
}

export function defaultScenarios(columnCount: number): ContractScenario[] {
  const cc = Math.max(1, columnCount);
  return [
    {
      label: 'default zoom, no scroll',
      info: buildPaintInfo({ columnCount: cc, pxPerBase: 4, scrollLeft: 0 }),
    },
    {
      label: 'zoomed-in (16 px/base), large scrollLeft (regression: off-screen drift)',
      info: buildPaintInfo({ columnCount: cc, pxPerBase: 16, scrollLeft: 5_000 }),
    },
    {
      label: 'zoomed-out (0.2 px/base), no scroll',
      info: buildPaintInfo({ columnCount: cc, pxPerBase: 0.2, scrollLeft: 0 }),
    },
    {
      label: 'zoomed-out + mid-sequence scroll',
      info: buildPaintInfo({
        columnCount: cc,
        pxPerBase: 0.5,
        scrollLeft: Math.floor((cc * 0.5) / 2),
      }),
    },
    {
      label: 'circular wrap straddle',
      info: buildPaintInfo({
        columnCount: cc,
        pxPerBase: 4,
        scrollLeft: cc * 4 - 200,
        isCircular: true,
      }),
    },
    {
      label: 'tiny lane height (8 px)',
      info: buildPaintInfo({ columnCount: cc, laneHeight: 8 }),
    },
    {
      label: 'tall viewport',
      info: buildPaintInfo({ columnCount: cc, laneY: 1_000 }),
    },
  ];
}

export interface ProbeContext {
  ctx: CanvasRenderingContext2D;
  log: CanvasOp[];

  resolveScreenX: (worldX: number, opIndex: number) => number;
  resolveScreenY: (worldY: number, opIndex: number) => number;
}

export function createProbeContext(canvasWidth = 800, canvasHeight = 600): ProbeContext {
  const log: CanvasOp[] = [];

  const stack: Array<[number, number, number, number, number, number]> = [[1, 0, 0, 1, 0, 0]];
  let current = stack[0];

  const transformsAtOp: Array<[number, number, number, number, number, number]> = [];
  const noop = () => undefined;

  function record(op: CanvasOp): number {
    const idx = log.length;
    log.push(op);
    transformsAtOp.push([...current] as [number, number, number, number, number, number]);
    return idx;
  }

  const ctx = {
    canvas: { width: canvasWidth, height: canvasHeight },
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '11px monospace',
    textAlign: 'start' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    globalAlpha: 1,
    fillRect(x: number, y: number, w: number, h: number) {
      record({ op: 'fillRect', x, y, w, h });
    },
    strokeRect(x: number, y: number, w: number, h: number) {
      record({ op: 'strokeRect', x, y, w, h });
    },
    clearRect(x: number, y: number, w: number, h: number) {
      record({ op: 'clearRect', x, y, w, h });
    },
    fillText(text: string, x: number, y: number, maxWidth?: number) {
      record({ op: 'fillText', text, x, y, maxWidth });
    },
    strokeText(text: string, x: number, y: number, maxWidth?: number) {
      record({ op: 'strokeText', text, x, y, maxWidth });
    },
    rect(x: number, y: number, w: number, h: number) {
      record({ op: 'rect', x, y, w, h });
    },
    beginPath() {
      record({ op: 'beginPath' });
    },
    closePath() {
      record({ op: 'closePath' });
    },
    moveTo(x: number, y: number) {
      record({ op: 'moveTo', x, y });
    },
    lineTo(x: number, y: number) {
      record({ op: 'lineTo', x, y });
    },
    stroke() {
      record({ op: 'stroke' });
    },
    fill() {
      record({ op: 'fill' });
    },
    save() {
      record({ op: 'save' });
      stack.push([...current] as [number, number, number, number, number, number]);
    },
    restore() {
      record({ op: 'restore' });
      if (stack.length > 1) stack.pop();
      current = stack[stack.length - 1];
    },
    translate(x: number, y: number) {
      record({ op: 'translate', x, y });

      current = [
        current[0],
        current[1],
        current[2],
        current[3],
        current[4] + current[0] * x + current[2] * y,
        current[5] + current[1] * x + current[3] * y,
      ];
      stack[stack.length - 1] = current;
    },
    setTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
      record({ op: 'setTransform', a, b, c, d, e, f });
      current = [a, b, c, d, e, f];
      stack[stack.length - 1] = current;
    },
    scale: noop,
    rotate: noop,
    measureText: () => ({ width: 0 }),
    clip: noop,
    quadraticCurveTo: noop,
    bezierCurveTo: noop,
    ellipse: noop,
    arc: noop,
    arcTo: noop,
    isPointInPath: () => false,
    isPointInStroke: () => false,
  } as unknown as CanvasRenderingContext2D;

  function resolveScreenX(worldX: number, opIndex: number): number {
    const t = transformsAtOp[opIndex];
    if (!t) return worldX;
    return t[0] * worldX + t[4];
  }
  function resolveScreenY(worldY: number, opIndex: number): number {
    const t = transformsAtOp[opIndex];
    if (!t) return worldY;
    return t[3] * worldY + t[5];
  }

  return { ctx, log, resolveScreenX, resolveScreenY };
}

const POSITION_OPS: ReadonlySet<CanvasOp['op']> = new Set([
  'fillRect',
  'strokeRect',
  'rect',
  'fillText',
  'strokeText',
  'moveTo',
  'lineTo',
]);

function isPositionedOp(op: CanvasOp): op is Extract<CanvasOp, { x: number; y: number }> {
  return POSITION_OPS.has(op.op) && 'x' in op && 'y' in op;
}

interface ScreenPositionedOp {
  op: CanvasOp;
  index: number;
  screenX: number;
  screenY: number;
  worldX: number;
  worldY: number;
}

function collectPositionedOps(probe: ProbeContext): ScreenPositionedOp[] {
  const out: ScreenPositionedOp[] = [];
  probe.log.forEach((op, index) => {
    if (!isPositionedOp(op)) return;
    out.push({
      op,
      index,
      screenX: probe.resolveScreenX(op.x, index),
      screenY: probe.resolveScreenY(op.y, index),
      worldX: op.x,
      worldY: op.y,
    });
  });
  return out;
}

export function assertNotEmpty(probe: ProbeContext, scenarioLabel: string): void {
  const positioned = collectPositionedOps(probe);
  expect(
    positioned.length,
    `[${scenarioLabel}] lane.draw made zero positioned ops — silent regression?`
  ).toBeGreaterThan(0);
}

export function assertNoOffScreenDraws(
  probe: ProbeContext,
  info: SequenceExtraLanePaintInfo,
  scenarioLabel: string,

  marginPx = 64
): void {
  const positioned = collectPositionedOps(probe);
  const minX = -marginPx;
  const maxX = info.viewportWidth + marginPx;
  for (const p of positioned) {
    if (typeof p.screenX === 'number' && p.screenX >= minX && p.screenX <= maxX) continue;
    expect(
      p.screenX,
      `[${scenarioLabel}] op #${p.index} (${p.op.op}) world x=${p.worldX} → screen x=${p.screenX.toFixed(1)} outside [${minX}, ${maxX}] (viewportWidth=${info.viewportWidth}, scrollLeft=${info.scrollLeft})`
    ).toBeGreaterThanOrEqual(minX);
    expect(p.screenX).toBeLessThanOrEqual(maxX);
  }
}

export function assertWithinLaneVertical(
  probe: ProbeContext,
  info: SequenceExtraLanePaintInfo,
  scenarioLabel: string,

  marginPx = 4
): void {
  const positioned = collectPositionedOps(probe);
  const minY = info.laneY - marginPx;
  const maxY = info.laneY + info.laneHeight + marginPx;
  for (const p of positioned) {
    if (typeof p.screenY === 'number' && p.screenY >= minY && p.screenY <= maxY) continue;
    expect(
      p.screenY,
      `[${scenarioLabel}] op #${p.index} (${p.op.op}) screen y=${p.screenY.toFixed(1)} outside lane band [${minY}, ${maxY}] (laneY=${info.laneY}, laneHeight=${info.laneHeight})`
    ).toBeGreaterThanOrEqual(minY);
    expect(p.screenY).toBeLessThanOrEqual(maxY);
  }
}

export interface RunContractOptions {
  scenarios?: (columnCount: number) => ContractScenario[];

  columnCount?: number;

  skipEmptyAssertionFor?: (scenarioLabel: string) => boolean;
}

export function runExtraLaneContractTests(
  laneLabel: string,
  factory: (columnCount: number) => SequenceExtraLane,
  options: RunContractOptions = {}
): void {
  const columnCount = options.columnCount ?? 10_000;
  const scenarios = (options.scenarios ?? defaultScenarios)(columnCount);
  const skipEmpty = options.skipEmptyAssertionFor ?? (() => false);

  describe(`${laneLabel} — ExtraLane contract`, () => {
    for (const scenario of scenarios) {
      describe(scenario.label, () => {
        it('draws within the visible viewport (no off-screen drift on zoom-in)', () => {
          const lane = factory(columnCount);
          const probe = createProbeContext(scenario.info.viewportWidth);

          probe.ctx.save();
          probe.ctx.translate(-scenario.info.scrollLeft, 0);
          lane.draw(probe.ctx, scenario.info);
          probe.ctx.restore();
          assertNoOffScreenDraws(probe, scenario.info, scenario.label);
        });

        it('keeps draws within its lane vertical band', () => {
          const lane = factory(columnCount);
          const probe = createProbeContext(scenario.info.viewportWidth);
          probe.ctx.save();
          probe.ctx.translate(-scenario.info.scrollLeft, 0);
          lane.draw(probe.ctx, scenario.info);
          probe.ctx.restore();
          assertWithinLaneVertical(probe, scenario.info, scenario.label);
        });

        if (!skipEmpty(scenario.label)) {
          it('produces at least one positioned draw op', () => {
            const lane = factory(columnCount);
            const probe = createProbeContext(scenario.info.viewportWidth);
            probe.ctx.save();
            probe.ctx.translate(-scenario.info.scrollLeft, 0);
            lane.draw(probe.ctx, scenario.info);
            probe.ctx.restore();
            assertNotEmpty(probe, scenario.label);
          });
        }
      });
    }

    it('does not throw on an empty visible window', () => {
      const lane = factory(columnCount);
      const probe = createProbeContext(800);
      const info = buildPaintInfo({
        columnCount,
        visibleStart: 0,
        visibleEnd: 0,
      });
      probe.ctx.save();
      probe.ctx.translate(-info.scrollLeft, 0);
      expect(() => lane.draw(probe.ctx, info)).not.toThrow();
      probe.ctx.restore();
    });

    it('does not throw on a single-column sequence', () => {
      const lane = factory(1);
      const probe = createProbeContext(800);
      const info = buildPaintInfo({ columnCount: 1, visibleStart: 0, visibleEnd: 1 });
      probe.ctx.save();
      probe.ctx.translate(-info.scrollLeft, 0);
      expect(() => lane.draw(probe.ctx, info)).not.toThrow();
      probe.ctx.restore();
    });
  });
}
