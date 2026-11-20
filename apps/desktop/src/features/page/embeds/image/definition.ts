import { embedRegistry } from '../registry';
import { ImageRenderer } from './Renderer';
import type { SlashCommandDefinition } from '../types';
import { createElement } from 'react';
import { ImageFileIcon } from '../../../../components/icons/glyphs';

export const imageEmbed: SlashCommandDefinition = {
  type: 'image',
  version: 1,
  label: 'Image',
  icon: createElement(ImageFileIcon, { className: 'w-4 h-4' }),
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
