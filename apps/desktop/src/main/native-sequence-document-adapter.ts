import { NativeDocumentCommandError } from '../shared/native-document-error';
import type { FileDocumentRequest, FileDocumentSnapshot } from '../shared/file-document';
import { documentLifecycleCapabilities } from '../shared/document-lifecycle';
import {
  sequenceDocumentInspectSchema,
  type SequenceDocumentOperation,
  type SequenceDocumentSnapshot,
} from '../shared/sequence-document';
import type { NativeScientificDocumentAdapter } from './native-document-dispatcher';
import type { NativeSequenceWorkingCopyOwner } from './native-sequence-working-copy';

export function nativeSequenceDocumentAdapter(
  owner: NativeSequenceWorkingCopyOwner
): NativeScientificDocumentAdapter {
  const project = (snapshot: SequenceDocumentSnapshot): FileDocumentSnapshot => {
    const { copy: _copy, ...sequence } = snapshot;
    return {
      ...sequence,
      type: 'sequence',
      kind: 'sequence',
      owner: { kind: 'sequence', runtime: 'native' },
      lifecycle: documentLifecycleCapabilities({
        readOnly: snapshot.readOnly,
        commands: snapshot.capabilities,
      }),
      sequence,
      content: null,
      persistedContent: null,
      diskContent: null,
    };
  };
  return {
    kind: 'sequence',
    close: () => owner.close(),
    locate: (id) => owner.locate(id),
    listDirty: () => owner.listDirty(),
    async execute(request: FileDocumentRequest & { target: { documentId: string } }) {
      const documentId = request.target.documentId;
      const state = await owner.execute({
        documentId,
        operation: sequenceDocumentInspectSchema.parse({ kind: 'inspect', annotationLimit: 0 }),
      });
      let operation: SequenceDocumentOperation;
      switch (request.operation.kind) {
        case 'inspect':
          operation = sequenceDocumentInspectSchema.parse({
            kind: 'inspect',
            start: request.operation.offset,
            limit: Math.min(request.operation.limit, 10000),
            annotationLimit: 0,
          });
          break;
        case 'sequence':
          operation = request.operation.command;
          break;
        case 'undo':
        case 'redo':
        case 'reload':
        case 'discard':
          operation = request.operation;
          break;
        case 'save':
          operation = { kind: 'save', message: 'Edit sequence' };
          break;
        case 'restore-recovery':
          operation = request.operation;
          break;
        default:
          throw new NativeDocumentCommandError(
            'DOCUMENT_KIND_MISMATCH',
            'Use typed sequence commands for this document.',
            false
          );
      }
      if (operation.kind !== 'inspect' && request.expectedRevision !== state.revision)
        throw new NativeDocumentCommandError(
          'STALE_FILE_DRAFT',
          'Inspect the current native sequence revision before editing.',
          false
        );
      return project(
        await owner.execute({
          documentId,
          expectedVersion: state.version,
          requestId: request.requestId,
          operation,
        })
      );
    },
    subscribe: (listener) => owner.subscribe((snapshot) => listener(project(snapshot))),
    assertClean: (path) => owner.assertClean(path),
    withCleanPaths: (paths, operation) => owner.withCleanPaths(paths, operation),
    relocate: (source, destination) => owner.relocate(source, destination),
  };
}
