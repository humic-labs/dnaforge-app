import { entityPickerResult } from '../entity-picker-result';
import { createElement } from 'react';
import { embedRegistry } from '../registry';
import { SequencePicker } from './Picker';
import type { SlashCommandDefinition } from '../types';
import { BiologyFileIcon } from '../../../../components/icons';
import { platform } from '../../../../platform';
import { resolveReferenceContentHash } from '../../entity-ref/resolve-content-hash';

export const sequenceCommand: SlashCommandDefinition = {
  type: 'sequence',
  version: 1,
  label: 'Sequence',
  icon: createElement(BiologyFileIcon, { className: 'w-4 h-4' }),
  keywords: ['dna', 'rna', 'seq', 'plasmid', 'gene'],

  picker: {
    stages: [
      {
        name: 'Select Sequence',
        component: SequencePicker,
      },
    ],
    size: 'md',
    onComplete: (data) => {
      if (data.entity) return entityPickerResult(data.entity);
      if (!data.sequenceName || typeof data.sequenceName !== 'string') {
        throw new Error('Invalid picker data: missing or invalid sequenceName');
      }
      if (!data.path || typeof data.path !== 'string') {
        throw new Error('Invalid picker data: missing or invalid path');
      }
      const path = data.path;
      return resolveReferenceContentHash({
        catalogHash: typeof data.contentHash === 'string' ? data.contentHash : null,
        workspaceRoot: typeof data.owningRoot === 'string' ? data.owningRoot : null,
        workspaceRelativePath: path,
        contentHash: (input) => platform().fs.contentHash(input),
      }).then((contentHash) => ({
        nodeType: 'mention' as const,
        entityType: 'sequence',
        entityId: typeof data.entityId === 'string' ? data.entityId : null,
        label: data.sequenceName as string,
        path,
        contentHash,
        objectUuid: typeof data.objectUuid === 'string' ? data.objectUuid : null,
      }));
    },
  },
};

embedRegistry.register(sequenceCommand);
