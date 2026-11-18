import { directTrackAdmissionRequest } from '@waypoint/genome-data';
import { ANNOTATION_COLOR_PALETTES } from '@waypoint/sequence-utils';
import { platform } from '../../platform';
import { useCanvasStore } from '../../features/canvas/public/store';
import {
  assemblyIdFromIndexedGenome,
  assemblyReferencesFromIndexedGenome,
} from '../../features/sequence/public/attach-indexed-bigwig';
import { importGenomeSources } from '../../features/sequence/public/import-genome-sources';
import { useLaneContractStore } from '../../features/sequence/public/lane-contract-store';
import manifest from '../../../../../test-fixtures/genome-view-prototypes/native-tracks/precise1k.json';

export async function applyNativeExpressionTracks(tabId: string): Promise<void> {
  const found = Object.entries(useCanvasStore.getState().panels).flatMap(([panelId, panel]) =>
    panel.tabs.filter((tab) => tab.id === tabId).map((tab) => ({ panelId, tab }))
  )[0];
  const genome = found?.tab.indexedGenome;
  if (!found || !genome) throw new Error('The expression example requires its indexed reference.');
  const references = assemblyReferencesFromIndexedGenome(genome);
  if (
    !references.some(
      (reference) => reference.name === 'NC_000913.3' && reference.length === 4_641_652
    )
  )
    throw new Error('The expression example requires the exact NC_000913.3 reference.');
  const assemblyId = assemblyIdFromIndexedGenome(genome);
  const requests = [];
  for (const track of manifest.tracks) {
    const source = await platform().internalFixtures.retainTrack({
      relativePath: `test-fixtures/genome-view-prototypes/native-tracks/${track.file}`,
    });
    requests.push(
      directTrackAdmissionRequest({
        assemblyId,
        input: { kind: 'path', path: source.path },
        formatId: 'bigwig',
        scientificKind: 'quantitative',
        label: `${track.displayLabel} · ${track.sample.id}`,
        ingress: 'session',
        sessionId: 'native-expression-tracks',
      })
    );
  }
  const results = await importGenomeSources({
    laneOwnerId: tabId,
    assemblyId,
    assemblyDisplayName: genome.assembly?.displayName ?? 'NC_000913.3',
    assemblyReferences: references,
    requests,
  });
  const failed = results.filter((result) => result.status === 'failed');
  if (failed.length) throw new Error(failed.map((result) => result.message).join('\n'));
  const lanes = useLaneContractStore.getState();
  const colors = ANNOTATION_COLOR_PALETTES[0].colors;
  for (const [index, result] of results.entries()) {
    if (result.status === 'failed') continue;
    const updated = lanes.updateLanePresentation(tabId, result.trackId, {
      color: Number.parseInt(colors[index % colors.length].slice(1), 16),
      heightPx: 64,
      quantitative: {
        version: 1,
        graph: 'bar',
        showRange: true,
        smoothingSigmaBins: 0,
        scale: { mode: 'fixed', transform: 'linear', min: 0, max: 16 },
      },
    });
    if (updated.status !== 'updated') throw new Error(updated.message);
    lanes.setLaneVisible(tabId, result.trackId, index < 4);
  }
  const current = useCanvasStore
    .getState()
    .panels[found.panelId]?.tabs.find((tab) => tab.id === tabId);
  if (!current?.indexedGenome) throw new Error('The expression view closed during source import.');
  useCanvasStore.getState().updateTab(found.panelId, tabId, {
    label: 'PRECISE-1K · native expression tracks',
    indexedGenome: {
      ...current.indexedGenome,
      scope: { kind: 'locus', chrom: 'NC_000913.3', start: 1_067_000, end: 1_084_000 },
    },
    viewState: {
      ...current.viewState,
      indexedViewport: { start0: 1_067_000, end0: 1_084_000 },
      indexedViewportCommand: {
        id: Date.now(),
        chrom: 'NC_000913.3',
        start0: 1_067_000,
        end0: 1_084_000,
      },
    },
  });
}
