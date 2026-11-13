import { TRANSCRIPT_INTRON_STYLE } from '@waypoint/platform';

import type { WebGLThemeMode } from '../shared/theme';
import { writePackedBpCoordinate } from './bp-coordinate-packing';
import {
  isNonCodingTranscriptType,
  rnaAccentColorForMode,
  transcriptColorForMode,
} from '../../../feature-colors';

export { TRANSCRIPT_COLORS } from '../../../feature-colors';
import {
  rnaAccentRoleKeyV1,
  type AnnotationColorRoleKeyV1,
} from '../../../annotation-role-palette';

export interface TranscriptGlyphFeature {
  type: string;
  annotationTrackId?: string;
  direction?: 'forward' | 'reverse' | 'none' | string;
  exons?: ReadonlyArray<{ start: number; end: number }>;
  cds?: ReadonlyArray<{ start: number; end: number }>;
  outlineOnly?: boolean;
  qualifiers?: { source?: string; status?: string } | Record<string, unknown>;
}

export interface TranscriptGlyphContext {
  getFeatureId?: (feature: TranscriptGlyphFeature) => number | undefined;

  getOffset: (feature: TranscriptGlyphFeature) => number | null;

  halfHeight: number;
  themeMode: WebGLThemeMode | undefined;

  cdsDetail: number;
}

export interface DirectionalBlock {
  featureId?: number;
  startBp: number;
  endBp: number;

  offsetCenter: number;
  halfH: number;
  color: number;

  role: AnnotationColorRoleKeyV1;
  alpha: number;

  cdsFade: number;

  dirSign: 0 | 1 | -1;
}

function isOutlineOnly(f: TranscriptGlyphFeature): boolean {
  if (f.outlineOnly === true) return true;
  const q = (f.qualifiers ?? {}) as { source?: string; status?: string };
  return q.source === 'pLannotate-draft' && q.status !== 'accepted';
}

function splitExon(
  exStart: number,
  exEnd: number,
  cdsSegments: ReadonlyArray<{ start: number; end: number }>,
  drawCdsBlocks: boolean
): Array<{ s: number; e: number; cds: boolean }> {
  if (!drawCdsBlocks) return [{ s: exStart, e: exEnd, cds: false }];
  const clipped = cdsSegments
    .map((c) => ({ s: Math.max(exStart, c.start - 1), e: Math.min(exEnd, c.end) }))
    .filter((c) => c.e > c.s)
    .sort((a, b) => a.s - b.s);
  if (clipped.length === 0) return [{ s: exStart, e: exEnd, cds: false }];
  const parts: Array<{ s: number; e: number; cds: boolean }> = [];
  let cursor = exStart;
  for (const c of clipped) {
    if (c.s > cursor) parts.push({ s: cursor, e: c.s, cds: false });
    parts.push({ s: c.s, e: c.e, cds: true });
    cursor = c.e;
  }
  if (cursor < exEnd) parts.push({ s: cursor, e: exEnd, cds: false });
  return parts;
}

export function buildTranscriptGlyphBlocks(
  features: ReadonlyArray<TranscriptGlyphFeature>,
  ctx: TranscriptGlyphContext
): DirectionalBlock[] {
  const halfHeight = ctx.halfHeight;
  const intronHalfH = Math.max(0.5, halfHeight * TRANSCRIPT_INTRON_STYLE.heightRatio);
  const cdsHalfH = halfHeight;
  const utrHalfH = Math.max(2, halfHeight * TRANSCRIPT_INTRON_STYLE.utrHeightRatio);
  const blocks: DirectionalBlock[] = [];

  for (const feature of features) {
    if (isOutlineOnly(feature)) continue;
    const exons = feature.exons ?? [];
    if (exons.length === 0) continue;
    const offset = ctx.getOffset(feature);

    if (offset == null) continue;
    const featureId = ctx.getFeatureId?.(feature);
    const cdsSegments = feature.cds ?? [];
    const transcriptType = feature.annotationTrackId ?? feature.type;
    const isNonCodingType = isNonCodingTranscriptType(transcriptType);
    const hasCdsData = cdsSegments.length > 0;
    const drawCdsBlocks = !isNonCodingType && hasCdsData;
    const utrColor = isNonCodingType
      ? rnaAccentColorForMode(transcriptType, ctx.themeMode)
      : transcriptColorForMode('utr', ctx.themeMode);
    const cdsColor = transcriptColorForMode('cdsThick', ctx.themeMode);
    const utrRole: AnnotationColorRoleKeyV1 = isNonCodingType
      ? rnaAccentRoleKeyV1(transcriptType)
      : 'transcript:utr';
    const dir = feature.direction;
    const drawArrow = dir === 'forward' || dir === 'reverse';
    const arrowSign: 0 | 1 | -1 = dir === 'forward' ? 1 : dir === 'reverse' ? -1 : 0;

    const alpha = 0.85;

    if (exons.length > 1) {
      for (let i = 0; i < exons.length - 1; i++) {
        const intronStart = exons[i].end;
        const intronEnd = exons[i + 1].start - 1;
        if (intronEnd <= intronStart) continue;
        blocks.push({
          ...(featureId === undefined ? {} : { featureId }),
          startBp: intronStart,
          endBp: intronEnd,
          offsetCenter: offset,
          halfH: intronHalfH,
          color: transcriptColorForMode('intron', ctx.themeMode),
          role: 'transcript:intron',
          alpha: alpha * 0.7,
          cdsFade: 0,
          dirSign: 0,
        });
      }
    }

    for (let i = 0; i < exons.length; i++) {
      const exStart = exons[i].start - 1;
      const exEnd = exons[i].end;
      if (exEnd <= exStart) continue;
      const parts = splitExon(exStart, exEnd, cdsSegments, drawCdsBlocks);
      const arrowPartIdx = dir === 'reverse' ? 0 : parts.length - 1;
      for (let p = 0; p < parts.length; p++) {
        const part = parts[p];
        const isCds = part.cds;
        const halfH = isCds ? cdsHalfH : utrHalfH;
        const fill = isCds ? cdsColor : utrColor;
        const pointed = drawArrow && p === arrowPartIdx;
        blocks.push({
          ...(featureId === undefined ? {} : { featureId }),
          startBp: part.s,
          endBp: part.e,
          offsetCenter: offset,
          halfH,
          color: fill,
          role: isCds ? 'transcript:cdsThick' : utrRole,
          alpha,
          cdsFade: isCds ? 0.85 : 0,
          dirSign: pointed ? arrowSign : 0,
        });
      }
    }
  }
  return blocks;
}

export type TranscriptGlyphVertices = {
  bpStartChunk: Float32Array;

  bpStartDelta: Float32Array;

  bpEndChunk: Float32Array;

  bpEndDelta: Float32Array;

  offsetCenter: Float32Array;

  halfH: Float32Array;

  dirSign: Float32Array;

  cdsFade: Float32Array;

  corner: Float32Array;

  color: Float32Array;
};

const FAN_CORNERS = [0, 1, 2, 0, 2, 3, 0, 3, 4];

const RECT_CORNERS = [0, 1, 3, 0, 3, 4];

export function packTranscriptGlyphVertices(
  blocks: ReadonlyArray<Omit<DirectionalBlock, 'role'>>
): TranscriptGlyphVertices {
  const vn = blocks.reduce((sum, block) => sum + (block.dirSign === 0 ? 6 : 9), 0);
  const bpStartChunk = new Float32Array(vn);
  const bpStartDelta = new Float32Array(vn);
  const bpEndChunk = new Float32Array(vn);
  const bpEndDelta = new Float32Array(vn);
  const offsetCenter = new Float32Array(vn);
  const halfH = new Float32Array(vn);
  const dirSign = new Float32Array(vn);
  const cdsFade = new Float32Array(vn);
  const corner = new Float32Array(vn);
  const color = new Float32Array(vn * 4);
  let v = 0;
  for (const blk of blocks) {
    const r = ((blk.color >> 16) & 0xff) / 255;
    const g = ((blk.color >> 8) & 0xff) / 255;
    const b = (blk.color & 0xff) / 255;
    const corners = blk.dirSign === 0 ? RECT_CORNERS : FAN_CORNERS;
    for (let k = 0; k < corners.length; k++) {
      writePackedBpCoordinate(blk.startBp, bpStartChunk, bpStartDelta, v);
      writePackedBpCoordinate(blk.endBp, bpEndChunk, bpEndDelta, v);
      offsetCenter[v] = blk.offsetCenter;
      halfH[v] = blk.halfH;
      dirSign[v] = blk.dirSign;
      cdsFade[v] = blk.cdsFade;
      corner[v] = corners[k];
      const ci = v * 4;
      color[ci] = r;
      color[ci + 1] = g;
      color[ci + 2] = b;
      color[ci + 3] = blk.alpha;
      v++;
    }
  }
  return {
    bpStartChunk,
    bpStartDelta,
    bpEndChunk,
    bpEndDelta,
    offsetCenter,
    halfH,
    dirSign,
    cdsFade,
    corner,
    color,
  };
}
