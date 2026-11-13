import { describe, expect, it, vi } from 'vitest';
import type { FileDocumentRequest, FileDocumentSnapshot } from './file-document';
import type { NativeDirtyDocument } from './native-document-drafts';
import { settleNativeDirtyDocuments } from './native-dirty-documents';

function draft(id = 'closed-native-document'): NativeDirtyDocument {
  return {
    documentId: id,
    target: { documentId: id },
    path: `/workspace/${id}.txt`,
    workspaceRoot: '/workspace',
    kind: 'text',
    revision: 'draft:7',
    readOnly: false,
    dirty: true,
    saving: false,
    recovery: false,
    inspectionRequired: false,
  };
}
function snapshot(overrides: Partial<FileDocumentSnapshot> = {}): FileDocumentSnapshot {
  return {
    documentId: 'closed-native-document',
    path: '/workspace/closed-native-document.txt',
    type: 'text',
    revision: 'draft:7',
    persistedRevision: 'saved:2',
    ready: true,
    readOnly: false,
    dirty: true,
    saving: false,
    canUndo: true,
    canRedo: false,
    capabilities: ['inspect', 'save', 'discard'],
    content: null,
    persistedContent: null,
    diskContent: null,
    ...overrides,
  };
}

describe('native dirty-document settlement', () => {
  it.each(['save', 'discard'] as const)(
    'performs no %s operations after a failed editing-client flush',
    async (action) => {
      const pending = draft();
      const execute = vi.fn<(_: FileDocumentRequest) => Promise<FileDocumentSnapshot>>();
      const listDirty = vi.fn(async () => [pending]);
      const result = await settleNativeDirtyDocuments(
        { action },
        {
          listDirty,
          execute,
          beforeList: async () => {
            throw new Error('An editor transaction is still pending.');
          },
        }
      );
      expect(execute).not.toHaveBeenCalled();
      expect(listDirty).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        settled: [],
        remaining: [pending],
        failures: [{ documentId: null, error: 'An editor transaction is still pending.' }],
      });
    }
  );

  it('retains both the failed flush and an unreadable remaining inventory', async () => {
    const execute = vi.fn<(_: FileDocumentRequest) => Promise<FileDocumentSnapshot>>();
    const result = await settleNativeDirtyDocuments(
      { action: 'save' },
      {
        execute,
        listDirty: async () => {
          throw new Error('Profile unavailable.');
        },
        beforeList: async () => {
          throw new Error('Flush refused.');
        },
      }
    );
    expect(execute).not.toHaveBeenCalled();
    expect(result.failures.map((item) => item.error)).toEqual([
      'Flush refused.',
      'Dirty inventory unavailable: Profile unavailable.',
    ]);
  });

  it('saves a closed native draft using the freshly inspected exact revision', async () => {
    let remaining = [draft()];
    const execute = vi.fn(async (request: FileDocumentRequest) => {
      if (request.operation.kind === 'inspect') return snapshot({ revision: 'draft:8' });
      expect(request).toEqual({
        target: { documentId: 'closed-native-document' },
        projection: 'inspection',
        expectedRevision: 'draft:8',
        operation: { kind: 'save' },
      });
      remaining = [];
      return snapshot({ revision: 'draft:8', persistedRevision: 'draft:8', dirty: false });
    });
    const beforeList = vi.fn(async () => undefined);
    const result = await settleNativeDirtyDocuments(
      { action: 'save' },
      { beforeList, listDirty: async () => remaining, execute }
    );
    expect(beforeList).toHaveBeenCalledOnce();
    expect(result).toEqual({
      action: 'save',
      settled: ['closed-native-document'],
      failures: [],
      remaining: [],
    });
  });

  it('does not apply an unaccepted recovery during Save All', async () => {
    const execute = vi.fn(async () =>
      snapshot({ ready: false, dirty: false, recoveryId: 'previous-session' })
    );
    const result = await settleNativeDirtyDocuments(
      { action: 'save' },
      { listDirty: async () => [draft()], execute }
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(result.settled).toEqual([]);
    expect(result.failures[0].error).toContain('RECOVERY_DECISION_REQUIRED');
  });

  it('permits explicit discard of a retained recovery without restoring it', async () => {
    let remaining = [{ ...draft(), recovery: true, inspectionRequired: true }];
    const execute = vi.fn(async (request: FileDocumentRequest) => {
      if (request.operation.kind === 'inspect')
        return snapshot({ ready: false, dirty: false, recoveryId: 'previous-session' });
      expect(request.operation).toEqual({ kind: 'discard' });
      remaining = [];
      return snapshot({ dirty: false });
    });
    expect(
      await settleNativeDirtyDocuments(
        { action: 'discard' },
        { listDirty: async () => remaining, execute }
      )
    ).toMatchObject({ settled: ['closed-native-document'], failures: [], remaining: [] });
  });

  it('refuses ambiguous native identities before executing either path', async () => {
    const execute = vi.fn<(_: FileDocumentRequest) => Promise<FileDocumentSnapshot>>();
    const result = await settleNativeDirtyDocuments(
      { action: 'save' },
      {
        listDirty: async () => [
          draft(),
          { ...draft(), path: '/other/same-id.txt', workspaceRoot: '/other' },
        ],
        execute,
      }
    );
    expect(execute).not.toHaveBeenCalled();
    expect(result.failures[0].error).toContain('ambiguous');
  });

  it('retains a draft when another editor wins the revision race', async () => {
    const execute = vi.fn(async (request: FileDocumentRequest) => {
      if (request.operation.kind === 'inspect') return snapshot();
      throw new Error('STALE_FILE_DOCUMENT: Revision changed.');
    });
    const result = await settleNativeDirtyDocuments(
      { action: 'save' },
      { listDirty: async () => [draft()], execute }
    );
    expect(result.settled).toEqual([]);
    expect(result.remaining).toEqual([draft()]);
    expect(result.failures[0].error).toContain('STALE_FILE_DOCUMENT');
  });
});
