import { entityPickerResult } from '../entity-picker-result';
import { embedRegistry } from '../registry';
import { PagePicker } from './Picker';
import type { SlashCommandDefinition } from '../types';

export const pageCommand: SlashCommandDefinition = {
  type: 'page',
  version: 1,
  label: 'Page',
  icon: '📄',
  keywords: ['page', 'link', 'note', 'document'],

  picker: {
    stages: [
      {
        name: 'Select Page',
        component: PagePicker,
      },
    ],
    size: 'md',
    onComplete: (data) => {
      if (data.entity) return entityPickerResult(data.entity);
      if (!data.pageId || typeof data.pageId !== 'string') {
        throw new Error('Invalid picker data: missing or invalid pageId');
      }
      if (!data.pageName || typeof data.pageName !== 'string') {
        throw new Error('Invalid picker data: missing or invalid pageName');
      }
      return {
        nodeType: 'mention',
        entityType: 'page',
        entityId: data.pageId,
        label: data.pageName,
      };
    },
  },
};

embedRegistry.register(pageCommand);
