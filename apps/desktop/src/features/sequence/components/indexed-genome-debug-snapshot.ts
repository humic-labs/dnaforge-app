import type { Feature } from '@waypoint/genome-renderer';

export const DEBUG_FEATURE_LANE_SAMPLE_LIMIT = 128;

export interface RendererFeatureLaneSample {
  key: string;
  label: string;
  type: string;
  sourceId: string | null;
  transcriptId: string | null;
  lane: number;
  start: number;
  end: number;
  direction: string;
  hasExons: boolean;
  hasCds: boolean;
}

export interface DebugCdsLocus {
  start: number;
  end: number;
  spanBp: number;
  type: string;
  label: string;
  cdsFeatureCount: number;
  totalVisible: number;
}

export interface RendererFeatureStructureSnapshot {
  type: string;
  start: number;
  end: number;
  lane: number;
  displayName: string;
  transcriptId: string | null;
  qualifiers: Record<string, string | undefined>;
  cds: Array<{ start: number; end: number }>;
  exons: Array<{ start: number; end: number }>;
}

export function buildRendererFeatureLaneSamples(
  features: ReadonlyArray<Feature>,
  limit = DEBUG_FEATURE_LANE_SAMPLE_LIMIT
): RendererFeatureLaneSample[] {
  const boundedLimit = Math.max(0, Math.floor(limit));
  const samples: RendererFeatureLaneSample[] = [];
  for (let i = 0; i < features.length && i < boundedLimit; i += 1) {
    samples.push(rendererFeatureLaneSample(features[i]));
  }
  return samples;
}

export function findCdsLociFromRendererFeatures(
  features: ReadonlyArray<Feature>,
  max = 60
): DebugCdsLocus[] {
  const maxResults = Math.max(0, Math.floor(max));
  const cds: RendererFeatureLaneSample[] = [];
  for (const feature of features) {
    if ((feature.cds?.length ?? 0) === 0 || feature.end <= feature.start) continue;
    cds.push(rendererFeatureLaneSample(feature));
  }
  cds.sort((a, b) => a.end - a.start - (b.end - b.start) || a.start - b.start);
  return cds.slice(0, maxResults).map((feature) => ({
    start: feature.start,
    end: feature.end,
    spanBp: feature.end - feature.start,
    type: feature.type,
    label: feature.label,
    cdsFeatureCount: cds.length,
    totalVisible: features.length,
  }));
}

export function findFeatureStructuresFromRendererFeatures(
  features: ReadonlyArray<Feature>,
  query: string,
  max = 20
): RendererFeatureStructureSnapshot[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const boundedMax = Math.max(0, Math.floor(max));
  if (boundedMax === 0) return [];
  const matches: RendererFeatureStructureSnapshot[] = [];
  for (const feature of features) {
    const identity = [
      feature.qualifiers?.gene ?? '',
      feature.qualifiers?.ID ?? '',
      feature.displayName,
      feature.transcriptId ?? '',
    ]
      .join('|')
      .toLocaleLowerCase();
    if (!identity.includes(needle)) continue;
    matches.push({
      type: feature.type,
      start: feature.start,
      end: feature.end,
      lane: feature.lane,
      displayName: feature.displayName,
      transcriptId: feature.transcriptId ?? null,
      qualifiers: { ...(feature.qualifiers ?? {}) },
      cds: (feature.cds ?? []).map(({ start, end }) => ({ start, end })),
      exons: (feature.exons ?? []).map(({ start, end }) => ({ start, end })),
    });
    if (matches.length >= boundedMax) break;
  }
  return matches;
}

function rendererFeatureLaneSample(feature: Feature): RendererFeatureLaneSample {
  return {
    key: [
      feature.qualifiers?.ID ?? '',
      feature.transcriptId ?? '',
      feature.type,
      feature.displayName,
      feature.start,
      feature.end,
      feature.direction,
    ].join('|'),
    label: feature.displayName,
    type: feature.type,
    sourceId: feature.qualifiers?.ID ?? null,
    transcriptId: feature.transcriptId ?? null,
    lane: feature.lane,
    start: feature.start,
    end: feature.end,
    direction: feature.direction,
    hasExons: (feature.exons?.length ?? 0) > 0,
    hasCds: (feature.cds?.length ?? 0) > 0,
  };
}
