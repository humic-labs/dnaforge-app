import { handleGroup } from '../../shared/ipc-contract';
import { contactSourcesContract } from '../../shared/ipc/contact-sources.contract';
import { resolveExplicitProjectRoot } from '../../shared/project-root-selection';
import { ContactSourceCommands } from '../contact-source-commands';
import { nativeDocuments } from '../features/native-documents';
import { getDb } from './database';
import { resolveCanonicalPath } from './path-allowlist';

export function registerContactSourceIpcHandlers(): void {
  const commands = new ContactSourceCommands({
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
      if (!selected) throw new Error('Choose an exact admitted project for this contact source.');
      return resolveCanonicalPath(selected.path);
    },
    captureReadable: (root) => nativeDocuments.workspaces.captureReadable(root),
  });
  handleGroup(contactSourcesContract, { read: (_event, request) => commands.read(request) });
}
