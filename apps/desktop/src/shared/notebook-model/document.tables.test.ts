// @vitest-environment node

import { expect, it } from 'vitest';
import { NotebookDocumentModel, notebookDocumentModelSchema } from './document';

it('opens and edits saved protocol table headers and cells through the native owner model', () => {
  const content = {
    type: 'doc',
    content: [
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableHeader',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Primer' }] }],
              },
            ],
          },
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                attrs: { colspan: 1, rowspan: 1, colwidth: [160] },
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Exact bases' }] }],
              },
            ],
          },
        ],
      },
    ],
  };
  const model = new NotebookDocumentModel(content, 'Saved primer protocol');
  const saved = model.content;
  expect(model.state.doc.firstChild?.childCount).toBe(2);
  expect(model.state.doc.textContent).toBe('PrimerExact bases');
  expect(saved.content?.[0].content?.[1].content?.[0].attrs?.colwidth).toEqual([160]);
  const position = 4;
  const steps = model.state.tr.insertText('Edited ', position).steps.map((step) => step.toJSON());
  model.applySteps(steps);
  expect(model.state.doc.textContent).toBe('Edited PrimerExact bases');
  model.execute({ kind: 'undo' });
  expect(model.content).toEqual(saved);
  expect(notebookDocumentModelSchema().nodeFromJSON(model.content).toJSON()).toEqual(saved);
});
