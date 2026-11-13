import {
  DEFAULT_QUANTITATIVE_TRACK_PRESENTATION,
  type AdmittedTrackSource,
  type ScientificTrackKind,
} from '@waypoint/genome-data';
import {
  GENERIC_INTERVAL_TYPE,
  IMPORTED_TRANSCRIPT_TYPE,
  PEAK_TYPE,
  QUANTITATIVE_TYPE,
  REPEAT_TYPE,
  type TrackTypeDefinition,
} from '@waypoint/genome-renderer';

import type { ActiveStressDataset } from './lane-contract-store';

export const ADMITTED_TRACK_LANE_COLOR = 0x3b82f6;

export type RenderableAdmittedScientificKind = Extract<
  ScientificTrackKind,
  'transcript' | 'interval' | 'quantitative' | 'peak' | 'repeat'
>;

export function datasetForAdmittedTrack(input: {
  readonly trackId: string;
  readonly label: string;
  readonly source: AdmittedTrackSource;
}): ActiveStressDataset {
  const scientificKind = requireRenderableScientificKind(input.source.scientificKind);
  const definition = definitionForScientificKind(scientificKind);
  const fallbackHeight =
    scientificKind === 'quantitative' ? 96 : scientificKind === 'peak' ? 72 : 160;
  const trackPx = defaultTrackHeight(definition, fallbackHeight);

  return {
    trackType: definition.type,
    trackId: input.trackId,
    label: input.label,
    color: ADMITTED_TRACK_LANE_COLOR,
    laneHeightPx: 8,
    maxLanes: 32,
    trackPx,
    records: [],
    kind: 'annotation',
    ...(scientificKind === 'quantitative'
      ? {
          quantitativePresentation: quantitativePresentationFor(input.source),
          ...(input.source.quantitativeSummary
            ? { quantitativeSourceSummary: input.source.quantitativeSummary }
            : {}),
        }
      : {}),
  };
}

export function trackTypeForAdmittedScientificKind(
  scientificKind: RenderableAdmittedScientificKind
): string {
  return definitionForScientificKind(scientificKind).type;
}

export function trackHeightForAdmittedScientificKind(
  scientificKind: RenderableAdmittedScientificKind
): number {
  const fallbackHeight =
    scientificKind === 'quantitative' ? 96 : scientificKind === 'peak' ? 72 : 160;
  return defaultTrackHeight(definitionForScientificKind(scientificKind), fallbackHeight);
}

export function requireRenderableScientificKind(
  scientificKind: ScientificTrackKind
): RenderableAdmittedScientificKind {
  switch (scientificKind) {
    case 'transcript':
    case 'interval':
    case 'quantitative':
    case 'peak':
    case 'repeat':
      return scientificKind;
    default:
      throw new Error(`Scientific kind ${scientificKind} has no lane attachment adapter.`);
  }
}

function definitionForScientificKind(
  scientificKind: RenderableAdmittedScientificKind
): TrackTypeDefinition {
  switch (scientificKind) {
    case 'transcript':
      return IMPORTED_TRANSCRIPT_TYPE;
    case 'interval':
      return GENERIC_INTERVAL_TYPE;
    case 'quantitative':
      return QUANTITATIVE_TYPE;
    case 'peak':
      return PEAK_TYPE;
    case 'repeat':
      return REPEAT_TYPE;
  }
}

function quantitativePresentationFor(source: AdmittedTrackSource) {
  const published = source.publishedSignalScale;
  if (!published) return DEFAULT_QUANTITATIVE_TRACK_PRESENTATION;
  return {
    ...DEFAULT_QUANTITATIVE_TRACK_PRESENTATION,
    scale: {
      ...DEFAULT_QUANTITATIVE_TRACK_PRESENTATION.scale,
      mode: 'fixed' as const,
      min: published.minimum,
      max: published.maximum,
    },
  };
}

function defaultTrackHeight(definition: TrackTypeDefinition, fallback: number): number {
  const sizing = definition.defaultSizing;
  if (sizing.kind === 'fixed') return sizing.pixels;
  return Math.min(sizing.maxHeight ?? fallback, Math.max(sizing.minHeight ?? 0, fallback));
}
