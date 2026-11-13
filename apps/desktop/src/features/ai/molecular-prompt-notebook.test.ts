import { describe, expect, it } from 'vitest';
import { upgradedMolecularPromptNotebookContent } from './molecular-prompt-notebook';

describe('protein run notebook upgrade', () => {
  it('keeps user notes but does not add a second table', () => {
    const oldIntro =
      'Each row is a recorded agent chat with a frozen question, coordinate fixture, and prompt variant. Open an output or its chat to inspect the exact run. The prompt column contains the trial-specific instructions saved at the start; the complete resolved agent system prompt was not recorded for these runs.';
    const existing = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'Protein visualization prompt trials' }],
        },
        { type: 'paragraph', content: [{ type: 'text', text: oldIntro }] },
        {
          type: 'embed',
          attrs: { type: 'protein-prompt-history', refId: 'protein-prompt-history', data: {} },
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'My previous critique stays here.' }],
        },
      ],
    };

    const upgraded = upgradedMolecularPromptNotebookContent(existing);
    expect(upgraded?.content?.[0]?.content?.[0]?.text).toBe('Protein run comparison');
    expect(upgraded?.content?.[1]?.content?.[0]?.text).toBe(
      'Captured-prompt runs and reviewed reference views.'
    );
    expect(upgraded?.content?.[3]).toEqual(existing.content[3]);
    const table = upgraded?.content?.find(
      (node) => node.type === 'embed' && node.attrs?.refId === 'protein-run-review-notes'
    );
    expect(table).toBeUndefined();
    expect(upgradedMolecularPromptNotebookContent(upgraded!)).toBeNull();
  });

  it('removes only the blank generated review table and retains filled review data', () => {
    const emptyReview = {
      type: 'embed',
      attrs: {
        type: 'table',
        refId: 'protein-run-review-notes',
        data: {
          rows: 1,
          cols: 1,
          cells: [[{ value: '', type: 'text' }]],
        },
      },
    };
    const heading = {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Review notes' }],
    };
    const base = {
      type: 'doc',
      content: [
        {
          type: 'embed',
          attrs: { type: 'protein-prompt-history', refId: 'protein-prompt-history' },
        },
        heading,
        emptyReview,
        { type: 'paragraph', content: [{ type: 'text', text: 'Keep my critique.' }] },
      ],
    };
    const cleaned = upgradedMolecularPromptNotebookContent(base);
    expect(cleaned?.content).toHaveLength(2);
    expect(cleaned?.content?.[1]?.content?.[0]?.text).toBe('Keep my critique.');

    const filledReview = structuredClone(base);
    filledReview.content[2].attrs.data.cells[0][0].value = 'This angle is good';
    const preserved = upgradedMolecularPromptNotebookContent(filledReview);
    expect(preserved).toBeNull();
  });
});
