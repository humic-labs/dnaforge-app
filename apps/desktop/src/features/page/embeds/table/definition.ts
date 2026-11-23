import { embedRegistry } from '../registry';
import { TableRenderer } from './Renderer';
import type { SlashCommandDefinition } from '../types';
import { TABLE_NOTEBOOK_BLOCK } from './notebook-contract';
import { createTableBlock } from '../../../../shared/notebook-model/table/configuration';
import { createElement } from 'react';
import { SpreadsheetFileIcon } from '../../../../components/icons/glyphs';

export const tableEmbed: SlashCommandDefinition = {
  type: TABLE_NOTEBOOK_BLOCK.type,
  version: TABLE_NOTEBOOK_BLOCK.currentVersion,
  label: 'Table',
  icon: createElement(SpreadsheetFileIcon, { className: 'w-4 h-4' }),
  keywords: ['table', 'grid', 'spreadsheet', 'data'],

  Renderer: TableRenderer,

  capturesEditorFocus: true,

  picker: {
    stages: [],
    onComplete: () => {
      const block = createTableBlock(undefined, {});
      return {
        nodeType: 'embed',
        embedType: 'table',
        refId: block.attrs.refId,
        data: block.attrs.data,
      };
    },
  },
};

embedRegistry.register(tableEmbed);
