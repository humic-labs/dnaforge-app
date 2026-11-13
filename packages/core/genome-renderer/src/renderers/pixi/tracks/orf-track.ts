import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import {
  SEQUENCE_FONT_FAMILY,
  CODON_FONT_WEIGHT,
  CODON_OUTLINE_WIDTH,
  CODON_CHEVRON_DEPTH_RATIO,
  codonFontSize,
} from '@waypoint/platform';
import type { CodonInfo } from '../../../biology/translation';
import { translateCDS } from '../../../biology/translation';
import { computeCodonEdges, type CodonEdge } from '../../../biology/codon-edges';
import { assignFeatureLanes } from '../../../geometry/lane-assignment';
import type { Genome, GenomeOrf, GenomeOrfIdentity, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { UnifiedLayout } from '../shared/track-layout';
import type { LaneEnvelope, TrackContract } from '../shared/lane-contracts';
import { drawDashedPolyline, type Point2 } from '../shared/dashed-line';
import { computeBBox, pointInPolygon } from '../overlays/hit-testing';
import { destroyPixiText } from '../shared/pixi-text-lifecycle';

const CHEVRON_WIDTH_RATIO = CODON_CHEVRON_DEPTH_RATIO;

const CODON_LETTER_SCALE = 0.92;
const STROKE_WIDTH = CODON_OUTLINE_WIDTH;
const ORF_COLOR = 0x8c8c8c;
const ORF_OVERVIEW_HOVER_COLOR = 0x6f6f6f;
const ORF_OVERVIEW_SELECTED_COLOR = 0x4b5563;
const ORF_OVERVIEW_CANDIDATE_COLOR = 0x555555;
const ORF_TEXT_LIGHT = 0x787878;
const ORF_TEXT_DARK = 0xaaaaaa;
const OVERVIEW_HALF_HEIGHT = 1.5;
const OVERVIEW_HIT_HALF_HEIGHT = 5;
const OVERVIEW_AGGREGATE_MIN_ORFS = 1_000;
const OVERVIEW_AGGREGATE_MAX_ZOOM = 4;

const OVERVIEW_AGGREGATE_BIN_PX = 6;

type OrfRenderRecord = GenomeOrf & {
  lane: number;
  endExclusive: number;
};

type OrfState = 'default' | 'hovered' | 'selected' | 'candidate';

type OrfStyle = {
  fillAlpha: number;
  strokeAlpha: number;
  textAlpha: number;
  outline?: {
    alpha: number;
    width: number;
    dashed?: boolean;
  };
};

type OverviewOrfStyle = {
  color: number;
  fillAlpha: number;
};

type CodonCellGeometry = {
  pts: number[];
  startPos: { x: number; y: number; angle: number };
  endPos: { x: number; y: number; angle: number };
  midPos: { x: number; y: number; angle: number };
  leftEdge: CodonEdge;
  rightEdge: CodonEdge;
  visualStartBp?: number;
};

type OrfHitRecord = {
  payload: GenomeOrf;
  pts: number[];
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
};

type OrfOverviewBin = {
  startBp: number;
  endBp: number;
  offset: number;
  halfHeight: number;
};

type OrfOverviewAggregationCache = {
  key: string;
  bins: OrfOverviewBin[];
};

function identityMatches(orf: GenomeOrf, identity: GenomeOrfIdentity | null | undefined): boolean {
  return (
    !!identity &&
    orf.start === identity.start &&
    orf.end === identity.end &&
    orf.strand === identity.strand
  );
}

function orfEndExclusive(orf: GenomeOrf, genomeLength: number): number {
  return Math.min(genomeLength, orf.end + 1);
}

function orfLengthBp(orf: OrfRenderRecord, genomeLength: number): number {
  if (orf.endExclusive > orf.start) return orf.endExclusive - orf.start;
  return genomeLength - orf.start + orf.endExclusive;
}

function codonVisualLength(codon: CodonInfo, genomeLength: number): number {
  if (codon.endBp > codon.startBp) return codon.endBp - codon.startBp;
  return genomeLength - codon.startBp + codon.endBp;
}

function styleForState(state: OrfState): OrfStyle {
  switch (state) {
    case 'candidate':
      return {
        fillAlpha: 0.14,
        strokeAlpha: 0.5,
        textAlpha: 0.85,
        outline: { alpha: 0.85, width: 1.5, dashed: true },
      };
    case 'selected':
      return {
        fillAlpha: 0.18,
        strokeAlpha: 0.6,
        textAlpha: 0.95,
        outline: { alpha: 0.95, width: 2 },
      };
    case 'hovered':
      return {
        fillAlpha: 0.18,
        strokeAlpha: 0.55,
        textAlpha: 0.85,
      };
    case 'default':
    default:
      return {
        fillAlpha: 0.08,
        strokeAlpha: 0.25,
        textAlpha: 0.6,
      };
  }
}

function overviewStyleForState(state: OrfState): OverviewOrfStyle {
  switch (state) {
    case 'candidate':
      return { color: ORF_OVERVIEW_CANDIDATE_COLOR, fillAlpha: 0.5 };
    case 'selected':
      return { color: ORF_OVERVIEW_SELECTED_COLOR, fillAlpha: 0.58 };
    case 'hovered':
      return { color: ORF_OVERVIEW_HOVER_COLOR, fillAlpha: 0.42 };
    case 'default':
    default:
      return { color: ORF_COLOR, fillAlpha: 0.22 };
  }
}

export class OrfTrack {
  private container: Container;
  private graphics = new Graphics();
  private letterPool: Text[] = [];
  private letterIndex = 0;
  private hitCache: OrfHitRecord[] = [];
  private forwardOrfs: OrfRenderRecord[] = [];
  private reverseOrfs: OrfRenderRecord[] = [];
  private candidateOrf: GenomeOrfIdentity | null = null;
  private codonCache = new Map<string, CodonInfo[]>();
  private overviewAggregationCache = new Map<string, OrfOverviewAggregationCache>();
  private overviewBinDrawCount = 0;
  private overviewIndividualDrawCount = 0;
  private genomeCircular = false;

  private genomeGeneticCode: Genome['geneticCode'];
  private letterStyle = new TextStyle({
    fontSize: 10,
    fill: ORF_TEXT_LIGHT,
    fontFamily: SEQUENCE_FONT_FAMILY,
    fontWeight: CODON_FONT_WEIGHT,
  });

  constructor(parent: Container) {
    this.container = parent;
    parent.addChild(this.graphics);
  }

  loadGenome(genome: Genome): void {
    this.genomeCircular = genome.circular;
    if (this.genomeGeneticCode !== genome.geneticCode) {
      this.codonCache.clear();
      this.genomeGeneticCode = genome.geneticCode;
    }
    this.candidateOrf = genome.candidateOrf ?? null;
    const orfs = genome.orfs ?? [];
    const toRecord = (orf: GenomeOrf): Omit<OrfRenderRecord, 'lane'> => ({
      ...orf,
      endExclusive: orfEndExclusive(orf, genome.length),
    });
    const forward = orfs.filter((orf) => orf.strand === '+').map(toRecord);
    const reverse = orfs.filter((orf) => orf.strand === '-').map(toRecord);
    const assign = (records: Array<Omit<OrfRenderRecord, 'lane'>>): OrfRenderRecord[] => {
      const ranges = records.map((orf) => ({ start: orf.start, end: orf.endExclusive }));
      const assignments = assignFeatureLanes(ranges, genome.length).laneAssignments;
      return records.map((orf, index) => ({
        ...orf,
        lane: assignments.get(index) ?? 0,
      }));
    };
    this.forwardOrfs = assign(forward);
    this.reverseOrfs = assign(reverse);
    this.codonCache.clear();
    this.overviewAggregationCache.clear();
    this.reset();
  }

  hasDrawnOrfs(): boolean {
    return (
      this.hitCache.length > 0 ||
      this.overviewBinDrawCount > 0 ||
      this.overviewIndividualDrawCount > 0
    );
  }

  getForwardLaneCount(): number {
    return this.forwardOrfs.reduce((max, orf) => Math.max(max, orf.lane + 1), 0);
  }

  getReverseLaneCount(): number {
    return this.reverseOrfs.reduce((max, orf) => Math.max(max, orf.lane + 1), 0);
  }

  reset(): void {
    this.graphics.clear();
    this.hitCache.length = 0;
    this.overviewBinDrawCount = 0;
    this.overviewIndividualDrawCount = 0;
    for (let i = 0; i < this.letterIndex; i++) {
      this.letterPool[i].visible = false;
    }
    this.letterIndex = 0;
  }

  render(
    path: PathMapper,
    state: RenderState,
    layout: UnifiedLayout,
    genomeLength: number,
    sequence?: string,
    contract?: TrackContract | null
  ): void {
    this.reset();
    if ((this.forwardOrfs.length === 0 && this.reverseOrfs.length === 0) || genomeLength <= 0) {
      return;
    }

    const overviewAlpha = 1 - layout.sequenceOpacity;
    const detailAlpha = layout.sequenceOpacity;
    if (overviewAlpha > 0) {
      this.renderOverviewBars(
        this.forwardOrfs,
        path,
        state,
        layout,
        genomeLength,
        overviewAlpha,
        contract
      );
      this.renderOverviewBars(
        this.reverseOrfs,
        path,
        state,
        layout,
        genomeLength,
        overviewAlpha,
        contract
      );
    }
    if (detailAlpha > 0 && layout.sequenceVisible && sequence) {
      this.renderDetailCodons(
        this.forwardOrfs,
        path,
        state,
        layout,
        genomeLength,
        sequence,
        1,
        contract
      );
      this.renderDetailCodons(
        this.reverseOrfs,
        path,
        state,
        layout,
        genomeLength,
        sequence,
        -1,
        contract
      );
    }
  }

  hitTest(screenX: number, screenY: number): GenomeOrf | null {
    for (let i = this.hitCache.length - 1; i >= 0; i--) {
      const rec = this.hitCache[i];
      if (screenX < rec.xMin || screenX > rec.xMax || screenY < rec.yMin || screenY > rec.yMax) {
        continue;
      }
      if (!pointInPolygon(screenX, screenY, rec.pts)) continue;
      return rec.payload;
    }
    return null;
  }

  destroy(): void {
    this.graphics.destroy();
    for (const letter of this.letterPool) {
      destroyPixiText(letter);
    }
    this.letterPool = [];
    this.hitCache.length = 0;
  }

  private laneEnvelope(orf: OrfRenderRecord, contract?: TrackContract | null): LaneEnvelope | null {
    if (!contract) return null;
    const role = orf.strand === '+' ? 'orf-forward' : 'orf-reverse';
    return contract.lanes.find((lane) => lane.role === role && lane.laneIndex === orf.lane) ?? null;
  }

  private laneOffset(
    orf: OrfRenderRecord,
    layout: UnifiedLayout,
    contract?: TrackContract | null
  ): number {
    const envelope = this.laneEnvelope(orf, contract);
    if (envelope) return envelope.centerOffset;
    if (contract) {
      throw new Error(`ORF lane contract missing ${orf.strand} lane ${orf.lane}`);
    }
    const base = orf.strand === '+' ? layout.orfForwardOffset : layout.orfReverseOffset;
    return base + orf.lane * layout.orfLaneStep;
  }

  private renderOverviewBars(
    orfs: OrfRenderRecord[],
    path: PathMapper,
    state: RenderState,
    layout: UnifiedLayout,
    genomeLength: number,
    alpha: number,
    contract?: TrackContract | null
  ): void {
    if (this.shouldAggregateOverview(orfs, path, state, layout)) {
      this.renderAggregatedOverviewBars(orfs, path, layout, genomeLength, alpha, contract);
      const emphasizedOrfs = orfs.filter((orf) => this.renderStateForOrf(orf, state) !== 'default');
      if (emphasizedOrfs.length > 0) {
        this.renderIndividualOverviewBars(
          emphasizedOrfs,
          path,
          state,
          layout,
          genomeLength,
          alpha,
          contract
        );
      }
      return;
    }
    this.renderIndividualOverviewBars(orfs, path, state, layout, genomeLength, alpha, contract);
  }

  private shouldAggregateOverview(
    orfs: OrfRenderRecord[],
    path: PathMapper,
    state: RenderState,
    layout: UnifiedLayout
  ): boolean {
    return (
      path.isArcMode &&
      orfs.length >= OVERVIEW_AGGREGATE_MIN_ORFS &&
      state.zoom <= OVERVIEW_AGGREGATE_MAX_ZOOM &&
      layout.sequenceOpacity < 0.05
    );
  }

  private renderIndividualOverviewBars(
    orfs: OrfRenderRecord[],
    path: PathMapper,
    state: RenderState,
    layout: UnifiedLayout,
    genomeLength: number,
    alpha: number,
    contract?: TrackContract | null
  ): void {
    const g = this.graphics;
    for (const orf of orfs) {
      const length = orfLengthBp(orf, genomeLength);
      const renderState = this.renderStateForOrf(orf, state);
      const style = overviewStyleForState(renderState);
      const offset = this.laneOffset(orf, layout, contract);
      if (length <= 0 || !path.isFeatureVisible(orf.start, length, offset, OVERVIEW_HALF_HEIGHT))
        continue;
      const pts = path.featurePolygonAt(orf.start, orf.endExclusive, offset, OVERVIEW_HALF_HEIGHT);
      g.poly(pts);
      g.fill({ color: style.color, alpha: style.fillAlpha * alpha });

      const dir = orf.strand === '+' ? 1 : -1;
      const midBp = (orf.start + length / 2) % genomeLength;
      const mid = path.featureLabelPosAt(midBp, offset);

      const triHalfH = Math.min(OVERVIEW_HALF_HEIGHT * 1.7, 7);
      const triLen = triHalfH * 0.7;
      if (length * path.pixelsPerBp > triLen * 2 + 2) {
        const apex = this.offsetTangent(mid, dir * triLen);
        const baseCenter = { ...this.offsetTangent(mid, -dir * triLen), angle: mid.angle };
        const baseTop = this.offsetNormal(baseCenter, -triHalfH);
        const baseBot = this.offsetNormal(baseCenter, triHalfH);
        g.poly([baseTop.x, baseTop.y, apex.x, apex.y, baseBot.x, baseBot.y]);

        g.fill({ color: 0x969696, alpha: 0.65 * alpha });
      }
      this.overviewIndividualDrawCount += 1;
      const hitPts = path.featurePolygonAt(
        orf.start,
        orf.endExclusive,
        offset,
        Math.min(
          OVERVIEW_HIT_HALF_HEIGHT,
          Math.max(OVERVIEW_HALF_HEIGHT, layout.orfLaneStep / 2 - 0.5)
        )
      );
      this.addHitRecord(orf, hitPts);
    }
  }

  private renderAggregatedOverviewBars(
    orfs: OrfRenderRecord[],
    path: PathMapper,
    layout: UnifiedLayout,
    genomeLength: number,
    alpha: number,
    contract?: TrackContract | null
  ): void {
    const g = this.graphics;
    const binBp = Math.max(
      1,
      Math.ceil(OVERVIEW_AGGREGATE_BIN_PX / Math.max(path.pixelsPerBp, 1e-6))
    );
    const cache = this.getOverviewAggregationCache(orfs, layout, genomeLength, binBp, contract);
    for (const bin of cache.bins) {
      if (!path.isFeatureVisible(bin.startBp, bin.endBp - bin.startBp, bin.offset, bin.halfHeight))
        continue;
      const pts = path.featurePolygonAt(bin.startBp, bin.endBp, bin.offset, bin.halfHeight);
      g.poly(pts);
      g.fill({ color: ORF_COLOR, alpha: 0.22 * alpha });
      this.overviewBinDrawCount += 1;
    }
  }

  private getOverviewAggregationCache(
    orfs: OrfRenderRecord[],
    layout: UnifiedLayout,
    genomeLength: number,
    binBp: number,
    contract?: TrackContract | null
  ): OrfOverviewAggregationCache {
    const strand = orfs[0]?.strand ?? 'none';
    const key = [
      strand,
      orfs.length,
      genomeLength,
      binBp,
      layout.orfForwardOffset.toFixed(2),
      layout.orfReverseOffset.toFixed(2),
      layout.orfLaneStep.toFixed(2),
    ].join('|');
    const cached = this.overviewAggregationCache.get(key);
    if (cached) return cached;

    const bins = new Map<string, OrfOverviewBin>();
    for (const orf of orfs) {
      const offset = this.laneOffset(orf, layout, contract);
      if (orf.endExclusive > orf.start) {
        this.addOverviewBinRange(bins, orf.start, orf.endExclusive, offset, binBp);
      } else {
        this.addOverviewBinRange(bins, orf.start, genomeLength, offset, binBp);
        this.addOverviewBinRange(bins, 0, orf.endExclusive, offset, binBp);
      }
    }

    const cache = { key, bins: [...bins.values()] };
    if (this.overviewAggregationCache.size > 8) this.overviewAggregationCache.clear();
    this.overviewAggregationCache.set(key, cache);
    return cache;
  }

  private addOverviewBinRange(
    bins: Map<string, OrfOverviewBin>,
    startBp: number,
    endBp: number,
    offset: number,
    binBp: number
  ): void {
    if (endBp <= startBp) return;
    const firstBin = Math.floor(startBp / binBp);
    const lastBin = Math.floor((endBp - 1) / binBp);
    const laneKey = Math.round(offset * 10);
    for (let bin = firstBin; bin <= lastBin; bin++) {
      const binStart = bin * binBp;
      const binEnd = binStart + binBp;
      const clampedStart = Math.max(startBp, binStart);
      const clampedEnd = Math.min(endBp, binEnd);
      if (clampedEnd <= clampedStart) continue;
      const key = `${laneKey}:${bin}`;
      const existing = bins.get(key);
      if (existing) {
        existing.startBp = Math.min(existing.startBp, clampedStart);
        existing.endBp = Math.max(existing.endBp, clampedEnd);
      } else {
        bins.set(key, {
          startBp: clampedStart,
          endBp: clampedEnd,
          offset,
          halfHeight: OVERVIEW_HALF_HEIGHT,
        });
      }
    }
  }

  private renderDetailCodons(
    orfs: OrfRenderRecord[],
    path: PathMapper,
    state: RenderState,
    layout: UnifiedLayout,
    genomeLength: number,
    sequence: string,
    dir: 1 | -1,
    contract?: TrackContract | null
  ): void {
    const g = this.graphics;
    const halfH = path.scaleNormalOffset?.(layout.orfLaneHeight / 2) ?? layout.orfLaneHeight / 2;
    const trackH = halfH * 2;
    const depth = Math.round(trackH * CHEVRON_WIDTH_RATIO);
    const direction = dir === 1 ? 'forward' : 'reverse';

    for (const orf of orfs) {
      const length = orfLengthBp(orf, genomeLength);
      const offset = this.laneOffset(orf, layout, contract);
      if (
        length <= 0 ||
        !path.isFeatureVisible(orf.start, length, offset, layout.orfLaneHeight / 2)
      )
        continue;
      const cacheKey = `${orf.start}:${orf.end}:${orf.strand}:${orf.frame}`;
      let codons = this.codonCache.get(cacheKey);
      if (!codons) {
        codons = translateCDS(
          sequence,
          orf.start,
          orf.endExclusive,
          direction,
          genomeLength,
          this.genomeCircular,
          { sequenceGeneticCode: this.genomeGeneticCode }
        );
        this.codonCache.set(cacheKey, codons);
      }
      if (codons.length === 0) continue;
      const style = styleForState(this.renderStateForOrf(orf, state));
      const cells: CodonCellGeometry[] = [];

      for (let idx = 0; idx < codons.length; idx++) {
        const codon = codons[idx];
        const visualLength = codonVisualLength(codon, genomeLength);
        const midBp = codon.startBp + visualLength / 2 - 0.5;
        const startBoundaryBp = codon.startBp - 0.5;
        const endBoundaryBp = codon.startBp + visualLength - 0.5;
        const midPos = path.featureLabelPosAt(midBp, offset);
        if (
          midPos.x < -80 ||
          midPos.x > state.width + 80 ||
          midPos.y < -80 ||
          midPos.y > state.height + 80
        ) {
          continue;
        }
        const startPos = path.featureLabelPosAt(startBoundaryBp, offset);
        const endPos = path.featureLabelPosAt(endBoundaryBp, offset);
        const regionEnd =
          orf.endExclusive > orf.start ? orf.endExclusive : orf.endExclusive + genomeLength;
        const codonEndInclusive = codon.startBp + visualLength - 1;
        const { leftEdge, rightEdge } = computeCodonEdges(
          {
            startPos: codon.codonStartBp ?? codon.startBp,
            endPos: codon.codonEndBp ?? codonEndInclusive,
            visibleStart: codon.startBp,
            visibleEnd: codonEndInclusive,
          },
          idx,
          codons.length,
          dir,
          orf.start,
          regionEnd
        );
        const cell =
          midPos.angle === 0
            ? this.buildLinearCellGeometry(
                startPos.x,
                endPos.x,
                midPos.y,
                startPos,
                endPos,
                midPos,
                halfH,
                depth,
                dir,
                leftEdge,
                rightEdge
              )
            : this.buildArcCellGeometry(
                startPos,
                endPos,
                midPos,
                halfH,
                depth,
                dir,
                leftEdge,
                rightEdge
              );
        cell.visualStartBp = startBoundaryBp;
        this.drawCell(g, cell.pts, style);
        cells.push(cell);
        this.addHitRecord(orf, cell.pts);

        const cellWidth = Math.hypot(endPos.x - startPos.x, endPos.y - startPos.y);
        if ((codon.renderLetter ?? true) && cellWidth > 8) {
          this.drawCodonLetter(
            codon,
            startPos,
            endPos,
            midPos,
            midPos.angle,
            depth,
            dir,
            path,
            style,
            state.themeMode === 'dark'
          );
        }
      }

      if (style.outline) {
        const ordered = this.orderCellsForStrip(cells, orf.start - 0.5, genomeLength);
        this.drawChevronStripOutline(ordered, halfH, depth, dir, style.outline);
      }
    }
  }

  private renderStateForOrf(orf: GenomeOrf, state: RenderState): OrfState {
    if (identityMatches(orf, this.candidateOrf)) return 'candidate';
    if (identityMatches(orf, state.selectedOrf)) return 'selected';
    if (identityMatches(orf, state.hoveredOrf)) return 'hovered';
    return 'default';
  }

  private drawCell(g: Graphics, pts: number[], style: OrfStyle): void {
    g.poly(pts);
    g.fill({ color: ORF_COLOR, alpha: style.fillAlpha });
    g.setStrokeStyle({ width: STROKE_WIDTH, color: ORF_COLOR, alpha: style.strokeAlpha });
    g.poly(pts);
    g.stroke();
  }

  private drawCodonLetter(
    codon: CodonInfo,
    startPos: { x: number; y: number },
    endPos: { x: number; y: number },
    midPos: { x: number; y: number },
    angle: number,
    depth: number,
    dir: 1 | -1,
    path: PathMapper,
    style: OrfStyle,
    isDark: boolean
  ): void {
    const textObj = this.acquireLetter();
    if (textObj.text !== codon.aa) textObj.text = codon.aa;
    textObj.style = this.letterStyle;
    this.letterStyle.fill = isDark ? ORF_TEXT_DARK : ORF_TEXT_LIGHT;
    textObj.alpha = style.textAlpha;
    textObj.anchor.set(0.5, 0.5);
    const nudge = dir * depth * 0.3;
    const targetFontSize = codonFontSize(path.sequenceFontSize) * CODON_LETTER_SCALE;
    const nudgeY = targetFontSize * 0.06;
    if (angle === 0) {
      textObj.x = (startPos.x + endPos.x) / 2 + nudge;
      textObj.y = midPos.y + nudgeY;
    } else {
      textObj.x = midPos.x + Math.cos(angle) * nudge - Math.sin(angle) * nudgeY;
      textObj.y = midPos.y + Math.sin(angle) * nudge + Math.cos(angle) * nudgeY;
    }
    textObj.rotation = angle;
    const rasterSize = Math.pow(2, Math.ceil(Math.log2(Math.max(4, targetFontSize))));
    const displayScale = targetFontSize / rasterSize;
    if (this.letterStyle.fontSize !== rasterSize) this.letterStyle.fontSize = rasterSize;
    textObj.scale.set(displayScale);
  }

  private acquireLetter(): Text {
    let text = this.letterPool[this.letterIndex];
    if (!text) {
      text = new Text({ text: '', style: this.letterStyle });
      this.letterPool.push(text);
      this.container.addChild(text);
    }
    text.visible = true;
    this.letterIndex++;
    return text;
  }

  getDebugSnapshot(): {
    forwardOrfCount: number;
    reverseOrfCount: number;
    overviewBinDrawCount: number;
    overviewIndividualDrawCount: number;
    hitCount: number;
  } {
    return {
      forwardOrfCount: this.forwardOrfs.length,
      reverseOrfCount: this.reverseOrfs.length,
      overviewBinDrawCount: this.overviewBinDrawCount,
      overviewIndividualDrawCount: this.overviewIndividualDrawCount,
      hitCount: this.hitCache.length,
    };
  }

  private addHitRecord(orf: GenomeOrf, pts: number[]): void {
    const bbox = computeBBox(pts);
    this.hitCache.push({
      payload: {
        start: orf.start,
        end: orf.end,
        strand: orf.strand,
        frame: orf.frame,
        length: orf.length,
      },
      pts,
      ...bbox,
    });
  }

  private buildLinearCellGeometry(
    x1: number,
    x2: number,
    cy: number,
    startPos: { x: number; y: number; angle: number },
    endPos: { x: number; y: number; angle: number },
    midPos: { x: number; y: number; angle: number },
    halfH: number,
    depth: number,
    dir: 1 | -1,
    leftEdge: CodonEdge,
    rightEdge: CodonEdge
  ): CodonCellGeometry {
    const top = cy - halfH;
    const bot = cy + halfH;
    const pts: number[] = [];

    if (dir === 1) {
      pts.push(x1, top, x2, top);
      if (rightEdge === 'chevron' || rightEdge === 'tip') {
        pts.push(x2 + depth, cy, x2, bot);
      } else {
        pts.push(x2, bot);
      }
      pts.push(x1, bot);
      if (leftEdge === 'chevron') pts.push(x1 + depth, cy);
      else if (leftEdge === 'tip') pts.push(x1 - depth, cy);
    } else {
      pts.push(x1, top, x2, top);
      if (rightEdge === 'chevron') {
        pts.push(x2 - depth, cy, x2, bot);
      } else if (rightEdge === 'tip') {
        pts.push(x2 + depth, cy, x2, bot);
      } else {
        pts.push(x2, bot);
      }
      pts.push(x1, bot);
      if (leftEdge === 'chevron' || leftEdge === 'tip') pts.push(x1 - depth, cy);
    }

    return { pts, startPos, endPos, midPos, leftEdge, rightEdge };
  }

  private buildArcCellGeometry(
    startPos: { x: number; y: number; angle: number },
    endPos: { x: number; y: number; angle: number },
    midPos: { x: number; y: number; angle: number },
    halfH: number,
    depth: number,
    dir: 1 | -1,
    leftEdge: CodonEdge,
    rightEdge: CodonEdge
  ): CodonCellGeometry {
    const angle = midPos.angle;
    const tx = Math.cos(angle);
    const ty = Math.sin(angle);
    const nx = -Math.sin(angle);
    const ny = Math.cos(angle);
    const s = startPos;
    const e = endPos;
    const pts: number[] = [];

    if (dir === 1) {
      pts.push(s.x - nx * halfH, s.y - ny * halfH);
      pts.push(e.x - nx * halfH, e.y - ny * halfH);
      if (rightEdge === 'chevron' || rightEdge === 'tip') {
        pts.push(e.x + tx * depth, e.y + ty * depth);
        pts.push(e.x + nx * halfH, e.y + ny * halfH);
      } else {
        pts.push(e.x + nx * halfH, e.y + ny * halfH);
      }
      pts.push(s.x + nx * halfH, s.y + ny * halfH);
      if (leftEdge === 'chevron') pts.push(s.x + tx * depth, s.y + ty * depth);
    } else {
      pts.push(s.x - nx * halfH, s.y - ny * halfH);
      pts.push(e.x - nx * halfH, e.y - ny * halfH);
      if (rightEdge === 'chevron') {
        pts.push(e.x - tx * depth, e.y - ty * depth);
        pts.push(e.x + nx * halfH, e.y + ny * halfH);
      } else if (rightEdge === 'tip') {
        pts.push(e.x + tx * depth, e.y + ty * depth);
        pts.push(e.x + nx * halfH, e.y + ny * halfH);
      } else {
        pts.push(e.x + nx * halfH, e.y + ny * halfH);
      }
      pts.push(s.x + nx * halfH, s.y + ny * halfH);
      if (leftEdge === 'chevron' || leftEdge === 'tip') {
        pts.push(s.x - tx * depth, s.y - ty * depth);
      }
    }

    return { pts, startPos, endPos, midPos, leftEdge, rightEdge };
  }

  private orderCellsForStrip(
    cells: CodonCellGeometry[],
    featureStartBoundaryBp: number,
    genomeLength: number
  ): CodonCellGeometry[] {
    if (cells.length <= 1) return cells;
    return [...cells].sort((a, b) => {
      const aDist = this.unwrappedDistanceFrom(
        featureStartBoundaryBp,
        a.visualStartBp ?? featureStartBoundaryBp,
        genomeLength
      );
      const bDist = this.unwrappedDistanceFrom(
        featureStartBoundaryBp,
        b.visualStartBp ?? featureStartBoundaryBp,
        genomeLength
      );
      return aDist - bDist;
    });
  }

  private unwrappedDistanceFrom(startBp: number, bp: number, genomeLength: number): number {
    if (genomeLength <= 0) return bp - startBp;
    let unwrapped = bp;
    while (unwrapped < startBp - 1e-6) unwrapped += genomeLength;
    return unwrapped - startBp;
  }

  private drawChevronStripOutline(
    cells: CodonCellGeometry[],
    halfH: number,
    depth: number,
    dir: 1 | -1,
    outline: NonNullable<OrfStyle['outline']>
  ): void {
    if (cells.length === 0) return;
    const pts = this.buildOuterStripPoints(cells, halfH, depth, dir);
    this.drawOutline(pts, outline.width, outline.alpha, outline.dashed);
  }

  private drawOutline(pts: number[], width: number, alpha: number, dashed?: boolean): void {
    if (pts.length < 4) return;
    this.graphics.setStrokeStyle({ width, color: ORF_COLOR, alpha });
    if (!dashed) {
      this.graphics.poly(pts);
      this.graphics.stroke();
      return;
    }
    const points = this.pointsFromFlatClosedPolygon(pts);
    drawDashedPolyline(this.graphics, points, 5, 3);
  }

  private pointsFromFlatClosedPolygon(pts: number[]): Point2[] {
    const out: Point2[] = [];
    for (let i = 0; i < pts.length; i += 2) out.push({ x: pts[i], y: pts[i + 1] });
    if (out.length > 0) out.push(out[0]);
    return out;
  }

  private buildOuterStripPoints(
    cells: CodonCellGeometry[],
    halfH: number,
    depth: number,
    dir: 1 | -1
  ): number[] {
    const first = cells[0];
    const last = cells[cells.length - 1];
    const pts: number[] = [];

    this.pushPoint(pts, this.offsetNormal(first.startPos, -halfH));
    for (const cell of cells) this.pushPoint(pts, this.offsetNormal(cell.endPos, -halfH));
    if (dir === 1) {
      if (last.rightEdge === 'chevron' || last.rightEdge === 'tip') {
        this.pushPoint(pts, this.offsetTangent(last.endPos, depth));
      }
    } else if (last.rightEdge === 'chevron') {
      this.pushPoint(pts, this.offsetTangent(last.endPos, -depth));
    } else if (last.rightEdge === 'tip') {
      this.pushPoint(pts, this.offsetTangent(last.endPos, depth));
    }
    this.pushPoint(pts, this.offsetNormal(last.endPos, halfH));

    for (let i = cells.length - 1; i >= 0; i--) {
      this.pushPoint(pts, this.offsetNormal(cells[i].startPos, halfH));
    }
    if (dir === 1) {
      if (first.leftEdge === 'chevron') {
        this.pushPoint(pts, this.offsetTangent(first.startPos, depth));
      } else if (first.leftEdge === 'tip') {
        this.pushPoint(pts, this.offsetTangent(first.startPos, -depth));
      }
    } else if (first.leftEdge === 'chevron' || first.leftEdge === 'tip') {
      this.pushPoint(pts, this.offsetTangent(first.startPos, -depth));
    }
    return pts;
  }

  private offsetNormal(
    pos: { x: number; y: number; angle: number },
    distance: number
  ): { x: number; y: number } {
    return {
      x: pos.x - Math.sin(pos.angle) * distance,
      y: pos.y + Math.cos(pos.angle) * distance,
    };
  }

  private offsetTangent(
    pos: { x: number; y: number; angle: number },
    distance: number
  ): { x: number; y: number } {
    return {
      x: pos.x + Math.cos(pos.angle) * distance,
      y: pos.y + Math.sin(pos.angle) * distance,
    };
  }

  private pushPoint(points: number[], point: { x: number; y: number }): void {
    points.push(point.x, point.y);
  }
}
