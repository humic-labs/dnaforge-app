import {
  createDeepShareBundleV1,
  resolveShareBundleLimits,
  validateDeepShareBundleV1,
  type DeepShareBundleV1,
  type DeepShareParentRef,
} from '@waypoint/share-bundle';
import type { DeepSharePreflight } from './preflight';

export function buildDeepShareBundle(args: {
  preflight: DeepSharePreflight;
  appVersion: string;
  createdAt?: string;
  parent?: DeepShareParentRef | null;
}): DeepShareBundleV1 {
  const versionId = args.preflight.workspace.latestVersionId;
  const versionNumber = args.preflight.workspace.latestVersionNumber;
  const versionContentSha256 = args.preflight.workspace.latestVersionContentSha256;
  if (!versionId || versionNumber === null || !versionContentSha256) {
    throw new Error('The reviewed project does not have an exact ready sync version.');
  }
  const root = args.preflight.manifest.artifacts.find(
    (artifact) => artifact.id === args.preflight.rootArtifactId
  );
  if (!root) throw new Error('The reviewed root artifact is missing from the manifest.');

  const bundle = createDeepShareBundleV1({
    schema: 'dnaforge.deep-share/v1',
    appVersion: args.appVersion,
    createdAt: args.createdAt ?? new Date().toISOString(),
    source: {
      workspaceId: args.preflight.workspace.remoteWorkspaceId,
      workspaceName: args.preflight.workspace.name,
      artifact: { id: root.id, type: root.type, name: root.name },
      pinnedVersionId: versionId,
      pinnedVersionNumber: versionNumber,
      pinnedVersionContentSha256: versionContentSha256,
    },
    parent: args.parent ?? null,
    manifest: args.preflight.manifest,
    files: args.preflight.files,
    chats: args.preflight.chats,
    limits: resolveShareBundleLimits(),
  });
  const validation = validateDeepShareBundleV1(bundle);
  if (!validation.ok) {
    throw new Error(`Built Deep Share bundle is invalid: ${validation.errors.join('; ')}`);
  }
  return validation.bundle;
}
