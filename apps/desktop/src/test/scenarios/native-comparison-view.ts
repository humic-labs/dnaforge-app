import { platform } from '../../platform';
import { useCanvasStore } from '../../features/canvas/public/store';
import { assertComparisonProjectionReference } from '../../features/sequence/comparison-projection-binding';
import { NATIVE_COMPARISON_FIXTURE } from './native-comparison-fixture';
import { materializeNativeProjectionSource } from './native-projection-source-fixture';

export async function applyNativeComparisonProjection(tabId: string): Promise<void> {
  const materialized = await materializeNativeProjectionSource({
    projectName: 'Aligned genome comparison',
    relativePath: NATIVE_COMPARISON_FIXTURE.path,
    sha256: NATIVE_COMPARISON_FIXTURE.sha256,
  });
  const source = { ...NATIVE_COMPARISON_FIXTURE, path: materialized.path };
  const loaded = await platform().comparisonSources.read({ project: materialized.project, source });
  const panel = Object.entries(useCanvasStore.getState().panels).find(([, value]) =>
    value.tabs.some((tab) => tab.id === tabId)
  );
  const current = panel?.[1].tabs.find((tab) => tab.id === tabId)?.indexedGenome;
  if (!panel || !current?.assembly)
    throw new Error('The comparison reference was closed before attachment.');
  assertComparisonProjectionReference(source, current.assembly.chromosomes);
  useCanvasStore.getState().updateTab(panel[0], tabId, {
    label: loaded.label,
    indexedGenome: {
      ...current,
      contactProjection: undefined,
      comparisonProjection: { kind: 'aligned-genomes', project: materialized.project, source },
    },
  });
}
