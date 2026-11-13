import type {
  DocumentCheckpointOutcome,
  ManagedDocumentOperationTarget,
  ManagedDocumentSaveOutcome,
  ManagedDocumentSelection,
} from '@waypoint/domain-services';
import type { DocumentWriteIntent, DocumentWriteSettlement } from '@waypoint/api-client/models';
import {
  mapAnnotationThroughSequenceEditTransition,
  serializeSequenceForInPlaceSave,
  type AnnotatedSequence,
  type Annotation,
} from '@waypoint/sequence-utils';
import { annotationInputRevision } from '../shared/annotation-input-revision';
import {
  assertManagedAnnotationAuthority,
  type ManagedAnnotationInspection,
  type TrustedManagedAnnotationAuthority,
} from '../shared/annotation-managed-operation-contract';
import { annotationTargetDocumentRevision } from '../shared/annotation-target-document-revision';
import { createDraftAnnotations, draftsToCommittedAnnotations } from '../shared/annotation-review';
import { SOFT_WARN_BYTES } from '../shared/oversized-guard';
import { parseSequenceFileAsDocument } from '../shared/parse-sequence-file';
import { readFileBoundedFromHandle } from './ipc/bounded-file-read';
import {
  canonicalWorkspacePath,
  sha256Bytes,
  sha256Text,
  writeWorkspaceTextFileAtomicInMain,
  WorkspaceFilePreconditionError,
  WorkspaceFilePublicationUncertainError,
} from './primer-artifact-files';
import {
  acquireWorkspaceMutationShared,
  acquireWorkspaceSyncMutationLease,
} from './workspace-sync-mutation-lease';
import type { ResolvedSequenceEditLineage } from './sequence-edit-lineage';

export interface NativeAnnotationDocument {
  readonly documentId: string;
  readonly workspaceRoot: string;
  readonly sourcePath: string;
}

export interface NativeAnnotationDocumentBarrier {
  finish(): Promise<'refreshed' | 'not-required'>;
  assertCurrent(): void;
  abort(disposition: 'unchanged' | 'needs-recovery'): void;
}

export interface NativeAnnotationDocumentCommandDependencies {
  resolve(target: ManagedDocumentOperationTarget): Promise<NativeAnnotationDocument>;
  authorize(target: ManagedDocumentOperationTarget): Promise<TrustedManagedAnnotationAuthority>;
  prepare(document: NativeAnnotationDocument): Promise<NativeAnnotationDocumentBarrier>;
  checkpoint(document: NativeAnnotationDocument): Promise<DocumentCheckpointOutcome>;
  prepareContentForSave?(
    document: NativeAnnotationDocument,
    content: string,
    actionId: string
  ): Promise<string>;
  publishEnrolled?(input: {
    document: NativeAnnotationDocument;
    content: string;
    expectedContentHash: string;
    actionId: string;
    mutationLease: () => void;
    assertCurrent: () => void;
  }): Promise<boolean>;
  recordWriteIntent(input: {
    readonly actionId: string;
    readonly selection: ManagedDocumentSelection;
    readonly intent: DocumentWriteIntent;
  }): Promise<
    | { readonly status: 'permitted' | 'existing' }
    | { readonly status: 'refused'; readonly reason: string }
  >;
  recordOutcome(settlement: DocumentWriteSettlement): Promise<void>;
  recordLineageAdvance(input: {
    documentId: string;
    actionId: string;
    beforeFileSha256: string;
    afterFileSha256: string;
    beforeTargetDocumentRevision: string;
    afterTargetDocumentRevision: string;
    inputRevision: string;
    topology: 'linear' | 'circular';
    sequenceLength: number;
  }): Promise<void>;
  resolveLineage?(input: {
    documentId: string;
    currentFileSha256: string;
    analyzedInputRevision: string;
    currentInputRevision: string;
  }): ResolvedSequenceEditLineage;
}

export type NativeAnnotationDocumentSaveOutcome = ManagedDocumentSaveOutcome & {
  readonly display?: 'refreshed' | 'pending' | 'not-required';
  readonly displayError?: string;
  readonly lineage?: 'recorded' | 'unavailable';
};

interface Snapshot {
  document: NativeAnnotationDocument;
  contentHash: string;
  sequence: AnnotatedSequence;
}

export class NativeAnnotationDocumentCommands {
  constructor(private readonly deps: NativeAnnotationDocumentCommandDependencies) {}

  async inspect(input: ManagedDocumentOperationTarget): Promise<ManagedAnnotationInspection> {
    const target = { ...input };
    const authority = await this.deps.authorize(target);
    assertManagedAnnotationAuthority(target, authority);
    const document = await this.deps.resolve(target);
    const release = await acquireWorkspaceMutationShared(document.workspaceRoot);
    try {
      const snapshot = await this.read(document, target);
      return this.inspection(target, authority, snapshot);
    } finally {
      release();
    }
  }

  async apply(
    input: ManagedDocumentSelection,
    actionId: string
  ): Promise<NativeAnnotationDocumentSaveOutcome> {
    const target = { ...input, selectedCandidateIds: [...input.selectedCandidateIds] };
    let barrier: NativeAnnotationDocumentBarrier | undefined;
    let release: (() => void) | undefined;
    let wrote = false;
    let writeAttempted = false;
    let intentMayBeRecorded = false;
    let intent: DocumentWriteIntent | undefined;
    let publicationDocument: NativeAnnotationDocument | undefined;
    let notPublished = false;
    let needsRecovery = false;
    const perform = async (): Promise<NativeAnnotationDocumentSaveOutcome> => {
      try {
        if (
          !actionId.trim() ||
          actionId.length > 128 ||
          [...actionId].some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
          )
        ) {
          return { status: 'blocked', reason: 'A valid document action identity is required.' };
        }
        const selection = new Set(target.selectedCandidateIds);
        if (
          !selection.size ||
          selection.size > 10_000 ||
          selection.size !== target.selectedCandidateIds.length
        ) {
          return { status: 'blocked', reason: 'Select unique annotation candidates before Apply.' };
        }
        assertManagedAnnotationAuthority(target, await this.deps.authorize(target));
        const resolved = await this.deps.resolve(target);
        release = await acquireWorkspaceSyncMutationLease(resolved.workspaceRoot);
        const current = await this.deps.resolve(target);
        if (
          current.sourcePath !== resolved.sourcePath ||
          current.workspaceRoot !== resolved.workspaceRoot
        ) {
          return {
            status: 'blocked',
            reason: 'The target document moved while Apply was waiting.',
          };
        }
        barrier = await this.deps.prepare(current);
        const snapshot = await this.read(current, target);
        publicationDocument = snapshot.document;
        const authority = await this.deps.authorize(target);
        assertManagedAnnotationAuthority(target, authority);
        const inspection = await this.inspection(target, authority, snapshot);
        if (inspection.operationVersion !== target.expectedOperationVersion) {
          return { status: 'blocked', reason: 'The managed operation changed after inspection.' };
        }
        if (inspection.resultSha256 !== target.expectedResultSha256) {
          return { status: 'blocked', reason: 'The retained result changed after inspection.' };
        }
        if (inspection.targetDocumentRevision !== target.expectedTargetDocumentRevision) {
          return {
            status: 'blocked',
            reason: 'The target document changed after inspection.',
            targetDocumentRevision: inspection.targetDocumentRevision,
          };
        }
        if (!inspection.applicable) {
          return {
            status: 'blocked',
            reason: inspection.blockReason ?? 'The result is not applicable.',
          };
        }
        if (
          [...selection].some(
            (id) => !inspection.candidates.some((candidate) => candidate.id === id)
          )
        ) {
          return {
            status: 'blocked',
            reason: 'The selection contains an unknown annotation candidate.',
          };
        }
        const selected = createDraftAnnotations(
          inspection.candidates.map((candidate) => candidate.feature),
          snapshot.sequence.annotations ?? []
        )
          .map((draft, index) => ({ ...draft, id: inspection.candidates[index].id }))
          .filter((draft) => selection.has(draft.id));
        const additions = draftsToCommittedAnnotations(
          selected,
          snapshot.sequence.sequence.length
        ).map((annotation, index) => ({
          ...annotation,
          qualifiers: {
            ...annotation.qualifiers,
            dnaforge_operation_id: [target.operationId],
            dnaforge_candidate_id: [selected[index].id],
            dnaforge_input_revision: [authority.operation.subject.input_revision],
            dnaforge_result_sha256: [authority.resultSha256],
            dnaforge_action_id: [actionId],
          },
        }));
        const existing = snapshot.sequence.annotations ?? [];
        const alreadyPresent = additions.filter((addition) =>
          existing.some(
            (annotation) =>
              annotation.qualifiers?.dnaforge_operation_id?.includes(target.operationId) &&
              annotation.qualifiers?.dnaforge_candidate_id?.includes(
                addition.qualifiers.dnaforge_candidate_id[0]
              )
          )
        );
        if (alreadyPresent.length) {
          return {
            status: 'blocked',
            reason:
              'This result already has applied candidates. Recover its recorded document action before repeating Apply.',
          };
        }
        let content = serializeSequenceForInPlaceSave(
          { ...snapshot.sequence, annotations: [...existing, ...additions] },
          snapshot.document.sourcePath
        );
        if (this.deps.prepareContentForSave)
          content = await this.deps.prepareContentForSave(snapshot.document, content, actionId);
        const persisted = parseSequenceFileAsDocument(
          content,
          snapshot.document.sourcePath
        ).sequence;
        persisted.id = target.targetDocumentId;
        const inputRevision = await annotationInputRevision({
          sequence: snapshot.sequence.sequence,
          linear: !snapshot.sequence.circular,
        });
        const persistedInputRevision = await annotationInputRevision({
          sequence: persisted.sequence,
          linear: !persisted.circular,
        });
        if (
          persistedInputRevision !== inputRevision ||
          persisted.sequence.length !== snapshot.sequence.sequence.length ||
          Boolean(persisted.circular) !== Boolean(snapshot.sequence.circular)
        ) {
          throw new Error('Annotation Apply unexpectedly changed the sequence coordinate system.');
        }
        const targetDocumentRevision = await annotationTargetDocumentRevision(persisted);
        intent = {
          before_sha256: `sha256:${snapshot.contentHash}`,
          after_sha256: `sha256:${await sha256Text(content)}`,
          target_revision: targetDocumentRevision,
          selection_sha256: `sha256:${await sha256Text(JSON.stringify([...selection].sort()))}`,
          selection_count: selection.size,
        };
        barrier.assertCurrent();
        intentMayBeRecorded = true;
        const permission = await this.deps.recordWriteIntent({
          actionId,
          selection: target,
          intent,
        });
        if (permission.status === 'refused') {
          return { status: 'blocked', reason: permission.reason };
        }
        if (permission.status !== 'permitted') {
          return {
            status: 'outcome-unresolved',
            actionId,
            reason:
              'This write intent already exists or has no confirmed permission. Recover its recorded action before continuing.',
          };
        }
        writeAttempted = true;
        const publicationBarrier = barrier;
        const assertPublicationCurrent = () => {
          try {
            publicationBarrier.assertCurrent();
          } catch (error) {
            throw new WorkspaceFilePreconditionError(message(error));
          }
        };
        assertPublicationCurrent();
        const enrolled =
          this.deps.publishEnrolled &&
          (await this.deps.publishEnrolled({
            document: current,
            content,
            expectedContentHash: snapshot.contentHash,
            actionId,
            mutationLease: release!,
            assertCurrent: assertPublicationCurrent,
          }));
        if (!enrolled)
          await writeWorkspaceTextFileAtomicInMain(
            {
              workspaceRoot: current.workspaceRoot,
              path: current.sourcePath,
              mode: 'replace',
              expectedContentHash: snapshot.contentHash,
              content,
              artifactNoun: 'sequence document',
            },
            { durable: true, beforePublish: barrier.assertCurrent.bind(barrier) }
          );
        wrote = true;
        let lineage: 'recorded' | 'unavailable' = 'recorded';
        try {
          await this.deps.recordLineageAdvance({
            documentId: target.targetDocumentId,
            actionId,
            beforeFileSha256: intent.before_sha256,
            afterFileSha256: intent.after_sha256,
            beforeTargetDocumentRevision: inspection.targetDocumentRevision,
            afterTargetDocumentRevision: targetDocumentRevision,
            inputRevision,
            topology: persisted.circular ? 'circular' : 'linear',
            sequenceLength: persisted.sequence.length,
          });
        } catch (error) {
          lineage = 'unavailable';
          console.error('[ManagedDocument] Annotation saved without edit-lineage advance:', error);
        }
        let checkpoint: DocumentCheckpointOutcome;
        try {
          checkpoint = await this.deps.checkpoint(current);
        } catch (error) {
          checkpoint = { status: 'failed', reason: message(error) };
        }
        return { status: 'saved', targetDocumentRevision, checkpoint, lineage };
      } catch (error) {
        if (error instanceof WorkspaceFilePublicationUncertainError) wrote = true;
        notPublished = error instanceof WorkspaceFilePreconditionError;
        return wrote || (intentMayBeRecorded && !writeAttempted)
          ? { status: 'outcome-unresolved', actionId, reason: message(error) }
          : { status: writeAttempted ? 'save-failed' : 'blocked', reason: message(error) };
      }
    };
    try {
      let outcome = await perform();
      let observedHash: string | undefined;
      if (intent && writeAttempted && publicationDocument) {
        try {
          const bytes = await readFileBoundedFromHandle(
            publicationDocument.sourcePath,
            SOFT_WARN_BYTES - 1
          );
          observedHash = `sha256:${await sha256Bytes(bytes)}`;
        } catch (error) {
          outcome = { status: 'outcome-unresolved', actionId, reason: message(error) };
        }
      }
      let settlement: DocumentWriteSettlement;
      if (outcome.status === 'saved') {
        if (!intent || observedHash !== intent.after_sha256) {
          outcome = {
            status: 'outcome-unresolved',
            actionId,
            reason: 'The observed document no longer matches the intended saved file.',
          };
          settlement = { status: 'outcome-unresolved', reason: outcome.reason };
        } else {
          settlement = {
            status: 'saved',
            observed_sha256: observedHash,
            target_revision: outcome.targetDocumentRevision,
            checkpoint:
              outcome.checkpoint.status === 'failed'
                ? { status: 'failed', reason: boundedReason(outcome.checkpoint.reason) }
                : outcome.checkpoint,
          };
        }
      } else if (outcome.status === 'save-failed') {
        if (!intent || !observedHash || (!notPublished && observedHash !== intent.before_sha256)) {
          outcome = { status: 'outcome-unresolved', actionId, reason: outcome.reason };
          settlement = { status: 'outcome-unresolved', reason: boundedReason(outcome.reason) };
        } else {
          settlement = {
            status: 'save-failed',
            observed_sha256: observedHash,
            reason: boundedReason(outcome.reason),
            ...(notPublished ? { write_disposition: 'not-published' as const } : {}),
          };
        }
      } else if ('reason' in outcome) {
        settlement = { status: outcome.status, reason: boundedReason(outcome.reason) };
      } else {
        throw new Error('The native command returned no document outcome.');
      }
      needsRecovery = wrote || (writeAttempted && outcome.status === 'outcome-unresolved');
      try {
        await this.deps.recordOutcome(settlement);
      } catch (error) {
        return { status: 'outcome-unresolved', actionId, reason: message(error) };
      }
      if (outcome.status === 'saved' && barrier) {
        try {
          const display = await barrier.finish();
          barrier = undefined;
          return { ...outcome, display };
        } catch (error) {
          return { ...outcome, display: 'pending', displayError: message(error) };
        }
      }
      return outcome;
    } finally {
      try {
        barrier?.abort(needsRecovery || wrote ? 'needs-recovery' : 'unchanged');
      } catch (error) {
        console.warn('[ManagedDocument] The client barrier needs recovery:', message(error));
      } finally {
        release?.();
      }
    }
  }

  private async read(
    document: NativeAnnotationDocument,
    target: ManagedDocumentOperationTarget
  ): Promise<Snapshot> {
    if (document.documentId !== target.targetDocumentId)
      throw new Error('The native document identity changed.');
    const canonical = await canonicalWorkspacePath({
      workspaceRoot: document.workspaceRoot,
      path: document.sourcePath,
      artifactNoun: 'sequence document',
    });
    const bytes = await readFileBoundedFromHandle(canonical.candidate, SOFT_WARN_BYTES - 1);
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const sequence = parseSequenceFileAsDocument(content, canonical.candidate).sequence;
    sequence.id = document.documentId;
    serializeSequenceForInPlaceSave(sequence, canonical.candidate);
    return {
      document: { ...document, workspaceRoot: canonical.root, sourcePath: canonical.candidate },
      contentHash: await sha256Text(content),
      sequence,
    };
  }

  private async inspection(
    target: ManagedDocumentOperationTarget,
    authority: TrustedManagedAnnotationAuthority,
    snapshot: Snapshot
  ): Promise<ManagedAnnotationInspection> {
    const { sequence } = snapshot;
    const currentInput = await annotationInputRevision({
      sequence: sequence.sequence,
      linear: !sequence.circular,
    });
    let blockReason: string | undefined;
    let coordinates: 'exact' | 'mapped' = 'exact';
    let transitionCount = 0;
    let candidates = authority.result.features.map((sourceFeature, index) => ({
      id: `${target.operationId}:${index}`,
      index,
      sourceFeature,
      feature: sourceFeature,
      substitutionOverlap: false,
    }));
    if (
      currentInput === authority.operation.subject.input_revision &&
      authority.result.sequence_length !== sequence.sequence.length
    ) {
      blockReason = 'The retained result length does not match its analyzed sequence revision.';
    } else if (currentInput !== authority.operation.subject.input_revision) {
      try {
        if (!this.deps.resolveLineage) {
          throw new Error('No native saved edit-lineage resolver is available.');
        }
        const lineage = this.deps.resolveLineage({
          documentId: target.targetDocumentId,
          currentFileSha256: `sha256:${snapshot.contentHash}`,
          analyzedInputRevision: authority.operation.subject.input_revision,
          currentInputRevision: currentInput,
        });
        coordinates = lineage.exact ? 'exact' : 'mapped';
        transitionCount = lineage.transitions.length;
        if (
          lineage.transitions[0]?.event.transition.beforeLength !== authority.result.sequence_length
        ) {
          throw new Error('The saved edit history does not begin at the analyzed sequence length.');
        }
        candidates = candidates.flatMap((candidate) => {
          let feature = candidate.feature;
          let substitutionOverlap = false;
          for (const stored of lineage.transitions) {
            if (stored.event.beforeTopology !== stored.event.afterTopology) {
              throw new Error('A saved edit changed sequence topology. Rerun annotation.');
            }
            const mapped = mapAnnotationThroughSequenceEditTransition(
              featureAsAnnotation(feature),
              stored.event.transition
            );
            if (!mapped.annotation) return [];
            feature = {
              ...feature,
              start: mapped.annotation.start,
              end: mapped.annotation.end,
            };
            substitutionOverlap ||= mapped.substitutionOverlap;
          }
          return [{ ...candidate, feature, substitutionOverlap }];
        });
        if (candidates.length === 0) {
          throw new Error(
            'Saved edits removed every retained annotation candidate. Rerun annotation.'
          );
        }
      } catch (error) {
        blockReason = message(error);
      }
    }
    return {
      operationId: target.operationId,
      targetDocumentId: target.targetDocumentId,
      operationVersion: authority.operation.version,
      resultSha256: authority.resultSha256,
      targetDocumentRevision: await annotationTargetDocumentRevision(sequence),
      analyzedInputRevision: authority.operation.subject.input_revision,
      candidates,
      applicable: !blockReason,
      coordinates,
      transitionCount,
      ...(blockReason ? { blockReason } : {}),
    };
  }
}

function featureAsAnnotation(
  feature: TrustedManagedAnnotationAuthority['result']['features'][number]
): Annotation {
  return {
    name: feature.name,
    type: feature.type || 'misc_feature',
    start: feature.start,
    end: feature.end,
    direction: feature.strand === 1 ? 1 : feature.strand === -1 ? -1 : 0,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'The native document command was refused.';
}

function boundedReason(reason: string): string {
  return (reason || 'The native document command did not complete.').slice(0, 2048);
}
