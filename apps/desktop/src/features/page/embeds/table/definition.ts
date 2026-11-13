import { embedRegistry } from '../registry';
import { TableRenderer } from './Renderer';
import type { SlashCommandDefinition } from '../types';
import { TABLE_NOTEBOOK_BLOCK } from './notebook-contract';

export const tableEmbed: SlashCommandDefinition = {
  type: TABLE_NOTEBOOK_BLOCK.type,
  version: TABLE_NOTEBOOK_BLOCK.currentVersion,
  label: 'Table',
  icon: '📊',
  keywords: ['table', 'grid', 'spreadsheet', 'data'],

  Renderer: TableRenderer,

  capturesEditorFocus: true,

  picker: {
    stages: [],
    onComplete: () => {
      return {
        nodeType: 'embed',
        embedType: 'table',
        refId: `table-${Date.now()}`,
        data: {},
      };
    },
  },
};

embedRegistry.register(tableEmbed);
