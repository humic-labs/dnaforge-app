import type { TrackAdmissionRequestV1 } from '@waypoint/genome-data';

import type { IndexedGenomeVariantSourceState } from '../../shared/indexed-genome';
import { useCanvasStore } from '../canvas/public/store';
import type { AlignmentReferenceIdentity } from './alignment-header-client';
import { admitTrackSource } from './track-admission';
import { durableVariantSource } from './variant-source-state';
import { variantTrackId } from './variant-track-lane';
import type { VariantTrackRuntime } from './variant-track-admission';

export type VariantSourceCommit = (
  source: IndexedGenomeVariantSourceState
) => 'added' | 'duplicate';

export interface AttachVariantRequestInput {
  readonly request: TrackAdmissionRequestV1;
  readonly assemblyId: string;
  readonly assemblyReferences: ReadonlyArray<AlignmentReferenceIdentity>;
  readonly signal?: AbortSignal;
  readonly commit: VariantSourceCommit;
  readonly admit?: typeof admitTrackSource;
}

export interface AttachVariantRequestResult {
  readonly status: 'added' | 'duplicate';
  readonly trackId: string;
  readonly label: string;
  readonly source: IndexedGenomeVariantSourceState;
  readonly runtime: VariantTrackRuntime;
}

export async function attachVariantRequest(
  input: AttachVariantRequestInput
): Promise<AttachVariantRequestResult> {
  const admit = input.admit ?? admitTrackSource;
  let admittedRuntime: VariantTrackRuntime | null = null;
  const admitted = await admit({
    request: input.request,
    assemblyId: input.assemblyId,
    assemblyReferences: input.assemblyReferences,
    signal: input.signal,
    onVariantRuntime: ({ runtime }) => {
      admittedRuntime = runtime;
    },
  });
  const runtime = admittedRuntime as VariantTrackRuntime | null;
  if (!runtime) throw new Error('Variant admission did not return a query runtime.');
  if (input.signal?.aborted) {
    throw new Error('Adding the variant source was cancelled before it was attached.');
  }
  const source = durableVariantSource(admitted, runtime);
  const status = input.commit(source);
  return { status, trackId: variantTrackId(source), label: source.label, source, runtime };
}

export function commitVariantSourceToTab(tabId: string): VariantSourceCommit {
  return (source) => {
    for (const [panelId, panel] of Object.entries(useCanvasStore.getState().panels)) {
      const tab = panel.tabs.find((candidate) => candidate.id === tabId);
      if (!tab) continue;
      if (!tab.indexedGenome) {
        throw new Error('The target tab is not an indexed genome view.');
      }
      if (tab.indexedGenome.variantSource?.sourceIdentity === source.sourceIdentity) {
        return 'duplicate';
      }
      useCanvasStore.getState().updateTab(panelId, tabId, {
        indexedGenome: { ...tab.indexedGenome, variantSource: source },
        isDirty: true,
      });
      return 'added';
    }
    throw new Error('The target tab is no longer open.');
  };
}
