import { describe, expect, it } from 'vitest';
import { projectPublicSequenceValue } from './public-sequence-projection';

describe('projectPublicSequenceValue', () => {
  it('keeps stable sequence identity while stripping raw GenBank locators', () => {
    expect(
      projectPublicSequenceValue({
        entity: {
          fields: {
            sequence: {
              mode: 'file',
              documentId: 'sequence-package-42',
              relPath: '/project/pUC19/pUC19.gb',
              length: 2686,
            },
            _managedSequenceDocument: {
              kind: 'managed-sequence',
              packageId: 'sequence-package-42',
              packageRoot: '/project/pUC19',
            },
          },
        },
      })
    ).toEqual({
      entity: {
        fields: {
          sequence: {
            mode: 'file',
            documentId: 'sequence-package-42',
            length: 2686,
          },
          _managedSequenceDocument: {
            kind: 'managed-sequence',
            packageId: 'sequence-package-42',
          },
        },
      },
    });
  });

  it('does not strip ordinary non-sequence file paths', () => {
    expect(projectPublicSequenceValue({ kind: 'file', filePath: '/project/notes.txt' })).toEqual({
      kind: 'file',
      filePath: '/project/notes.txt',
    });
  });
});
