import { Container, Text, TextStyle } from 'pixi.js';
import { LABEL_FONT_FAMILY, LABEL_FONT_WEIGHT } from './theme';
import type { PathMapper } from './path-mapper';
import { destroyPixiText } from './pixi-text-lifecycle';

interface ArcPoint {
  x: number;
  y: number;
  angle: number;
}

type ArcPositionFn = (t: number) => ArcPoint;

interface PoolEntry {
  text: Text;
}

interface KeyedLabel {
  entries: PoolEntry[];
  usedInFrame: number;
}

const ADVANCE_CACHE_MAX_ENTRIES = 4096;
const advanceCache = new Map<string, readonly number[]>();
let advanceCacheFontListenerInstalled = false;

function prefixAdvances(
  ctx: CanvasRenderingContext2D,
  fontStr: string,
  text: string
): readonly number[] {
  if (!advanceCacheFontListenerInstalled && typeof document !== 'undefined') {
    advanceCacheFontListenerInstalled = true;
    document.fonts?.addEventListener?.('loadingdone', () => advanceCache.clear());
  }
  const key = `${fontStr}\u0000${text}`;
  const cached = advanceCache.get(key);
  if (cached) {
    advanceCache.delete(key);
    advanceCache.set(key, cached);
    return cached;
  }
  ctx.font = fontStr;
  const advances: number[] = [0];
  for (let i = 1; i <= text.length; i++) {
    advances.push(ctx.measureText(text.slice(0, i)).width);
  }
  advanceCache.set(key, advances);
  while (advanceCache.size > ADVANCE_CACHE_MAX_ENTRIES) {
    const oldestKey = advanceCache.keys().next().value;
    if (oldestKey === undefined) break;
    advanceCache.delete(oldestKey);
  }
  return advances;
}

let measureCtx: CanvasRenderingContext2D | null = null;
export function getMeasureCtx(): CanvasRenderingContext2D {
  if (!measureCtx) {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    measureCtx = c.getContext('2d')!;
  }
  return measureCtx;
}

const textStyleCache = new Map<string, TextStyle>();
const TEXT_STYLE_CACHE_MAX_ENTRIES = 128;

function targetTextResolution(): number {
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  return Math.max(2, dpr);
}

function getTextStyle(
  fontSize: number,
  color: number,
  fontFamily: TextStyle['fontFamily'],
  fontWeight: TextStyle['fontWeight']
): TextStyle {
  const roundedSize = Math.round(fontSize * 2) / 2;
  const key = `${roundedSize}:${color}:${fontFamily}:${fontWeight}`;
  let style = textStyleCache.get(key);
  if (style) {
    textStyleCache.delete(key);
    textStyleCache.set(key, style);
    return style;
  }
  style = new TextStyle({
    fontSize: roundedSize,
    fill: color,
    fontFamily,
    fontWeight,
  });
  textStyleCache.set(key, style);
  while (textStyleCache.size > TEXT_STYLE_CACHE_MAX_ENTRIES) {
    const oldestKey = textStyleCache.keys().next().value;
    if (oldestKey === undefined) break;
    textStyleCache.delete(oldestKey);
  }
  return style;
}

function stableRasterFontSize(displayFontSize: number): number {
  return Math.pow(2, Math.ceil(Math.log2(Math.max(4, displayFontSize))));
}

export function labelLevelTextRotation(angle: number, flip: boolean): number {
  let rot = angle + (flip ? Math.PI : 0);
  while (rot > Math.PI) rot -= 2 * Math.PI;
  while (rot < -Math.PI) rot += 2 * Math.PI;
  return rot;
}

function normalizeAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function shouldFlipArcText(angle: number): boolean {
  const a = normalizeAngle(angle);
  return a > Math.PI / 2 || a < -Math.PI / 2;
}

function localPixelsPerBp(path: PathMapper, bp: number, offset: number): number {
  const prev = path.featureLabelPosAt(bp - 1, offset);
  const next = path.featureLabelPosAt(bp + 1, offset);
  const sampled = Math.hypot(next.x - prev.x, next.y - prev.y) / 2;
  return sampled > 1e-4 ? sampled : Math.max(path.pixelsPerBp, 1e-4);
}

function clampSpanAround(
  centerBp: number,
  spanBp: number,
  featureStart: number,
  featureEnd: number
): { start: number; end: number } | null {
  if (spanBp <= 0 || featureEnd <= featureStart) return null;
  const clampedSpan = Math.min(spanBp, featureEnd - featureStart);
  let start = centerBp - clampedSpan / 2;
  let end = centerBp + clampedSpan / 2;

  if (start < featureStart) {
    end += featureStart - start;
    start = featureStart;
  }
  if (end > featureEnd) {
    start -= end - featureEnd;
    end = featureEnd;
  }

  start = Math.max(featureStart, start);
  end = Math.min(featureEnd, end);
  return end > start ? { start, end } : null;
}

interface ArcLengthSamples {
  readonly bps: Float64Array;
  readonly dists: Float64Array;
  readonly length: number;
}

function buildArcLengthSamples(
  path: PathMapper,
  centerBp: number,
  spanWidthPx: number,
  offset: number,
  featureStart: number,
  featureEnd: number
): { samples: ArcLengthSamples; centerDist: number } | null {
  const pxPerBp = localPixelsPerBp(path, centerBp, offset);
  const featureLen = featureEnd - featureStart;
  if (featureLen <= 0) return null;

  let spanBp = Math.min(featureLen, Math.max(2, (spanWidthPx / pxPerBp) * 1.6));
  let best: { samples: ArcLengthSamples; centerDist: number } | null = null;

  for (let attempt = 0; attempt < 4; attempt++) {
    const span = clampSpanAround(centerBp, spanBp, featureStart, featureEnd);
    if (!span) return best;

    const sampleCount = Math.min(96, Math.max(16, Math.ceil(spanWidthPx / 2)));
    const bps = new Float64Array(sampleCount + 2);
    const dists = new Float64Array(sampleCount + 2);
    let length = 0;
    let centerInserted = false;
    const push = (bp: number) => {
      if (length > 0 && Math.abs(bp - bps[length - 1]) <= 1e-6) return;
      bps[length++] = bp;
    };
    for (let i = 0; i <= sampleCount; i++) {
      const bp = span.start + (span.end - span.start) * (i / sampleCount);
      if (!centerInserted && centerBp <= bp) {
        push(centerBp);
        centerInserted = true;
      }
      push(bp);
    }
    if (!centerInserted) push(centerBp);

    let dist = 0;
    let prev = path.featureLabelPosAt(bps[0], offset);
    dists[0] = 0;
    for (let i = 1; i < length; i++) {
      const current = path.featureLabelPosAt(bps[i], offset);
      dist += Math.hypot(current.x - prev.x, current.y - prev.y);
      dists[i] = dist;
      prev = current;
    }

    let centerDist = dist / 2;
    for (let i = 0; i < length; i++) {
      if (Math.abs(bps[i] - centerBp) < 1e-6) {
        centerDist = dists[i];
        break;
      }
    }
    best = { samples: { bps, dists, length }, centerDist };

    if (centerDist >= spanWidthPx / 2 && dist - centerDist >= spanWidthPx / 2) return best;
    if (spanBp >= featureLen) return best;
    spanBp = Math.min(featureLen, spanBp * 1.6);
  }

  return best;
}

function bpAtArcDistance(samples: ArcLengthSamples, targetDist: number): number {
  const { bps, dists, length } = samples;
  if (length === 0) return 0;
  if (targetDist <= dists[0]) return bps[0];
  const lastIndex = length - 1;
  if (targetDist >= dists[lastIndex]) return bps[lastIndex];

  let lo = 0;
  let hi = lastIndex;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (dists[mid] < targetDist) lo = mid;
    else hi = mid;
  }

  const t = (targetDist - dists[lo]) / (dists[hi] - dists[lo] || 1);
  return bps[lo] + (bps[hi] - bps[lo]) * t;
}

export function renderCurvedLabelOnPath(
  renderer: CurvedLabelRenderer,
  text: string,
  path: PathMapper,
  centerBp: number,
  textWidth: number,
  offset: number,
  rangeStartBp: number,
  rangeEndBp: number,
  fontSize: number,
  color: number,
  zInv: number,
  alpha: number = 1,
  key?: string
): void {
  const placement = buildArcLengthSamples(
    path,
    centerBp,
    textWidth,
    offset,
    rangeStartBp,
    rangeEndBp
  );
  if (!placement) return;

  const mid = path.featureLabelPosAt(centerBp, offset);
  const flip = shouldFlipArcText(mid.angle);
  const probeBack = path.featureLabelPosAt(centerBp - 1, offset);
  const probeFwd = path.featureLabelPosAt(centerBp + 1, offset);
  const dxp = probeFwd.x - probeBack.x;
  const dyp = probeFwd.y - probeBack.y;
  const cosA = Math.cos(mid.angle);
  const sinA = Math.sin(mid.angle);
  let bpDir = dxp * cosA + dyp * sinA >= 0 ? 1 : -1;
  if (flip) bpDir = -bpDir;

  renderer.renderLabel(
    text,
    (t) => {
      const targetDist = placement.centerDist + (t - 0.5) * textWidth * bpDir;
      const bp = bpAtArcDistance(placement.samples, targetDist);
      return path.featureLabelPosAt(bp, offset);
    },
    fontSize,
    color,
    zInv,
    flip,
    alpha,
    undefined,
    key
  );
}

export class CurvedLabelRenderer {
  private pool: PoolEntry[] = [];
  private poolIndex = 0;
  private readonly keyedLabels = new Map<string, KeyedLabel>();
  private spareKeyedEntries: PoolEntry[] = [];
  private frame = 0;
  private container: Container;

  constructor(parent: Container) {
    this.container = new Container();
    parent.addChild(this.container);
  }

  reset(): void {
    for (let i = 0; i < this.poolIndex; i++) {
      this.pool[i].text.visible = false;
    }
    this.poolIndex = 0;
    for (const [key, label] of this.keyedLabels) {
      if (label.usedInFrame !== this.frame) {
        this.releaseKeyedEntries(label.entries, 0);
        this.keyedLabels.delete(key);
        continue;
      }
      for (const entry of label.entries) entry.text.visible = false;
    }
    this.frame += 1;
  }

  private releaseKeyedEntries(entries: PoolEntry[], keepCount: number): void {
    for (let index = keepCount; index < entries.length; index += 1) {
      entries[index].text.visible = false;
      this.spareKeyedEntries.push(entries[index]);
    }
    entries.length = keepCount;
  }

  private createGlyph(style: TextStyle): PoolEntry {
    const glyph = new Text({ text: '', style, resolution: targetTextResolution() });
    this.container.addChild(glyph);
    return { text: glyph };
  }

  renderLabel(
    text: string,
    arcPositionFn: ArcPositionFn,
    fontSize: number,
    color: number,
    zInv: number,
    flip: boolean,
    alpha: number = 1,
    typography: Pick<TextStyle, 'fontFamily' | 'fontWeight'> = {
      fontFamily: LABEL_FONT_FAMILY,
      fontWeight: LABEL_FONT_WEIGHT,
    },
    key?: string
  ): void {
    const displayFontSize = Math.round(fontSize * 2) / 2;
    const rasterFontSize = stableRasterFontSize(displayFontSize);
    const displayScale = (displayFontSize / rasterFontSize) * zInv;
    const style = getTextStyle(rasterFontSize, color, typography.fontFamily, typography.fontWeight);
    const ctx = getMeasureCtx();
    const fontStr = `${typography.fontWeight} ${displayFontSize}px ${typography.fontFamily}`;

    const advances = prefixAdvances(ctx, fontStr, text);
    const totalWidth = advances[advances.length - 1];
    if (totalWidth <= 0) return;

    let keyedEntries: PoolEntry[] | null = null;
    if (key !== undefined) {
      let label = this.keyedLabels.get(key);
      if (!label) {
        label = { entries: [], usedInFrame: this.frame };
        this.keyedLabels.set(key, label);
      }
      label.usedInFrame = this.frame;
      keyedEntries = label.entries;
      if (keyedEntries.length > text.length) this.releaseKeyedEntries(keyedEntries, text.length);
    }

    for (let i = 0; i < text.length; i++) {
      const charCenter = (advances[i] + advances[i + 1]) / 2;
      const t = charCenter / totalWidth;

      const arcPt = arcPositionFn(t);
      const rotation = labelLevelTextRotation(arcPt.angle, flip);

      let entry: PoolEntry;
      if (keyedEntries) {
        entry = keyedEntries[i] ?? this.spareKeyedEntries.pop() ?? this.createGlyph(style);
        keyedEntries[i] = entry;
        entry.text.visible = true;
      } else if (this.poolIndex < this.pool.length) {
        entry = this.pool[this.poolIndex];
        entry.text.visible = true;
        this.poolIndex++;
      } else {
        entry = this.createGlyph(style);
        this.pool.push(entry);
        this.poolIndex++;
      }

      const glyph = entry.text;
      if (glyph.text !== text[i]) glyph.text = text[i];
      if (glyph.style !== style) glyph.style = style;
      const resolution = targetTextResolution();
      if (glyph.resolution !== resolution) glyph.resolution = resolution;
      glyph.anchor.set(0.5, 0.5);
      glyph.x = arcPt.x;
      glyph.y = arcPt.y;
      glyph.rotation = rotation;
      glyph.scale.set(displayScale);
      glyph.alpha = alpha;
    }
  }

  private activeKeyedEntries(): PoolEntry[] {
    const entries: PoolEntry[] = [];
    for (const label of this.keyedLabels.values()) {
      if (label.usedInFrame === this.frame) entries.push(...label.entries);
    }
    return entries;
  }

  get activeCount(): number {
    return this.poolIndex + this.activeKeyedEntries().length;
  }

  private activeEntries(): PoolEntry[] {
    return [...this.pool.slice(0, this.poolIndex), ...this.activeKeyedEntries()];
  }

  get activeRotations(): number[] {
    return this.activeEntries().map((entry) => entry.text.rotation);
  }

  get activeFontSizes(): number[] {
    return this.activeEntries().map((entry) => Number(entry.text.style.fontSize));
  }

  get activeScales(): number[] {
    return this.activeEntries().map((entry) => entry.text.scale.x);
  }

  get activeResolutions(): number[] {
    return this.activeEntries().map((entry) => entry.text.resolution);
  }

  get activePositions(): Array<{ x: number; y: number }> {
    return this.activeEntries().map((entry) => ({ x: entry.text.x, y: entry.text.y }));
  }

  get activeTexts(): string[] {
    return this.activeEntries().map((entry) => String(entry.text.text));
  }

  destroy(): void {
    for (const entry of this.pool) {
      destroyPixiText(entry.text);
    }
    for (const label of this.keyedLabels.values()) {
      for (const entry of label.entries) destroyPixiText(entry.text);
    }
    for (const entry of this.spareKeyedEntries) destroyPixiText(entry.text);
    this.pool = [];
    this.poolIndex = 0;
    this.keyedLabels.clear();
    this.spareKeyedEntries = [];
    this.container.destroy();
  }
}
