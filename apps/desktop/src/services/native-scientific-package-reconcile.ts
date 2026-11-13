import {
  bindCatalogEntityToFile,
  registerCatalogEntity,
  resolveCatalogEntityIdForWorkspace,
} from '../db/workspace-catalog';
import { platform } from '../platform';
import { parseScientificPackageIdentity } from '../shared/scientific-package';

export type NativeScientificPackageReconcileResult = {
  entityId: string;
  rawId: string;
  kind: 'protocol' | 'protocol-run';
};

export async function reconcileNativeScientificPackage(input: {
  path: string;
  workspaceRoot: string;
  contentHash?: string | null;
  sizeBytes?: number | null;
  modifiedAt?: number | null;
  discoveredFrom: 'workspace-reconcile' | 'git-indexer';
  mutationToken?: string;
}): Promise<NativeScientificPackageReconcileResult> {
  const identity = parseScientificPackageIdentity(
    input.path,
    await platform().fs.readTextFile(input.path)
  );
  const entityId = await resolveCatalogEntityIdForWorkspace(input.workspaceRoot, identity.rawId);
  const entity = await registerCatalogEntity({
    id: entityId,
    type: identity.kind === 'protocol' ? 'protocol' : 'protocol_run',
    name: identity.title,
    locator: `file://${input.path}`,
    storageType: 'file',
    workspaceRoot: input.workspaceRoot,
    metadata: {
      portableId: identity.rawId,
      nativePackage: identity.kind,
      discoveredFrom: input.discoveredFrom,
    },
  });
  if (entity.id !== entityId) {
    throw new Error(
      `Native protocol package path is already bound to another identity: ${input.path}`
    );
  }
  await bindCatalogEntityToFile({
    entityId,
    path: input.path,
    fileKind: identity.kind === 'protocol' ? 'waypoint-protocol' : 'waypoint-protocol-run',
    workspaceRoot: input.workspaceRoot,
    contentHash: input.contentHash,
    sizeBytes: input.sizeBytes,
    modifiedAt: input.modifiedAt,
    status: 'current',
    mutationToken: input.mutationToken,
  });
  return {
    entityId,
    rawId: identity.rawId,
    kind: identity.kind,
  };
}
