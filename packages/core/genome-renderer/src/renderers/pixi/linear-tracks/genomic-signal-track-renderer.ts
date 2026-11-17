import { Container, Graphics, Rectangle, Text } from 'pixi.js';
import type {
  ResolvedGenomicMarkup,
  ResolvedGenomicMarkupObservation,
} from '@waypoint/genome-data';
import type {
  PixiLinearTrackRenderer,
  TrackMountArgs,
  TrackPaintArgs,
  TrackHoverArgs,
  TrackHitResult,
} from './types';

type Point = { x: number; y: number };
type Arc = {
  start: Point;
  control: Point;
  end: Point;
  points: Point[];
};
type Hit = {
  x: number;
  y: number;
  width: number;
  height: number;
  record: ResolvedGenomicMarkupObservation;
  arc?: Arc;
  pickPoint?: Point;
};
type State = {
  graphics: Graphics;
  hover: Graphics;
  heading: Text;
  detail: Text;
  tooltip: Text;
  hits: Hit[];
  data: ResolvedGenomicMarkup | null;
  diagnostics: object;
};

export class PixiGenomicSignalTrackRenderer implements PixiLinearTrackRenderer<ResolvedGenomicMarkup> {
  readonly type = 'genomic-data-signal';
  private readonly states = new WeakMap<Container, State>();
  mount(_args: TrackMountArgs): Container {
    const container = new Container();
    const graphics = new Graphics(),
      hover = new Graphics();
    const label = () =>
      new Text({ text: '', style: { fontFamily: 'system-ui', fontSize: 11, fill: 0x475569 } });
    const heading = label(),
      detail = label(),
      tooltip = label();
    tooltip.visible = false;
    container.addChild(graphics, hover, heading, detail, tooltip);
    this.states.set(container, {
      graphics,
      hover,
      heading,
      detail,
      tooltip,
      hits: [],
      data: null,
      diagnostics: {},
    });
    return container;
  }
  paint(args: TrackPaintArgs<ResolvedGenomicMarkup>): void {
    const state = this.states.get(args.container)!;
    state.graphics.clear();
    state.hover.clear();
    state.tooltip.visible = false;
    state.hits = [];
    state.data = args.data;
    if (!args.data) return;
    const data = args.data,
      g = state.graphics,
      h = args.layoutEntry.height,
      w = args.viewportWidthPx;
    const domain =
      data.style.colorScale.kind === 'continuous' ? data.style.colorScale.domain : [0, 1];
    const min = Math.min(0, domain[0]),
      max = Math.max(0, domain[domain.length - 1]);
    const y = (v: number) => 32 + ((max - v) / (max - min || 1)) * (h - 65),
      zero = y(0);
    const color = args.theme.background < 0x555555 ? 0xcbd5e1 : 0x475569;
    state.heading.style.fill = color;
    state.detail.style.fill = color;
    state.heading.text = `${data.sampleId} · ${data.unit}`;
    state.heading.position.set(10, 6);
    state.detail.text = `${domain[0].toPrecision(3)} to ${domain[domain.length - 1].toPrecision(3)}`;
    state.detail.position.set(10, h - 20);
    const baseline = data.style.geometry === 'arcs' ? h - 34 : zero;
    g.moveTo(0, baseline).lineTo(w, baseline).stroke({ color, alpha: 0.2, width: 1 });
    for (const record of data.records) {
      if (
        record.end <= args.viewportBpRange.start ||
        record.start >= args.viewportBpRange.end ||
        record.value === null
      )
        continue;
      const fill = Number.parseInt(record.color.slice(1), 16);
      if (data.style.geometry === 'arcs') {
        if (record.sourceStart < data.window.start || record.sourceEnd > data.window.end) continue;
        const startX = args.pathMapper.bpLeftX(record.sourceStart - data.window.start + 0.5);
        const endX = args.pathMapper.bpLeftX(record.sourceEnd - data.window.start - 0.5);
        const rise = Math.min(Math.max(6, Math.abs(endX - startX) * 0.4), h - 70);
        const arc = makeArc(startX, endX, baseline, rise);
        drawArc(g, arc, fill, 1.5);
        g.circle(startX, baseline, 2).circle(endX, baseline, 2).fill(fill);
        state.hits.push({
          x: Math.min(startX, endX) - 5,
          y: baseline - rise - 5,
          width: Math.abs(endX - startX) + 10,
          height: rise + 10,
          record,
          arc,
          pickPoint: { x: (startX + endX) / 2, y: baseline - rise },
        });
        continue;
      }
      const left = Math.max(0, args.pathMapper.bpLeftX(record.start)),
        right = Math.min(w, args.pathMapper.bpLeftX(record.end));
      if (right < 0 || left > w) continue;
      const py = y(record.value),
        width = Math.max(1, right - left);
      const top = data.style.geometry === 'band' ? 36 : Math.min(py, zero),
        height = data.style.geometry === 'band' ? h - 70 : Math.max(2, Math.abs(py - zero));
      if (data.style.geometry === 'points') {
        const cx = (left + right) / 2;
        g.moveTo(cx, zero).lineTo(cx, py).stroke({ color: fill, alpha: 0.3, width: 1 });
        g.circle(cx, py, 3).fill(fill);
      } else g.rect(left, top, width, height).fill({ color: fill, alpha: 0.9 });
      state.hits.push({
        x: left,
        y: top - 4,
        width: Math.max(5, width),
        height: height + 8,
        record,
      });
    }
    args.container.hitArea = new Rectangle(0, 0, w, h);
    state.diagnostics = {
      kind: 'genomic-data-signal',
      datasetId: data.datasetId,
      sampleId: data.sampleId,
      geometry: data.style.geometry,
      reference: data.reference,
      sourceWindow: data.window,
      viewport: { ...args.viewportBpRange },
      containerTopPx: args.containerTopPx,
      visibleRecordCount: state.hits.length,
      sampleHits: state.hits.slice(0, 5).map(({ arc, ...hit }) => hit),
      annotationValues: Object.fromEntries(data.annotationValues),
      colorScale: data.style.colorScale,
    };
  }
  private hit(args: TrackHoverArgs): Hit | undefined {
    const hits = this.states.get(args.container)?.hits;
    if (!hits) return undefined;
    for (let index = hits.length - 1; index >= 0; index--) {
      const hit = hits[index];
      if (
        args.localX >= hit.x &&
        args.localX <= hit.x + hit.width &&
        args.localY >= hit.y &&
        args.localY <= hit.y + hit.height &&
        (!hit.arc || nearArc(hit.arc, args.localX, args.localY))
      )
        return hit;
    }
    return undefined;
  }
  hitTest(args: TrackHoverArgs): TrackHitResult | null {
    const hit = this.hit(args);
    return hit
      ? {
          kind: 'select-bp-range',
          startBp: hit.record.start,
          endBp: hit.record.end,
          chromosomeId: args.chromosome.id,
          name: hit.record.label ?? hit.record.id,
        }
      : null;
  }
  updateHover(args: TrackHoverArgs): void {
    const state = this.states.get(args.container);
    if (!state) return;
    state.hover.clear();
    state.tooltip.visible = false;
    const hit = this.hit(args);
    if (!hit || !state.data) return;
    if (hit.arc) drawArc(state.hover, hit.arc, 0x64748b, 3);
    else
      state.hover.rect(hit.x, hit.y, hit.width, hit.height).stroke({ color: 0x64748b, width: 1.5 });
    state.tooltip.text = `${hit.record.label ?? hit.record.id}: ${hit.record.value} ${state.data.unit} · source ${hit.record.sourceStart}–${hit.record.sourceEnd}`;
    state.tooltip.style.fill = args.chromosome ? 0x64748b : 0x475569;
    state.tooltip.position.set(
      Math.max(10, Math.min(args.localX + 8, args.viewportWidthPx - state.tooltip.width - 10)),
      20
    );
    state.tooltip.visible = true;
  }
  clearHover(container: Container): void {
    const s = this.states.get(container);
    if (s) {
      s.hover.clear();
      s.tooltip.visible = false;
    }
  }
  getDiagnostics(container: Container): object | null {
    return this.states.get(container)?.diagnostics ?? null;
  }
  unmount(container: Container): void {
    this.states.delete(container);
    container.destroy({ children: true });
  }
}

function makeArc(startX: number, endX: number, baseline: number, rise: number): Arc {
  const start = { x: startX, y: baseline };
  const control = { x: (startX + endX) / 2, y: baseline - rise * 2 };
  const end = { x: endX, y: baseline };
  const segments = Math.max(12, Math.min(128, Math.ceil(Math.abs(endX - startX) / 8)));
  const points = Array.from({ length: segments + 1 }, (_, index) => {
    const t = index / segments;
    return {
      x: startX + (endX - startX) * t,
      y: baseline - 4 * rise * t * (1 - t),
    };
  });
  return { start, control, end, points };
}

function drawArc(graphics: Graphics, arc: Arc, color: number, width: number): void {
  graphics
    .moveTo(arc.start.x, arc.start.y)
    .quadraticCurveTo(arc.control.x, arc.control.y, arc.end.x, arc.end.y)
    .stroke({ color, alpha: 0.85, width });
}

function nearArc(arc: Arc, x: number, y: number): boolean {
  for (let index = 1; index < arc.points.length; index++) {
    const start = arc.points[index - 1],
      end = arc.points[index];
    const dx = end.x - start.x,
      dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared
      ? Math.max(0, Math.min(1, ((x - start.x) * dx + (y - start.y) * dy) / lengthSquared))
      : 0;
    if ((x - start.x - t * dx) ** 2 + (y - start.y - t * dy) ** 2 <= 25) return true;
  }
  return false;
}
