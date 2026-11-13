import { embedRegistry } from '../registry';
import type { SlashCommandDefinition } from '../types';
import { BenchlingReferenceRenderer } from './Renderer';

export const benchlingReferenceEmbed: SlashCommandDefinition = {
  type: 'benchling-reference',
  version: 1,
  label: 'Benchling reference',
  icon: '🔗',
  keywords: [],
  importOnly: true,

  Renderer: BenchlingReferenceRenderer,

  picker: {
    stages: [],
    size: 'md',
    onComplete: () => {
      throw new Error('A Benchling reference is created by import, not inserted by hand.');
    },
  },
};

embedRegistry.register(benchlingReferenceEmbed);
