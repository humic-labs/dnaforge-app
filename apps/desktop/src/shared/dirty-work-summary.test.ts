import { describe, expect, it } from 'vitest';
import { mergeDirtyWorkState } from './dirty-work-summary';
import type { NativeDirtyDocument } from './native-document-drafts';

function draft(kind: NativeDirtyDocument['kind'] = 'text'): NativeDirtyDocument {
  return {
    documentId: 'catalog-document',
    target: { documentId: 'catalog-document' },
    path: '/project/sample.csv',
    workspaceRoot: '/project',
    kind,
    revision: 'draft:1',
    dirty: true,
    saving: false,
    readOnly: false,
    recovery: false,
    inspectionRequired: false,
  };
}
describe('native and human unsaved-work summary', () => {
  it('includes closed native drafts when the renderer has no dirty tabs', () => {
    expect(
      mergeDirtyWorkState({ hasDirtyWork: false, details: '', dirtyItems: [] }, [draft()])
    ).toMatchObject({
      hasDirtyWork: true,
      details: '1 text file',
      dirtyFilePaths: ['/project/sample.csv'],
    });
  });
  it('counts duplicate views and their native owner once even when the opener uses a different kind', () => {
    expect(
      mergeDirtyWorkState(
        {
          hasDirtyWork: true,
          details: '2 text files',
          dirtyItems: [
            { kind: 'text', id: '/project/sample.csv', filePath: '/project/sample.csv' },
            { kind: 'text', id: '/project/sample.csv', filePath: '/project/sample.csv' },
          ],
        },
        [draft('csv')]
      ).details
    ).toBe('1 text file');
  });
  it('retains separate legacy dirty work and recovery decisions', () => {
    expect(
      mergeDirtyWorkState(
        {
          hasDirtyWork: true,
          details: '1 chat',
          dirtyItems: [{ kind: 'chat', id: 'conversation' }],
        },
        [{ ...draft('sequence'), dirty: false, recovery: true }]
      )
    ).toMatchObject({
      hasDirtyWork: true,
      details: '1 sequence and 1 chat',
      dirtySequenceDocumentIds: ['catalog-document'],
    });
  });
  it('does not describe an unreadable inventory as clean', () => {
    expect(
      mergeDirtyWorkState({ hasDirtyWork: false, details: '' }, [], 'Profile unavailable.')
    ).toMatchObject({
      hasDirtyWork: true,
      details: 'open documents',
    });
  });
});
