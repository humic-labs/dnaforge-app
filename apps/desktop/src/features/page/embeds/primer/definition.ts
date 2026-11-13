import { embedRegistry } from '../registry';
import { referenceIconFor } from '../../entity-ref/reference-icon';
import { platform } from '../../../../platform';
import { resolveReferenceContentHash } from '../../entity-ref/resolve-content-hash';
import { PrimerPicker } from './Picker';
import type { SlashCommandDefinition } from '../types';

export const primerCommand: SlashCommandDefinition = {
  type: 'primer',
  version: 1,
  label: 'Primer',
  icon: referenceIconFor('primer'),
  keywords: ['primer', 'oligo', 'oligonucleotide'],

  picker: {
    stages: [
      {
        name: 'Select Primer',
        component: PrimerPicker,
      },
    ],
    size: 'md',
    onComplete: (data) => {
      if (!data.primerId || typeof data.primerId !== 'string') {
        throw new Error('Invalid picker data: missing or invalid primerId');
      }
      if (!data.primerName || typeof data.primerName !== 'string') {
        throw new Error('Invalid picker data: missing or invalid primerName');
      }
      const path = typeof data.path === 'string' ? data.path : null;

      if (!path) {
        return {
          nodeType: 'mention' as const,
          entityType: 'primer',
          entityId: data.primerId as string,
          label: data.primerName as string,
          path: null,
          contentHash: null,
        };
      }

      return resolveReferenceContentHash({
        catalogHash: null,
        workspaceRoot: typeof data.owningRoot === 'string' ? data.owningRoot : null,
        workspaceRelativePath: path,
        contentHash: (input) => platform().fs.contentHash(input),
      }).then((contentHash) => ({
        nodeType: 'mention' as const,
        entityType: 'primer',
        entityId: data.primerId as string,
        label: data.primerName as string,
        path,
        contentHash,
      }));
    },
  },
};

embedRegistry.register(primerCommand);
