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

type Hit = {
  x: number;
  y: number;
  width: number;
  height: number;
  record: ResolvedGenomicMarkupObservation;
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
    state.heading.text = data.unit;
    state.heading.position.set(10, 6);
    state.detail.text = `${domain[0].toPrecision(3)} to ${domain[domain.length - 1].toPrecision(3)}`;
    state.detail.position.set(10, h - 20);
    g.moveTo(0, zero).lineTo(w, zero).stroke({ color, alpha: 0.2, width: 1 });
    for (const record of data.records) {
      if (
        record.end <= args.viewportBpRange.start ||
        record.start >= args.viewportBpRange.end ||
        record.value === null
      )
        continue;
      const left = Math.max(0, args.pathMapper.bpLeftX(record.start)),
        right = Math.min(w, args.pathMapper.bpLeftX(record.end));
      if (right < 0 || left > w) continue;
      const fill = Number.parseInt(record.color.slice(1), 16),
        py = y(record.value),
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
      sampleHits: state.hits.slice(0, 5),
      annotationValues: Object.fromEntries(data.annotationValues),
      colorScale: data.style.colorScale,
    };
  }
  private hit(args: TrackHoverArgs): Hit | undefined {
    return this.states
      .get(args.container)
      ?.hits.findLast(
        (h) =>
          args.localX >= h.x &&
          args.localX <= h.x + h.width &&
          args.localY >= h.y &&
          args.localY <= h.y + h.height
      );
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
