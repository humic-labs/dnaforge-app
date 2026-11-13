import { FinalizationPreconditionError } from './finalization-error';
import {
  userMessage,
  userMessageWithValues,
  userMessageValue,
  withUserMessage,
} from '@waypoint/user-messages';
import { observeAssemblySaved } from './journey-telemetry';
import { platform } from '../../platform';
import { findContainingPathBoundary, pathRelativeToBoundary } from '../../shared/path-boundary';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useSequenceStore } from '../sequence/public/store';
import {
  assertDesignArtifactMaturationTarget,
  matureDesignArtifactToPlasmidPackage,
} from '../design/public/design-artifact-maturation';
import {
  freezeDesignEditsForPublication,
  unfreezeDesignEditsForPublication,
  useDesignStore,
  withAuthorizedDesignPublicationUpdate,
} from '../design/public/store';
import {
  hasRecordableAssemblyPrimers,
  recordAcceptedAssemblyPrimers,
  registerAcceptedAssemblyAsLimsEntity,
} from '../lims/public/assembly-bridge';
import { commitPrimerBatchHistory } from '../primers/public/primer-artifact-service';
import { useToastStore } from '../../stores/toast-store';
import {
  getCatalogEntity,
  linkCatalogEntities,
  recordCatalogEvent,
  updateCatalogEntityMetadata,
} from '../../db/workspace-catalog';
import { markAcceptedAssemblyVersionLifecycle } from './accepted-service';
import { requireConstructId } from './accepted-construct-id';
import { rememberFinalizedPlasmid } from './plasmid-identity';
import { gitHead, gitStatus, isGitRepo } from '../workspace/public/git';
import {
  projectionInputToAnnotatedSequence,
  writeAcceptedAssemblyFiles,
  type AcceptedAssemblyWriteReceipt,
} from './accepted-writer';
import type { AcceptedAssemblyVersion } from './accepted-types';
import type { PreparedFinalizationCandidate } from './accepted-finalization-preview';
import type { ManagedSequenceDocumentRef } from '../../shared/managed-sequence-document';
import { withRendererWorkspaceMutation } from '../../services/workspace-mutation-transaction';
import {
  resolveReconcileWorkspaceRoot,
  runWorkspaceReconcileOperation,
} from '../../services/workspace-operations';
import { LIMS_GIT_EXPORT_RELATIVE_PATH } from '../../shared/lims';
import { fromPackageRelative, parseSequencePackageDocument } from '../../db/sequence-package';
import { sequencePackagePaths } from '../../db/sequence-package';
import {
  consumePackageAssemblyWorkingCopy,
  readPackageAssemblyWorkingCopy,
  type PackageAssemblyWorkingCopy,
} from '../../db/sequence-package-working-copy-storage';
import { designContentIdentity } from '../design/public/design-recovery';
import {
  drainDesignArtifactMirrors,
  resumeDesignArtifactMirror,
  resumeDesignArtifactMirrors,
  retireDesignArtifactMirror,
  suspendDesignArtifactMirrors,
} from '../design/public/design-artifact-mirror';
import {
  publishScientificAssembly,
  type PublishedScientificAssembly,
} from './scientific-finalization';
import { NativeArtifactPublicationPendingError } from '../../services/publish-native-artifact';
import type { ScientificAcceptedDocumentRevision } from '@waypoint/domain-services';

type FinalizationWriteReceipt = AcceptedAssemblyWriteReceipt & {
  scientific?: PublishedScientificAssembly;
};

export interface FinalizeAcceptedAssemblyWorkflowResult {
  constructId: string;
  sequenceDocument: ManagedSequenceDocumentRef;
  acceptedVersion: AcceptedAssemblyVersion;
  packageRoot: string;
  productPath: string;
  metaPath: string;
  primerCsvPath: string;
  primerFastaPath: string;
  productSequenceChecksum: string;
  productGenBankChecksum: string;
  historyState: 'committed' | 'not-git' | 'failed';
  gitCommitSha: string | null;
  consumedDraftPath: string | null;
  acceptedRevision?: ScientificAcceptedDocumentRevision;
  acceptedAssemblyResourceId?: string;
}

export class AcceptedAssemblyProjectionError extends Error {
  override readonly name = 'AcceptedAssemblyProjectionError';
}

export async function finalizeAcceptedAssemblyWorkflow(input: {
  candidate: PreparedFinalizationCandidate;
  actor?: string;
  notify?: boolean;
  telemetryActionId?: string;
  abortSignal?: AbortSignal;
  agentOperation?: { idempotencyKey: string; previewFingerprint: string };
}): Promise<FinalizeAcceptedAssemblyWorkflowResult> {
  const { candidate } = input;
  const workspaceState = useWorkspaceStore.getState();
  const workspaceRoot =
    findContainingPathBoundary(
      workspaceState.folders.filter((folder) => !folder.pinned),
      candidate.prepared.files.productGenBankPath
    )?.path ?? null;
  const metaPath = sequencePackagePaths(candidate.prepared.files.packageRoot).metaPath;
  const packageCopy = (await platform().fs.exists(metaPath))
    ? await readPackageAssemblyWorkingCopy(candidate.prepared.files.packageRoot)
    : null;
  if (packageCopy?.published) {
    throw new Error(
      'The accepted assembly was written, but retirement of its working copy was interrupted. ' +
        'Reconcile that publication before attempting another finalization.'
    );
  }
  if (packageCopy && packageCopy.design.id !== candidate.design.id) {
    throw new Error('Another unfinished assembly already belongs to this sequence package.');
  }

  suspendDesignArtifactMirrors([candidate.design.id]);
  let editsFrozen = false;
  try {
    await drainDesignArtifactMirrors([candidate.design.id]);
    if (packageCopy) {
      const frozen = await readPackageAssemblyWorkingCopy(candidate.prepared.files.packageRoot);
      if (
        !frozen ||
        designContentIdentity(frozen.design) !== designContentIdentity(candidate.design)
      ) {
        throw new FinalizationPreconditionError(
          'stale_design',
          'The assembly working copy changed after finalization preview.'
        );
      }
    }
    freezeDesignEditsForPublication(candidate.design.id);
    editsFrozen = true;
    return await withRendererWorkspaceMutation(
      workspaceRoot,
      (mutationToken) =>
        finalizeAcceptedAssemblyInMutation(input, workspaceRoot, mutationToken, packageCopy),
      undefined,
      { waitForAvailability: true }
    );
  } catch (error) {
    resumeDesignArtifactMirrors([candidate.design.id], { scheduleLatest: !packageCopy });
    if (packageCopy) {
      try {
        if (await readPackageAssemblyWorkingCopy(candidate.prepared.files.packageRoot)) {
          resumeDesignArtifactMirror(candidate.design.id);
        }
      } catch {}
    }
    throw error;
  } finally {
    if (editsFrozen) unfreezeDesignEditsForPublication(candidate.design.id);
  }
}

async function finalizeAcceptedAssemblyInMutation(
  input: {
    candidate: PreparedFinalizationCandidate;
    actor?: string;
    notify?: boolean;
    telemetryActionId?: string;
    abortSignal?: AbortSignal;
    agentOperation?: { idempotencyKey: string; previewFingerprint: string };
  },
  workspaceRoot: string | null,
  mutationToken?: string,
  packageCopy?: PackageAssemblyWorkingCopy | null
): Promise<FinalizeAcceptedAssemblyWorkflowResult> {
  const { candidate } = input;
  const design = candidate.design;
  const initialVersion = design.version;
  await assertDesignArtifactMaturationTarget({
    designId: design.id,
    packageRoot: candidate.prepared.files.packageRoot,
    workspaceRoot,
  });
  if (input.abortSignal?.aborted) {
    throw new Error('Finalization was canceled before commit.');
  }

  const reserved = withAuthorizedDesignPublicationUpdate(design.id, () =>
    useDesignStore
      .getState()
      .commitAcceptedAssemblyVersion(design.id, candidate.prepared.acceptedVersion, initialVersion)
  );
  if (!reserved) {
    throw new FinalizationPreconditionError(
      'stale_design',
      'Design changed before finalization could reserve the accepted assembly version. ' +
        'Re-read the design and preview finalization again.'
    );
  }

  const packageRoot = candidate.prepared.files.packageRoot;
  const limsBefore = workspaceRoot
    ? await finalizationLimsBaseline(workspaceRoot, candidate, mutationToken)
    : null;
  if (limsBefore) interruptedFinalizationBaselines.set(packageRoot, limsBefore);
  let writeReceipt: FinalizationWriteReceipt;
  try {
    writeReceipt = await writePreparedFiles(candidate, workspaceRoot, mutationToken);
  } catch (error) {
    withAuthorizedDesignPublicationUpdate(design.id, () =>
      useDesignStore
        .getState()
        .replaceAcceptedAssemblyVersion(
          design.id,
          markAcceptedAssemblyVersionLifecycle(candidate.prepared.acceptedVersion, 'write_failed')
        )
    );
    throw error;
  }

  const writtenConstructId =
    candidate.prepared.acceptedVersion.projectionInput.constructId ??
    candidate.constructId ??
    design.constructId;
  if (writtenConstructId) observeAssemblySaved(writtenConstructId, input.telemetryActionId);
  const acceptedVersion = markAcceptedAssemblyVersionLifecycle(
    candidate.prepared.acceptedVersion,
    'written'
  );
  if (
    !withAuthorizedDesignPublicationUpdate(design.id, () =>
      useDesignStore.getState().replaceAcceptedAssemblyVersion(design.id, acceptedVersion)
    )
  ) {
    throw new Error(
      'The plasmid package was written, but the app could not record its written accepted version.'
    );
  }
  const writtenDesign = useDesignStore.getState().designs[design.id];

  const constructId = requireConstructId(
    acceptedVersion.projectionInput.constructId ?? candidate.constructId ?? design.constructId,
    'Accepted assembly finalization'
  );

  if (limsBefore) interruptedFinalizationBaselines.set(packageRoot, limsBefore);
  withAuthorizedDesignPublicationUpdate(design.id, () =>
    useDesignStore.getState().bindDesignConstructId(design.id, constructId)
  );
  let consumedDraftPath: string | null;
  if (packageCopy) {
    if (useDesignStore.getState().designs[design.id] !== writtenDesign) {
      throw new Error(
        'Assembly changed while its accepted version was being published; working copy retained.'
      );
    }
    await retireDesignArtifactMirror(design.id);
    consumedDraftPath = await consumePackageAssemblyWorkingCopy({
      packageRoot: candidate.prepared.files.packageRoot,
      packageId: constructId,
      designId: design.id,
      mutationToken,
    });
  } else {
    const maturation = await matureDesignArtifactToPlasmidPackage({
      designId: design.id,
      constructId,
      designName: design.name,
      packageRoot: candidate.prepared.files.packageRoot,
      workspaceRoot,
      mutationToken,
    });
    consumedDraftPath = maturation.state === 'matured' ? maturation.draftPath : null;
  }

  if (!writeReceipt.scientific) {
    await registerAcceptedAssemblyAsLimsEntity({
      packageDocument: parseSequencePackageDocument(candidate.prepared.files.sidecarJsonContent),
      productGenBankContent: candidate.prepared.files.productGenBankContent,
      packageRoot: candidate.prepared.files.packageRoot,
      workspaceRoot,
      actor: input.actor ?? 'local-user',
      mutationToken,
      parentActionId: input.telemetryActionId,
    });
  }

  await reconcileFinalizedPackage({
    workspaceRoot,
    packageRoot: candidate.prepared.files.packageRoot,
    constructId,
    mutationToken,
  });

  interruptedFinalizationBaselines.delete(packageRoot);
  const historyState = await recordAndCommitAssemblyPrimers({
    acceptedVersion,
    productFiles: [
      candidate.prepared.files.productGenBankPath,
      candidate.prepared.files.metaPath,
      candidate.prepared.files.primerCsvPath,
      candidate.prepared.files.primerFastaPath,
      ...(writeReceipt.publicationPaths ?? []),
      ...(candidate.prepared.files.snapshotFiles ?? []).map((snapshot) =>
        fromPackageRelative(snapshot.path, candidate.prepared.files.packageRoot)
      ),
      ...writeReceipt.migratedPaths,
      ...(writeReceipt.scientific?.ownedPaths ?? []),
      ...(consumedDraftPath ? [consumedDraftPath] : []),
    ],
    workspaceRoot,
    limsBefore,
    notify: input.notify ?? false,
    mutationToken,
    scientific: writeReceipt.scientific,
    parentActionId: input.telemetryActionId,
  });
  if (historyState === 'failed' && writeReceipt.scientific)
    throw new NativeArtifactPublicationPendingError(
      writeReceipt.scientific.accepted,
      'assembly Git publication remains incomplete. Retry this captured finalization.'
    );
  if (historyState === 'failed' && input.notify) {
    useToastStore
      .getState()
      .addToast(
        userMessage(
          'notice.plasmid-package-was-written-but-git-history-was-not-recorded-the-const'
        ),
        {
          definition:
            'accepted-finalization-workflow-plasmid-package-was-written-but-git-history-was-not-recorded-the-construct-i',
        }
      );
  }
  const gitCommitSha =
    historyState === 'committed' && workspaceRoot
      ? await gitHead(workspaceRoot, mutationToken)
      : null;
  await recordLineageProjection({
    constructId,
    acceptedVersion,
    packageRoot: candidate.prepared.files.packageRoot,
    productPath: candidate.prepared.files.productGenBankPath,
    actor: input.actor ?? 'local-user',
    historyState,
    gitCommitSha,
    agentOperation: input.agentOperation,
  });

  const productSequence = projectionInputToAnnotatedSequence(acceptedVersion.projectionInput, {
    outputPath: candidate.prepared.files.productGenBankPath,
  });
  useSequenceStore.getState().setSequence(constructId, {
    ...productSequence,
    ...(writeReceipt.scientific ? { acceptedRevision: writeReceipt.scientific.accepted } : {}),
  });
  useSequenceStore.getState().markClean(constructId);
  rememberFinalizedPlasmid({
    productPath: candidate.prepared.files.productGenBankPath,
    packageRoot: candidate.prepared.files.packageRoot,
    metaPath: candidate.prepared.files.metaPath,
    constructId,
    acceptedVersion,
  });

  return {
    constructId,
    sequenceDocument: {
      kind: 'managed-sequence',
      packageId: constructId,
      packageRoot: candidate.prepared.files.packageRoot,
    },
    acceptedVersion,
    packageRoot: candidate.prepared.files.packageRoot,
    productPath: candidate.prepared.files.productGenBankPath,
    metaPath: candidate.prepared.files.metaPath,
    primerCsvPath: candidate.prepared.files.primerCsvPath,
    primerFastaPath: candidate.prepared.files.primerFastaPath,
    productSequenceChecksum: candidate.prepared.files.productSequenceChecksum,
    productGenBankChecksum: candidate.prepared.files.productGenBankChecksum,
    historyState,
    gitCommitSha,
    consumedDraftPath,
    ...(writeReceipt.scientific
      ? {
          acceptedRevision: writeReceipt.scientific.accepted,
          acceptedAssemblyResourceId: `accepted-assembly:${acceptedVersion.id}`,
        }
      : {}),
  };
}

const interruptedFinalizationBaselines = new Map<string, Set<string>>();

async function finalizationLimsBaseline(
  workspaceRoot: string,
  candidate: PreparedFinalizationCandidate,
  mutationToken?: string
): Promise<Set<string>> {
  const remembered = interruptedFinalizationBaselines.get(candidate.prepared.files.packageRoot);
  if (remembered) return remembered;
  if (!(await isGitRepo(workspaceRoot, mutationToken))) return new Set();
  const status = await gitStatus(workspaceRoot, mutationToken);
  const dirtyLims = [...status.keys()].filter((path) =>
    path.startsWith(`${LIMS_GIT_EXPORT_RELATIVE_PATH}/`)
  );
  if (dirtyLims.length === 0 || !candidate.overwrite) return new Set(dirtyLims);
  const recordPath = pathRelativeToBoundary(candidate.prepared.files.metaPath, workspaceRoot);
  return recordPath && status.get(recordPath) === 'untracked' ? new Set() : new Set(dirtyLims);
}

async function reconcileFinalizedPackage(input: {
  workspaceRoot: string | null;
  packageRoot: string;
  constructId: string;
  mutationToken?: string;
}): Promise<void> {
  const workspaceRoot = resolveReconcileWorkspaceRoot(input.workspaceRoot, input.packageRoot);
  if (!workspaceRoot) return;
  try {
    await runWorkspaceReconcileOperation({
      workspaceRoot,
      operationId: `assembly-finalization:${input.constructId}`,
      mutationToken: input.mutationToken,
      strict: true,
      catalogSource: 'working-tree',

      healManagedHead: false,
      pendingSequenceDocument: {
        kind: 'managed-sequence',
        packageId: input.constructId,
        packageRoot: input.packageRoot,
      },
      displayDelivery: 'optional',
      filesChanged: { revealPath: input.packageRoot, notifyGitStatus: true },
    });
  } catch (error) {
    throw withUserMessage(
      new AcceptedAssemblyProjectionError(
        `The plasmid package was written, but its workspace records could not be rebuilt: ${
          error instanceof Error ? error.message : String(error)
        }`
      ),
      'assembly.projectionFailed'
    );
  }
}

async function writePreparedFiles(
  candidate: PreparedFinalizationCandidate,
  workspaceRoot: string | null,
  mutationToken?: string
): Promise<FinalizationWriteReceipt> {
  if (workspaceRoot) {
    const scientific = await publishScientificAssembly(candidate, workspaceRoot, mutationToken);
    if (scientific) return { migratedPaths: [], scientific };
  }
  const fs = platform().fs;
  const createPackageScratch = fs.createPackageScratch;
  const removePackageScratch = fs.removePackageScratch;
  const renamePackageScratchMember = fs.renamePackageScratchMember;
  return writeAcceptedAssemblyFiles(candidate.prepared.files, {
    exists: (path) => fs.exists(path),
    readTextFile: (path) => fs.readTextFile(path),
    mkdir: (path, options) => fs.mkdir(path, options, mutationToken),
    writeTextFile: (path, content) => fs.writeTextFile(path, content, undefined, mutationToken),
    writeWorkspaceTextFileAtomic: (request) =>
      fs.writeWorkspaceTextFileAtomic({
        ...request,
        workspaceRoot: workspaceRoot ?? request.workspaceRoot,
        mutationToken,
      }),
    publishAcceptedAssemblyRevision: workspaceRoot
      ? (request) =>
          fs.publishAcceptedAssemblyRevision({
            ...request,
            workspaceRoot,
            mutationToken,
          })
      : undefined,
    rename: (from, to) => fs.rename(from, to, mutationToken),
    createScratch: createPackageScratch
      ? (packageRoot) => createPackageScratch(packageRoot, mutationToken)
      : undefined,
    removeScratch: removePackageScratch
      ? (lease) => removePackageScratch(lease.cleanupToken)
      : undefined,
    renameScratch: renamePackageScratchMember
      ? (lease, from, to) => renamePackageScratchMember(lease.cleanupToken, from, to)
      : undefined,
  });
}

async function alreadySavedPrimerIds(designId: string): Promise<ReadonlySet<string>> {
  if (!useDesignStore.getState().designs[designId]?.savedPrimerLinks?.length) return new Set();
  const { primerIdsWithCurrentSavedOligo } = await import('./saved-primer-oligo-service');
  return primerIdsWithCurrentSavedOligo(designId);
}

async function recordAndCommitAssemblyPrimers(input: {
  acceptedVersion: AcceptedAssemblyVersion;
  productFiles: string[];
  workspaceRoot: string | null;
  limsBefore: Set<string> | null;
  notify: boolean;
  mutationToken?: string;
  scientific?: PublishedScientificAssembly;
  parentActionId?: string;
}): Promise<'committed' | 'not-git' | 'failed'> {
  const addToast = input.notify ? useToastStore.getState().addToast : null;
  if (!input.workspaceRoot) {
    if (hasRecordableAssemblyPrimers(input.acceptedVersion)) {
      addToast?.(userMessage('notice.no-project-is-available-for-saving-assembly-primers'), {
        definition:
          'accepted-finalization-workflow-no-project-is-available-for-saving-assembly-primers',
      });
    }
    return 'not-git';
  }

  try {
    const batch = input.scientific
      ? { recorded: [], skipped: [], failed: [] }
      : await recordAcceptedAssemblyPrimers({
          acceptedVersion: input.acceptedVersion,
          workspaceRoot: input.workspaceRoot,
          alreadySavedPrimerIds: await alreadySavedPrimerIds(
            input.acceptedVersion.projectionInput.designId
          ),
          actor: input.acceptedVersion.acceptedBy ?? 'local-user',
          mutationToken: input.mutationToken,
          parentActionId: input.parentActionId,
        });
    const relPaths = [
      ...input.productFiles
        .map((path) => pathRelativeToBoundary(path, input.workspaceRoot!))
        .filter((path): path is string => path !== null && path.length > 0),
      ...batch.recorded.map((saved) => saved.artifact.file.workspaceRelativePath),
    ];
    let historyState: 'committed' | 'not-git' | 'failed' = 'committed';
    if (relPaths.length > 0) {
      const count = input.scientific?.primerCount ?? batch.recorded.length;
      historyState = await commitPrimerBatchHistory(
        input.workspaceRoot,
        relPaths,
        input.limsBefore ?? new Set<string>(),
        count > 0
          ? `Record ${count} assembly primer${count === 1 ? '' : 's'}`
          : 'Finalize assembly product',
        input.mutationToken
      );
      if (historyState === 'failed') {
        addToast?.(userMessage('notice.assembly-primers-recorded-but-committing-them-failed'), {
          definition:
            'accepted-finalization-workflow-assembly-primers-recorded-but-committing-them-failed',
        });
      }
    }
    if (batch.failed.length > 0) {
      const count = batch.failed.length;
      addToast?.(
        userMessageWithValues('notice.value-assembly-primervalue-could-not-be-recorded', {
          value0: userMessageValue(count),
          value1: userMessageValue(count === 1 ? '' : 's'),
        }),
        {
          definition: 'accepted-finalization-workflow-3-assembly-primers-could-not-be-recorded',
        }
      );
    }
    return historyState;
  } catch (error) {
    console.warn('[AssemblyFinalize] Recording assembly primers failed:', error);
    addToast?.(userMessage('notice.assembly-primers-could-not-be-recorded'), {
      definition: 'accepted-finalization-workflow-assembly-primers-could-not-be-recorded',
    });
    return 'failed';
  }
}

async function recordLineageProjection(input: {
  constructId: string;
  acceptedVersion: AcceptedAssemblyVersion;
  packageRoot: string;
  productPath: string;
  actor: string;
  historyState: 'committed' | 'not-git' | 'failed';
  gitCommitSha: string | null;
  agentOperation?: { idempotencyKey: string; previewFingerprint: string };
}): Promise<void> {
  if (!(await getCatalogEntity(input.constructId))) return;
  await updateCatalogEntityMetadata(input.constructId, {
    constructId: input.constructId,
    latestAcceptedAssemblyVersionId: input.acceptedVersion.id,
    latestProductSequenceVersionId: input.acceptedVersion.artifacts?.productSequenceChecksum,
  });
  await recordCatalogEvent({
    entityId: input.constructId,
    eventType: 'assembly_finalized',
    actor: input.actor,
    summary: 'Finalized assembly into a plasmid package',
    payload: {
      constructId: input.constructId,
      draftRevisionId: input.acceptedVersion.projectionInput.designId,
      parentAcceptedAssemblyVersionId:
        input.acceptedVersion.projectionInput.parentAcceptedAssemblyVersionId ?? null,
      acceptedAssemblyVersionId: input.acceptedVersion.id,
      canonicalDraftChecksum: input.acceptedVersion.canonicalDraftChecksum,
      productSequenceVersionId: input.acceptedVersion.artifacts?.productSequenceChecksum,
      packageRoot: input.packageRoot,
      productPath: input.productPath,
      historyState: input.historyState,
      gitCommitSha: input.gitCommitSha,
      agentOperation: input.agentOperation ?? null,
    },
  });
  for (const source of input.acceptedVersion.projectionInput.sourceProvenance) {
    if (!source.sourceConstructId || !(await getCatalogEntity(source.sourceConstructId))) continue;
    await linkCatalogEntities({
      sourceEntityId: input.constructId,
      relation: 'assembled_from',
      targetEntityId: source.sourceConstructId,
      confidence: 'confirmed',
      evidence: {
        acceptedAssemblyVersionId: input.acceptedVersion.id,
        regionId: source.regionId,
        sourceSequenceVersionId: source.sourceSequenceVersionId,
        sourceSequenceChecksum: source.sourceSequenceChecksum,
        sourceLocator: source.sourceLocator,
      },
    });
  }
}
