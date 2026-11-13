import {
  NativeArtifactPublicationPendingError,
  prepareNativeArtifactSubmission,
  type ScientificArtifactPublicationInput,
} from '../shared/scientific-artifact-port';
export { NativeArtifactPublicationPendingError } from '../shared/scientific-artifact-port';
import {
  parseWorkspaceIdentity,
  type ScientificAcceptedDocumentRevision,
} from '@waypoint/domain-services';

import { resolveWorkspaceScope } from '../db/workspace-catalog';
import { platform } from '../platform';
import { pathRelativeToBoundary } from '../shared/path-boundary';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { findWorkspaceRootForPath } from '../db/workspace-catalog';
import { readScientificText } from '../features/scientific-document/services/read-scientific-text';
import { withRendererWorkspaceMutation } from './workspace-mutation-transaction';
import { reconcileAcceptedWorkspaceAfterFilesChanged } from './reconcile-accepted-workspace';

export async function publishNativeArtifact(
  supplied: ScientificArtifactPublicationInput
): Promise<ScientificAcceptedDocumentRevision> {
  const input = structuredClone(supplied);
  const path = pathRelativeToBoundary(input.artifactPath, input.workspaceRoot);
  if (!path || (input.prior && input.prior.resourceId !== input.resourceId))
    throw new Error('The native artifact does not match its captured project identity.');
  const scope = await resolveWorkspaceScope(input.workspaceRoot);
  if (!scope) throw new Error('The native artifact project is unavailable.');
  const prepared = prepareNativeArtifactSubmission(input, parseWorkspaceIdentity(scope));
  return withRendererWorkspaceMutation(
    input.workspaceRoot,
    async (mutationToken) => {
      const result = await platform().scientificObjects.submit({
        ...prepared,
        ...(mutationToken ? { mutationToken } : {}),
      });
      if (result.receipt.outcome === 'conflict' || result.receipt.outcome === 'rejected')
        throw new Error(
          'The accepted artifact changed or the Save intent conflicts. Reopen it before saving.'
        );
      const accepted = result.accepted;
      if (!accepted) throw new Error('The native Save did not return its accepted revision.');
      if (result.delivery?.kind !== 'complete')
        throw new NativeArtifactPublicationPendingError(
          accepted,
          `file delivery remains pending: ${result.delivery?.kind === 'blocked' ? result.delivery.error : 'unavailable'}`
        );
      try {
        const nativeProjectionComplete =
          result.nativeProjectionComplete === true &&
          !result.replayed &&
          result.currentHead === accepted.workspaceVersionId &&
          ((result.receipt.outcome === 'changed' &&
            result.receipt.version === accepted.workspaceVersionId) ||
            (result.receipt.outcome === 'no-op' &&
              result.receipt.head === accepted.workspaceVersionId));
        await reconcileAcceptedWorkspaceAfterFilesChanged({
          workspaceRoot: input.workspaceRoot,
          mutationToken,
          ...(nativeProjectionComplete ? { nativeProjectionComplete: true } : {}),
          assertCurrent: () => {
            if (
              findWorkspaceRootForPath(useWorkspaceStore.getState().folders, input.artifactPath) !==
              input.workspaceRoot
            )
              throw new Error('The artifact project was closed during its refresh.');
          },
        });
        const current = await readScientificText(input.artifactPath, input.workspaceRoot);
        if (
          current.acceptedRevision?.resourceRevisionId !== accepted.resourceRevisionId ||
          current.acceptedRevision.resourceId !== accepted.resourceId ||
          current.content !== input.representation.text
        )
          throw new Error('Another artifact revision is current. Reopen it before saving.');
      } catch (error) {
        throw new NativeArtifactPublicationPendingError(
          accepted,
          error instanceof Error ? error.message : 'project reconstruction remains incomplete.'
        );
      }
      return accepted;
    },
    input.mutationToken
  );
}
