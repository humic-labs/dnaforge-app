import { platform } from '../../platform';
import { useCanvasStore } from '../../features/canvas/public/store';
import { assertComparisonProjectionReference } from '../../features/sequence/comparison-projection-binding';
import { NATIVE_COMPARISON_FIXTURE } from './native-comparison-fixture';
import { materializeNativeProjectionSource } from './native-projection-source-fixture';
import { comparisonSourceProjectionId } from '../../shared/comparison-source';

export async function applyNativeComparisonProjection(tabId: string): Promise<void> {
  const materialized = await materializeNativeProjectionSource({
    projectName: 'Aligned genome comparison',
    relativePath: NATIVE_COMPARISON_FIXTURE.path,
    sha256: NATIVE_COMPARISON_FIXTURE.sha256,
  });
  const bridge = platform();
  const checkout = await bridge.path.projectRoot();
  if (!checkout) throw new Error('The comparison example requires its development checkout.');
  const imported = await bridge.referenceAssets.importLocal({
    operationId: crypto.randomUUID(),
    themeMode: 'light',
    sourcePath: `${checkout}/test-fixtures/genome-view-prototypes/native-references/NC_004741.1`,
  });
  if (imported.status !== 'ready')
    throw new Error('The comparison query source could not be admitted.');
  const deadline = Date.now() + 120_000;
  while (true) {
    const status = await bridge.referenceAssets.getLocalPreparationStatus({
      assemblyId: imported.entry.id,
    });
    if (status?.status === 'ready') break;
    if (status?.status === 'failed') throw new Error(status.label);
    if (Date.now() > deadline) throw new Error('The comparison query source is still preparing.');
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const query = (await bridge.referenceAssets.listLocal()).find(
    (entry) => entry.id === imported.entry.id
  );
  if (
    !query?.referenceIdentity ||
    !query.members.some(
      (member) =>
        member.chrom === NATIVE_COMPARISON_FIXTURE.queryReference.chrom &&
        member.lengthBp === NATIVE_COMPARISON_FIXTURE.queryReference.length
    )
  )
    throw new Error('The comparison query must match its exact prepared source.');
  const panel = Object.entries(useCanvasStore.getState().panels).find(([, value]) =>
    value.tabs.some((tab) => tab.id === tabId)
  );
  const current = panel?.[1].tabs.find((tab) => tab.id === tabId)?.indexedGenome;
  if (!panel || !current?.assembly || !current.assemblyReferenceIdentity)
    throw new Error('The comparison reference was closed before attachment.');
  const source = {
    ...NATIVE_COMPARISON_FIXTURE,
    path: materialized.path,
    targetSource: {
      referenceId: current.assembly.assemblyId,
      ...current.assemblyReferenceIdentity,
    },
    querySource: { referenceId: query.id, ...query.referenceIdentity },
  };
  const loaded = await bridge.comparisonSources.read({ project: materialized.project, source });
  assertComparisonProjectionReference(source, current.assembly.chromosomes);
  useCanvasStore.getState().updateTab(panel[0], tabId, {
    label: loaded.label,
    indexedGenome: {
      ...current,
      contactProjection: undefined,
      comparisonProjection: {
        kind: 'aligned-genomes',
        project: materialized.project,
        source,
        camera: {
          projectionId: comparisonSourceProjectionId(source),
          startColumn: 15_980,
          endColumn: 16_100,
        },
      },
    },
  });
}
