// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { NotebookDocumentModel, notebookDocumentModelSchema } from './notebook-document-model';
import { createConfiguredTableBlock } from './embeds/table/configuration';

describe('native notebook model', () => {
  it('uses the rich schema without a document or mounted editor', () => {
    const content = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { indent: 2 },
          content: [
            {
              type: 'text',
              text: 'Dose',
              marks: [{ type: 'highlight', attrs: { color: '#FDE68A' } }],
            },
            {
              type: 'mention',
              attrs: {
                id: null,
                label: 'Sequence',
                entityType: 'sequence',
                entityId: 'seq',
                path: 'seq.gb',
                contentHash: 'sha256:abc',
                objectUuid: 'object',
                registryKind: 'custom_sequence',
                projectId: 'project-7',
              },
            },
          ],
        },
        { type: 'rawMarkdown', attrs: { source: ':::unknown\npreserve\n:::' } },
        {
          type: 'embed',
          attrs: { type: 'future-widget', version: 3, refId: 'future', data: { exact: [1, 2] } },
        },
        createConfiguredTableBlock('table', { rows: 2, columns: 2 }),
      ],
    };
    const model = new NotebookDocumentModel(content, 'Notes');
    const roundtrip = notebookDocumentModelSchema().nodeFromJSON(model.content).toJSON();
    expect(roundtrip).toEqual(model.content);
    expect(model.content.content?.[0].content?.[1].attrs).toMatchObject({
      registryKind: 'custom_sequence',
      projectId: 'project-7',
    });
    expect(model.content.content?.[2].attrs?.data).toEqual({ exact: [1, 2] });
    model.execute({
      kind: 'table',
      tableId: 'table',
      command: { kind: 'set-cell', row: 0, column: 0, value: '=2+3' },
    });
    expect(
      model.execute({
        kind: 'table',
        tableId: 'table',
        command: { kind: 'inspect', rowOffset: 0, rowLimit: 2, columnOffset: 0, columnLimit: 2 },
      })
    ).toMatchObject({
      cells: [
        [{ value: '=2+3', type: 'formula' }, {}],
        [{}, {}],
      ],
    });
    model.execute({ kind: 'undo' });
    expect(model.content).toEqual(roundtrip);
    model.execute({ kind: 'redo' });
    expect(model.content).not.toEqual(roundtrip);
  });
  it('applies real ProseMirror steps and refuses an incompatible step', () => {
    const model = new NotebookDocumentModel(
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] },
      'Notes'
    );
    const steps = model.state.tr.insertText('B', 2).steps.map((step) => step.toJSON());
    model.applySteps(steps);
    expect(model.state.doc.textContent).toBe('AB');
    expect(() => model.applySteps([{ stepType: 'replace', from: 999, to: 999 }])).toThrow();
    expect(model.state.doc.textContent).toBe('AB');
  });
});
