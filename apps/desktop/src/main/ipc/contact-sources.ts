import { handleGroup } from '../../shared/ipc-contract';
import { contactSourcesContract } from '../../shared/ipc/contact-sources.contract';
import { resolveAdmittedProjectRoot } from '../admitted-scientific-project';
import { ContactSourceCommands } from '../contact-source-commands';
import { nativeDocuments } from '../features/native-documents';
import { getDb } from './database';
import { resolveCanonicalPath } from './path-allowlist';

export function createNativeContactSources() {
  return new ContactSourceCommands({
    resolveProject: async (project) => {
      const selected = resolveAdmittedProjectRoot(
        getDb(),
        [...nativeDocuments.workspaces.readableRoots()],
        project
      );
      if (!selected) throw new Error('Choose an exact admitted project for this contact source.');
      return resolveCanonicalPath(selected.path);
    },
    captureReadable: (root) => nativeDocuments.workspaces.captureReadable(root),
  });
}

export function registerContactSourceIpcHandlers(): void {
  const commands = createNativeContactSources();
  handleGroup(contactSourcesContract, { read: (_event, request) => commands.read(request) });
}
