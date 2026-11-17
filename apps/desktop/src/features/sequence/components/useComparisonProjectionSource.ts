import { useEffect, useState } from 'react';
import {
  createComparisonProjection,
  resolveComparisonCamera,
  type ComparisonProjection,
} from '@waypoint/genome-renderer/pure';
import { platform } from '../../../platform';
import {
  comparisonProjectionViewStateSchema,
  type ComparisonProjectionViewState,
  type ComparisonSourceReadResult,
  type ComparisonSourceWindowResult,
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
      sourceWindow?: ComparisonSourceWindowResult;
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
  const [windowResource, setWindowResource] = useState<
    | { status: 'loading'; key: string }
    | {
        status: 'ready';
        key: string;
        value: ComparisonSourceWindowResult;
        projection: ComparisonProjection;
      }
    | { status: 'error'; key: string; message: string }
    | null
  >(null);
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
  const current = 'key' in resource && resource.key === sourceKey ? resource : null;
  const windowView =
    view && (view.source.targetSource || view.source.querySource) && current?.status === 'ready'
      ? {
          project: view.project,
          source: view.source,
          camera: resolveComparisonCamera(current.projection, view.camera),
        }
      : null;
  const windowKey = windowView ? JSON.stringify(windowView) : '';
  useEffect(() => {
    if (!windowView || current?.status !== 'ready') {
      setWindowResource(null);
      return;
    }
    let cancelled = false;
    setWindowResource({ status: 'loading', key: windowKey });
    const loadWindow = async () => {
      try {
        const value = await platform().comparisonSources.readWindow(windowView);
        if (
          value.projectionId !== current.projection.id ||
          JSON.stringify(value.camera) !== JSON.stringify(windowView.camera)
        )
          throw new Error('The comparison source window belongs to another camera or source.');
        const projection: ComparisonProjection = {
          ...current.projection,
          targetSequenceWindows: value.targetSequenceWindows,
          querySequenceWindows: value.querySequenceWindows,
          annotations: value.annotations,
        };
        if (!cancelled) setWindowResource({ status: 'ready', key: windowKey, value, projection });
      } catch (error) {
        if (!cancelled)
          setWindowResource({
            status: 'error',
            key: windowKey,
            message: error instanceof Error ? error.message : String(error),
          });
      }
    };
    const timer = setTimeout(() => void loadWindow(), 80);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [windowKey]);
  if (!view) return { status: 'inactive' };
  if (!current) return { status: 'loading', key: sourceKey };
  if (current.status !== 'ready' || !windowView || windowResource?.key !== windowKey)
    return current;
  if (windowResource.status === 'error')
    return { status: 'error', key: sourceKey, message: windowResource.message };
  return windowResource.status === 'ready'
    ? { ...current, projection: windowResource.projection, sourceWindow: windowResource.value }
    : current;
}
