import {
  ANNOTATION_TRACK_LAYOUT_SCHEMA,
  DEFAULT_FILTER,
  DEFAULT_PRESENTATION,
  sourceId,
  trackBindingId,
  visualizationId,
  type AnnotationSourceCatalog,
  type AnnotationTrackBinding,
  type AnnotationTrackLayout,
  type AssemblyIdentity,
  type FeatureKind,
  type SourceId,
  type TrackBindingId,
} from '@waypoint/genome-data/annotation-catalog';

import {
  PREDICTED_OPERONS_SOURCE_ID,
  annotationCatalogForAccession,
  promoterWindowsSourceIdFor,
} from './annotation-catalog-registry';

const YAN2018_TSS = 'yan2018-tss';
const ETTWILLER2016_TSS = 'ettwiller2016-tss';
const YAN2018_UNIT_GENE_LISTS_MERGED = sourceId('yan2018-unit-gene-lists-merged');
const YAN2018_UNIT_GENE_LISTS = sourceId('yan2018-unit-gene-lists');
const YAN2018_UNITS = sourceId('yan2018-transcription-units');
const TERMITE_TERMINATORS = sourceId('termite-ecoli-terminators');
const ADAMS2021_INTRINSIC_TERMINATORS = sourceId('adams2021-intrinsic-terminators');
const TRANSTERMHP_TERMINATORS = sourceId('transtermhp-terminators');

interface SourceChoice {
  readonly id: SourceId;
  readonly name: string;
}

interface DefaultTrack {
  readonly id: string;
  readonly kind: FeatureKind;
  readonly sourcePreference: readonly [SourceChoice, ...SourceChoice[]];
  readonly visualization: string;
  readonly visible: boolean;
}

const MG1655_DEFAULT_TRACKS: readonly DefaultTrack[] = [
  {
    id: 'promoters',
    kind: 'promoter',
    sourcePreference: [
      { id: promoterWindowsSourceIdFor(YAN2018_TSS), name: 'Yan 2018 start sites' },
      { id: promoterWindowsSourceIdFor(ETTWILLER2016_TSS), name: 'Ettwiller 2016 start sites' },
    ],
    visualization: 'promoter-arrow',
    visible: true,
  },
  {
    id: 'terminators',
    kind: 'terminator',
    sourcePreference: [
      { id: TERMITE_TERMINATORS, name: 'TERMITe' },
      { id: ADAMS2021_INTRINSIC_TERMINATORS, name: 'Adams 2021 intrinsic terminators' },
      { id: TRANSTERMHP_TERMINATORS, name: 'TransTermHP' },
    ],
    visualization: 'terminator-hairpin',
    visible: true,
  },
  {
    id: 'transcription-units',
    kind: 'transcription_unit',
    sourcePreference: [
      {
        id: YAN2018_UNIT_GENE_LISTS_MERGED,
        name: 'Yan 2018 unit gene lists, one per gene set',
      },
      { id: YAN2018_UNIT_GENE_LISTS, name: 'Yan 2018 unit gene lists' },
      { id: YAN2018_UNITS, name: 'Yan 2018 units with both ends measured' },
      { id: PREDICTED_OPERONS_SOURCE_ID, name: 'Predicted operons' },
    ],
    visualization: 'transcription-unit-arrows',
    visible: true,
  },
  {
    id: 'start-sites',
    kind: 'tss',
    sourcePreference: [
      { id: sourceId(YAN2018_TSS), name: 'Yan 2018 start sites' },
      { id: sourceId(ETTWILLER2016_TSS), name: 'Ettwiller 2016 start sites' },
    ],
    visualization: 'position-ticks',
    visible: false,
  },
];

export interface DefaultTrackFallback {
  readonly trackId: TrackBindingId;
  readonly preferredSourceId: SourceId;
  readonly preferredName: string;
  readonly usedSourceId: SourceId;
  readonly usedName: string;
  readonly reason: 'missing' | 'unavailable';
}

export interface DefaultLayoutPlan {
  readonly layout: AnnotationTrackLayout;
  readonly fallbacks: readonly DefaultTrackFallback[];
}

export function planDefaultLayout(catalog: {
  readonly assembly: AssemblyIdentity;
  readonly sources: Pick<AnnotationSourceCatalog, 'get'>;
}): DefaultLayoutPlan {
  const tracks: AnnotationTrackBinding[] = [];
  const fallbacks: DefaultTrackFallback[] = [];
  for (const track of MG1655_DEFAULT_TRACKS) {
    const usable = (choice: SourceChoice) =>
      catalog.sources.get(choice.id)?.availability.status === 'available';
    const chosen = track.sourcePreference.find(usable);
    if (!chosen) continue;
    const [preferred] = track.sourcePreference;
    const trackId = trackBindingId(track.id);
    if (chosen !== preferred) {
      fallbacks.push({
        trackId,
        preferredSourceId: preferred.id,
        preferredName: preferred.name,
        usedSourceId: chosen.id,
        usedName: chosen.name,
        reason: catalog.sources.get(preferred.id) ? 'unavailable' : 'missing',
      });
    }
    tracks.push({
      id: trackId,
      kind: track.kind,
      sourceId: chosen.id,
      visualizationId: visualizationId(track.visualization),
      visible: track.visible,
      label: null,
      presentation: DEFAULT_PRESENTATION,
      filter: DEFAULT_FILTER,
    });
  }
  return {
    layout: {
      schema: ANNOTATION_TRACK_LAYOUT_SCHEMA,
      assembly: catalog.assembly.accession,
      tracks,
    },
    fallbacks,
  };
}

function planFor(assembly: string): DefaultLayoutPlan | null {
  const catalog = annotationCatalogForAccession(assembly);
  return catalog ? planDefaultLayout(catalog) : null;
}

export function defaultLayoutFor(assembly: string): AnnotationTrackLayout | null {
  return planFor(assembly)?.layout ?? null;
}

export function defaultLayoutFallbacksFor(assembly: string): readonly DefaultTrackFallback[] {
  return planFor(assembly)?.fallbacks ?? [];
}

export function fallbackNotice(fallback: DefaultTrackFallback): string {
  const why = fallback.reason === 'missing' ? "isn't in this build" : "isn't available";
  return `Using ${fallback.usedName} because ${fallback.preferredName} ${why}.`;
}
