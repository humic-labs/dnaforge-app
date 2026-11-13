import {
  SEQUENCE_FONT_FAMILY,
  CODON_FONT_WEIGHT,
  CODON_OUTLINE_WIDTH,
  CODON_CHEVRON_DEPTH_RATIO,
  codonFontSize,
  canvasCdsMetrics,
  intronTickPitch,
  intronTickAlpha,
  TRANSCRIPT_INTRON_STYLE,
  indexedCodonLettersVisible,
} from '@waypoint/platform';
import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import {
  translateDnaCodon,
  type CodonInfo,
  type IntronInfo,
  type CodonMutationInfo,
} from '../../../biology/translation';
import { codonLabelThatFits } from '@waypoint/sequence-utils';
import { CDS_MUTATION_MARKUP } from '@waypoint/sequence-utils/sequence-edit-markup';
import { tintedTextColor } from '@waypoint/sequence-utils/annotation-text-color';
import { codonMutationColor } from '../overlays/annotation-mutation-paint';
import type { Feature, RenderState } from '../../../types';
import type { PathMapper, Pos3 } from '../shared/path-mapper';
import { destroyPixiText } from '../shared/pixi-text-lifecycle';
import { drawDashedPolyline, type Point2 } from '../shared/dashed-line';
import { buildLaneCenterline } from '../shared/lane-path';
import { LABEL_FONT_FAMILY } from '../shared/theme';
import {
  interactionOutlineStyle,
  type InteractionOutlineStyle,
} from '../shared/interaction-outline';
import { MAX_SEQUENCE_FONT_SIZE, stableRasterSize } from '../shared/sequence-sizing';
import { computeCodonEdges, type CodonEdge } from '../../../biology/codon-edges';
import { getCodonFillColor, isLightAAColor, CODON_FILL_ALPHA } from '../../../biology/aa-colors';
import { computeBBox, pointInPolygon } from '../overlays/hit-testing';
import type { FeatureHitPayload } from '../shared/hit-targets';
import { canvasMiddleTextAnchorY } from '../shared/canvas-middle-text';

const DRAFT_LETTER_STYLE_CACHE_MAX_ENTRIES = 64;
const CODON_LETTER_RASTER_SIZE = stableRasterSize(MAX_SEQUENCE_FONT_SIZE);

const CODON_LETTER_SCALE = 0.92;

const CHEVRON_WIDTH_RATIO = CODON_CHEVRON_DEPTH_RATIO;

const STROKE_WIDTH = CODON_OUTLINE_WIDTH;
const STROKE_ALPHA = 0.3;
const MOLSTAR_HOVER_COLOR_LIGHT = 0xff6699;
const MOLSTAR_HOVER_COLOR_DARK = 0xb3476b;

const MOLSTAR_SELECTION_COLOR_LIGHT = 0x33ff1a;
const MOLSTAR_SELECTION_COLOR_DARK = 0x24b212;
const REVIEW_GRAYED_COLOR = 0xe5e7eb;
const PLANNOTATE_DRAFT_OUTLINE_ALPHA = 0.6;
const PLANNOTATE_DRAFT_FAINT_ALPHA = 0.3;
const DRAFT_OUTLINE_DASH_PX = 2;
const DRAFT_OUTLINE_GAP_PX = 2;
const DRAFT_OUTLINE_SOURCES = new Set([
  'pLannotate-draft',
  'annotation-draft',
  'orf-candidate-cds',
]);

const INTRON_LINE_ALPHA = 0.5;
const INTRON_HOVER_TOLERANCE_PX = 4;

const ANNOTATION_SEARCH_FOCUS_DIM_COLOR = 0x6b7280;
const ANNOTATION_SEARCH_FOCUS_DIM_ALPHA_LIGHT = 0.2;
const ANNOTATION_SEARCH_FOCUS_DIM_ALPHA_DARK = 0.14;

const RESIDUE_NUMBER_FONT_SIZE = 9;
const RESIDUE_TEXT_LIGHT = 0x000000;
const RESIDUE_TEXT_DARK = 0xc8c8c8;
const RESIDUE_TEXT_ALPHA_LIGHT = 0.4;
const RESIDUE_TEXT_ALPHA_DARK = 0.55;

function residueNumberStep(pixelsPerCodon: number): number {
  if (pixelsPerCodon >= 30) return 1;
  if (pixelsPerCodon >= 15) return 2;
  if (pixelsPerCodon >= 8) return 5;
  if (pixelsPerCodon >= 4) return 10;
  if (pixelsPerCodon >= 2) return 20;
  if (pixelsPerCodon >= 1) return 50;
  return 100;
}

function intronBoundaryResidues(codons: CodonInfo[], genomeLength: number): Set<number> {
  const boundary = new Set<number>();
  for (const codon of codons) {
    if (
      codon.residueIndex !== undefined &&
      (codon.isPartialPreIntron === true || codon.isPartialPostIntron === true)
    ) {
      boundary.add(codon.residueIndex);
    }
  }
  const sorted = codons
    .map((c) => c.residueIndex)
    .filter((ri): ri is number => ri !== undefined)
    .sort((a, b) => a - b);
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i + 1] > sorted[i] + 1) {
      boundary.add(sorted[i]);
      boundary.add(sorted[i + 1]);
    }
  }

  const anchorByResidue = new Map<number, number>();
  for (const codon of codons) {
    if (codon.residueIndex === undefined) continue;
    if (!anchorByResidue.has(codon.residueIndex)) {
      anchorByResidue.set(codon.residueIndex, codon.codonStartBp ?? codon.startBp);
    }
  }
  const residues = [...anchorByResidue.keys()].sort((a, b) => a - b);
  const circDist = (a: number, b: number): number => {
    if (genomeLength <= 0) return Math.abs(a - b);
    const raw = Math.abs(a - b) % genomeLength;
    return Math.min(raw, genomeLength - raw);
  };
  for (let i = 0; i < residues.length - 1; i++) {
    const ri = residues[i];
    const next = residues[i + 1];
    if (next !== ri + 1) continue;
    const d = circDist(anchorByResidue.get(ri)!, anchorByResidue.get(next)!);

    if (d > 3) {
      boundary.add(ri);
      boundary.add(next);
    }
  }
  return boundary;
}

type CodonCellGeometry = {
  pts: number[];
  startPos: { x: number; y: number; angle: number };
  endPos: { x: number; y: number; angle: number };
  midPos: { x: number; y: number; angle: number };
  leftEdge: CodonEdge;
  rightEdge: CodonEdge;
  visualStartBp?: number;
};

type PendingCodonLetter = {
  codon: CodonInfo;
  startPos: { x: number; y: number; angle: number };
  endPos: { x: number; y: number; angle: number };
  midPos: { x: number; y: number; angle: number };
  angle: number;
  depth: number;
  dir: 1 | -1;
};

type FilledCodonCell = {
  cell: CodonCellGeometry;
  fillColor: number;
  fillAlpha?: number;
};

type CodonHitRecord = {
  codingSource?: 'reference' | 'query';
  mutation?: CodonMutationInfo;
  featureId: number;
  featureStart: number;
  featureEnd: number;
  strand: 1 | -1;
  start: number;
  end: number;
  pts: number[];
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
};

type CodonMutationSample = {
  kind: CodonMutationInfo['kind'];
  start: number;
  end: number;
  referenceAa?: string;
  queryAa?: string;
  prematureStop: boolean;
  frameShifted: boolean;
  stopLost: boolean;
};

export type CodonTrackDebugSnapshot = {
  codingRows: Array<{
    featureId: number;
    source: 'reference' | 'query';
    start: number;
    end: number;
    letters: string[];
  }>;
  mutationCodonCount: number;
  mutationKindCounts: Partial<Record<CodonMutationInfo['kind'], number>>;
  mutationSamples: CodonMutationSample[];
  letterCount: number;
  letterPoolSize: number;
  letterSample: string[];
  unknownLetterCount: number;
  semanticCodonCount: number;
  distinctCodonCount: number;
  distinctAminoAcidCount: number;
  translationMismatchCount: number;
  intronLabelCount: number;
  intronLabelPoolSize: number;
  intronLabelSample: string[];
  curvedIntronLabelCount: number;
  hitCount: number;
  selectedCodonCellCount: number;
  residueNumberCount: number;
  residueNumberSample: string[];
  annotationSearchFocusTargetCodonCellCount: number;
  annotationSearchFocusDimmedCodonCellCount: number;
  annotationSearchFocusDimmedIntronCount: number;
};

function codonVisualLength(codon: CodonInfo, genomeLength: number): number {
  if (codon.endBp > codon.startBp) return codon.endBp - codon.startBp;
  return genomeLength - codon.startBp + codon.endBp;
}

function splitIntronRanges(intron: IntronInfo, genomeLength: number): Array<[number, number]> {
  if (intron.genomicEnd >= intron.genomicStart) {
    return [[intron.genomicStart, intron.genomicEnd]];
  }
  return [
    [intron.genomicStart, genomeLength - 1],
    [0, intron.genomicEnd],
  ];
}

function intronRangesForPath(
  intron: IntronInfo,
  genomeLength: number,
  path: PathMapper
): Array<[number, number]> {
  if (!path.isArcMode || intron.genomicEnd >= intron.genomicStart) {
    return splitIntronRanges(intron, genomeLength);
  }
  return [[intron.genomicStart, intron.genomicEnd + genomeLength]];
}

function sameCircularBp(a: number, b: number, genomeLength: number): boolean {
  return ((a % genomeLength) + genomeLength) % genomeLength === b;
}

function adjustAlongTangent(
  pos: { x: number; y: number; angle: number },
  distance: number
): { x: number; y: number } {
  return {
    x: pos.x + Math.cos(pos.angle) * distance,
    y: pos.y + Math.sin(pos.angle) * distance,
  };
}

function isOutlineOnlyCds(feature: Feature): boolean {
  if (feature.outlineOnly === true) return true;
  const isDraft = feature.qualifiers?.source === 'pLannotate-draft';
  const isAccepted = feature.qualifiers?.status === 'accepted';
  return isDraft && !isAccepted;
}

function hasDraftOutline(feature: Feature): boolean {
  const source = feature.qualifiers?.source;
  return source ? DRAFT_OUTLINE_SOURCES.has(source) : false;
}

function flatPolygonToPolyline(pts: number[]): Point2[] {
  const points: Point2[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    points.push({ x: pts[i], y: pts[i + 1] });
  }
  if (points.length > 0) {
    points.push({ ...points[0] });
  }
  return points;
}

function reviewAlphaForFeature(feature: Feature, state: RenderState): number {
  if (feature.color !== REVIEW_GRAYED_COLOR) return 1;
  return state.themeMode === 'dark' ? 0.08 : 0.2;
}

type AnnotationSearchFocusTreatment = 'ordinary' | 'target' | 'dimmed';

export function isAnnotationSearchFocusTarget(
  feature: Feature,
  focus: RenderState['annotationSearchFocus']
): boolean {
  return (
    !!focus &&
    (feature.annotationTrackId ?? feature.type) === focus.trackId &&
    feature.canonicalIdentity === focus.canonicalIdentity
  );
}

function annotationSearchFocusTreatment(
  feature: Feature,
  state: RenderState
): AnnotationSearchFocusTreatment {
  const focus = state.annotationSearchFocus;
  if (!focus || (feature.annotationTrackId ?? feature.type) !== focus.trackId) {
    return 'ordinary';
  }
  return isAnnotationSearchFocusTarget(feature, focus) ? 'target' : 'dimmed';
}

function annotationSearchFocusAlpha(
  treatment: AnnotationSearchFocusTreatment,
  state: RenderState
): number {
  if (treatment !== 'dimmed') return 1;
  return state.themeMode === 'dark'
    ? ANNOTATION_SEARCH_FOCUS_DIM_ALPHA_DARK
    : ANNOTATION_SEARCH_FOCUS_DIM_ALPHA_LIGHT;
}

export class CodonTrack {
  private container: Container;
  private graphics = new Graphics();
  private letterPool: Text[] = [];
  private letterIndex = 0;
  private semanticCodonCount = 0;
  private semanticCodons = new Set<string>();
  private semanticAminoAcids = new Set<string>();
  private translationMismatchCount = 0;
  private mutationKeys = new Set<string>();
  private mutationKindCounts: Partial<Record<CodonMutationInfo['kind'], number>> = {};
  private mutationSamples: CodonMutationSample[] = [];
  private codingRows: CodonTrackDebugSnapshot['codingRows'] = [];
  private residueLabelPool: Text[] = [];
  private residueLabelIndex = 0;
  private residueStyleLight = new TextStyle({
    fontSize: RESIDUE_NUMBER_FONT_SIZE,
    fill: RESIDUE_TEXT_LIGHT,
    fontFamily: LABEL_FONT_FAMILY,
    fontWeight: '400',
  });
  private residueStyleDark = new TextStyle({
    fontSize: RESIDUE_NUMBER_FONT_SIZE,
    fill: RESIDUE_TEXT_DARK,
    fontFamily: LABEL_FONT_FAMILY,
    fontWeight: '400',
  });
  private hitCache: CodonHitRecord[] = [];
  private intronHitCache: Array<{
    feature: FeatureHitPayload;
    points: Pos3[];
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
  }> = [];
  private selectedCodonCellCount = 0;
  private annotationSearchFocusTargetCodonCellCount = 0;
  private annotationSearchFocusDimmedCodonCellCount = 0;
  private annotationSearchFocusDimmedIntronCount = 0;
  private draftLetterStyles = new Map<number, TextStyle>();
  private exactLetterStyles = new Map<string, TextStyle>();
  private letterStyleLight = new TextStyle({
    fontSize: 10,
    fill: 0x222222,
    fontFamily: SEQUENCE_FONT_FAMILY,
    fontWeight: CODON_FONT_WEIGHT,
  });
  private letterStyleDark = new TextStyle({
    fontSize: 10,
    fill: 0xffffff,
    fontFamily: SEQUENCE_FONT_FAMILY,
    fontWeight: CODON_FONT_WEIGHT,
  });
  private letterStyleStop = new TextStyle({
    fontSize: 10,
    fill: 0xcc0000,
    fontFamily: SEQUENCE_FONT_FAMILY,
    fontWeight: CODON_FONT_WEIGHT,
  });
  private letterStyleAnnotationSearchDimmed = new TextStyle({
    fontSize: 10,
    fill: ANNOTATION_SEARCH_FOCUS_DIM_COLOR,
    fontFamily: SEQUENCE_FONT_FAMILY,
    fontWeight: CODON_FONT_WEIGHT,
  });
  private residueStyleAnnotationSearchDimmed = new TextStyle({
    fontSize: RESIDUE_NUMBER_FONT_SIZE,
    fill: ANNOTATION_SEARCH_FOCUS_DIM_COLOR,
    fontFamily: LABEL_FONT_FAMILY,
    fontWeight: '400',
  });

  constructor(parent: Container) {
    this.container = parent;
    parent.addChild(this.graphics);
  }

  reset(): void {
    this.graphics.clear();
    this.hitCache.length = 0;
    this.intronHitCache.length = 0;
    this.selectedCodonCellCount = 0;
    this.annotationSearchFocusTargetCodonCellCount = 0;
    this.annotationSearchFocusDimmedCodonCellCount = 0;
    this.annotationSearchFocusDimmedIntronCount = 0;
    this.semanticCodonCount = 0;
    this.semanticCodons.clear();
    this.semanticAminoAcids.clear();
    this.translationMismatchCount = 0;
    this.mutationKeys.clear();
    this.mutationKindCounts = {};
    this.mutationSamples = [];
    this.codingRows = [];
    for (let i = 0; i < this.letterIndex; i++) {
      this.letterPool[i].visible = false;
    }
    for (let i = 0; i < this.residueLabelIndex; i++) {
      this.residueLabelPool[i].visible = false;
    }
    this.letterIndex = 0;
    this.residueLabelIndex = 0;
  }

  getDebugSnapshot(): CodonTrackDebugSnapshot {
    const letters = this.letterPool.slice(0, this.letterIndex).map((text) => String(text.text));
    return {
      codingRows: [...this.codingRows],
      mutationCodonCount: this.mutationKeys.size,
      mutationKindCounts: { ...this.mutationKindCounts },
      mutationSamples: [...this.mutationSamples],
      letterCount: this.letterIndex,
      letterPoolSize: this.letterPool.length,
      letterSample: letters.slice(0, 48),
      unknownLetterCount: letters.filter((letter) => letter === '?').length,
      semanticCodonCount: this.semanticCodonCount,
      distinctCodonCount: this.semanticCodons.size,
      distinctAminoAcidCount: this.semanticAminoAcids.size,
      translationMismatchCount: this.translationMismatchCount,

      intronLabelCount: 0,
      intronLabelPoolSize: 0,
      intronLabelSample: [],
      curvedIntronLabelCount: 0,
      hitCount: this.hitCache.length,
      selectedCodonCellCount: this.selectedCodonCellCount,
      residueNumberCount: this.residueLabelIndex,
      residueNumberSample: this.residueLabelPool
        .slice(0, this.residueLabelIndex)
        .map((text) => String(text.text)),
      annotationSearchFocusTargetCodonCellCount: this.annotationSearchFocusTargetCodonCellCount,
      annotationSearchFocusDimmedCodonCellCount: this.annotationSearchFocusDimmedCodonCellCount,
      annotationSearchFocusDimmedIntronCount: this.annotationSearchFocusDimmedIntronCount,
    };
  }

  renderCodons(
    feature: Feature,
    codons: CodonInfo[],
    path: PathMapper,
    chevronOffsetPx: number,
    genomeLength: number,
    state: RenderState,
    opacity: number = 1,
    residueRowOffsetPx: number = 0,
    maxHalfHeightPx: number = Number.POSITIVE_INFINITY,
    compoundOutline?: (points: number[]) => void
  ): void {
    if (opacity <= 0) return;
    const firstLetter = this.letterIndex;

    const g = this.graphics;
    const isForward = feature.direction === 'forward';
    const dir: 1 | -1 = isForward ? 1 : -1;

    const cdsHeight =
      path.cdsChevronHeight ??
      (path.isArcMode
        ? Math.max(5.4, canvasCdsMetrics(path.pixelsPerBp).aaHeight)
        : path.rowHeight * 0.9);
    const halfH = Math.min(
      maxHalfHeightPx,
      path.scaleNormalOffset?.(cdsHeight / 2) ?? cdsHeight / 2
    );
    const trackH = halfH * 2;
    const depth = Math.round(trackH * CHEVRON_WIDTH_RATIO);
    const outlineOnly = isOutlineOnlyCds(feature);
    const focusTreatment = annotationSearchFocusTreatment(feature, state);
    const focusDimmed = focusTreatment === 'dimmed';
    const original = feature.codingSource === 'reference';
    const inlineDiff = state.sequencePresentation?.cdsComparisonLayout === 'diff';
    const visualColor = focusDimmed ? ANNOTATION_SEARCH_FOCUS_DIM_COLOR : feature.color;
    const effectiveOpacity =
      opacity *
      reviewAlphaForFeature(feature, state) *
      annotationSearchFocusAlpha(focusTreatment, state);
    const filledCells: FilledCodonCell[] = [];
    const aaScheme = state.sequencePresentation?.aminoAcidColorScheme ?? 'rasmol';
    const interactionOutlineCells: CodonCellGeometry[] = [];
    const hoveredCodonCells: CodonCellGeometry[] = [];
    const selectedCodonCells: CodonCellGeometry[] = [];
    const draftLetters: PendingCodonLetter[] = [];
    const hoveredCodon = state.hoveredCodon ?? null;
    const selectedCodonKeys =
      state.selectedCodons && state.selectedCodons.length > 0
        ? new Set(
            state.selectedCodons
              .filter((selected) => selected.strand === dir)
              .map((selected) => `${selected.start}:${selected.end}`)
          )
        : null;

    for (let idx = 0; idx < codons.length; idx++) {
      const codon = codons[idx];

      const visualLength = codonVisualLength(codon, genomeLength);
      const midBp = codon.startBp + visualLength / 2 - 0.5;
      const startBoundaryBp = codon.startBp - 0.5;
      const endBoundaryBp = codon.startBp + visualLength - 0.5;
      const midPos = path.featureLabelPosAt(midBp, chevronOffsetPx);
      if (
        midPos.x < -80 ||
        midPos.x > state.width + 80 ||
        midPos.y < -80 ||
        midPos.y > state.height + 80
      )
        continue;

      const startPos = path.featureLabelPosAt(startBoundaryBp, chevronOffsetPx);
      const endPos = path.featureLabelPosAt(endBoundaryBp, chevronOffsetPx);
      const angle = midPos.angle;

      const fillColor = focusDimmed
        ? ANNOTATION_SEARCH_FOCUS_DIM_COLOR
        : getCodonFillColor(
            codon.aa,
            codon.isStop,
            codon.display?.kind === 'residue' ? codon.display.full : undefined,
            aaScheme
          );

      const regionEnd = feature.end > feature.start ? feature.end : feature.end + genomeLength;
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
        feature.start,
        regionEnd
      );

      const cell = {
        ...(angle === 0
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
            )),
        visualStartBp: startBoundaryBp,
      };
      interactionOutlineCells.push(cell);

      if (opacity <= 0) continue;
      const mutation = focusDimmed ? undefined : codon.mutation;
      const mutationColor = focusDimmed ? null : codonMutationColor(codon);
      const mutationPaint = mutationColor === null ? null : { color: mutationColor };
      const diffColor = mutationPaint?.color ?? fillColor;
      if (!outlineOnly) {
        let paintedColor =
          original || (!focusDimmed && aaScheme === 'none') ? feature.color : fillColor;
        let paintedAlpha = original
          ? 0.18
          : aaScheme === 'none' && !focusDimmed
            ? 0.3
            : CODON_FILL_ALPHA;
        if (
          !inlineDiff &&
          !original &&
          (mutation?.kind === 'inserted' ||
            mutation?.kind === 'deleted' ||
            (mutation?.kind === 'frameshifted' && aaScheme === 'none'))
        ) {
          const paint = CDS_MUTATION_MARKUP[mutation.kind].background;
          paintedColor = paint.color;
          paintedAlpha = paint.alpha;
        }
        if (inlineDiff && !focusDimmed) {
          paintedColor = mutationPaint ? diffColor : 0x9e9e9e;
          paintedAlpha = mutationPaint ? 1 : 0.3;
        }
        filledCells.push({ cell, fillColor: paintedColor, fillAlpha: paintedAlpha });
        if (mutation && mutation.kind !== 'match' && mutation.kind !== 'unknown') {
          const key = `${feature.id}:${codon.codonStartBp ?? codon.startBp}:${codon.codonEndBp ?? codon.endBp}:${mutation.kind}`;
          if (!this.mutationKeys.has(key)) {
            this.mutationKeys.add(key);
            this.mutationKindCounts[mutation.kind] =
              (this.mutationKindCounts[mutation.kind] ?? 0) + 1;
            if (this.mutationSamples.length < 48)
              this.mutationSamples.push({
                kind: mutation.kind,
                start: codon.codonStartBp ?? codon.startBp,
                end: codon.codonEndBp ?? codon.endBp - 1,
                referenceAa: mutation.referenceAa,
                queryAa: mutation.queryAa,
                prematureStop: mutation.prematureStop,
                frameShifted: mutation.frameShifted,
                stopLost: mutation.stopLost,
              });
          }
        }
      }

      if (focusTreatment === 'target') {
        this.annotationSearchFocusTargetCodonCellCount += 1;
      } else if (focusDimmed) {
        this.annotationSearchFocusDimmedCodonCellCount += 1;
      }
      const pts = cell.pts;
      const bbox = computeBBox(pts);
      const codonStart = codon.codonStartBp ?? codon.startBp;
      const codonEnd =
        codon.codonEndBp ?? ((codonEndInclusive % genomeLength) + genomeLength) % genomeLength;
      this.hitCache.push({
        codingSource: feature.codingSource,
        mutation: codon.mutation,
        featureId: feature.id,
        featureStart: feature.start,
        featureEnd: feature.end,
        strand: dir,
        start: codonStart,
        end: codonEnd,
        pts,
        ...bbox,
      });
      if (
        hoveredCodon &&
        hoveredCodon.strand === dir &&
        hoveredCodon.start === codonStart &&
        hoveredCodon.end === codonEnd
      ) {
        hoveredCodonCells.push(cell);
      }
      if (selectedCodonKeys?.has(`${codonStart}:${codonEnd}`)) {
        selectedCodonCells.push(cell);
      }

      const cellWidth = Math.hypot(endPos.x - startPos.x, endPos.y - startPos.y);
      if ((codon.renderLetter ?? true) && indexedCodonLettersVisible(cellWidth)) {
        if (outlineOnly) {
          draftLetters.push({ codon, startPos, endPos, midPos, angle, depth, dir });
        } else {
          this.drawCodonLetter(
            codon,
            startPos,
            endPos,
            midPos,
            angle,
            depth,
            dir,
            path,
            focusDimmed
              ? this.letterStyleAnnotationSearchDimmed
              : inlineDiff
                ? mutationPaint
                  ? codon.isStop
                    ? this.letterStyleDark
                    : this.getCodonLetterStyle(codon, diffColor)
                  : this.getDraftLetterStyle(state.themeMode === 'dark' ? 0xb0b0b0 : 0x616161)
                : original
                  ? this.getDraftLetterStyle(feature.color)
                  : codon.mutation?.kind === 'inserted' && !codon.isStop
                    ? this.getDraftLetterStyle(state.themeMode === 'dark' ? 0xa8c8a8 : 0x4a6a4a)
                    : aaScheme === 'none' && !codon.isStop && codon.mutation?.kind !== 'deleted'
                      ? this.getDraftLetterStyle(
                          Number.parseInt(
                            tintedTextColor(
                              '#' + feature.color.toString(16).padStart(6, '0'),
                              state.themeMode === 'dark'
                            ).slice(1),
                            16
                          )
                        )
                      : this.getCodonLetterStyle(codon, fillColor),
            (path.isArcMode ? 1 : 0.85) * effectiveOpacity * (original ? 0.7 : 1),
            state.themeMode === 'dark'
          );
        }
      }
    }

    const orderedInteractionCells = this.orderCellsForStrip(
      interactionOutlineCells,
      feature.start - 0.5,
      genomeLength
    );

    if (orderedInteractionCells.length === 0) return;

    const interactionStyle = interactionOutlineStyle(state, feature.id);
    const drawBasePerimeter =
      !interactionStyle && !hasDraftOutline(feature) && !feature.codingGhostOnly;
    if (!outlineOnly) {
      this.drawFilledCells(
        g,
        filledCells,
        orderedInteractionCells,
        halfH,
        depth,
        dir,
        visualColor,
        effectiveOpacity,
        drawBasePerimeter
      );
    }

    if (outlineOnly) {
      this.drawChevronStripWireframe(
        g,
        orderedInteractionCells,
        halfH,
        depth,
        dir,
        visualColor,
        effectiveOpacity,
        drawBasePerimeter
      );
      const draftStyle = focusDimmed
        ? this.letterStyleAnnotationSearchDimmed
        : this.getDraftLetterStyle(feature.color);
      for (const letter of draftLetters) {
        this.drawCodonLetter(
          letter.codon,
          letter.startPos,
          letter.endPos,
          letter.midPos,
          letter.angle,
          letter.depth,
          letter.dir,
          path,
          draftStyle,
          PLANNOTATE_DRAFT_FAINT_ALPHA * effectiveOpacity
        );
      }
    }

    if (hasDraftOutline(feature) && !interactionStyle) {
      this.drawChevronStripDraftOutline(
        g,
        orderedInteractionCells,
        halfH,
        depth,
        dir,
        visualColor,
        effectiveOpacity
      );
    }

    if (interactionStyle && !focusDimmed) {
      if (compoundOutline) {
        for (const run of this.contiguousCellRuns(orderedInteractionCells))
          compoundOutline(this.buildOuterStripPoints(run, halfH, depth, dir));
      } else
        this.drawChevronStripInteractionOutline(
          g,
          orderedInteractionCells,
          halfH,
          depth,
          dir,
          interactionStyle
        );
    }

    if (hoveredCodonCells.length > 0 && !focusDimmed) {
      this.drawHoveredCodonCellOutline(g, hoveredCodonCells, state);
    }
    if (selectedCodonCells.length > 0 && !focusDimmed) {
      this.selectedCodonCellCount += selectedCodonCells.length;
      this.drawSelectedCodonCellOutline(g, selectedCodonCells, state);
    }

    if (
      state.showResidueNumbers === true &&
      opacity > 0 &&
      !outlineOnly &&
      residueRowOffsetPx !== 0
    ) {
      this.renderResidueNumbers(
        codons,
        path,
        residueRowOffsetPx,
        genomeLength,
        state,
        effectiveOpacity,
        focusDimmed
      );
    }
    if (feature.codingSource)
      this.codingRows.push({
        featureId: feature.id,
        source: feature.codingSource,
        start: feature.start,
        end: feature.end,
        letters: this.letterPool
          .slice(firstLetter, this.letterIndex)
          .map((text) => String(text.text)),
      });
  }

  private renderResidueNumbers(
    codons: CodonInfo[],
    path: PathMapper,
    residueRowOffsetPx: number,
    genomeLength: number,
    state: RenderState,
    opacity: number,
    focusDimmed: boolean
  ): void {
    const pixelsPerCodon = path.pixelsPerBp * 3;

    if (pixelsPerCodon < 1) return;
    const step = residueNumberStep(pixelsPerCodon);
    const boundary = intronBoundaryResidues(codons, genomeLength);

    const isDark = state.themeMode === 'dark';
    const style = focusDimmed
      ? this.residueStyleAnnotationSearchDimmed
      : isDark
        ? this.residueStyleDark
        : this.residueStyleLight;
    const textAlpha = (isDark ? RESIDUE_TEXT_ALPHA_DARK : RESIDUE_TEXT_ALPHA_LIGHT) * opacity;

    const residueOffsetPx = residueRowOffsetPx;

    const drawn = new Set<number>();
    for (const codon of codons) {
      if (codon.mutation?.kind === 'deleted') continue;
      const ri = codon.residueIndex;
      if (ri === undefined) {
        const isProd =
          typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'production';
        if (!isProd) {
          throw new Error(
            'codon-track: codon has no residueIndex. translateCDS must set ' +
              'protein-order numbering; never infer from screen/genomic position.'
          );
        }
        continue;
      }

      if (drawn.has(ri)) continue;
      const shouldRender = ri === 1 || ri % step === 0 || boundary.has(ri);
      if (!shouldRender) continue;

      const visualLength = codonVisualLength(codon, genomeLength);
      const midBp = codon.startBp + visualLength / 2 - 0.5;
      const pos = path.featureLabelPosAt(midBp, residueOffsetPx);
      if (pos.x < -40 || pos.x > state.width + 40 || pos.y < -40 || pos.y > state.height + 40) {
        continue;
      }
      drawn.add(ri);

      const textObj = this.acquireResidueLabel();
      const label = String(ri);
      if (textObj.text !== label) textObj.text = label;
      if (textObj.style !== style) textObj.style = style;
      textObj.alpha = textAlpha;
      textObj.anchor.set(0.5, 0.5);
      textObj.x = pos.x;
      textObj.y = pos.y;
      textObj.rotation = pos.angle;

      const targetFontSize = RESIDUE_NUMBER_FONT_SIZE;
      const rasterSize = stableRasterSize(targetFontSize);
      const displayScale = targetFontSize / rasterSize;
      if (style.fontSize !== rasterSize) style.fontSize = rasterSize;
      textObj.scale.set(displayScale);
    }
  }

  private acquireResidueLabel(): Text {
    let t: Text;
    if (this.residueLabelIndex < this.residueLabelPool.length) {
      t = this.residueLabelPool[this.residueLabelIndex];
      t.visible = true;
    } else {
      t = new Text({ text: '', style: this.residueStyleLight });
      this.container.addChild(t);
      this.residueLabelPool.push(t);
    }
    this.residueLabelIndex++;
    return t;
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

  renderIntrons(
    feature: Feature,
    introns: IntronInfo[],
    path: PathMapper,
    chevronOffsetPx: number,
    genomeLength: number,
    state: RenderState,
    opacity: number = 1
  ): void {
    if (opacity <= 0 || introns.length === 0) return;
    const g = this.graphics;
    const dir: 1 | -1 = feature.direction === 'reverse' ? -1 : 1;
    const trackH =
      path.cdsChevronHeight ??
      (path.isArcMode
        ? Math.max(5.4, canvasCdsMetrics(path.pixelsPerBp).aaHeight)
        : path.rowHeight * 0.9);
    const depth = Math.round(trackH * CHEVRON_WIDTH_RATIO);
    const lineWidth = 1;
    const focusTreatment = annotationSearchFocusTreatment(feature, state);
    const focusDimmed = focusTreatment === 'dimmed';
    const visualColor = focusDimmed ? ANNOTATION_SEARCH_FOCUS_DIM_COLOR : feature.color;
    const effectiveOpacity = opacity * annotationSearchFocusAlpha(focusTreatment, state);

    for (const intron of introns) {
      if (focusDimmed) this.annotationSearchFocusDimmedIntronCount += 1;
      const ranges = intronRangesForPath(intron, genomeLength, path);
      g.setStrokeStyle({
        width: lineWidth,
        color: visualColor,
        alpha: INTRON_LINE_ALPHA * effectiveOpacity,
      });

      for (const [start, end] of ranges) {
        const featureLen = end - start + 1;
        if (featureLen <= 0 || !path.isFeatureVisible(start, featureLen, chevronOffsetPx, depth))
          continue;

        const adjustStart = sameCircularBp(start, intron.genomicStart, genomeLength) && dir === 1;
        const adjustEnd = sameCircularBp(end, intron.genomicEnd, genomeLength) && dir === -1;
        const points = this.drawIntronConnectorSegment(
          g,
          path,
          start - 0.5,
          end + 0.5,
          chevronOffsetPx,
          genomeLength,
          depth,
          adjustStart,
          adjustEnd,
          dir,
          visualColor,
          effectiveOpacity
        );
        if (points) {
          const record = {
            feature: { id: feature.id, start: feature.start, end: feature.end },
            points,
            xMin: Infinity,
            xMax: -Infinity,
            yMin: Infinity,
            yMax: -Infinity,
          };
          for (const point of points) {
            record.xMin = Math.min(record.xMin, point.x);
            record.xMax = Math.max(record.xMax, point.x);
            record.yMin = Math.min(record.yMin, point.y);
            record.yMax = Math.max(record.yMax, point.y);
          }
          this.intronHitCache.push(record);
        }
      }
    }
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
      pts.push(x1, top);

      pts.push(x2, top);

      if (rightEdge === 'chevron' || rightEdge === 'tip') {
        pts.push(x2 + depth, cy);
        pts.push(x2, bot);
      } else {
        pts.push(x2, bot);
      }

      pts.push(x1, bot);

      if (leftEdge === 'chevron') {
        pts.push(x1 + depth, cy);
      } else if (leftEdge === 'tip') {
        pts.push(x1 - depth, cy);
      }
    } else {
      pts.push(x1, top);

      pts.push(x2, top);

      if (rightEdge === 'chevron') {
        pts.push(x2 - depth, cy);
        pts.push(x2, bot);
      } else if (rightEdge === 'tip') {
        pts.push(x2 + depth, cy);
        pts.push(x2, bot);
      } else {
        pts.push(x2, bot);
      }

      pts.push(x1, bot);

      if (leftEdge === 'chevron' || leftEdge === 'tip') {
        pts.push(x1 - depth, cy);
      }
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
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const tx = cos,
      ty = sin;
    const nx = -sin,
      ny = cos;
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

      if (leftEdge === 'chevron') {
        pts.push(s.x + tx * depth, s.y + ty * depth);
      }
    } else {
      pts.push(s.x - nx * halfH, s.y - ny * halfH);
      pts.push(e.x - nx * halfH, e.y - ny * halfH);
      if (rightEdge === 'chevron') {
        pts.push(e.x - tx * depth - nx * halfH + nx * halfH, e.y - ty * depth);

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

  private drawFilledCells(
    g: Graphics,
    cells: FilledCodonCell[],
    orderedCells: CodonCellGeometry[],
    halfH: number,
    depth: number,
    dir: 1 | -1,
    strokeColor: number,
    opacity: number,
    drawPerimeter: boolean
  ): void {
    if (cells.length === 0) return;

    const cellsByFill = new Map<
      string,
      { color: number; alpha: number; cells: CodonCellGeometry[] }
    >();
    for (const { cell, fillColor, fillAlpha = CODON_FILL_ALPHA } of cells) {
      const key = `${fillColor}:${fillAlpha}`;
      const group = cellsByFill.get(key);
      if (group) group.cells.push(cell);
      else cellsByFill.set(key, { color: fillColor, alpha: fillAlpha, cells: [cell] });
    }
    for (const group of cellsByFill.values()) {
      for (const cell of group.cells) g.poly(cell.pts);
      g.fill({ color: group.color, alpha: group.alpha * opacity });
    }

    g.setStrokeStyle({ width: STROKE_WIDTH, color: strokeColor, alpha: STROKE_ALPHA * opacity });
    for (const run of this.contiguousCellRuns(orderedCells)) {
      for (let index = 0; index < run.length - 1; index += 1)
        this.drawInteriorDivider(g, run[index].endPos, halfH, depth, dir, false);
      if (drawPerimeter) g.poly(this.buildOuterStripPoints(run, halfH, depth, dir));
    }
    if (drawPerimeter || orderedCells.length > 1) g.stroke();
  }

  private drawChevronStripWireframe(
    g: Graphics,
    cells: CodonCellGeometry[],
    halfH: number,
    depth: number,
    dir: 1 | -1,
    color: number,
    opacity: number,
    drawPerimeter: boolean
  ): void {
    if (cells.length === 0) return;

    g.setStrokeStyle({
      width: STROKE_WIDTH,
      color,
      alpha: PLANNOTATE_DRAFT_FAINT_ALPHA * opacity,
    });
    for (const run of this.contiguousCellRuns(cells)) {
      for (let i = 0; i < run.length - 1; i++)
        this.drawInteriorDivider(g, run[i].endPos, halfH, depth, dir);
    }

    if (!drawPerimeter) return;
    g.setStrokeStyle({
      width: 1.5,
      color,
      alpha: PLANNOTATE_DRAFT_OUTLINE_ALPHA * opacity,
    });
    for (const run of this.contiguousCellRuns(cells))
      g.poly(this.buildOuterStripPoints(run, halfH, depth, dir));
    g.stroke();
  }

  private drawChevronStripDraftOutline(
    g: Graphics,
    cells: CodonCellGeometry[],
    halfH: number,
    depth: number,
    dir: 1 | -1,
    color: number,
    opacity: number
  ): void {
    if (cells.length === 0) return;
    g.setStrokeStyle({ width: 1.75, color, alpha: 0.95 * opacity });
    for (const run of this.contiguousCellRuns(cells)) {
      drawDashedPolyline(
        g,
        flatPolygonToPolyline(this.buildOuterStripPoints(run, halfH, depth, dir)),
        DRAFT_OUTLINE_DASH_PX,
        DRAFT_OUTLINE_GAP_PX
      );
    }
  }

  private drawChevronStripInteractionOutline(
    g: Graphics,
    cells: CodonCellGeometry[],
    halfH: number,
    depth: number,
    dir: 1 | -1,
    style: InteractionOutlineStyle
  ): void {
    if (cells.length === 0) return;

    g.setStrokeStyle(style);
    for (const run of this.contiguousCellRuns(cells))
      g.poly(this.buildOuterStripPoints(run, halfH, depth, dir));
    g.stroke();
  }

  private drawHoveredCodonCellOutline(
    g: Graphics,
    cells: CodonCellGeometry[],
    state: RenderState
  ): void {
    const color = state.themeMode === 'dark' ? MOLSTAR_HOVER_COLOR_DARK : MOLSTAR_HOVER_COLOR_LIGHT;
    g.setStrokeStyle({ width: 2.5, color, alpha: 0.95 });
    for (const cell of cells) {
      g.poly(cell.pts);
      g.stroke();
    }
  }

  private drawSelectedCodonCellOutline(
    g: Graphics,
    cells: CodonCellGeometry[],
    state: RenderState
  ): void {
    const color =
      state.themeMode === 'dark' ? MOLSTAR_SELECTION_COLOR_DARK : MOLSTAR_SELECTION_COLOR_LIGHT;
    g.setStrokeStyle({ width: 2.5, color, alpha: 0.95 });
    for (const cell of cells) {
      g.poly(cell.pts);
      g.stroke();
    }
  }

  private drawInteriorDivider(
    g: Graphics,
    boundary: { x: number; y: number; angle: number },
    halfH: number,
    depth: number,
    dir: 1 | -1,
    commitStroke: boolean = true
  ): void {
    const top = this.offsetNormal(boundary, -halfH);
    const bot = this.offsetNormal(boundary, halfH);
    const tip = this.offsetTangent(boundary, dir * depth);
    g.moveTo(top.x, top.y);
    g.lineTo(tip.x, tip.y);
    g.lineTo(bot.x, bot.y);
    if (commitStroke) g.stroke();
  }

  private contiguousCellRuns(cells: CodonCellGeometry[]): CodonCellGeometry[][] {
    const runs: CodonCellGeometry[][] = [];
    for (const cell of cells) {
      const run = runs[runs.length - 1];
      const previous = run?.[run.length - 1];
      if (
        !previous ||
        Math.hypot(previous.endPos.x - cell.startPos.x, previous.endPos.y - cell.startPos.y) > 1e-4
      )
        runs.push([cell]);
      else run!.push(cell);
    }
    return runs;
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
    for (const cell of cells) {
      this.pushPoint(pts, this.offsetNormal(cell.endPos, -halfH));
    }

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

  private getCodonLetterStyle(codon: CodonInfo, fillColor: number): TextStyle {
    if (codon.isStop || codon.mutation?.kind === 'deleted') return this.letterStyleStop;
    if (isLightAAColor(fillColor)) return this.letterStyleLight;
    return this.letterStyleDark;
  }

  private getDraftLetterStyle(color: number): TextStyle {
    let style = this.draftLetterStyles.get(color);
    if (style) {
      this.draftLetterStyles.delete(color);
      this.draftLetterStyles.set(color, style);
      return style;
    }
    style = new TextStyle({
      fontSize: 10,
      fill: color,
      fontFamily: SEQUENCE_FONT_FAMILY,
      fontWeight: CODON_FONT_WEIGHT,
    });
    this.draftLetterStyles.set(color, style);
    while (this.draftLetterStyles.size > DRAFT_LETTER_STYLE_CACHE_MAX_ENTRIES) {
      const oldestColor = this.draftLetterStyles.keys().next().value;
      if (oldestColor === undefined) break;
      this.draftLetterStyles.delete(oldestColor);
    }
    return style;
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
    targetStyle: TextStyle,
    alpha: number,
    isDark = false
  ): void {
    const textObj = this.acquireLetter();
    const normalizedCodon = codon.codon.toUpperCase();
    this.semanticCodonCount += 1;
    this.semanticCodons.add(normalizedCodon);
    this.semanticAminoAcids.add(codon.aa);

    if (
      codon.mutation?.kind !== 'deleted' &&
      (codon.display?.short ?? translateDnaCodon(normalizedCodon, codon.geneticCode)) !== codon.aa
    ) {
      this.translationMismatchCount += 1;
    }

    const cellWidth = Math.hypot(endPos.x - startPos.x, endPos.y - startPos.y);
    const usesCanvasMetrics = path.isArcMode || path.cdsChevronHeight !== undefined;
    const targetFontSize = usesCanvasMetrics
      ? canvasCdsMetrics(path.pixelsPerBp).aaFontSize
      : codonFontSize(path.sequenceFontSize) * CODON_LETTER_SCALE;
    const fit = codon.display
      ? codonLabelThatFits(codon.display, cellWidth, targetFontSize)
      : { text: codon.aa, scale: 1 };
    if (textObj.text !== fit.text) textObj.text = fit.text;
    if (usesCanvasMetrics) {
      const fill =
        targetStyle === this.letterStyleLight
          ? 0x000000
          : targetStyle === this.letterStyleDark && isDark
            ? 0xe6e6e6
            : targetStyle.fill;
      const key = `${targetFontSize}|${fill}`;
      let exact = this.exactLetterStyles.get(key);
      if (!exact) {
        exact = targetStyle.clone();
        exact.fontSize = targetFontSize;
        exact.fill = fill;
        this.exactLetterStyles.set(key, exact);
        if (this.exactLetterStyles.size > 64)
          this.exactLetterStyles.delete(this.exactLetterStyles.keys().next().value!);
      }
      targetStyle = exact;
    }
    if (textObj.style !== targetStyle) textObj.style = targetStyle;
    textObj.alpha = alpha;
    textObj.anchor.set(0.5, usesCanvasMetrics ? canvasMiddleTextAnchorY(targetStyle) : 0.5);

    const nudgeX = dir * depth * 0.3;
    const nudgeY = path.isArcMode ? Math.round(targetFontSize * 0.06) : targetFontSize * 0.06;
    if (angle === 0) {
      textObj.x = (startPos.x + endPos.x) / 2 + nudgeX;
      textObj.y = midPos.y + nudgeY;
    } else {
      textObj.x = midPos.x + Math.cos(angle) * nudgeX - Math.sin(angle) * nudgeY;
      textObj.y = midPos.y + Math.sin(angle) * nudgeX + Math.cos(angle) * nudgeY;
    }
    textObj.rotation = angle;

    const rasterSize = usesCanvasMetrics ? targetFontSize : CODON_LETTER_RASTER_SIZE;

    const displayScale = (targetFontSize / rasterSize) * fit.scale;
    if (targetStyle.fontSize !== rasterSize) targetStyle.fontSize = rasterSize;
    textObj.scale.set(displayScale);
  }

  hitTest(
    screenX: number,
    screenY: number
  ): {
    codingSource?: 'reference' | 'query';
    mutation?: CodonMutationInfo;
    start: number;
    end: number;
    featureId: number;
    featureStart: number;
    featureEnd: number;
    strand: 1 | -1;
  } | null {
    for (let i = this.hitCache.length - 1; i >= 0; i--) {
      const rec = this.hitCache[i];
      if (screenX < rec.xMin || screenX > rec.xMax || screenY < rec.yMin || screenY > rec.yMax) {
        continue;
      }
      if (!pointInPolygon(screenX, screenY, rec.pts)) continue;
      return {
        codingSource: rec.codingSource,
        mutation: rec.mutation,
        start: rec.start,
        end: rec.end,
        featureId: rec.featureId,
        featureStart: rec.featureStart,
        featureEnd: rec.featureEnd,
        strand: rec.strand,
      };
    }
    return null;
  }

  hitTestIntron(screenX: number, screenY: number): FeatureHitPayload | null {
    const tolerance = INTRON_HOVER_TOLERANCE_PX;
    for (let i = this.intronHitCache.length - 1; i >= 0; i--) {
      const record = this.intronHitCache[i];
      if (
        screenX < record.xMin - tolerance ||
        screenX > record.xMax + tolerance ||
        screenY < record.yMin - tolerance ||
        screenY > record.yMax + tolerance
      )
        continue;
      for (let j = 1; j < record.points.length; j++) {
        const start = record.points[j - 1];
        const end = record.points[j];
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const lengthSquared = dx * dx + dy * dy;
        const t =
          lengthSquared > 0
            ? Math.max(
                0,
                Math.min(1, ((screenX - start.x) * dx + (screenY - start.y) * dy) / lengthSquared)
              )
            : 0;
        const distanceX = screenX - start.x - t * dx;
        const distanceY = screenY - start.y - t * dy;
        if (distanceX * distanceX + distanceY * distanceY <= tolerance * tolerance) {
          return record.feature;
        }
      }
    }
    return null;
  }

  private buildIntronConnectorPoints(
    path: PathMapper,
    startBp: number,
    endBp: number,
    offsetPx: number,
    genomeLength: number,
    endpointDepthPx: number,
    adjustStart: boolean,
    adjustEnd: boolean
  ): Pos3[] {
    const points = buildLaneCenterline(path, startBp, endBp, offsetPx, genomeLength);
    if (points.length < 2) return points;

    if (adjustStart) {
      const adjusted = adjustAlongTangent(points[0], endpointDepthPx);
      points[0] = { ...points[0], ...adjusted };
    }
    if (adjustEnd) {
      const lastIndex = points.length - 1;
      const adjusted = adjustAlongTangent(points[lastIndex], -endpointDepthPx);
      points[lastIndex] = { ...points[lastIndex], ...adjusted };
    }
    return points;
  }

  private drawIntronConnectorSegment(
    g: Graphics,
    path: PathMapper,
    startBp: number,
    endBp: number,
    offsetPx: number,
    genomeLength: number,
    endpointDepthPx: number,
    adjustStart: boolean,
    adjustEnd: boolean,
    direction: 1 | -1,
    color: number,
    opacity: number
  ): Pos3[] | null {
    const totalLen = endBp - startBp;
    if (totalLen <= 0) return null;
    const points = this.buildIntronConnectorPoints(
      path,
      startBp,
      endBp,
      offsetPx,
      genomeLength,
      endpointDepthPx,
      adjustStart,
      adjustEnd
    );
    if (points.length < 2) return null;
    g.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) g.lineTo(points[i].x, points[i].y);
    g.stroke();
    const pitch = intronTickPitch(path.pixelsPerBp);
    const tickAlpha = intronTickAlpha((endBp - startBp) * path.pixelsPerBp) * opacity;
    if (!Number.isFinite(pitch) || tickAlpha <= 0) return points;
    g.setStrokeStyle({ width: 1, color, alpha: tickAlpha });
    const lo = Math.max(startBp + 1, path.isArcMode ? startBp : (path.viewStartBp ?? startBp));
    const hi = Math.min(endBp - 1, path.isArcMode ? endBp : (path.viewEndBp ?? endBp));
    for (let bp = Math.ceil(lo / pitch) * pitch; bp <= hi; bp += pitch) {
      const p = path.featureLabelPosAt(bp, offsetPx);
      const tip = direction * TRANSCRIPT_INTRON_STYLE.tickHalfWidth;
      const half = TRANSCRIPT_INTRON_STYLE.tickHalfHeight;
      const project = (dx: number, dy: number) => ({
        x: p.x + Math.cos(p.angle) * dx - Math.sin(p.angle) * dy,
        y: p.y + Math.sin(p.angle) * dx + Math.cos(p.angle) * dy,
      });
      const a = project(-tip, -half),
        b = project(tip, 0),
        c = project(-tip, half);
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.lineTo(c.x, c.y);
    }
    g.stroke();
    g.setStrokeStyle({ width: 1, color, alpha: INTRON_LINE_ALPHA * opacity });
    return points;
  }

  private acquireLetter(): Text {
    let t: Text;
    if (this.letterIndex < this.letterPool.length) {
      t = this.letterPool[this.letterIndex];
      t.visible = true;
    } else {
      t = new Text({ text: '', style: this.letterStyleDark });
      this.container.addChild(t);
      this.letterPool.push(t);
    }
    this.letterIndex++;
    return t;
  }

  destroy(): void {
    this.graphics.destroy();
    for (const t of this.letterPool) destroyPixiText(t);
    for (const t of this.residueLabelPool) destroyPixiText(t);
  }
}
