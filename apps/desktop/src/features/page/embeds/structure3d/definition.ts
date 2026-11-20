import { embedRegistry } from '../registry';
import { Structure3dRenderer } from './Renderer';
import type { SlashCommandDefinition } from '../types';
import { iconForEntityKind } from '../../../../components/icons/entity-icon-registry';

export const structure3dEmbed: SlashCommandDefinition = {
  type: 'structure3d',
  version: 1,
  label: '3D Structure',
  icon: iconForEntityKind('structure3d'),
  keywords: ['3d', 'structure', 'pdb', 'protein', 'molstar', 'alphafold'],

  capturesEditorFocus: true,

  Renderer: Structure3dRenderer,

  picker: {
    stages: [],
    onComplete: () => {
      return {
        nodeType: 'embed',
        embedType: 'structure3d',
        refId: `structure3d-${Date.now()}`,
        data: {},
      };
    },
  },
};

embedRegistry.register(structure3dEmbed);
