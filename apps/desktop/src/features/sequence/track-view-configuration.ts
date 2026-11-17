import type { TrackViewDocument } from '../../shared/track-view';
import type {
  IndexedGenomeBamTrackState,
  IndexedGenomeDataTrackState,
} from '../../shared/indexed-genome';
import { bbiAdmissionContentIdentity } from './bbi-admission-content-identity';

export type TrackViewConfiguration = Pick<
  TrackViewDocument,
  | 'reference'
  | 'contactProjection'
  | 'comparisonProjection'
  | 'viewport'
  | 'scope'
  | 'annotation'
  | 'variantSource'
  | 'signalReadPileupViews'
  | 'primerBindings'
  | 'userAnnotations'
> & {
  dataTracks: ReadonlyArray<IndexedGenomeDataTrackState>;
  bamTracks: ReadonlyArray<IndexedGenomeBamTrackState>;
};

export function trackViewMatchesSavedConfiguration(
  current: TrackViewConfiguration,
  saved: TrackViewConfiguration
): boolean {
  const comparable =
    saved.reference.sequenceIdentity !== undefined
      ? current
      : { ...current, reference: { ...current.reference, sequenceIdentity: undefined } };
  return trackViewConfigurationKey(comparable) === trackViewConfigurationKey(saved);
}

export function trackViewConfigurationKey(view: TrackViewConfiguration): string {
  const {
    reference,
    viewport,
    scope,
    annotation,
    dataTracks,
    bamTracks,
    signalReadPileupViews,
    variantSource,
  } = view;
  const primerBindings = view.primerBindings?.length ? view.primerBindings : undefined;
  const userAnnotations = view.userAnnotations?.length ? view.userAnnotations : undefined;
  return JSON.stringify(
    {
      reference: {
        assemblyId: reference.assemblyId,
        chromosomes: reference.chromosomes,
        sequenceIdentity: reference.sequenceIdentity,
      },
      viewport,
      contactProjection: view.contactProjection,
      comparisonProjection: view.comparisonProjection,
      scope,
      annotation,
      dataTracks: dataTracks.map((track) => ({
        ...track,
        source: { ...track.source, fingerprint: bbiAdmissionContentIdentity(track.source) },
      })),
      bamTracks,
      signalReadPileupViews: signalReadPileupViews ?? [],
      variantSource,
      primerBindings,
      userAnnotations,
    },
    (_key, value: unknown) => {
      if (_key === 'admittedAt' || _key === 'checkedAt') return undefined;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
      }
      return value;
    }
  );
}
