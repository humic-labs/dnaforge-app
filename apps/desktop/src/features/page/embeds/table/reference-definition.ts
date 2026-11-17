import { embedRegistry } from '../registry';
import { TABLE_REFERENCE_NOTEBOOK_BLOCK } from '../../../../shared/table-reference-notebook-contract';
import { TableReferenceRenderer } from './ReferenceRenderer';

embedRegistry.register({
  type: TABLE_REFERENCE_NOTEBOOK_BLOCK.type,
  version: TABLE_REFERENCE_NOTEBOOK_BLOCK.currentVersion,
  label: 'Table reference',
  icon: '📊',
  keywords: ['table', 'reference'],
  importOnly: true,
  capturesEditorFocus: true,
  Renderer: TableReferenceRenderer,
  picker: {
    stages: [],
    onComplete: () => {
      throw new Error('Choose a table document before inserting its reference.');
    },
  },
});
