import { handleGroup } from '../../shared/ipc-contract';
import { comparisonSourcesContract } from '../../shared/ipc/comparison-sources.contract';
import { resolveExplicitProjectRoot } from '../../shared/project-root-selection';
import { ComparisonSourceCommands } from '../comparison-source-commands';
import { nativeDocuments } from '../features/native-documents';
import { getDb } from './database';
import { resolveCanonicalPath } from './path-allowlist';

export function registerComparisonSourceIpcHandlers(): void {
  const commands = new ComparisonSourceCommands({
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
      if (!selected)
        throw new Error('Choose an exact admitted project for this comparison source.');
      return resolveCanonicalPath(selected.path);
    },
    captureReadable: (root) => nativeDocuments.workspaces.captureReadable(root),
  });
  handleGroup(comparisonSourcesContract, { read: (_event, request) => commands.read(request) });
}
