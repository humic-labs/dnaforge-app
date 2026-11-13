import { embedRegistry } from '../registry';
import { ImageRenderer } from './Renderer';
import type { SlashCommandDefinition } from '../types';

export const imageEmbed: SlashCommandDefinition = {
  type: 'image',
  version: 1,
  label: 'Image',
  icon: '🖼',
  keywords: ['image', 'picture', 'photo', 'gel', 'figure'],

  Renderer: ImageRenderer,

  picker: {
    stages: [],
    size: 'md',
    onComplete: () => ({
      nodeType: 'embed',
      embedType: 'image',
      refId: `img-${Date.now()}`,
      data: {},
    }),
  },
};

embedRegistry.register(imageEmbed);
