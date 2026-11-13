import {
  createNativeAdministrationCommands,
  registerAdministrationHandlers,
  type NativeAdministrationDependencies,
} from '../ipc/administration';
import { createComputeIpcHandlers } from '../compute/ipc';
import { DEFAULT_MCP_GRANT_CAPABILITIES } from '../sidecar-capabilities';
import { workspaceMutationRootIdentity } from '../workspace-sync-mutation-lease';
import { sidecarFetch } from '../sidecar-session-runtime';
import { getDb } from '../ipc/database';
import { nativeDocuments } from './native-documents';
import { workspaceSync } from './workspace-sync';
import type { MainFeature, MainFeatureContext } from './main-feature';
import type { AdministrationOwner } from '../administration-owner';

let prepared: {
  dependencies: NativeAdministrationDependencies;
  owner: AdministrationOwner;
} | null = null;

export function prepareNativeAdministration(
  context: MainFeatureContext & { appVersion: string }
): void {
  if (prepared) throw new Error('The native administration feature is already prepared.');
  const providers = createComputeIpcHandlers({
    sidecarFetch,
    grantedCapabilities: () => [...DEFAULT_MCP_GRANT_CAPABILITIES],
  });
  const dependencies: NativeAdministrationDependencies = {
    getDb,
    getMainWindow: context.getMainWindow,
    captureWorkspace: (root) =>
      nativeDocuments.workspaces.capture(workspaceMutationRootIdentity(root)),
    forceSync: async (workspaceUuid) => {
      const forceSync = workspaceSync.ipcDependencies()?.actions?.forceSync;
      return forceSync
        ? forceSync(workspaceUuid)
        : { ok: false, message: 'Project sync is not available in this runtime.' };
    },
    appVersion: context.appVersion,
    sidecarFetch,
    listProviders: () => providers.listProviders(),
  };
  const owner = createNativeAdministrationCommands(dependencies);
  nativeDocuments.setAdministration(owner);
  prepared = { dependencies, owner };
}

export const administrationFeature: MainFeature = {
  id: 'administration',
  registerIpc() {
    if (!prepared) throw new Error('The native administration feature has not been prepared.');
    registerAdministrationHandlers(prepared.dependencies, prepared.owner);
    return () => undefined;
  },
};
