import { useEffect, useState } from 'react';
import {
  createComparisonProjection,
  type ComparisonProjection,
} from '@waypoint/genome-renderer/pure';
import { platform } from '../../../platform';
import {
  comparisonProjectionViewStateSchema,
  type ComparisonProjectionViewState,
  type ComparisonSourceReadResult,
} from '../../../shared/comparison-source';
import { assertComparisonProjectionReference } from '../comparison-projection-binding';

type ComparisonResource =
  | { status: 'inactive' }
  | { status: 'loading'; key: string }
  | {
      status: 'ready';
      key: string;
      value: ComparisonSourceReadResult;
      projection: ComparisonProjection;
    }
  | { status: 'error'; key: string; message: string };

export function useComparisonProjectionSource(
  view: ComparisonProjectionViewState | undefined,
  chromosomes: readonly { chrom: string; length: number }[]
): ComparisonResource {
  const sourceKey = view
    ? JSON.stringify({
        project: view.project,
        source: view.source,
        references: chromosomes.map(({ chrom, length }) => ({ chrom, length })),
      })
    : '';
  const [resource, setResource] = useState<ComparisonResource>({ status: 'inactive' });
  useEffect(() => {
    if (!view) {
      setResource({ status: 'inactive' });
      return;
    }
    let cancelled = false;
    setResource({ status: 'loading', key: sourceKey });
    void (async () => {
      try {
        const request = comparisonProjectionViewStateSchema.parse(view);
        assertComparisonProjectionReference(request.source, chromosomes);
        const value = await platform().comparisonSources.read({
          project: request.project,
          source: request.source,
        });
        const projection = createComparisonProjection({
          id: value.projectionId,
          comparison: value.comparison,
          targetLabel: request.source.targetReference.label ?? request.source.targetReference.id,
          queryLabel: request.source.queryReference.label ?? request.source.queryReference.id,
        });
        if (!cancelled) setResource({ status: 'ready', key: sourceKey, value, projection });
      } catch (error) {
        if (!cancelled)
          setResource({
            status: 'error',
            key: sourceKey,
            message: error instanceof Error ? error.message : String(error),
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceKey]);
  if (!view) return { status: 'inactive' };
  return 'key' in resource && resource.key === sourceKey
    ? resource
    : { status: 'loading', key: sourceKey };
}
