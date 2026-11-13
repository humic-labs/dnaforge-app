import { defineBlob } from '@waypoint/workspace-revisions';
import { scientificIdentityPath } from '@waypoint/scientific-objects';
import { platform } from '../../platform';
import { findWorkspaceRootForPath } from '../../db/workspace-catalog';
import {
  fromPackageRelative,
  parseSequencePackageDocument,
  sequencePackagePaths,
  serializeSequencePackageDocument,
} from '../../db/sequence-package';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { readScientificNamespace } from '../../services/read-scientific-namespace';
import { readScientificText } from '../scientific-document/public/read-scientific-text';
import { withRendererWorkspaceMutation } from '../../services/workspace-mutation-transaction';
import { reconcileAcceptedWorkspaceAfterFilesChanged } from '../../services/reconcile-accepted-workspace';
import { gitCommitPaths } from '../workspace/public/git';
import { pathRelativeToBoundary } from '../../shared/path-boundary';
import type { AcceptedSequenceMetadataOwner } from './managed-sequence-repository-types';
import { useSequenceStore } from './store';
import { parseSequenceFileAsDocument } from '../../shared/parse-sequence-file';

export const acceptedSequenceMetadataOwner: AcceptedSequenceMetadataOwner = {
  async load(packageRoot) {
    const root = findWorkspaceRootForPath(useWorkspaceStore.getState().folders, packageRoot);
    if (!root) return null;
    const namespace = await readScientificNamespace(root);
    if (!namespace) return null;
    const paths = sequencePackagePaths(packageRoot);
    const relativeMeta = pathRelativeToBoundary(paths.metaPath, root);
    if (
      !namespace.entries.some(
        (entry) => entry.path === relativeMeta || entry.lastPath === relativeMeta
      )
    )
      return null;
    const metadata = await readScientificText(paths.metaPath, root, undefined, namespace.head);
    if (!metadata.acceptedRevision)
      throw new Error('The accepted package metadata is unavailable.');
    const document = parseSequencePackageDocument(metadata.content);
    const productPath = fromPackageRelative(document.product.file, paths.root);
    const product = await readScientificText(productPath, root, undefined, namespace.head);
    if (
      !product.acceptedRevision ||
      product.acceptedRevision.resourceId !== document.id ||
      product.acceptedRevision.workspaceVersionId !== metadata.acceptedRevision.workspaceVersionId
    )
      throw new Error('The sequence and package metadata do not share a captured accepted head.');
    return {
      ref: { kind: 'managed-sequence', packageId: document.id, packageRoot: paths.root },
      document,
      productPath,
      accepted: {
        workspaceRoot: root,
        workspace: namespace.workspace,
        head: metadata.acceptedRevision.workspaceVersionId,
        productRevisionId: product.acceptedRevision.resourceRevisionId,
        packageRevisionId: metadata.acceptedRevision.resourceRevisionId,
      },
    };
  },
  async save(current, next, options) {
    if (useSequenceStore.getState().isDirty(current.ref.packageId))
      throw new Error('Save or discard sequence edits before changing its metadata.');
    const expectedSaved = useSequenceStore.getState().savedSequences[current.ref.packageId];
    const prior = current.accepted!;
    const request = {
      workspace: prior.workspace,
      expectedHead: prior.head,
      source: {
        kind: 'sequence-metadata' as const,
        resourceId: current.ref.packageId,
        expectedRevisionId: prior.productRevisionId,
        expectedPackageRevisionId: prior.packageRevisionId,
        metadataText: serializeSequencePackageDocument(next),
        ...options,
      },
    };
    return withRendererWorkspaceMutation(prior.workspaceRoot, async (mutationToken) => {
      const live = await this.load(current.ref.packageRoot);
      if (
        !live?.accepted ||
        live.accepted.productRevisionId !== prior.productRevisionId ||
        live.accepted.packageRevisionId !== prior.packageRevisionId
      )
        throw new Error('The sequence metadata changed. Reopen it before saving.');
      const capturedRequest = { ...request, expectedHead: live.accepted.head };
      const operationId = `sequence-metadata:${defineBlob(new TextEncoder().encode(JSON.stringify(capturedRequest))).hash.slice('sha256:'.length)}`;
      const result = await platform().scientificObjects.submit({
        workspaceRoot: prior.workspaceRoot,
        request: { ...capturedRequest, operationId },
        ...(mutationToken ? { mutationToken } : {}),
      });
      if (result.receipt.outcome === 'conflict' || result.receipt.outcome === 'rejected')
        throw new Error('The sequence metadata changed. Reopen it before saving.');
      if (result.delivery?.kind !== 'complete')
        throw new Error(
          `Metadata Save accepted; file delivery remains pending: ${result.delivery?.kind === 'blocked' ? result.delivery.error : 'unavailable'}`
        );
      await reconcileAcceptedWorkspaceAfterFilesChanged({
        workspaceRoot: prior.workspaceRoot,
        mutationToken,
      });
      const refreshed = await this.load(current.ref.packageRoot);
      if (!refreshed || refreshed.accepted?.head !== result.currentHead)
        throw new Error(
          'Metadata Save accepted; reload the current sequence before editing again.'
        );
      const ownedPaths = [
        current.productPath,
        sequencePackagePaths(current.ref.packageRoot).metaPath,
        `${prior.workspaceRoot}/${scientificIdentityPath}`,
        ...refreshed.document.versionHistory.revisions
          .filter(
            (revision) =>
              !current.document.versionHistory.revisions.some(
                (priorRevision) => priorRevision.id === revision.id
              )
          )
          .map((revision) =>
            fromPackageRelative(revision.productSnapshot.path, current.ref.packageRoot)
          ),
      ];
      if (
        options.geneticCode !== undefined ||
        next.product.topology !== current.document.product.topology ||
        next.entity.fields.locus !== current.document.entity.fields.locus
      ) {
        const eventId = `sequence-metadata-${defineBlob(new TextEncoder().encode(operationId)).hash.slice('sha256:'.length)}`;
        const history = `${prior.workspaceRoot}/.dnaforge/history/sequence-edits/${eventId}.json`;
        if (await platform().fs.exists(history)) ownedPaths.push(history);
      }
      await gitCommitPaths(
        prior.workspaceRoot,
        `Update metadata for ${next.name}`,
        ownedPaths.map((path) => pathRelativeToBoundary(path, prior.workspaceRoot)!),
        mutationToken
      );
      const published = await readScientificText(current.productPath, prior.workspaceRoot);
      if (published.acceptedRevision?.workspaceVersionId !== result.currentHead)
        throw new Error('Metadata Save accepted; reload the sequence after another change.');
      if (expectedSaved) {
        const sequence = parseSequenceFileAsDocument(
          published.content,
          current.productPath
        ).sequence;
        useSequenceStore.getState().acknowledgeMetadata(
          current.ref.packageId,
          expectedSaved,
          {
            ...sequence,
            name: refreshed.document.name,
            ...(published.acceptedRevision.resourceRevisionId === prior.productRevisionId
              ? { annotations: expectedSaved.annotations }
              : {}),
          },
          published.acceptedRevision
        );
      }
      return refreshed.document;
    });
  },
};
