import { handleGroup } from '../../shared/ipc-contract';
import { sequenceDataLayersContract } from '../../shared/ipc/sequence-data-layers.contract';
import { resolveExplicitProjectRoot } from '../../shared/project-root-selection';
import { sequenceDataLayerTargetFromBytes } from '../sequence-data-layer-target';
import { SequenceDataLayerCommands } from '../sequence-data-layer-commands';
import { createNativeSequenceDocumentResolver } from '../native-sequence-document-resolver';
import { assertKnownWorkspaceContentWritable } from '../workspace-content-write-access';
import { assertWorkspaceWriteAllowed } from '../workspace-write-admission';
import { nativeDocuments } from '../features/native-documents';
import { getDb } from './database';
import { assertSafeWritablePath, resolveCanonicalPath } from './path-allowlist';
import { readFileBoundedFromHandle } from './bounded-file-read';

export function registerSequenceDataLayerIpcHandlers(): void {
  const resolveDocument = createNativeSequenceDocumentResolver({
    db: getDb,
    workspaceRoots: () => nativeDocuments.workspaces.readableRoots(),
  });
  const commands = new SequenceDataLayerCommands({
    resolveProject: async (project) => {
      const roots = new Set(nativeDocuments.workspaces.readableRoots());
      const rows = getDb()
        .prepare(
          'SELECT name,path FROM workspaces WHERE path IS NOT NULL AND archived_at IS NULL AND trashed_at IS NULL'
        )
        .all() as Array<{ name: string; path: string }>;
      const selected = resolveExplicitProjectRoot(
        rows.filter((row) => roots.has(row.path)),
        project
      );
      if (!selected) throw new Error('Choose an exact admitted project for this data layer.');
      return resolveCanonicalPath(selected.path);
    },
    capture: (root, mutating) =>
      mutating
        ? nativeDocuments.workspaces.capture(root)
        : nativeDocuments.workspaces.captureReadable(root),
    assertWritable: async (root, path) => {
      await assertSafeWritablePath(path, { requireAbsolute: true });
      assertKnownWorkspaceContentWritable(getDb(), root);
      assertWorkspaceWriteAllowed(getDb(), [path]);
    },
    resolveTarget: async (documentId, root) => {
      const document = await resolveDocument({ targetDocumentId: documentId });
      if ((await resolveCanonicalPath(document.workspaceRoot)) !== root)
        throw new Error('The sequence belongs to another project.');
      const bytes = await readFileBoundedFromHandle(document.sourcePath, 32 * 1024 * 1024);
      return sequenceDataLayerTargetFromBytes(documentId, document.sourcePath, bytes);
    },
  });
  handleGroup(sequenceDataLayersContract, { run: (_event, request) => commands.run(request) });
}
