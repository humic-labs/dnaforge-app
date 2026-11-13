import { embedRegistry } from '../registry';
import type { SlashCommandDefinition } from '../types';
import { ProteinPromptHistoryRenderer } from './Renderer';

export const proteinPromptHistoryEmbed: SlashCommandDefinition = {
  type: 'protein-prompt-history',
  version: 1,
  label: 'Protein prompt trials',
  icon: '🧬',
  keywords: [],
  importOnly: true,
  Renderer: ProteinPromptHistoryRenderer,
  picker: {
    stages: [],
    onComplete: () => {
      throw new Error('Open the protein trial notebook from the development prompt controls.');
    },
  },
};

embedRegistry.register(proteinPromptHistoryEmbed);
