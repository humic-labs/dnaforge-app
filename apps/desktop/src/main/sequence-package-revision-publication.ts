import { AsyncLocalStorage } from 'node:async_hooks';
interface PublicationChecks {
  beforePublish?(): void;
  onPendingRecovery?(): void;
}
const publicationChecks = new AsyncLocalStorage<PublicationChecks>();
import { stageOrganizationSavedSequenceMembers } from './org-registry-saved-sequence-members';
import { createHash } from 'node:crypto';
import {
  prepareSequenceMetadataEdit,
  stableSequencePackageRequestJson as stableJson,
} from '../db/sequence-package-metadata-edit';
import { readFile, realpath, stat } from 'node:fs/promises';
import {
  fromPackageRelative,
  parseSequencePackageDocument,
  sequencePackagePaths,
  serializeSequencePackageDocument,
  type SequencePackageDocument,
  type SequencePackageRevision,
  type SequencePackageRevisionKind,
} from '../db/sequence-package';
import {
  computeChecksum,
  insertManagedGenBankAnnotation,
  listManagedGenBankAnnotations,
  managedGenBankAnnotationValueDigest,
  removeManagedGenBankAnnotation,
  replaceManagedGenBankAnnotation,
  updateGenBankGeneticCodeComment,
} from '@waypoint/sequence-utils';
import { parseSequenceFileAsDocument } from '../shared/parse-sequence-file';
import { updateGenBankLocusMetadata } from '../shared/genbank-locus-metadata';
import type {
  AcceptedAssemblyRevisionPublicationRequest,
  AcceptedAssemblyRevisionPublicationResult,
  SequenceMetadataRevisionRequest,
  SequenceMetadataRevisionResult,
} from '../shared/sequence-package-revision';
import {
  prepareSequencePackageRevision,
  sequenceReferenceCheckpointId,
  verifySequencePackageSnapshot,
  type PreparedSequencePackageRevision,
} from '../db/sequence-package-versioning';
import {
  composeSequenceRestore,
  annotationIdForRestoreItem,
  RESTORE_ASSEMBLY_ITEM,
  RESTORE_GENETIC_CODE_ITEM,
  RESTORE_PRODUCT_ITEM,
  RESTORE_TOPOLOGY_ITEM,
  sequenceRestoreItemCatalog,
  sourceValueForRestoreItem,
  userAttachmentIdForRestoreItem,
} from '../db/sequence-package-restore';
import {
  ASSEMBLY_WORKING_COPY_RELATIVE_PATH,
  sequenceAssemblyWorkingCopyMember,
  sequenceAssemblyWorkingCopyPath,
} from '../db/sequence-package-working-copy';
import {
  prepareSequenceUserAttachmentMutation,
  type UserAttachmentMutation,
} from '../db/sequence-package-user-attachment-mutation';
import type {
  SequenceRestoreApplyRequest,
  SequenceRestoreApplyResult,
  SequenceRestorePreviewRequest,
  SequenceRestorePreviewResult,
} from '../shared/sequence-package-revision';
import {
  canonicalWorkspacePath,
  writeWorkspaceTextFileAtomicInMain,
} from './primer-artifact-files';
import { assertLegacySequenceMetadataTransactionSettledInMain } from './sequence-package-legacy-metadata-journal';
import { stagePreparedUserAttachmentAssetInMain } from './sequence-package-user-attachment-asset';
import { observeSequenceSaveAfterProductForTest } from './sequence-save-publication-test-seam';
import {
  createRegisteredSequencePackagePublicationContext,
  readCheckedManagedSequencePair,
  readRetainedSequenceKeepSavedPublication,
  hasSettledRegisteredSequencePublicationInDb,
  assertRegisteredSequencePackageCurrent,
  prepareRegisteredSequencePublication,
  parseRegisteredSequencePublicationIntent,
  assertRegisteredSequencePublicationAccess,
  settleRegisteredSequencePublication,
  assertUnversionedSequencePackageMutationAllowed,
  type RegisteredSequencePackagePublicationContext,
  type RegisteredSequencePublicationIntent,
} from './sequence-package-registry-publication';

import type { VerifiedRegisteredRecordResolution } from './org-registry-local-mutations';
import { limsEntityFromRow, type LimsEntityActionInput } from '../shared/lims';
import {
  readManagedSequenceDocumentRef,
  MANAGED_SEQUENCE_DOCUMENT_FIELD,
} from '../shared/managed-sequence-document';
import { getEntityRowById } from './lims-engine-core';
import { readOrgRegistryPublicationAdmissionInDb } from './org-registry-record-sync';

import {
  assertRendererDatabaseStatementAllowed,
  notifyRendererDatabaseStatementSettled,
} from './workspace-sync-database-fence';

async function sequencePackagePublicationContext(
  supplied?: RegisteredSequencePackagePublicationContext | PublicationChecks
): Promise<RegisteredSequencePackagePublicationContext> {
  if (supplied && 'db' in supplied) return supplied;
  const { getDb } = await import('./ipc/database');
  const db = getDb();
  return createRegisteredSequencePackagePublicationContext({
    db,
    runDatabase: (work) => {
      assertRendererDatabaseStatementAllowed(db);
      try {
        return work();
      } finally {
        notifyRendererDatabaseStatementSettled(db);
      }
    },
  });
}
import {
  hasSequencePackagePublicationOwner,
  prepareAcceptedSequencePackageProduct,
  publishAcceptedSequencePackage,
  readAcceptedSequencePackageBytes,
} from './sequence-package-publication-owner';

const PUBLICATION_SCHEMA = 'waypoint.sequence-revision-publication.v1' as const;
const packagePublicationTails = new Map<string, Promise<void>>();

type PendingPublication = {
  schema: typeof PUBLICATION_SCHEMA;
  state: 'pending';
  packageId: string;
  operationId: string;
  beforeMarkerSha256: string;
  beforeProductSha256: string;
  beforeMarkerContent: string;
  beforeProductSnapshotPath: string;
  afterMarkerSha256: string;
  afterProductSha256: string;
  nextMarkerContent: string;
  nextProductSnapshotPath: string;
  registeredPublication?: RegisteredSequencePublicationIntent;
};

type CompletePublication = {
  schema: typeof PUBLICATION_SCHEMA;
  state: 'complete' | 'aborted';
  packageId: string;
  operationId: string;
  revisionId: string;
  completedAt: string;
  registeredPublication?: RegisteredSequencePublicationIntent;
};

export interface SequencePackagePublicationReceipt {
  revisionId: string;
  snapshotPaths: string[];
  assetPaths: string[];
  markerPath: string;
  publicationPaths?: string[];
}

export async function publishSequenceUserAttachmentMutationInMain(
  input: {
    workspaceRoot: string;
    packageRoot: string;
    packageId: string;
    expectedMarkerSha256: string;
    expectedProductSha256: string;
    operationId: string;
    mutation: UserAttachmentMutation;
  },
  suppliedContext?: RegisteredSequencePackagePublicationContext
): Promise<SequencePackagePublicationReceipt & { alreadyPublished: boolean }> {
  if (!input.operationId || !input.packageId) {
    throw new Error('User attachment publication requires package and operation identities.');
  }
  const mutationDigest = input.mutation.kind === 'detach' ? null : sha256(input.mutation.content);
  const requestFingerprint = sha256(
    stableJson({
      packageId: input.packageId,
      operationId: input.operationId,
      expectedMarkerSha256: input.expectedMarkerSha256,
      expectedProductSha256: input.expectedProductSha256,
      mutation:
        input.mutation.kind === 'detach'
          ? input.mutation
          : { ...input.mutation, content: undefined, sha256: mutationDigest },
    })
  );
  const context = await sequencePackagePublicationContext(suppliedContext);
  return withRegisteredSequenceRevisionMutation(
    context,
    input.workspaceRoot,
    input.packageRoot,
    async () => {
      const markerContent = await readContained(
        input.workspaceRoot,
        sequencePackagePaths(input.packageRoot).metaPath
      );
      const current = parseSequencePackageDocument(markerContent);
      if (current.id !== input.packageId) {
        throw new Error('User attachment package identity changed.');
      }
      const productPath = sequencePackagePaths(input.packageRoot, {
        productFile: current.product.file,
      }).productPath;
      const productContent = await readContained(input.workspaceRoot, productPath);
      const previous = current.versionHistory.revisions.find(
        (revision) => revision.operationId === input.operationId
      );
      if (previous) {
        if (
          previous.kind !== 'member-update' ||
          previous.id !== input.operationId ||
          previous.requestFingerprint !== requestFingerprint
        ) {
          throw new Error('This operation ID already belongs to another package revision.');
        }
        const attachment = previous.state.userAttachments?.[input.mutation.attachmentId];
        if (input.mutation.kind !== 'detach') {
          if (!attachment || attachment.sha256 !== mutationDigest) {
            throw new Error('Published user attachment retry has different bytes.');
          }
          await verifyUserAttachments(input.workspaceRoot, input.packageRoot, current, {
            [input.mutation.attachmentId]: attachment,
          });
        }
        return {
          revisionId: previous.id,
          snapshotPaths: [fromPackageRelative(previous.productSnapshot.path, input.packageRoot)],
          assetPaths: attachment
            ? [
                fromPackageRelative(
                  current.members.find((member) => member.id === attachment.memberId)!.path,
                  input.packageRoot
                ),
              ]
            : [],
          markerPath: sequencePackagePaths(input.packageRoot).metaPath,
          alreadyPublished: true,
        };
      }
      if (
        sha256(markerContent) !== input.expectedMarkerSha256 ||
        sha256(productContent) !== input.expectedProductSha256
      ) {
        throw new Error('User attachment package changed. Reopen and review the current version.');
      }
      const prepared = await prepareSequenceUserAttachmentMutation(current, input.mutation);
      const assetPath = prepared.asset
        ? await stagePreparedUserAttachmentAssetInMain({
            workspaceRoot: input.workspaceRoot,
            packageRoot: input.packageRoot,
            asset: prepared.asset,
          })
        : null;
      const receipt = await publishRevisionLocked(
        {
          workspaceRoot: input.workspaceRoot,
          packageRoot: input.packageRoot,
          packageId: input.packageId,
          nextDocument: prepared.nextDocument,
          nextProductContent: productContent,
          kind: 'member-update',
          operationId: input.operationId,
          revisionId: input.operationId,
          adoptedRevisionId: `adopted-before:${input.operationId}`,
          expectedMarkerSha256: input.expectedMarkerSha256,
          expectedProductSha256: input.expectedProductSha256,
          requestFingerprint,
        },
        context
      );
      return {
        ...receipt,
        assetPaths: assetPath ? [...receipt.assetPaths, assetPath] : receipt.assetPaths,
        alreadyPublished: false,
      };
    }
  );
}

export async function publishSequencePackageRevisionInMain(
  input: {
    workspaceRoot: string;
    packageRoot: string;
    packageId: string;
    nextDocument: SequencePackageDocument;
    nextProductContent: string;
    kind: SequencePackageRevisionKind;
    operationId: string;
    revisionId: string;
    adoptedRevisionId?: string;
    createdAt?: string;
    expectedMarkerSha256: string;
    expectedProductSha256: string;
    requestFingerprint?: string;
    immutableAssets?: ReadonlyArray<{ path: string; sha256: string; content: string }>;
    sources?: SequencePackageRevision['sources'];
    evidenceRunId?: string;
    beforePublish?(): void;
  },
  suppliedContext?: RegisteredSequencePackagePublicationContext
): Promise<SequencePackagePublicationReceipt> {
  const context = await sequencePackagePublicationContext(suppliedContext);
  return publicationChecks.run({ beforePublish: input.beforePublish }, () =>
    withRegisteredSequenceRevisionMutation(context, input.workspaceRoot, input.packageRoot, () =>
      publishRevisionLocked(input, context)
    )
  );
}

export async function publishRegisteredSequenceLifecycleInMain(
  action: 'archive' | 'restore',
  request: LimsEntityActionInput,
  suppliedContext: RegisteredSequencePackagePublicationContext
) {
  if (
    !request.operationId ||
    request.operationId.length > 200 ||
    !Number.isSafeInteger(request.expectedEventSeq) ||
    Number(request.expectedEventSeq) < 1
  )
    throw new Error('Refresh this saved sequence before changing its archive state.');
  const context = { ...suppliedContext, lifecyclePublication: true as const };
  const accountId = await context.getActiveAccountId();
  const admitted = context.runDatabase(() =>
    readOrgRegistryPublicationAdmissionInDb(context.db, { entityId: request.id, accountId })
  );
  if (
    !admitted ||
    admitted.bindings.some((binding) => binding.authorityKind !== 'sequence_package')
  )
    throw new Error('This lifecycle action has no registered sequence package owner.');
  const locator = readManagedSequenceDocumentRef(
    admitted.entity.fields[MANAGED_SEQUENCE_DOCUMENT_FIELD]
  );
  const home = context.runDatabase(() =>
    context.db.prepare('SELECT path FROM workspaces WHERE id=?').get(admitted.entity.workspaceId)
  ) as { path: string } | undefined;
  if (!locator || locator.packageId !== request.id || !home)
    throw new Error('The saved sequence has no verified home or package location.');
  const operationId = request.operationId;
  const requestFingerprint = sha256(
    stableJson({
      action: 'sequence-registry-lifecycle',
      choice: action,
      entityId: request.id,
      operationId,
      expectedEventSeq: request.expectedEventSeq,
    })
  );
  return withRegisteredSequenceRevisionMutation(
    context,
    home.path,
    locator.packageRoot,
    async () => {
      const pair = await readCheckedManagedSequencePair(context, {
        entityId: request.id,
        workspaceRoot: home.path,
        packageRoot: locator.packageRoot,
      });
      const previous = pair.document.versionHistory.revisions.find(
        (revision) => revision.operationId === operationId
      );
      if (previous) {
        if (
          previous.kind !== 'metadata-update' ||
          previous.requestFingerprint !== requestFingerprint ||
          previous.state.entity.lifecycle?.archived !== (action === 'archive')
        )
          throw new Error('This operation ID belongs to a different sequence lifecycle choice.');
        return pair.entity;
      }
      if (pair.entity.eventSeq !== request.expectedEventSeq)
        throw new Error('The saved sequence changed; review it before changing its archive state.');
      const archived = action === 'archive';
      if (pair.entity.tombstone === archived) return pair.entity;
      await publishRevisionLocked(
        {
          workspaceRoot: home.path,
          packageRoot: locator.packageRoot,
          packageId: request.id,
          nextDocument: {
            ...pair.document,
            entity: {
              ...pair.document.entity,
              lifecycle: { archived, archivedAt: archived ? Date.now() : null },
            },
          },
          nextProductContent: pair.productContent,
          kind: 'metadata-update',
          operationId,
          revisionId: operationId,
          expectedMarkerSha256: sha256(pair.markerContent),
          expectedProductSha256: sha256(pair.productContent),
          requestFingerprint,
        },
        context
      );
      return context.runDatabase(() => limsEntityFromRow(getEntityRowById(context.db, request.id)));
    }
  );
}

async function publishRevisionLocked(
  input: {
    workspaceRoot: string;
    packageRoot: string;
    packageId: string;
    nextDocument: SequencePackageDocument;
    nextProductContent: string;
    kind: SequencePackageRevisionKind;
    operationId: string;
    revisionId: string;
    adoptedRevisionId?: string;
    createdAt?: string;
    expectedMarkerSha256: string;
    expectedProductSha256: string;
    requestFingerprint?: string;
    immutableAssets?: ReadonlyArray<{ path: string; sha256: string; content: string }>;
    sources?: SequencePackageRevision['sources'];
    evidenceRunId?: string;
    beforePublish?(): void;
  },
  context: RegisteredSequencePackagePublicationContext
): Promise<SequencePackagePublicationReceipt> {
  await assertLegacySequenceMetadataTransactionSettledInMain(
    input.workspaceRoot,
    input.packageRoot
  );
  const paths = sequencePackagePaths(input.packageRoot);
  const markerPath = paths.metaPath;
  const markerContent = await readContained(input.workspaceRoot, markerPath);
  const current = parseSequencePackageDocument(markerContent);
  if (current.id !== input.packageId || input.nextDocument.id !== input.packageId) {
    throw new Error('The package revision target does not match its stable entity identity.');
  }
  const productPath = sequencePackagePaths(input.packageRoot, {
    productFile: current.product.file,
  }).productPath;
  if (input.nextDocument.product.file !== current.product.file) {
    throw new Error('A sequence revision cannot silently rename the product file.');
  }
  const currentProductContent = await readContained(input.workspaceRoot, productPath);
  await verifyUserAttachments(input.workspaceRoot, input.packageRoot, current);
  await verifyUserAttachments(input.workspaceRoot, input.packageRoot, input.nextDocument);
  const requestFingerprint =
    input.requestFingerprint ??
    sha256(
      stableJson({
        packageId: input.packageId,
        kind: input.kind,
        operationId: input.operationId,
        revisionId: input.revisionId,
        adoptedRevisionId: input.adoptedRevisionId ?? null,
        expectedMarkerSha256: input.expectedMarkerSha256,
        expectedProductSha256: input.expectedProductSha256,
        nextProductSha256: sha256(input.nextProductContent),
        immutableAssets:
          input.immutableAssets?.map((asset) => ({
            path: asset.path,
            sha256: asset.sha256,
          })) ?? [],
        sources: input.sources ?? null,
        evidenceRunId: input.evidenceRunId ?? null,
        next: {
          name: input.nextDocument.name,
          product: input.nextDocument.product,
          entity: input.nextDocument.entity,
          assembly: input.nextDocument.assembly ?? null,
          members: input.nextDocument.members,
          userAttachments: input.nextDocument.userAttachments,
        },
      })
    );
  const previous = current.versionHistory.revisions.find(
    (revision) => revision.operationId === input.operationId
  );
  if (previous) {
    if (
      previous.id !== input.revisionId ||
      previous.kind !== input.kind ||
      previous.requestFingerprint !== requestFingerprint
    ) {
      throw new Error('This operation ID was already used for a different package revision.');
    }
    await verifyImmutableAssets(
      input.workspaceRoot,
      input.packageRoot,
      current,
      input.immutableAssets ?? []
    );
    return {
      revisionId: previous.id,
      snapshotPaths: [
        ...new Set(
          current.versionHistory.revisions
            .filter(
              (revision) =>
                revision.operationId === input.operationId ||
                revision.operationId === `${input.operationId}:adopted`
            )
            .map((revision) =>
              fromPackageRelative(revision.productSnapshot.path, input.packageRoot)
            )
        ),
      ],
      assetPaths: (input.immutableAssets ?? []).map((asset) =>
        fromPackageRelative(asset.path, input.packageRoot)
      ),
      markerPath,
    };
  }
  if (sha256(markerContent) !== input.expectedMarkerSha256) {
    throw new Error('Sequence package changed after this edit was prepared. Reopen and retry.');
  }
  if (sha256(currentProductContent) !== input.expectedProductSha256) {
    throw new Error('Sequence product changed after this edit was prepared. Reopen and retry.');
  }
  if (input.kind === 'sequencing-apply') {
    const run = current.evidenceRuns?.find((candidate) => candidate.id === input.evidenceRunId);
    if (!run || run.status !== 'completed' || !run.result) {
      throw new Error(
        'Sequencing application requires a completed run on the exact current reference.'
      );
    }
    const testedReferencePath = fromPackageRelative(run.reference.artifact.path, input.packageRoot);
    if (
      sha256(await readContained(input.workspaceRoot, testedReferencePath)) !==
      run.reference.artifact.sha256
    ) {
      throw new Error('Sequencing evidence reference failed integrity verification.');
    }
    const currentSequence = parseSequenceFileAsDocument(
      currentProductContent,
      productPath
    ).sequence;
    const currentTopology = currentSequence.circular ? 'circular' : 'linear';
    if (
      run.reference.sequenceRevision !== pairwiseReferenceRevision(currentSequence.sequence) ||
      run.reference.topology !== currentTopology ||
      run.reference.checkpointId !== sequenceReferenceCheckpointId(current)
    ) {
      throw new Error(
        'Sequencing application requires a completed run on the exact current reference.'
      );
    }
    const resultPath = fromPackageRelative(run.result.path, input.packageRoot);
    if (sha256(await readContained(input.workspaceRoot, resultPath)) !== run.result.sha256) {
      throw new Error('Sequencing evidence result failed integrity verification.');
    }
  }
  const head = current.versionHistory.revisions.find(
    (revision) => revision.id === current.versionHistory.headId
  );
  if (head) {
    const snapshot = await readContained(
      input.workspaceRoot,
      fromPackageRelative(head.productSnapshot.path, input.packageRoot)
    );
    if (sha256(snapshot) !== head.productSnapshot.sha256) {
      throw new Error(
        'The current sequence snapshot is missing or damaged. No revision was published.'
      );
    }
  }
  const nextProductContent = prepareAcceptedSequencePackageProduct({
    workspaceRoot: input.workspaceRoot,
    packageRoot: input.packageRoot,
    operationId: input.operationId,
    content: input.nextProductContent,
  });
  const prepared = await prepareSequencePackageRevision({
    current,
    currentProductContent,
    next: input.nextDocument,
    nextProductContent,
    kind: input.kind,
    operationId: input.operationId,
    requestFingerprint,
    revisionId: input.revisionId,
    adoptedRevisionId: input.adoptedRevisionId,
    createdAt: input.createdAt,
    sources: input.sources,
    evidenceRunId: input.evidenceRunId,
  });
  const nextMarkerContent = serializeSequencePackageDocument(prepared.document);
  const registeredPublication = await prepareRegisteredSequencePublication(context, {
    workspaceRoot: input.workspaceRoot,
    packageRoot: input.packageRoot,
    beforeMarkerContent: markerContent,
    beforeProductContent: currentProductContent,
    nextMarkerContent,
    nextProductContent,
    operationId: input.operationId,
    revisionId: input.revisionId,
    requestFingerprint,
  });
  const accepted = hasSequencePackagePublicationOwner()
    ? await publishAcceptedSequencePackage({
        workspaceRoot: input.workspaceRoot,
        packageRoot: input.packageRoot,
        packageId: input.packageId,
        operationId: input.operationId,
        beforeMarkerContent: markerContent,
        productContent: nextProductContent,
        markerContent: serializeSequencePackageDocument(prepared.document),
        files: [
          ...prepared.snapshots.map((snapshot) => ({
            path: fromPackageRelative(snapshot.path, input.packageRoot),
            content: new TextEncoder().encode(snapshot.content),
          })),
          ...(input.immutableAssets ?? []).map((asset) => ({
            path: fromPackageRelative(asset.path, input.packageRoot),
            content: new TextEncoder().encode(asset.content),
          })),
          {
            path: paths.revisionJournalPath,
            content: new TextEncoder().encode(
              JSON.stringify({
                schema: PUBLICATION_SCHEMA,
                state: 'complete',
                packageId: input.packageId,
                operationId: input.operationId,
                revisionId: input.revisionId,
                completedAt: new Date().toISOString(),
              })
            ),
          },
        ],
      })
    : null;
  if (accepted) {
    if (registeredPublication)
      await settleRegisteredSequencePublication(context, {
        ...input,
        intent: registeredPublication,
      });
    return {
      revisionId: input.revisionId,
      snapshotPaths: prepared.snapshots.map((snapshot) =>
        fromPackageRelative(snapshot.path, input.packageRoot)
      ),
      assetPaths: (input.immutableAssets ?? []).map((asset) =>
        fromPackageRelative(asset.path, input.packageRoot)
      ),
      markerPath,
      publicationPaths: [...accepted.publicationPaths],
    };
  }
  await writeAndVerifySnapshots(input.workspaceRoot, input.packageRoot, prepared);
  await writeAndVerifyImmutableAssets(
    input.workspaceRoot,
    input.packageRoot,
    prepared.document,
    input.immutableAssets ?? []
  );
  const afterProductSha256 = sha256(input.nextProductContent);
  const journal: PendingPublication = {
    schema: PUBLICATION_SCHEMA,
    state: 'pending',
    packageId: input.packageId,
    operationId: input.operationId,
    beforeMarkerSha256: sha256(markerContent),
    beforeProductSha256: sha256(currentProductContent),
    beforeMarkerContent: markerContent,
    beforeProductSnapshotPath:
      head?.productSnapshot.path ??
      prepared.document.versionHistory.revisions.find(
        (revision) => revision.id === input.adoptedRevisionId
      )?.productSnapshot.path ??
      (() => {
        throw new Error('A revision publication has no archived preimage.');
      })(),
    afterMarkerSha256: sha256(nextMarkerContent),
    afterProductSha256,
    nextMarkerContent,
    nextProductSnapshotPath: prepared.revision.productSnapshot.path,
    ...(registeredPublication ? { registeredPublication } : {}),
  };
  await writeJournal(input.workspaceRoot, input.packageRoot, journal);
  if (registeredPublication)
    await assertRegisteredSequencePublicationAccess(context, {
      ...input,
      intent: registeredPublication,
    });
  await installPending(
    input.workspaceRoot,
    input.packageRoot,
    journal,
    publicationChecks.getStore()?.beforePublish,
    input.kind === 'sequence-save'
      ? () =>
          observeSequenceSaveAfterProductForTest({
            workspaceRoot: input.workspaceRoot,
            packageRoot: input.packageRoot,
            packageId: input.packageId,
            operationId: input.operationId,
          })
      : undefined
  );
  await writeJournal(input.workspaceRoot, input.packageRoot, {
    schema: PUBLICATION_SCHEMA,
    state: 'complete',
    packageId: input.packageId,
    operationId: input.operationId,
    revisionId: input.revisionId,
    completedAt: new Date().toISOString(),
    ...(registeredPublication ? { registeredPublication } : {}),
  });
  if (registeredPublication)
    await settleRegisteredSequencePublication(context, { ...input, intent: registeredPublication });
  return {
    revisionId: input.revisionId,
    snapshotPaths: prepared.snapshots.map((snapshot) =>
      fromPackageRelative(snapshot.path, input.packageRoot)
    ),
    assetPaths: (input.immutableAssets ?? []).map((asset) =>
      fromPackageRelative(asset.path, input.packageRoot)
    ),
    markerPath,
  };
}

export async function publishAcceptedAssemblyRevisionInMain(
  request: AcceptedAssemblyRevisionPublicationRequest,
  context?: RegisteredSequencePackagePublicationContext
): Promise<AcceptedAssemblyRevisionPublicationResult> {
  const { packageRoot, packageId, acceptedVersionId, workspaceRoot } = request;
  if (
    !packageRoot ||
    !packageId ||
    !acceptedVersionId ||
    !/^sha256:[a-f0-9]{64}$/.test(request.expectedMarkerSha256) ||
    !/^sha256:[a-f0-9]{64}$/.test(request.expectedProductSha256)
  ) {
    throw new Error('Accepted assembly revision request is invalid.');
  }
  const next = parseSequencePackageDocument(serializeSequencePackageDocument(request.nextDocument));
  if (
    next.id !== packageId ||
    next.assembly?.accepted?.acceptedAssemblyVersionId !== acceptedVersionId
  ) {
    throw new Error('Accepted assembly revision identity does not match the package.');
  }
  if (request.primerAssets.length !== 2) {
    throw new Error('Accepted assembly revision requires its exact two primer exports.');
  }
  const artifacts = next.assembly.accepted.artifacts;
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    throw new Error('Accepted assembly primer artifact references are missing.');
  }
  const refs = artifacts as Record<string, unknown>;
  if (typeof refs.primerCsvPath !== 'string' || typeof refs.primerFastaPath !== 'string') {
    throw new Error('Accepted assembly primer artifact references are invalid.');
  }
  const expectedPaths = [refs.primerCsvPath, refs.primerFastaPath];
  for (const [index, asset] of request.primerAssets.entries()) {
    if (
      asset.path !== expectedPaths[index] ||
      sha256(asset.content) !== asset.sha256 ||
      !next.members.some(
        (member) =>
          member.path === asset.path && member.role === 'primer-export' && !member.replaceable
      )
    ) {
      throw new Error(
        'Accepted assembly primer export does not match its immutable package member.'
      );
    }
  }
  const operationId = `assembly-finalization:${acceptedVersionId}`;
  const receipt = await publishSequencePackageRevisionInMain(
    {
      workspaceRoot,
      packageRoot,
      packageId,
      nextDocument: next,
      nextProductContent: request.nextProductContent,
      kind: 'assembly-finalization',
      operationId,
      revisionId: operationId,
      adoptedRevisionId: `adopted-before:${acceptedVersionId}`,
      expectedMarkerSha256: request.expectedMarkerSha256,
      expectedProductSha256: request.expectedProductSha256,
      immutableAssets: request.primerAssets,
    },
    context
  );
  return {
    revisionId: receipt.revisionId,
    markerContent: await readContained(workspaceRoot, receipt.markerPath),
    snapshotPaths: receipt.snapshotPaths,
    assetPaths: receipt.assetPaths,
  };
}

interface BuiltRestorePreview {
  preview: SequenceRestorePreviewResult;
  next: SequencePackageDocument;
  nextProductContent: string;
}

export async function previewSequenceRestoreInMain(
  request: SequenceRestorePreviewRequest
): Promise<SequenceRestorePreviewResult> {
  return (await buildRestorePreview(request)).preview;
}

export async function applySequenceRestoreInMain(
  request: SequenceRestoreApplyRequest,
  context?: RegisteredSequencePackagePublicationContext
): Promise<SequenceRestoreApplyResult> {
  if (
    !request.operationId ||
    request.operationId.length > 256 ||
    !/^sha256:[a-f0-9]{64}$/.test(request.previewFingerprint)
  ) {
    throw new Error('Restore operation identity or preview fingerprint is invalid.');
  }
  const operationId = `restore:${request.operationId}`;
  const requestFingerprint = sha256(
    stableJson({
      packageId: request.packageId,
      operationId,
      previewFingerprint: request.previewFingerprint,
      selections: canonicalRestoreSelections(request.selections),
    })
  );
  await recoverSequencePackageRevisionPublicationInMain(
    request.workspaceRoot,
    request.packageRoot,
    context
  );
  await assertLegacySequenceMetadataTransactionSettledInMain(
    request.workspaceRoot,
    request.packageRoot
  );
  const markerPath = sequencePackagePaths(request.packageRoot).metaPath;
  const currentMarker = await readContained(request.workspaceRoot, markerPath);
  const current = parseSequencePackageDocument(currentMarker);
  if (current.id !== request.packageId) throw new Error('Restore package identity changed.');
  const previous = current.versionHistory.revisions.find(
    (revision) => revision.operationId === operationId
  );
  if (previous) {
    if (previous.requestFingerprint !== requestFingerprint) {
      throw new Error('Restore operation ID was already used for a different preview.');
    }
    const content = await readContained(
      request.workspaceRoot,
      fromPackageRelative(previous.productSnapshot.path, request.packageRoot)
    );
    await verifySequencePackageSnapshot({ revision: previous, content });
    return {
      revisionId: previous.id,
      alreadyPublished: true,
      markerContent: currentMarker,
      snapshotPaths: [fromPackageRelative(previous.productSnapshot.path, request.packageRoot)],
    };
  }
  const built = await buildRestorePreview(request);
  if (built.preview.previewFingerprint !== request.previewFingerprint) {
    throw new Error('Restore preview is stale. Preview the current package again.');
  }
  if (built.preview.blockers.length > 0) {
    throw new Error(`Restore is blocked: ${built.preview.blockers.join(' ')}`);
  }
  const receipt = await publishSequencePackageRevisionInMain(
    {
      workspaceRoot: request.workspaceRoot,
      packageRoot: request.packageRoot,
      packageId: request.packageId,
      nextDocument: built.next,
      nextProductContent: built.nextProductContent,
      kind: 'restore',
      operationId,
      revisionId: operationId,
      expectedMarkerSha256: built.preview.currentMarkerSha256,
      expectedProductSha256: built.preview.currentProductSha256,
      requestFingerprint,
      sources: built.preview.selectedSources,
    },
    context
  );
  return {
    revisionId: receipt.revisionId,
    alreadyPublished: false,
    markerContent: await readContained(request.workspaceRoot, receipt.markerPath),
    snapshotPaths: receipt.snapshotPaths,
    publicationPaths: receipt.publicationPaths,
  };
}

async function buildRestorePreview(
  request: SequenceRestorePreviewRequest
): Promise<BuiltRestorePreview> {
  if (
    !request.packageId ||
    !request.packageRoot ||
    !request.workspaceRoot ||
    !Array.isArray(request.selections) ||
    request.selections.length === 0 ||
    request.selections.length > 256
  ) {
    throw new Error('Restore requires a bounded selection of saved package items.');
  }
  await assertLegacySequenceMetadataTransactionSettledInMain(
    request.workspaceRoot,
    request.packageRoot
  );
  const journal = journalPath(request.packageRoot);
  if (await exists(journal)) {
    const record = parseJournal(await readContained(request.workspaceRoot, journal));
    if (record.state === 'pending') {
      throw new Error('A package publication is pending recovery. Restore cannot preview it.');
    }
  }
  const markerPath = sequencePackagePaths(request.packageRoot).metaPath;
  const markerContent = await readContained(request.workspaceRoot, markerPath);
  const current = parseSequencePackageDocument(markerContent);
  if (current.id !== request.packageId) throw new Error('Restore package identity changed.');
  const head = current.versionHistory.revisions.find(
    (revision) => revision.id === current.versionHistory.headId
  );
  if (!head)
    throw new Error('This legacy package has no archived current version to restore against.');
  if (
    stableJson({
      name: current.name,
      product: current.product,
      entity: current.entity,
      acceptedAssembly: current.assembly?.accepted ?? null,
    }) !==
    stableJson({
      name: head.state.name,
      product: head.state.product,
      entity: head.state.entity,
      acceptedAssembly: head.state.acceptedAssembly,
    })
  ) {
    throw new Error(
      'Current package metadata differs from its published head. Reconcile it before Restore.'
    );
  }
  const productPath = sequencePackagePaths(request.packageRoot, {
    productFile: current.product.file,
  }).productPath;
  const currentProductContent = await readContained(request.workspaceRoot, productPath);
  await verifySequencePackageSnapshot({ revision: head, content: currentProductContent });
  await verifyUserAttachments(request.workspaceRoot, request.packageRoot, current);
  const assemblyWorkingCopyPin = await readAssemblyWorkingCopyPin(
    request.workspaceRoot,
    request.packageRoot,
    current
  );
  const selections = canonicalRestoreSelections(request.selections);
  const hasProductSelection = selections.some(
    (selection) => selection.itemId === RESTORE_PRODUCT_ITEM
  );
  const hasAnnotationSelection = selections.some(
    (selection) => annotationIdForRestoreItem(selection.itemId) !== null
  );
  const knownItems = new Set(sequenceRestoreItemCatalog(current).map((item) => item.id));
  const seen = new Set<string>();
  const selectedSources: SequenceRestorePreviewResult['selectedSources'] = {};
  const changedItems: string[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (hasProductSelection && hasAnnotationSelection) {
    blockers.push(
      'A complete product snapshot already contains its annotations. Choose the product or individual annotations, not both.'
    );
  }
  let nextProductContent = currentProductContent;
  for (const selection of selections) {
    if (!knownItems.has(selection.itemId) || seen.has(selection.itemId)) {
      throw new Error(`Unknown or duplicate restore item: ${selection.itemId}`);
    }
    seen.add(selection.itemId);
    const sourceRevision = current.versionHistory.revisions.find(
      (revision) => revision.id === selection.revisionId
    );
    if (!sourceRevision) throw new Error(`Unknown restore source: ${selection.revisionId}`);
    const sourceValue = sourceValueForRestoreItem(sourceRevision, selection.itemId);
    const annotationId = annotationIdForRestoreItem(selection.itemId);
    if (annotationId !== null) {
      const sourceContent = await readContained(
        request.workspaceRoot,
        fromPackageRelative(sourceRevision.productSnapshot.path, request.packageRoot)
      );
      await verifySequencePackageSnapshot({ revision: sourceRevision, content: sourceContent });
      try {
        const sourceHasAnnotation = listManagedGenBankAnnotations(sourceContent).some(
          (item) => item.id === annotationId
        );
        if (sourceHasAnnotation !== sourceValue.present) {
          throw new Error('The saved annotation catalog does not match its product snapshot.');
        }
        const sourceDigest = await managedGenBankAnnotationValueDigest(sourceContent, annotationId);
        selectedSources[selection.itemId] = {
          revisionId: sourceRevision.id,
          valueSha256: sourceDigest.valueSha256,
        };
        if (!hasProductSelection) {
          const currentHasAnnotation = listManagedGenBankAnnotations(nextProductContent).some(
            (item) => item.id === annotationId
          );
          const transfer = {
            currentContent: nextProductContent,
            sourceContent,
            annotationId,
            currentFrameId: annotationFrameId(nextProductContent, productPath),
            sourceFrameId: annotationFrameId(sourceContent, productPath),
          };
          const before = nextProductContent;
          nextProductContent = sourceHasAnnotation
            ? currentHasAnnotation
              ? replaceManagedGenBankAnnotation(transfer)
              : insertManagedGenBankAnnotation(transfer)
            : currentHasAnnotation
              ? removeManagedGenBankAnnotation(transfer)
              : nextProductContent;
          if (before !== nextProductContent) changedItems.push(selection.itemId);
        }
      } catch (error) {
        blockers.push(
          error instanceof Error ? error.message : 'The annotation cannot be restored.'
        );
      }
      continue;
    }
    const attachmentId = userAttachmentIdForRestoreItem(selection.itemId);
    if (attachmentId !== null && sourceValue.present) {
      await verifyUserAttachments(request.workspaceRoot, request.packageRoot, current, {
        [attachmentId]: sourceValue.value as NonNullable<(typeof current.userAttachments)[string]>,
      });
    }
    const sourceDigest =
      selection.itemId === RESTORE_PRODUCT_ITEM
        ? sourceRevision.productSnapshot.sha256
        : sha256(stableJson(sourceValue));
    selectedSources[selection.itemId] = {
      revisionId: sourceRevision.id,
      valueSha256: sourceDigest,
    };
    if (selection.itemId === RESTORE_PRODUCT_ITEM) {
      nextProductContent = await readContained(
        request.workspaceRoot,
        fromPackageRelative(sourceRevision.productSnapshot.path, request.packageRoot)
      );
      await verifySequencePackageSnapshot({
        revision: sourceRevision,
        content: nextProductContent,
      });
      if (sha256(currentProductContent) !== sourceDigest) changedItems.push(selection.itemId);
    } else {
      const currentValue =
        attachmentId !== null
          ? {
              present: current.userAttachments[attachmentId] !== undefined,
              value: current.userAttachments[attachmentId],
            }
          : sourceValueForRestoreItem(head, selection.itemId);
      if (sha256(stableJson(currentValue)) !== sourceDigest) changedItems.push(selection.itemId);
    }
  }
  const composed = composeSequenceRestore({
    current,
    selections,
    revisions: current.versionHistory.revisions,
  });
  blockers.push(...composed.blockers);
  const next = composed.next;
  await verifyUserAttachments(request.workspaceRoot, request.packageRoot, next);
  if (seen.has(RESTORE_TOPOLOGY_ITEM)) {
    const sourceRevision = current.versionHistory.revisions.find(
      (revision) =>
        revision.id ===
        selections.find((selection) => selection.itemId === RESTORE_TOPOLOGY_ITEM)?.revisionId
    );
    const topology = sourceRevision?.state.product.topology;
    if (topology !== 'linear' && topology !== 'circular') {
      blockers.push('The selected topology is unavailable.');
    } else {
      nextProductContent = updateGenBankLocusMetadata(nextProductContent, { topology });
    }
  }
  if (seen.has(RESTORE_GENETIC_CODE_ITEM)) {
    const sourceRevision = current.versionHistory.revisions.find(
      (revision) =>
        revision.id ===
        selections.find((selection) => selection.itemId === RESTORE_GENETIC_CODE_ITEM)?.revisionId
    );
    if (
      !sourceRevision ||
      !Object.prototype.hasOwnProperty.call(sourceRevision.state, 'geneticCode')
    ) {
      blockers.push('The selected genetic code is unavailable.');
    } else {
      nextProductContent = updateGenBankGeneticCodeComment(
        nextProductContent,
        sourceRevision.state.geneticCode ?? null
      );
    }
  }
  if (
    seen.has(RESTORE_PRODUCT_ITEM) ||
    hasAnnotationSelection ||
    seen.has(RESTORE_TOPOLOGY_ITEM) ||
    seen.has(RESTORE_GENETIC_CODE_ITEM)
  ) {
    const nextSequence = parseSequenceFileAsDocument(nextProductContent, productPath).sequence;
    next.product.genBankChecksum = await computeChecksum(nextProductContent);
    next.product.sequenceChecksum = await computeChecksum(nextSequence.sequence);
    next.product.topology = nextSequence.circular ? 'circular' : 'linear';
  }
  const expectedAcceptedHash = acceptedProductChecksum(next.assembly?.accepted);
  if (seen.has(RESTORE_ASSEMBLY_ITEM)) {
    if (next.assembly?.accepted && !expectedAcceptedHash) {
      blockers.push('The selected saved assembly has no verifiable product reference.');
    } else if (expectedAcceptedHash && expectedAcceptedHash !== sha256(nextProductContent)) {
      warnings.push(
        'The selected saved assembly remains historical; it did not produce the composed sequence bytes.'
      );
    }
  } else if (expectedAcceptedHash && expectedAcceptedHash !== sha256(nextProductContent)) {
    warnings.push(
      'The retained saved assembly is historical; it did not produce the composed sequence bytes.'
    );
  }
  const markerAfter = await readContained(request.workspaceRoot, markerPath);
  if (
    markerAfter !== markerContent ||
    sha256(await readContained(request.workspaceRoot, productPath)) !==
      sha256(currentProductContent)
  ) {
    throw new Error('The package changed during Restore preview. Preview again.');
  }
  if (await exists(journal)) {
    const record = parseJournal(await readContained(request.workspaceRoot, journal));
    if (record.state === 'pending')
      throw new Error('A package publication began during Restore preview.');
  }
  if (
    stableJson(
      await readAssemblyWorkingCopyPin(request.workspaceRoot, request.packageRoot, current)
    ) !== stableJson(assemblyWorkingCopyPin)
  ) {
    throw new Error('The assembly working copy changed during Restore preview. Preview again.');
  }
  const currentMarkerSha256 = sha256(markerContent);
  const currentProductSha256 = sha256(currentProductContent);
  const previewFingerprint = sha256(
    stableJson({
      packageId: request.packageId,
      currentHeadId: head.id,
      currentMarkerSha256,
      currentProductSha256,
      assemblyWorkingCopyPin,
      selections,
      selectedSources,
      nextProductSha256: sha256(nextProductContent),
      next: {
        name: next.name,
        product: next.product,
        entity: next.entity,
        assembly: next.assembly ?? null,
        userAttachments: next.userAttachments,
      },
    })
  );
  return {
    preview: {
      previewFingerprint,
      currentHeadId: head.id,
      currentMarkerSha256,
      currentProductSha256,
      selectedSources,
      changedItems,
      blockers,
      warnings,
    },
    next,
    nextProductContent,
  };
}

async function readAssemblyWorkingCopyPin(
  workspaceRoot: string,
  packageRoot: string,
  document: SequencePackageDocument
): Promise<{ id: string; path: string; createdAt: string; sha256: string } | null> {
  const member = sequenceAssemblyWorkingCopyMember(document);
  if (!member) {
    const unregisteredPath = fromPackageRelative(ASSEMBLY_WORKING_COPY_RELATIVE_PATH, packageRoot);
    if (await exists(unregisteredPath)) {
      throw new Error('An unregistered assembly working copy blocks Restore preview.');
    }
    return null;
  }
  const safe = await canonicalWorkspacePath({
    workspaceRoot,
    path: sequenceAssemblyWorkingCopyPath(packageRoot, member),
    artifactNoun: 'assembly working copy',
  });
  const content = await readFile(safe.candidate);
  return {
    id: member.id,
    path: member.path,
    createdAt: member.createdAt,
    sha256: sha256(content),
  };
}

function canonicalRestoreSelections(
  selections: readonly { itemId: string; revisionId: string }[]
): Array<{ itemId: string; revisionId: string }> {
  return [...selections].sort((left, right) =>
    left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0
  );
}

function acceptedProductChecksum(accepted: Record<string, unknown> | undefined): string | null {
  const artifacts = accepted?.artifacts;
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) return null;
  const checksum = (artifacts as Record<string, unknown>).productGenBankChecksum;
  return typeof checksum === 'string' && /^sha256:[a-f0-9]{64}$/.test(checksum) ? checksum : null;
}

function annotationFrameId(content: string, productPath: string): string {
  const sequence = parseSequenceFileAsDocument(content, productPath).sequence;
  return sha256(JSON.stringify([sequence.sequence.toUpperCase(), Boolean(sequence.circular)]));
}

export async function publishSequenceMetadataRevisionInMain(
  input: {
    workspaceRoot: string;
    request: SequenceMetadataRevisionRequest;
  },
  context?: RegisteredSequencePackagePublicationContext
): Promise<SequenceMetadataRevisionResult> {
  const { request, workspaceRoot } = input;
  if (
    request.document.kind !== 'managed-sequence' ||
    !request.document.packageId ||
    !request.document.packageRoot ||
    !/^sha256:[a-f0-9]{64}$/.test(request.expectedMarkerSha256) ||
    !request.operationId ||
    request.operationId.length > 256
  ) {
    throw new Error('Sequence metadata revision request is invalid.');
  }
  await recoverSequencePackageRevisionPublicationInMain(
    workspaceRoot,
    request.document.packageRoot,
    context
  );
  await assertLegacySequenceMetadataTransactionSettledInMain(
    workspaceRoot,
    request.document.packageRoot
  );
  const paths = sequencePackagePaths(request.document.packageRoot);
  const markerContent = await readContained(workspaceRoot, paths.metaPath);
  const revisionId = `metadata-update:${request.operationId}`;
  const requestFingerprint = sha256(stableJson(request));
  const onDisk = parseSequencePackageDocument(markerContent);
  const alreadyPublished = onDisk.versionHistory.revisions.find(
    (revision) => revision.operationId === revisionId
  );
  if (alreadyPublished) {
    if (alreadyPublished.requestFingerprint !== requestFingerprint) {
      throw new Error('This metadata operation ID was already used for a different edit.');
    }
    const parent = onDisk.versionHistory.revisions.find(
      (revision) => revision.id === alreadyPublished.parentId
    );
    return {
      updatedMarkerContent: markerContent,
      revisionId,
      productChanged: parent?.productSnapshot.sha256 !== alreadyPublished.productSnapshot.sha256,
      snapshotPaths: [],
      alreadyPublished: true,
    };
  }
  if (sha256(markerContent) !== request.expectedMarkerSha256) {
    throw new Error('Sequence metadata changed after it was opened. Reopen and retry.');
  }
  const current = parseSequencePackageDocument(markerContent);
  if (current.id !== request.document.packageId) {
    throw new Error('Sequence metadata package identity changed.');
  }
  const productPath = sequencePackagePaths(request.document.packageRoot, {
    productFile: current.product.file,
  }).productPath;
  const beforeProduct = await readContained(workspaceRoot, productPath);
  const { next, afterProduct, productChanged, changed } = await prepareSequenceMetadataEdit({
    current,
    proposed: request.proposed,
    beforeProduct,
    productPath,
  });
  if (!changed) {
    return {
      updatedMarkerContent: markerContent,
      revisionId: null,
      productChanged: false,
      snapshotPaths: [],
    };
  }
  const receipt = await publishSequencePackageRevisionInMain(
    {
      workspaceRoot,
      packageRoot: request.document.packageRoot,
      packageId: request.document.packageId,
      nextDocument: next,
      nextProductContent: afterProduct,
      kind: 'metadata-update',
      operationId: revisionId,
      revisionId,
      adoptedRevisionId: `adopted-before:${request.operationId}`,
      expectedMarkerSha256: request.expectedMarkerSha256,
      expectedProductSha256: sha256(beforeProduct),
      requestFingerprint,
    },
    context
  );
  const updatedMarkerContent = await readContained(workspaceRoot, paths.metaPath);
  const updatedDocument = parseSequencePackageDocument(updatedMarkerContent);
  const published = updatedDocument.versionHistory.revisions.find(
    (revision) => revision.id === revisionId
  );
  const parent = updatedDocument.versionHistory.revisions.find(
    (revision) => revision.id === published?.parentId
  );
  return {
    updatedMarkerContent,
    revisionId,
    productChanged: published
      ? parent?.productSnapshot.sha256 !== published.productSnapshot.sha256
      : productChanged,
    snapshotPaths: receipt.snapshotPaths,
  };
}

export async function readCheckedManagedSequenceRegistrySnapshot(
  suppliedContext: RegisteredSequencePackagePublicationContext,
  input: { entityId: string; workspaceRoot: string; packageRoot: string }
) {
  const context = { ...suppliedContext, lifecyclePublication: true as const };
  return withPackagePublicationLock(input.packageRoot, async () => {
    const path = journalPath(input.packageRoot);
    if (await exists(path)) {
      const journal = parseJournal(await readContained(input.workspaceRoot, path));
      if (journal.packageId !== input.entityId || journal.state === 'pending')
        throw new Error('Finish the pending sequence publication before reviewing registration.');
      if (journal.state === 'complete' && journal.registeredPublication) {
        await assertRegisteredSequencePublicationAccess(context, {
          ...input,
          intent: journal.registeredPublication,
        });
        if (
          !context.runDatabase(() =>
            hasSettledRegisteredSequencePublicationInDb(context, journal.registeredPublication!)
          )
        )
          throw new Error('Finish the saved sequence publication before reviewing registration.');
      }
    }
    return readCheckedManagedSequencePair(context, input);
  });
}

export async function recoverSequencePackageRevisionPublicationInMain(
  workspaceRoot: string,
  packageRoot: string,
  suppliedContext?: RegisteredSequencePackagePublicationContext | PublicationChecks,
  checks: PublicationChecks = {}
): Promise<void> {
  const context = await sequencePackagePublicationContext(suppliedContext);
  return publicationChecks.run(
    { ...(suppliedContext && !('db' in suppliedContext) ? suppliedContext : {}), ...checks },
    () =>
      withPackagePublicationLock(packageRoot, async () => {
        if (
          (await recoverRevisionPublicationLocked(workspaceRoot, packageRoot, context)) ===
          'review_pending'
        )
          return;
        await assertRegisteredSequencePackageCurrent(context, {
          workspaceRoot,
          packageRoot,
          markerContent: await readContained(
            workspaceRoot,
            sequencePackagePaths(packageRoot).metaPath
          ),
        });
      })
  );
}

export async function withPublishedSequenceEvidenceMutationInMain<T>(
  workspaceRoot: string,
  packageRoot: string,
  work: (
    publishMarker: (before: string, next: SequencePackageDocument) => Promise<void>
  ) => Promise<T>,
  suppliedContext?: RegisteredSequencePackagePublicationContext,
  beforePublish?: () => void
): Promise<T> {
  const context = await sequencePackagePublicationContext(suppliedContext);
  return withPackagePublicationLock(packageRoot, async () => {
    await recoverRevisionPublicationLocked(workspaceRoot, packageRoot, context);
    const markerPath = sequencePackagePaths(packageRoot).metaPath;
    const registered = await assertRegisteredSequencePackageCurrent(context, {
      workspaceRoot,
      packageRoot,
      markerContent: await readContained(workspaceRoot, markerPath),
    });
    return work(async (before, next) => {
      beforePublish?.();
      const currentRegistration = await assertRegisteredSequencePackageCurrent(context, {
        workspaceRoot,
        packageRoot,
        markerContent: before,
      });
      if (Boolean(registered) !== Boolean(currentRegistration))
        throw new Error(
          'Sequence registration changed while preparing its saved evidence. Retry the operation.'
        );
      if (!registered) {
        if (hasSequencePackagePublicationOwner()) {
          const current = parseSequencePackageDocument(before);
          const productContent = await readContained(
            workspaceRoot,
            sequencePackagePaths(packageRoot, { productFile: current.product.file }).productPath
          );
          const markerContent = serializeSequencePackageDocument(next);
          const accepted = await publishAcceptedSequencePackage({
            workspaceRoot,
            packageRoot,
            packageId: current.id,
            operationId: `evidence-update:${sha256(stableJson({ before, markerContent, productContent })).slice('sha256:'.length)}`,
            beforeMarkerContent: before,
            productContent,
            markerContent,
            beforePublish,
          });
          if (!accepted) throw new Error('The accepted evidence publication owner changed.');
          return;
        }
        await writeWorkspaceTextFileAtomicInMain(
          {
            workspaceRoot,
            path: markerPath,
            mode: 'replace',
            expectedContentHash: sha256(before).slice('sha256:'.length),
            content: serializeSequencePackageDocument(next),
            artifactNoun: 'sequence evidence',
          },
          { durable: true, beforePublish }
        );
        return;
      }
      const current = parseSequencePackageDocument(before);
      const productContent = await readContained(
        workspaceRoot,
        sequencePackagePaths(packageRoot, {
          productFile: current.product.file,
        }).productPath
      );
      const requestFingerprint = sha256(
        stableJson({
          beforeMarkerSha256: sha256(before),
          nextMarkerSha256: sha256(serializeSequencePackageDocument(next)),
          productSha256: sha256(productContent),
        })
      );
      const operationId = `evidence-update:${requestFingerprint.slice('sha256:'.length)}`;
      beforePublish?.();
      await publishRevisionLocked(
        {
          workspaceRoot,
          packageRoot,
          packageId: current.id,
          nextDocument: next,
          nextProductContent: productContent,
          kind: 'metadata-update',
          operationId,
          revisionId: operationId,
          expectedMarkerSha256: sha256(before),
          expectedProductSha256: sha256(productContent),
          requestFingerprint,
        },
        context
      );
    });
  });
}

export async function withRecoveredSequencePackageMutationInMain<T>(
  workspaceRoot: string,
  packageRoot: string,
  work: () => Promise<T>,
  suppliedContext?: RegisteredSequencePackagePublicationContext | PublicationChecks,
  checks: PublicationChecks = {}
): Promise<T> {
  const context = await sequencePackagePublicationContext(suppliedContext);
  return publicationChecks.run(
    { ...(suppliedContext && !('db' in suppliedContext) ? suppliedContext : {}), ...checks },
    () =>
      withPackagePublicationLock(packageRoot, async () => {
        await assertUnversionedSequencePackageMutationAllowed(context, [packageRoot]);
        try {
          await recoverRevisionPublicationLocked(workspaceRoot, packageRoot, context);
        } catch (error) {
          const failure = new Error(error instanceof Error ? error.message : String(error));
          failure.name = 'SequencePackagePublicationRecoveryError';
          throw failure;
        }
        return work();
      })
  );
}

async function withRegisteredSequenceRevisionMutation<T>(
  context: RegisteredSequencePackagePublicationContext,
  workspaceRoot: string,
  packageRoot: string,
  work: () => Promise<T>
): Promise<T> {
  return withPackagePublicationLock(packageRoot, async () => {
    try {
      await recoverRevisionPublicationLocked(workspaceRoot, packageRoot, context);
      await assertRegisteredSequencePackageCurrent(context, {
        workspaceRoot,
        packageRoot,
        markerContent: await readContained(
          workspaceRoot,
          sequencePackagePaths(packageRoot).metaPath
        ),
      });
    } catch (error) {
      const failure = new Error(error instanceof Error ? error.message : String(error));
      failure.name = 'SequencePackagePublicationRecoveryError';
      throw failure;
    }
    return work();
  });
}

async function recoverRevisionPublicationLocked(
  workspaceRoot: string,
  packageRoot: string,
  context: RegisteredSequencePackagePublicationContext
): Promise<'review_pending' | void> {
  const path = journalPath(packageRoot);
  if (!(await exists(path))) return;
  const journal = parseJournal(await readContained(workspaceRoot, path));
  if (
    journal.registeredPublication?.organizationResolution &&
    !context.organizationResolution &&
    !context.runDatabase(() =>
      hasSettledRegisteredSequencePublicationInDb(context, journal.registeredPublication!)
    )
  ) {
    return 'review_pending';
  }
  if (journal.state !== 'pending') {
    if (journal.state === 'complete' && journal.registeredPublication)
      await settleRegisteredSequencePublication(context, {
        workspaceRoot,
        packageRoot,
        intent: journal.registeredPublication,
      });
    return;
  }
  if (journal.registeredPublication) {
    await assertRegisteredSequencePublicationAccess(context, {
      workspaceRoot,
      packageRoot,
      intent: journal.registeredPublication,
    });
  } else {
    const checked = await assertRegisteredSequencePackageCurrent(context, {
      workspaceRoot,
      packageRoot,
      markerContent: await readContained(workspaceRoot, sequencePackagePaths(packageRoot).metaPath),
    });
    if (checked)
      throw new Error('An unfinished sequence revision has no registered publication authority.');
  }
  publicationChecks.getStore()?.onPendingRecovery?.();
  const marker = parseSequencePackageDocument(journal.nextMarkerContent);
  if (marker.id !== journal.packageId) {
    throw new Error('Pending sequence revision has a different package identity.');
  }
  if (sha256(journal.nextMarkerContent) !== journal.afterMarkerSha256) {
    throw new Error('Pending sequence revision marker integrity failed.');
  }
  let afterProductValid = false;
  try {
    const afterProduct = await readContained(
      workspaceRoot,
      fromPackageRelative(journal.nextProductSnapshotPath, packageRoot)
    );
    afterProductValid = sha256(afterProduct) === journal.afterProductSha256;
  } catch {
    afterProductValid = false;
  }
  if (!afterProductValid) {
    if (journal.registeredPublication?.organizationResolution)
      throw new Error(
        'The approved sequence snapshot is unavailable; its exact resolution was retained.'
      );
    await rollbackPending(workspaceRoot, packageRoot, journal);
    await writeJournal(workspaceRoot, packageRoot, {
      schema: PUBLICATION_SCHEMA,
      state: 'aborted',
      packageId: journal.packageId,
      operationId: journal.operationId,
      revisionId: marker.versionHistory.headId ?? journal.operationId,
      completedAt: new Date().toISOString(),
    });
    return;
  }
  await installPending(workspaceRoot, packageRoot, journal);
  const revision = marker.versionHistory.revisions.find((entry) =>
    journal.registeredPublication?.organizationResolution
      ? entry.id === journal.registeredPublication.revisionId
      : entry.operationId === journal.operationId
  );
  if (!revision) throw new Error('Pending sequence revision is absent from its marker.');
  await writeJournal(workspaceRoot, packageRoot, {
    schema: PUBLICATION_SCHEMA,
    state: 'complete',
    packageId: journal.packageId,
    operationId: journal.operationId,
    revisionId: revision.id,
    completedAt: new Date().toISOString(),
    ...(journal.registeredPublication
      ? { registeredPublication: journal.registeredPublication }
      : {}),
  });
  if (journal.registeredPublication)
    await settleRegisteredSequencePublication(context, {
      workspaceRoot,
      packageRoot,
      intent: journal.registeredPublication,
    });
}

async function rollbackPending(
  workspaceRoot: string,
  packageRoot: string,
  journal: PendingPublication,
  beforePublish: (() => void) | undefined = publicationChecks.getStore()?.beforePublish
): Promise<void> {
  if (sha256(journal.beforeMarkerContent) !== journal.beforeMarkerSha256) {
    throw new Error('Pending sequence revision preimage marker integrity failed.');
  }
  const beforeProduct = await readContained(
    workspaceRoot,
    fromPackageRelative(journal.beforeProductSnapshotPath, packageRoot)
  );
  if (sha256(beforeProduct) !== journal.beforeProductSha256) {
    throw new Error('Pending sequence revision preimage product integrity failed.');
  }
  const beforeMarker = parseSequencePackageDocument(journal.beforeMarkerContent);
  if (beforeMarker.id !== journal.packageId) {
    throw new Error('Pending sequence revision preimage identity changed.');
  }
  const paths = sequencePackagePaths(packageRoot, { productFile: beforeMarker.product.file });
  const currentProductHash = sha256(await readContained(workspaceRoot, paths.productPath));
  const currentMarkerHash = sha256(await readContained(workspaceRoot, paths.metaPath));
  if (
    ![journal.beforeProductSha256, journal.afterProductSha256].includes(currentProductHash) ||
    ![journal.beforeMarkerSha256, journal.afterMarkerSha256].includes(currentMarkerHash)
  ) {
    throw new Error('Pending sequence revision cannot roll back externally changed files.');
  }
  if (currentProductHash !== journal.beforeProductSha256) {
    await replaceContained(
      workspaceRoot,
      paths.productPath,
      currentProductHash,
      beforeProduct,
      beforePublish
    );
  }
  if (currentMarkerHash !== journal.beforeMarkerSha256) {
    await replaceContained(
      workspaceRoot,
      paths.metaPath,
      currentMarkerHash,
      journal.beforeMarkerContent,
      beforePublish
    );
  }
}

async function withPackagePublicationLock<T>(
  packageRoot: string,
  work: () => Promise<T>
): Promise<T> {
  const lockKey = await realpath(packageRoot);
  const previous = packagePublicationTails.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => turn);
  packagePublicationTails.set(lockKey, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (packagePublicationTails.get(lockKey) === tail) {
      packagePublicationTails.delete(lockKey);
    }
  }
}

async function installPending(
  workspaceRoot: string,
  packageRoot: string,
  journal: PendingPublication,
  beforePublish: (() => void) | undefined = publicationChecks.getStore()?.beforePublish,
  afterProductForTest?: () => Promise<void> | undefined
): Promise<void> {
  const marker = parseSequencePackageDocument(journal.nextMarkerContent);
  const paths = sequencePackagePaths(packageRoot, { productFile: marker.product.file });
  const product = await readContained(workspaceRoot, paths.productPath);
  const productHash = sha256(product);
  if (productHash !== journal.beforeProductSha256 && productHash !== journal.afterProductSha256) {
    throw new Error('Pending sequence revision conflicts with externally changed product bytes.');
  }
  const markerContent = await readContained(workspaceRoot, paths.metaPath);
  const markerHash = sha256(markerContent);
  if (markerHash !== journal.beforeMarkerSha256 && markerHash !== journal.afterMarkerSha256) {
    throw new Error('Pending sequence revision conflicts with a newer package marker.');
  }
  if (productHash === journal.beforeProductSha256 && productHash !== journal.afterProductSha256) {
    const afterProduct = await readContained(
      workspaceRoot,
      fromPackageRelative(journal.nextProductSnapshotPath, packageRoot)
    );
    await replaceContained(
      workspaceRoot,
      paths.productPath,
      productHash,
      afterProduct,
      beforePublish
    );
    await afterProductForTest?.();
  }
  if (markerHash === journal.beforeMarkerSha256 && markerHash !== journal.afterMarkerSha256) {
    await replaceContained(
      workspaceRoot,
      paths.metaPath,
      markerHash,
      journal.nextMarkerContent,
      beforePublish
    );
  }
}

async function writeAndVerifySnapshots(
  workspaceRoot: string,
  packageRoot: string,
  prepared: PreparedSequencePackageRevision,
  beforePublish: (() => void) | undefined = publicationChecks.getStore()?.beforePublish
): Promise<void> {
  for (const snapshot of prepared.snapshots) {
    const path = fromPackageRelative(snapshot.path, packageRoot);
    if (await exists(path)) {
      const current = await readContained(workspaceRoot, path);
      if (sha256(current) !== snapshot.sha256) {
        throw new Error(`Immutable sequence snapshot conflicts at ${snapshot.path}.`);
      }
      continue;
    }
    await writeWorkspaceTextFileAtomicInMain(
      {
        workspaceRoot,
        path,
        mode: 'create',
        content: snapshot.content,
        artifactNoun: 'sequence snapshot',
      },
      { durable: true, beforePublish }
    );
    if (sha256(await readContained(workspaceRoot, path)) !== snapshot.sha256) {
      throw new Error(`Sequence snapshot write could not be verified: ${snapshot.path}.`);
    }
  }
}

async function writeAndVerifyImmutableAssets(
  workspaceRoot: string,
  packageRoot: string,
  document: SequencePackageDocument,
  assets: ReadonlyArray<{ path: string; sha256: string; content: string }>,
  beforePublish: (() => void) | undefined = publicationChecks.getStore()?.beforePublish
): Promise<void> {
  const seen = new Set<string>();
  for (const asset of assets) {
    if (seen.has(asset.path) || sha256(asset.content) !== asset.sha256) {
      throw new Error('Immutable package asset identity is invalid.');
    }
    seen.add(asset.path);
    const member = document.members.find((candidate) => candidate.path === asset.path);
    if (!member || member.replaceable || member.role !== 'primer-export') {
      throw new Error('Immutable package asset is not declared in the package.');
    }
    const path = fromPackageRelative(asset.path, packageRoot);
    if (await exists(path)) {
      if (sha256(await readContained(workspaceRoot, path)) !== asset.sha256) {
        throw new Error(`Immutable package asset conflicts at ${asset.path}.`);
      }
      continue;
    }
    await writeWorkspaceTextFileAtomicInMain(
      {
        workspaceRoot,
        path,
        mode: 'create',
        content: asset.content,
        artifactNoun: 'package asset',
      },
      { durable: true, beforePublish }
    );
    if (sha256(await readContained(workspaceRoot, path)) !== asset.sha256) {
      throw new Error(`Immutable package asset write could not be verified: ${asset.path}.`);
    }
  }
}

async function verifyImmutableAssets(
  workspaceRoot: string,
  packageRoot: string,
  document: SequencePackageDocument,
  assets: ReadonlyArray<{ path: string; sha256: string; content: string }>
): Promise<void> {
  for (const asset of assets) {
    const member = document.members.find((candidate) => candidate.path === asset.path);
    if (!member || member.replaceable || member.role !== 'primer-export') {
      throw new Error(`Published immutable asset is absent from the package: ${asset.path}.`);
    }
    if (
      sha256(await readContained(workspaceRoot, fromPackageRelative(asset.path, packageRoot))) !==
      asset.sha256
    ) {
      throw new Error(`Published immutable asset failed integrity verification: ${asset.path}.`);
    }
  }
}

async function writeJournal(
  workspaceRoot: string,
  packageRoot: string,
  journal: PendingPublication | CompletePublication,
  beforePublish: (() => void) | undefined = publicationChecks.getStore()?.beforePublish
): Promise<void> {
  const path = journalPath(packageRoot);
  const content = `${JSON.stringify(journal, null, 2)}\n`;
  if (await exists(path)) {
    const current = await readContained(workspaceRoot, path);
    await replaceContained(workspaceRoot, path, sha256(current), content, beforePublish);
    return;
  }
  await writeWorkspaceTextFileAtomicInMain(
    { workspaceRoot, path, mode: 'create', content, artifactNoun: 'sequence revision journal' },
    { durable: true, beforePublish }
  );
}

async function replaceContained(
  workspaceRoot: string,
  path: string,
  expectedSha256: string,
  content: string,
  beforePublish: (() => void) | undefined = publicationChecks.getStore()?.beforePublish
): Promise<void> {
  await writeWorkspaceTextFileAtomicInMain(
    {
      workspaceRoot,
      path,
      mode: 'replace',
      expectedContentHash: expectedSha256.slice('sha256:'.length),
      content,
      artifactNoun: 'sequence revision',
    },
    { durable: true, beforePublish }
  );
}

async function readContained(workspaceRoot: string, path: string): Promise<string> {
  const accepted = readAcceptedSequencePackageBytes(path);
  if (accepted) return new TextDecoder('utf-8', { fatal: true }).decode(accepted);
  const safe = await canonicalWorkspacePath({
    workspaceRoot,
    path,
    artifactNoun: 'sequence revision',
  });
  return readFile(safe.candidate, 'utf8');
}

async function verifyUserAttachments(
  workspaceRoot: string,
  packageRoot: string,
  document: SequencePackageDocument,
  attachments = document.userAttachments
): Promise<void> {
  for (const [attachmentId, attachment] of Object.entries(attachments)) {
    if (attachment.sha256 === null) continue;
    const member = document.members.find(
      (candidate) => candidate.id === attachment.memberId && candidate.role === 'user'
    );
    if (!member || member.replaceable) {
      throw new Error(`User attachment ${attachmentId} has no immutable package member.`);
    }
    const path = fromPackageRelative(member.path, packageRoot);
    let bytes = readAcceptedSequencePackageBytes(path);
    if (!bytes) {
      const safe = await canonicalWorkspacePath({
        workspaceRoot,
        path,
        artifactNoun: 'user attachment',
      });
      try {
        bytes = await readFile(safe.candidate);
      } catch {
        throw new Error(
          `User attachment ${attachmentId} is missing or failed integrity verification.`
        );
      }
    }
    if (sha256(bytes) !== attachment.sha256) {
      throw new Error(`User attachment ${attachmentId} failed integrity verification.`);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function journalPath(packageRoot: string): string {
  return sequencePackagePaths(packageRoot).revisionJournalPath;
}

function sha256(content: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function pairwiseReferenceRevision(sequence: string): string {
  return `pairwise-reference-v1:${sha256(JSON.stringify(sequence.replace(/\s/g, '').toUpperCase()))}`;
}

function parseJournal(content: string): PendingPublication | CompletePublication {
  const parsed: unknown = JSON.parse(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Sequence revision journal is invalid.');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.schema !== PUBLICATION_SCHEMA ||
    typeof record.packageId !== 'string' ||
    typeof record.operationId !== 'string'
  ) {
    throw new Error('Sequence revision journal identity is invalid.');
  }
  if (record.registeredPublication !== undefined) {
    const intent = parseRegisteredSequencePublicationIntent(record.registeredPublication);
    if (
      intent.operationId !== record.operationId ||
      intent.desired.id !== record.packageId ||
      record.state === 'aborted' ||
      (record.state === 'complete' && record.revisionId !== intent.revisionId) ||
      (record.state === 'pending' &&
        (record.afterMarkerSha256 !== `sha256:${intent.markerSha256}` ||
          record.afterProductSha256 !== `sha256:${intent.productSha256}`))
    )
      throw new Error(
        'Registered sequence journal identity does not match its retained publication.'
      );
  }
  if (
    (record.state === 'complete' || record.state === 'aborted') &&
    typeof record.revisionId === 'string'
  ) {
    return record as CompletePublication;
  }
  if (
    record.state === 'pending' &&
    typeof record.beforeMarkerSha256 === 'string' &&
    typeof record.beforeProductSha256 === 'string' &&
    typeof record.beforeMarkerContent === 'string' &&
    typeof record.beforeProductSnapshotPath === 'string' &&
    typeof record.afterMarkerSha256 === 'string' &&
    typeof record.afterProductSha256 === 'string' &&
    typeof record.nextMarkerContent === 'string' &&
    typeof record.nextProductSnapshotPath === 'string'
  ) {
    return record as PendingPublication;
  }
  throw new Error('Sequence revision journal state is invalid.');
}

export async function publishSequenceKeepSavedPublicationInMain(
  context: RegisteredSequencePackagePublicationContext,
  resolution: VerifiedRegisteredRecordResolution
): Promise<void> {
  const first = await readRetainedSequenceKeepSavedPublication(context, resolution);
  if (!first) throw new Error('The reviewed sequence publication is unavailable.');
  if (first.result) return;
  const scoped = { ...context, organizationResolution: resolution };
  await withPackagePublicationLock(first.plan.packageRoot, async () => {
    const retained = await readRetainedSequenceKeepSavedPublication(scoped, resolution);
    if (!retained) throw new Error('The reviewed sequence publication changed.');
    if (retained.result) return;
    const { plan } = retained;
    const path = journalPath(plan.packageRoot);
    if (await exists(path)) {
      const previous = parseJournal(await readContained(plan.workspaceRoot, path));
      if (previous.operationId === resolution.operationId) {
        if (
          !previous.registeredPublication ||
          stableJson(previous.registeredPublication) !== stableJson(plan.intent)
        )
          throw new Error('The sequence journal belongs to a different approved choice.');
        await recoverRevisionPublicationLocked(plan.workspaceRoot, plan.packageRoot, scoped);
        return;
      }
      if (
        previous.state === 'pending' ||
        (previous.registeredPublication &&
          !context.runDatabase(() =>
            hasSettledRegisteredSequencePublicationInDb(context, previous.registeredPublication!)
          ))
      )
        throw new Error('Finish the existing sequence publication before this reviewed choice.');
    }
    await assertRegisteredSequencePublicationAccess(scoped, { ...plan, intent: plan.intent });
    const marker = parseSequencePackageDocument(plan.markerContent);
    const beforeMarkerContent = plan.beforeMarkerContent ?? plan.markerContent;
    const beforeMarker = parseSequencePackageDocument(beforeMarkerContent);
    const beforeProductSnapshotPath = plan.beforeProductSnapshotPath ?? plan.productSnapshotPath;
    const beforeProductSha256 = beforeMarker.product.genBankChecksum;
    if (!beforeProductSha256)
      throw new Error('The retained sequence preimage has no product digest.');
    const paths = sequencePackagePaths(plan.packageRoot, { productFile: marker.product.file });
    const [currentMarker, currentProduct, snapshot] = await Promise.all([
      readContained(plan.workspaceRoot, paths.metaPath),
      readContained(plan.workspaceRoot, paths.productPath),
      readContained(
        plan.workspaceRoot,
        fromPackageRelative(beforeProductSnapshotPath, plan.packageRoot)
      ),
    ]);
    if (
      currentMarker !== beforeMarkerContent ||
      sha256(currentProduct) !== beforeProductSha256 ||
      sha256(snapshot) !== beforeProductSha256
    )
      throw new Error('The approved sequence bytes changed; the original resolution was retained.');
    if (plan.organizationSnapshot)
      await stageOrganizationSavedSequenceMembers({ ...plan, snapshot: plan.organizationSnapshot });
    await assertRegisteredSequencePublicationAccess(scoped, { ...plan, intent: plan.intent });
    const journal: PendingPublication = {
      schema: PUBLICATION_SCHEMA,
      state: 'pending',
      packageId: resolution.entityId,
      operationId: resolution.operationId,
      beforeMarkerSha256: sha256(beforeMarkerContent),
      afterMarkerSha256: `sha256:${plan.intent.markerSha256}`,
      beforeProductSha256,
      afterProductSha256: `sha256:${plan.intent.productSha256}`,
      beforeMarkerContent,
      nextMarkerContent: plan.markerContent,
      beforeProductSnapshotPath,
      nextProductSnapshotPath: plan.productSnapshotPath,
      registeredPublication: plan.intent,
    };
    await writeJournal(plan.workspaceRoot, plan.packageRoot, journal);
    await recoverRevisionPublicationLocked(plan.workspaceRoot, plan.packageRoot, scoped);
  });
}
