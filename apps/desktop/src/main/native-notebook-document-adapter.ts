import type { FileDocumentSnapshot } from '../shared/file-document';
import { documentLifecycleCapabilities } from '../shared/document-lifecycle';
import type { NotebookDocumentSnapshot, NativeNotebookRequest } from '../shared/notebook-document';
import { NativeDocumentCommandError } from '../shared/native-document-error';
import type { NativeScientificDocumentAdapter } from './native-document-dispatcher';
import type { NativeNotebookWorkingCopyOwner } from './notebook-document-owner';

export function nativeNotebookDocumentAdapter(
  owner: NativeNotebookWorkingCopyOwner
): NativeScientificDocumentAdapter {
  const project = (snapshot: NotebookDocumentSnapshot): FileDocumentSnapshot => {
    const { copy: _copy, recovery, ...notebook } = snapshot;
    return {
      documentId: snapshot.documentId,
      path: snapshot.path,
      workspaceRoot: snapshot.workspaceRoot,
      type: 'notebook',
      kind: 'notebook',
      revision: snapshot.revision,
      persistedRevision: snapshot.persistedRevision,
      ready: snapshot.ready,
      readOnly: snapshot.readOnly,
      dirty: snapshot.dirty,
      saving: snapshot.saving,
      canUndo: snapshot.canUndo,
      canRedo: snapshot.canRedo,
      content: null,
      persistedContent: null,
      diskContent: null,
      capabilities: snapshot.readOnly
        ? ['inspect']
        : ['inspect', 'notebook', 'undo', 'redo', 'save', 'discard', 'reload', 'restore-recovery'],
      owner: { kind: 'notebook', runtime: 'native' },
      lifecycle: documentLifecycleCapabilities({
        readOnly: snapshot.readOnly,
        commands: snapshot.readOnly
          ? ['inspect']
          : ['inspect', 'edit', 'undo', 'redo', 'save', 'discard', 'reload', 'restore-recovery'],
      }),
      notebook: {
        ...notebook,
        ...(recovery ? { recovery: { baselineMismatch: recovery.baselineMismatch } } : {}),
      },
    };
  };
  return {
    kind: 'notebook',
    locate: (id) => owner.locate(id),
    listDirty: () => owner.listDirty(),
    async execute(request) {
      let operation: NativeNotebookRequest['operation'];
      switch (request.operation.kind) {
        case 'inspect':
          operation = {
            kind: 'inspect',
            offset: request.operation.offset,
            limit: Math.min(request.operation.limit, 50),
          };
          break;
        case 'notebook':
          operation = request.operation.command;
          break;
        case 'undo':
        case 'redo':
        case 'save':
        case 'discard':
        case 'reload':
        case 'restore-recovery':
          operation = { kind: request.operation.kind };
          break;
        default:
          throw new NativeDocumentCommandError(
            'DOCUMENT_KIND_MISMATCH',
            'Use typed notebook commands for this document.',
            false
          );
      }
      return project(
        await owner.execute({
          documentId: request.target.documentId,
          expectedRevision: request.expectedRevision,
          requestId: request.requestId,
          operation,
        })
      );
    },
    subscribe: (listener) => owner.subscribe((snapshot) => listener(project(snapshot))),
    assertClean: (path) => owner.assertClean(path),
    withCleanPaths: (paths, operation) => owner.withCleanPaths(paths, operation),
    relocate: (source, destination) => owner.relocate(source, destination),
    close: () => owner.close(),
  };
}
