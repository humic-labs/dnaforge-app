import { describe, expect, it } from 'vitest';
import { compileNotebookBlocks, notebookBlockReferenceIds } from './notebook-authoring-content';

describe('native notebook authoring content', () => {
  it('keeps table coordinates, exact primer text and durable reference identities', () => {
    const referenceId = 'e18c3ba4-9448-4589-8309-710c13a0261b';
    const blocks = [
      {
        type: 'table' as const,
        header: true,
        rows: [
          [[{ text: 'Primer' }], [{ text: 'Chosen sequence' }]],
          [[{ text: 'R51-P01', referenceId }], [{ text: 'CAGCTTTTGTTCCCTTTAGTGAGGGTTAATTG' }]],
        ],
      },
    ];
    const content = compileNotebookBlocks(blocks);
    expect(content.content?.[0].attrs?.data.cells).toHaveLength(2);
    expect(content.content?.[0].attrs?.data.cells[1][1].value).toBe(
      'CAGCTTTTGTTCCCTTTAGTGAGGGTTAATTG'
    );
    expect(notebookBlockReferenceIds(blocks)).toEqual([referenceId]);
    expect(JSON.stringify(content)).toContain(`dnaforge-chat://reference/${referenceId}`);
  });
  it('refuses ragged rows rather than silently flattening cells', () => {
    expect(() =>
      compileNotebookBlocks([
        {
          type: 'table',
          header: true,
          rows: [[[{ text: 'one' }], [{ text: 'two' }]], [[{ text: 'only one' }]]],
        },
      ])
    ).toThrow('same number of columns');
  });
});
