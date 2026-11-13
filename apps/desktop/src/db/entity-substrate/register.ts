import { registerTrackViewAdapter } from './track-view-adapter';
import { registerMolecularDocumentAdapter } from './molecular-document-adapter';
import { getEntityAdapterForKind } from './adapter';
import { registerNotebookEntityAdapter } from './notebook-adapter';
import { registerLimsEntityArtifactAdapter } from './lims-entity-adapter';
import { registerSequencePackageEntityAdapter } from './sequence-package-adapter';

export const REQUIRED_ENTITY_KINDS = [
  'notebook',
  'lims-entity',
  'sequence',
  'track-view',
  'molecular-document',
] as const;

let registered = false;
export function registerAllEntityAdapters(): void {
  if (registered) return;
  registered = true;
  registerNotebookEntityAdapter();
  registerLimsEntityArtifactAdapter();
  registerSequencePackageEntityAdapter();
  registerTrackViewAdapter();
  registerMolecularDocumentAdapter();
}

export function assertRequiredEntityAdaptersRegistered(): void {
  const missing = REQUIRED_ENTITY_KINDS.filter((kind) => !getEntityAdapterForKind(kind));
  if (missing.length > 0) {
    throw new Error(`[entity-substrate] required adapter(s) not registered: ${missing.join(', ')}`);
  }
}
