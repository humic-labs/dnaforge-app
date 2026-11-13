import { NativeDocumentCommandError } from '../shared/native-document-error';
import { assertDeclaredFastaKindInDb } from './fasta-kind-authority';
import type Database from 'better-sqlite3';
import { createRegisteredSequencePackagePublicationContext } from './sequence-package-registry-publication';
import { assertNativeSequenceContentWritable } from './native-sequence-content-access';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import {
  computeChecksum,
  deriveSequenceEditTransition,
  ensureManagedGenBankAnnotationIds,
  listManagedGenBankAnnotations,
  serializeSequenceForInPlaceSave,
  type AnnotatedSequence,
  parseGenBankMoleculeLabel,
} from '@waypoint/sequence-utils';
import { annotationInputRevision } from '../shared/annotation-input-revision';
import { annotationTargetDocumentRevision } from '../shared/annotation-target-document-revision';
import { SOFT_WARN_BYTES } from '../shared/oversized-guard';
import {
  SEQUENCE_EDIT_TRANSITION_SCHEMA,
  type SequenceDocumentSaveInput,
  type SequenceDocumentSaveResult,
  type SequenceEditTransitionEventV1,
} from '../shared/sequence-edit-lineage';
import { parseSequenceFileAsDocument } from '../shared/parse-sequence-file';
import {
  fromPackageRelative,
  parseSequencePackageDocument,
  sequencePackagePaths,
  type SequencePackageDocument,
} from '../db/sequence-package';
import { readFileBoundedFromHandle } from './ipc/bounded-file-read';
import type { NativeAnnotationDocument } from './managed-annotation-document-command';
import {
  canonicalWorkspacePath,
  sha256Text,
  writeWorkspaceTextFileAtomicInMain,
} from './primer-artifact-files';
import {
  appendSequenceEditTransition,
  findCurrentSequenceEditHead,
  MAX_SEQUENCE_EDIT_OPERATIONS,
} from './sequence-edit-lineage';
import { acquireWorkspaceMutationShared } from './workspace-sync-mutation-lease';
import { saveEnrolledSequenceDocument } from './scientific-sequence-save';
import {
  publishSequencePackageRevisionInMain,
  recoverSequencePackageRevisionPublicationInMain,
} from './sequence-package-revision-publication';

export interface SequenceDocumentSaveDependencies {
  expectedFileSha256?: string;
  onPublished?(fileSha256: string): void;
  assertCurrent?(): void;
  db: Database.Database;
  resolve(documentId: string): Promise<NativeAnnotationDocument>;
  runDatabase<T>(operation: () => T): T;
  readText?(path: string): Promise<string>;
  write?(input: {
    workspaceRoot: string;
    path: string;
    expectedContentHash: string;
    content: string;
  }): Promise<void>;
  createEventId?(): string;
  getActiveAccountId?(): Promise<string | null>;
  renderer?: { readonly ownerId: number; readonly mutationToken?: string };
  includeWriteReceipt?: boolean;
}

interface BeforeAuthority {
  parentEventId: string | null;
  fileSha256: string;
  targetDocumentRevision: string;
  inputRevision: string;
  topology: 'linear' | 'circular';
}

export async function saveSequenceDocumentWithLineage(
  input: SequenceDocumentSaveInput,
  dependencies: SequenceDocumentSaveDependencies
): Promise<SequenceDocumentSaveResult> {
  assertSaveInput(input);
  const registeredContext = createRegisteredSequencePackagePublicationContext(dependencies);
  const document = await dependencies.resolve(input.documentId);
  dependencies.runDatabase(() =>
    assertNativeSequenceContentWritable(dependencies.db, input.documentId, document.workspaceRoot)
  );
  dependencies.runDatabase(() =>
    assertDeclaredFastaKindInDb(
      dependencies.db,
      { path: document.sourcePath, workspaceRoot: document.workspaceRoot },
      'sequence'
    )
  );
  const requested = await canonicalWorkspacePath({
    workspaceRoot: document.workspaceRoot,
    path: input.sourcePath,
    artifactNoun: 'sequence document',
  });
  const bound = await canonicalWorkspacePath({
    workspaceRoot: document.workspaceRoot,
    path: document.sourcePath,
    artifactNoun: 'sequence document',
  });
  if (requested.candidate !== bound.candidate) {
    throw new Error('The sequence save path does not match its native document binding.');
  }
  const resolvedDocument = {
    ...document,
    workspaceRoot: bound.root,
    sourcePath: bound.candidate,
  };
  const enrolled = await saveEnrolledSequenceDocument({
    db: dependencies.db,
    document: resolvedDocument,
    request: input,
    beforeAccept: dependencies.assertCurrent,
    ...(dependencies.renderer ? { renderer: dependencies.renderer } : {}),
  });
  if (enrolled)
    return enrolled.status === 'saved'
      ? savedWithReceipt(enrolled, enrolled.fileSha256, true, dependencies)
      : enrolled;
  const release = await acquireWorkspaceMutationShared(bound.root);
  const assertWriteAccess = () =>
    dependencies.runDatabase(() =>
      assertNativeSequenceContentWritable(dependencies.db, input.documentId, bound.root)
    );
  try {
    assertWriteAccess();
    dependencies.runDatabase(() =>
      assertDeclaredFastaKindInDb(
        dependencies.db,
        { path: resolvedDocument.sourcePath, workspaceRoot: resolvedDocument.workspaceRoot },
        'sequence'
      )
    );
    const packageRoot = dirname(resolvedDocument.sourcePath);
    let packageExists = false;
    try {
      await stat(sequencePackagePaths(packageRoot).metaPath);
      packageExists = true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
    let recoveredPendingPublication = false;
    if (packageExists) {
      await recoverSequencePackageRevisionPublicationInMain(
        bound.root,
        packageRoot,
        registeredContext,
        {
          onPendingRecovery: () => {
            recoveredPendingPublication = true;
          },
          beforePublish: () => {
            assertWriteAccess();
            dependencies.assertCurrent?.();
          },
        }
      );
    }
    const current = await readSnapshot(resolvedDocument, dependencies.readText);
    const expectedFileChanged =
      dependencies.expectedFileSha256 !== undefined &&
      current.fileSha256 !== dependencies.expectedFileSha256;
    const transition = deriveSequenceEditTransition({
      baselineSequence: input.capture.draftBaseline.sequence,
      draftSequence: input.capture.draftSequence,
      cleanSequence: input.capture.sequence.sequence,
      insertedRanges: input.capture.insertedRanges,
      deletedRanges: input.capture.deletedRanges,
      substitutedRanges: input.capture.substitutedRanges,
    });
    if (transition.operations.length > MAX_SEQUENCE_EDIT_OPERATIONS) {
      throw new Error('The sequence save contains too many coordinate operations.');
    }
    if (
      transition.beforeLength !== input.capture.draftBaseline.length ||
      transition.afterLength !== input.capture.sequence.length
    ) {
      throw new Error('The sequence save lengths do not match the proved edit transition.');
    }

    const managedPackage = await currentPackageForProduct(
      bound.root,
      resolvedDocument.sourcePath,
      input.documentId
    );
    let content = serializeSequenceForInPlaceSave(
      input.capture.sequence,
      resolvedDocument.sourcePath
    );
    if (managedPackage) {
      content = ensureManagedGenBankAnnotationIds(content, randomUUID, current.content);
    }
    const persisted = parseSequenceFileAsDocument(content, resolvedDocument.sourcePath).sequence;
    persisted.id = resolvedDocument.documentId;
    const managedAnnotationIds = managedPackage
      ? listManagedGenBankAnnotations(content).map((annotation) => annotation.id)
      : undefined;
    if (managedAnnotationIds && managedAnnotationIds.length !== persisted.annotations.length) {
      throw new Error('Managed annotation IDs do not match the parsed saved features.');
    }
    if (
      managedAnnotationIds &&
      managedAnnotationIds.some(
        (id, index) => persisted.annotations[index].qualifiers?.dnaforge_ann_id?.[0] !== id
      )
    ) {
      throw new Error('Managed annotation IDs changed order during saved feature parsing.');
    }
    if (
      managedAnnotationIds &&
      managedAnnotationIds.length !== input.capture.sequence.annotations.length
    ) {
      throw new Error('Managed annotation IDs do not match the captured editor features.');
    }
    if (
      persisted.sequence !== input.capture.sequence.sequence ||
      persisted.sequence.length !== input.capture.sequence.length ||
      topology(persisted) !== topology(input.capture.sequence)
    ) {
      throw new Error('The serialized sequence does not match the captured clean document.');
    }
    if (genBankMoleculeLabel(content) !== genBankMoleculeLabel(current.content)) {
      throw new Error('The save would change the molecule type recorded in the file.');
    }
    const afterFileSha256 = `sha256:${await sha256Text(content)}`;
    if (managedPackage) {
      const publishedRetry = await findPublishedSequenceSaveRetry({
        document: managedPackage.document,
        packageRoot: dirname(resolvedDocument.sourcePath),
        workspaceRoot: bound.root,
        documentId: input.documentId,
        draftLineageId: input.capture.draftLineageId,
        afterFileSha256,
        evidenceRunId: input.sequencingEvidenceRunId,
      });
      if (publishedRetry && current.fileSha256 === afterFileSha256) {
        dependencies.onPublished?.(afterFileSha256);
        return savedWithReceipt(
          {
            status: 'saved',
            fileSha256: afterFileSha256,
            eventId: publishedRetry,
            lineage: 'recorded',
            managedAnnotationIds,
          },
          afterFileSha256,
          false,
          dependencies
        );
      }
    }

    const baselineInputRevision = await annotationInputRevision({
      sequence: input.capture.draftBaseline.sequence,
      linear: !input.capture.draftBaseline.circular,
    });
    const currentInputRevision = await annotationInputRevision({
      sequence: current.sequence.sequence,
      linear: !current.sequence.circular,
    });
    const currentTopology = topology(current.sequence);
    const currentHead = dependencies.runDatabase(() =>
      findCurrentSequenceEditHead(dependencies.db, input.documentId, current.fileSha256)
    );
    const sameDraftSibling =
      currentHead?.event.draftLineageId === input.capture.draftLineageId &&
      currentHead.event.beforeInputRevision === baselineInputRevision &&
      currentHead.event.transition.beforeLength === input.capture.draftBaseline.length &&
      currentHead.event.beforeTopology === topology(input.capture.draftBaseline);

    if (expectedFileChanged) {
      if (sameDraftSibling && currentHead && current.fileSha256 === afterFileSha256) {
        dependencies.onPublished?.(afterFileSha256);
        return {
          status: 'saved',
          fileSha256: afterFileSha256,
          eventId: currentHead.id,
          lineage: 'recorded',
          ...(managedAnnotationIds ? { managedAnnotationIds } : {}),
        };
      }
      throw new NativeDocumentCommandError(
        'FILE_CHANGED',
        'The sequence source changed after this working copy was loaded.',
        recoveredPendingPublication ? 'unknown' : false
      );
    }

    let before: BeforeAuthority;
    if (sameDraftSibling && currentHead) {
      before = {
        parentEventId: currentHead.event.parentEventId,
        fileSha256: currentHead.event.beforeFileSha256,
        targetDocumentRevision: currentHead.event.beforeTargetDocumentRevision,
        inputRevision: currentHead.event.beforeInputRevision,
        topology: currentHead.event.beforeTopology,
      };
    } else if (
      current.sequence.sequence === input.capture.draftBaseline.sequence &&
      current.sequence.sequence.length === input.capture.draftBaseline.length &&
      currentTopology === topology(input.capture.draftBaseline) &&
      currentInputRevision === baselineInputRevision
    ) {
      before = {
        parentEventId: currentHead?.id ?? null,
        fileSha256: current.fileSha256,
        targetDocumentRevision: await annotationTargetDocumentRevision(current.sequence),
        inputRevision: currentInputRevision,
        topology: currentTopology,
      };
    } else {
      throw new Error(
        'The sequence on disk is not the captured draft baseline or its verified racing sibling.'
      );
    }

    const event: SequenceEditTransitionEventV1 = {
      schema: SEQUENCE_EDIT_TRANSITION_SCHEMA,
      parentEventId: before.parentEventId,
      draftLineageId: input.capture.draftLineageId,
      beforeFileSha256: before.fileSha256,
      afterFileSha256,
      beforeTargetDocumentRevision: before.targetDocumentRevision,
      afterTargetDocumentRevision: await annotationTargetDocumentRevision(persisted),
      beforeInputRevision: before.inputRevision,
      afterInputRevision: await annotationInputRevision({
        sequence: persisted.sequence,
        linear: !persisted.circular,
      }),
      beforeTopology: before.topology,
      afterTopology: topology(persisted),
      transition,
    };
    let packageRevisionId: string | null = null;
    if (input.sequencingEvidenceRunId && !managedPackage) {
      throw new Error('Sequencing mutations require a managed sequence package.');
    }
    if (managedPackage) {
      if (content === current.content) {
        dependencies.onPublished?.(afterFileSha256);
        return savedWithReceipt(
          {
            status: 'saved',
            fileSha256: afterFileSha256,
            eventId: managedPackage.document.versionHistory.headId,
            lineage: 'recorded',
            managedAnnotationIds,
          },
          afterFileSha256,
          false,
          dependencies
        );
      }
      const operationDigest = await sha256Text(
        JSON.stringify([
          input.documentId,
          input.capture.draftLineageId,
          current.fileSha256,
          afterFileSha256,
          ...(input.sequencingEvidenceRunId ? [input.sequencingEvidenceRunId] : []),
        ])
      );
      const kind = input.sequencingEvidenceRunId ? 'sequencing-apply' : 'sequence-save';
      packageRevisionId = `${kind}:${operationDigest}`;
      const nextDocument: SequencePackageDocument = {
        ...managedPackage.document,
        product: {
          ...managedPackage.document.product,
          topology: topology(persisted),
          sequenceChecksum: await computeChecksum(persisted.sequence),
          genBankChecksum: await computeChecksum(content),
        },
        updatedAt: new Date().toISOString(),
      };
      assertWriteAccess();
      await publishSequencePackageRevisionInMain(
        {
          workspaceRoot: bound.root,
          packageRoot: dirname(resolvedDocument.sourcePath),
          packageId: input.documentId,
          nextDocument,
          nextProductContent: content,
          kind,
          evidenceRunId: input.sequencingEvidenceRunId,
          operationId: packageRevisionId,
          revisionId: packageRevisionId,
          adoptedRevisionId: `adopted:${operationDigest}`,
          expectedMarkerSha256: managedPackage.markerSha256,
          expectedProductSha256: current.fileSha256,
          beforePublish: () => {
            assertWriteAccess();
            dependencies.assertCurrent?.();
          },
        },
        registeredContext
      );
    } else if (dependencies.write) {
      assertWriteAccess();
      await dependencies.write({
        workspaceRoot: bound.root,
        path: resolvedDocument.sourcePath,
        expectedContentHash: current.fileSha256.slice('sha256:'.length),
        content,
      });
    } else {
      assertWriteAccess();
      await writeWorkspaceTextFileAtomicInMain(
        {
          workspaceRoot: bound.root,
          path: resolvedDocument.sourcePath,
          mode: 'replace',
          expectedContentHash: current.fileSha256.slice('sha256:'.length),
          content,
          artifactNoun: 'sequence document',
        },
        {
          durable: true,
          beforePublish: () => {
            assertWriteAccess();
            dependencies.assertCurrent?.();
          },
        }
      );
    }

    dependencies.onPublished?.(afterFileSha256);
    try {
      const stored = dependencies.runDatabase(() =>
        appendSequenceEditTransition({
          db: dependencies.db,
          entityId: input.documentId,
          event,
          eventId: dependencies.createEventId?.(),
        })
      );
      return savedWithReceipt(
        {
          status: 'saved',
          fileSha256: afterFileSha256,
          eventId: packageRevisionId ?? stored.id,
          lineage: 'recorded',
          ...(managedAnnotationIds ? { managedAnnotationIds } : {}),
        },
        afterFileSha256,
        true,
        dependencies
      );
    } catch (error) {
      console.error('[SequenceDocumentSave] File saved without edit-lineage event:', error);
      return savedWithReceipt(
        packageRevisionId
          ? {
              status: 'saved',
              fileSha256: afterFileSha256,
              eventId: packageRevisionId,
              lineage: 'recorded',
              managedAnnotationIds,
            }
          : { status: 'saved', fileSha256: afterFileSha256, eventId: null, lineage: 'unavailable' },
        afterFileSha256,
        true,
        dependencies
      );
    }
  } finally {
    release();
  }
}

function savedWithReceipt(
  result: Extract<SequenceDocumentSaveResult, { status: 'saved' }>,
  contentSha256: string,
  wrote: boolean,
  dependencies: SequenceDocumentSaveDependencies
): SequenceDocumentSaveResult {
  return dependencies.includeWriteReceipt
    ? {
        ...result,
        writeReceipt: {
          nativeActionId: randomUUID(),
          revisionId: result.eventId,
          contentSha256: contentSha256.slice('sha256:'.length),
          wrote,
          ...(result.accepted ? { accepted: result.accepted } : {}),
        },
      }
    : result;
}

async function findPublishedSequenceSaveRetry(input: {
  document: SequencePackageDocument;
  packageRoot: string;
  workspaceRoot: string;
  documentId: string;
  draftLineageId: string;
  afterFileSha256: string;
  evidenceRunId?: string;
}): Promise<string | null> {
  const revisions = input.document.versionHistory.revisions;
  const kind = input.evidenceRunId ? 'sequencing-apply' : 'sequence-save';
  for (const revision of revisions) {
    if (
      revision.kind !== kind ||
      revision.productSnapshot.sha256 !== input.afterFileSha256 ||
      revision.evidenceRunId !== input.evidenceRunId
    ) {
      continue;
    }
    const parent = revisions.find((entry) => entry.id === revision.parentId);
    if (!parent) continue;
    const digest = await sha256Text(
      JSON.stringify([
        input.documentId,
        input.draftLineageId,
        parent.productSnapshot.sha256,
        input.afterFileSha256,
        ...(input.evidenceRunId ? [input.evidenceRunId] : []),
      ])
    );
    if (revision.operationId !== `${kind}:${digest}`) continue;
    const snapshotPath = fromPackageRelative(revision.productSnapshot.path, input.packageRoot);
    const snapshot = await canonicalWorkspacePath({
      workspaceRoot: input.workspaceRoot,
      path: snapshotPath,
      artifactNoun: 'sequence snapshot',
    });
    const bytes = await readFile(snapshot.candidate, 'utf8');
    if (`sha256:${await sha256Text(bytes)}` !== input.afterFileSha256) {
      throw new Error('The archived sequence save snapshot is damaged; retry cannot be verified.');
    }
    return revision.id;
  }
  return null;
}

async function readSnapshot(
  document: NativeAnnotationDocument,
  readText?: (path: string) => Promise<string>
): Promise<{ sequence: AnnotatedSequence; content: string; fileSha256: string }> {
  const content = readText
    ? await readText(document.sourcePath)
    : new TextDecoder('utf-8', { fatal: true }).decode(
        await readFileBoundedFromHandle(document.sourcePath, SOFT_WARN_BYTES - 1)
      );
  const sequence = parseSequenceFileAsDocument(content, document.sourcePath).sequence;
  sequence.id = document.documentId;
  serializeSequenceForInPlaceSave(sequence, document.sourcePath);
  return { sequence, content, fileSha256: `sha256:${await sha256Text(content)}` };
}

async function currentPackageForProduct(
  workspaceRoot: string,
  productPath: string,
  documentId: string
): Promise<{ document: SequencePackageDocument; markerSha256: string } | null> {
  const packageRoot = dirname(productPath);
  const markerPath = sequencePackagePaths(packageRoot).metaPath;
  try {
    await stat(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const marker = await canonicalWorkspacePath({
    workspaceRoot,
    path: markerPath,
    artifactNoun: 'sequence package',
  });
  const markerContent = await readFile(marker.candidate, 'utf8');
  const document = parseSequencePackageDocument(markerContent);
  if (document.id !== documentId || document.product.file !== basename(productPath)) {
    throw new Error('The sequence product does not match its package identity or binding.');
  }
  return { document, markerSha256: `sha256:${await sha256Text(markerContent)}` };
}

function assertSaveInput(input: SequenceDocumentSaveInput): void {
  if (
    !input ||
    typeof input !== 'object' ||
    !identifier(input.documentId) ||
    typeof input.sourcePath !== 'string' ||
    !input.sourcePath ||
    !input.capture ||
    typeof input.capture !== 'object' ||
    !identifier(input.capture.draftLineageId) ||
    typeof input.capture.draftSequence !== 'string' ||
    !input.capture.draftBaseline ||
    typeof input.capture.draftBaseline.sequence !== 'string' ||
    !Number.isSafeInteger(input.capture.draftBaseline.length) ||
    input.capture.draftBaseline.length < 0 ||
    input.capture.draftBaseline.length !== input.capture.draftBaseline.sequence.length ||
    typeof input.capture.draftBaseline.circular !== 'boolean' ||
    !input.capture.sequence ||
    typeof input.capture.sequence.sequence !== 'string' ||
    !Number.isSafeInteger(input.capture.sequence.length) ||
    input.capture.sequence.length !== input.capture.sequence.sequence.length ||
    !Array.isArray(input.capture.insertedRanges) ||
    !Array.isArray(input.capture.deletedRanges) ||
    !Array.isArray(input.capture.substitutedRanges) ||
    (input.sequencingEvidenceRunId !== undefined && !identifier(input.sequencingEvidenceRunId))
  ) {
    throw new Error('The sequence save request is malformed.');
  }
  const authority = input.accepted;
  if (
    (input.mutationToken !== undefined && typeof input.mutationToken !== 'string') ||
    (authority !== undefined &&
      (!authority ||
        typeof authority !== 'object' ||
        typeof authority.operationId !== 'string' ||
        typeof authority.expectedHead !== 'string' ||
        typeof authority.expectedRevisionId !== 'string' ||
        (authority.parentEventId !== null && typeof authority.parentEventId !== 'string') ||
        (authority.baseline !== undefined &&
          (!authority.baseline ||
            typeof authority.baseline !== 'object' ||
            typeof authority.baseline.head !== 'string' ||
            typeof authority.baseline.revisionId !== 'string'))))
  )
    throw new Error('The accepted sequence Save authority is malformed.');
}

function topology(value: { circular?: boolean }): 'linear' | 'circular' {
  return value.circular ? 'circular' : 'linear';
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function genBankMoleculeLabel(content: string): string {
  const tail = /^LOCUS\s+.+?\s+\d+\s+bp\b(.*)$/im.exec(content)?.[1] ?? '';
  return parseGenBankMoleculeLabel(tail) ?? 'DNA';
}
