import type { AnnotationTrackBinding, AnnotationTrackLayout } from './layout';
import type { CatalogRecord } from './records';
import type {
  AnnotationSourceCatalog,
  AnnotationSourceDefinition,
  SourceRecordCache,
} from './sources';
import type {
  AnnotationVisualizationCatalog,
  AnnotationVisualizationDefinition,
} from './visualizations';

export type ResolvedTrackState =
  | {
      readonly status: 'ready';
      readonly records: readonly CatalogRecord[];
      readonly totalBeforeFilter: number;
    }
  | { readonly status: 'error'; readonly message: string };

export interface ResolvedAnnotationTrack {
  readonly binding: AnnotationTrackBinding;
  readonly source: AnnotationSourceDefinition;
  readonly visualization: AnnotationVisualizationDefinition;
  readonly state: ResolvedTrackState;
}

export async function resolveAnnotationTracks(input: {
  readonly layout: AnnotationTrackLayout;
  readonly sources: AnnotationSourceCatalog;
  readonly visualizations: AnnotationVisualizationCatalog;
  readonly cache: SourceRecordCache;
}): Promise<readonly ResolvedAnnotationTrack[]> {
  const visible = input.layout.tracks.filter((track) => track.visible);
  const resolved = await Promise.all(
    visible.map(async (binding): Promise<ResolvedAnnotationTrack | null> => {
      const source = input.sources.get(binding.sourceId);
      const visualization = input.visualizations.get(binding.visualizationId);
      if (!source || !visualization) return null;
      try {
        const all = await input.cache.load(binding.sourceId);
        const ofKind = all.filter((record) => record.kind === binding.kind);
        const { minScore } = binding.filter;
        const records =
          minScore === null
            ? ofKind
            : ofKind.filter((record) => record.score === null || record.score >= minScore);
        return {
          binding,
          source,
          visualization,
          state: { status: 'ready', records, totalBeforeFilter: ofKind.length },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { binding, source, visualization, state: { status: 'error', message } };
      }
    })
  );
  return resolved.filter((track): track is ResolvedAnnotationTrack => track !== null);
}
