import { handleGroup } from '../../shared/ipc-contract';
import { comparisonSourcesContract } from '../../shared/ipc/comparison-sources.contract';
import { resolveAdmittedProjectRoot } from '../admitted-scientific-project';
import { ComparisonSourceCommands } from '../comparison-source-commands';
import { nativeDocuments } from '../features/native-documents';
import { withLocalTrackViewReference } from '../features/reference-assets';
import { getDb } from './database';
import { resolveCanonicalPath } from './path-allowlist';

export function createNativeComparisonSources() {
  return new ComparisonSourceCommands({
    resolveProject: async (project) => {
      const selected = resolveAdmittedProjectRoot(
        getDb(),
        [...nativeDocuments.workspaces.readableRoots()],
        project
      );
      if (!selected)
        throw new Error('Choose an exact admitted project for this comparison source.');
      return resolveCanonicalPath(selected.path);
    },
    captureReadable: (root) => nativeDocuments.workspaces.captureReadable(root),
    references: { withReference: withLocalTrackViewReference },
  });
}

export function registerComparisonSourceIpcHandlers(): void {
  const commands = createNativeComparisonSources();
  handleGroup(comparisonSourcesContract, {
    read: (_event, request) => commands.read(request),
    readWindow: (_event, request) => commands.readWindow(request),
  });
}
