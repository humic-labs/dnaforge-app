import type { Feature } from '../../../types';

const FNV_PRIME = 0x01000193;
const FNV_OFFSET = 0x811c9dc5;
const FNV_SEED_B = 0x9e3779b9;

export function mixU32(h: number, v: number): number {
  return Math.imul(h ^ (v >>> 0), FNV_PRIME) >>> 0;
}

export function mixNum(h: number, n: number): number {
  const v = Number.isFinite(n) ? n : -1;
  const lo = v >>> 0;
  const hi = Math.floor(v / 0x1_0000_0000) >>> 0;
  return mixU32(mixU32(h, lo), hi);
}

export function mixStr(h: number, s: string): number {
  let acc = h;
  for (let i = 0; i < s.length; i += 1) acc = mixU32(acc, s.charCodeAt(i));
  return mixU32(acc, s.length);
}

const TOKEN_IDS = new Map<string, number>();

export function internToken(token: string): number {
  let id = TOKEN_IDS.get(token);
  if (id === undefined) {
    id = mixStr(FNV_OFFSET, token);
    TOKEN_IDS.set(token, id);
  }
  return id;
}

export function mixSpans(
  h: number,
  spans: ReadonlyArray<{ start: number; end: number }> | undefined
): number {
  if (!spans || spans.length === 0) return mixU32(h, 0);
  let acc = mixU32(h, spans.length);
  for (let i = 0; i < spans.length; i += 1) {
    acc = mixNum(mixNum(acc, spans[i].start), spans[i].end);
  }
  return acc;
}

export function fingerprintAnnotationFeatureSet(features: readonly Feature[]): string {
  let a = FNV_OFFSET;
  let b = FNV_SEED_B;
  for (let i = 0; i < features.length; i += 1) {
    const feature = features[i];
    const qualifiers = feature.qualifiers;
    a = mixNum(a, feature.id);
    b = mixU32(b, internToken(feature.type));
    a = mixNum(a, feature.start);
    b = mixNum(b, feature.end);
    a = mixU32(a, internToken(feature.direction));
    b = mixNum(b, feature.lane ?? -1);
    a = mixNum(a, feature.cdsLane ?? -1);
    b = mixU32(b, feature.outlineOnly === true ? 1 : 0);
    if (qualifiers !== undefined) {
      const source = qualifiers.source;
      const status = qualifiers.status;
      if (source !== undefined) a = mixU32(a, internToken(source));
      if (status !== undefined) b = mixU32(b, internToken(status));
    }
    a = mixSpans(a, feature.exons);
    b = mixSpans(b, feature.cds);
  }
  return `fnv:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}:${features.length}`;
}
