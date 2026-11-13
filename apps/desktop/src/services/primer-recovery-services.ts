import { platform } from '../platform';
import { setSetting } from '../db/settings';
import { withRendererWorkspaceMutation } from './workspace-mutation-transaction';
import { getLimsRegistryPreview } from '../features/lims/operations';
import { buildFileDnaSequenceRef } from '../features/lims/dna-sequence';
import { generateCatalogNumber } from '../features/primers/auto-numbering';
import { createPrimerRecoveryServices } from '../shared/primer-artifacts/primer-recovery-owner';
export const primerRecoveryServices = createPrimerRecoveryServices({
  io: platform,
  setSetting: (...args) => setSetting(...args),
  withRendererWorkspaceMutation: (...args) => withRendererWorkspaceMutation(...args),
  getLimsRegistryPreview: async (input) => {
    if (!input) throw new Error('A Registry preview requires an entity identity.');
    return getLimsRegistryPreview(input);
  },
  buildFileDnaSequenceRef: (...args) => buildFileDnaSequenceRef(...args),
  generateCatalogNumber: (...args) => generateCatalogNumber(...args),
});
