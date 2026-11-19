import { serializeGenBank } from '@waypoint/sequence-utils';
import { cleanSequenceFromEditorState } from '@waypoint/workspace-editor/model';
import { platform } from '../../platform';
import { findWorkspaceRootForPath } from '../../db/workspace-catalog';
import { ensureSequenceIdentity } from '../../db';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { documentLifecycle } from '../../shared/document-lifecycle';
import { SaveAllCancelled } from '../../shared/save-all-result';
import type { SequenceDocumentSnapshot } from '../../shared/sequence-document';
import { canonicalJson } from '../../shared/canonical-json';
import { sha256Hex } from '../../shared/sha256';
import { useCanvasStore } from '../canvas/public/store';
import { classifyTabSession } from '../canvas/tab-document-session';
import { openSequenceFile } from '../document-opening/public/compat';
import { flushFileDocumentClients } from '../workspace/public/file-document-client';
import { persistRichPastePrimerBindings } from '../sequence-clipboard/public/persist-primer-bindings';
import {
  createDnaSequencePackage,
  normalizeSequencePackageName,
  SequenceCreationPendingError,
  type CapturedSequenceCreation,
} from './create-empty-dna-sequence';
import { managedSequenceRepository } from './managed-sequence-repository';
import { getNativeSequenceDocumentClient } from './sequence-document-client';
import { useSequenceStore, type SequenceSaveCapture } from './store';
import {
  SequencePersistenceError,
  type PersistableSequenceDocument,
  type SequencePersistenceResult,
} from './persist-sequence-document';

type CopyCapture = Pick<
  SequenceSaveCapture,
  'revision' | 'sequence' | 'pendingPrimerBindings' | 'draftLineageId'
>;
type PendingCopy = {
  revision: number;
  captured: string;
  destinationPath: string;
  name: string;
  content: string;
  publication?: CapturedSequenceCreation;
  filePath?: string;
};
const copies = new Map<string, PendingCopy>();
const saving = new Map<string, { revision: number; done: Promise<SequencePersistenceResult> }>();

const inspectCopy = (documentId: string) =>
  platform().fs.sequenceDocument({
    documentId,
    operation: { kind: 'inspect', start: 0, limit: 1, annotationOffset: 0, annotationLimit: 0 },
    projection: 'document',
  });

function nativeCapture(snapshot: SequenceDocumentSnapshot): CopyCapture {
  if (
    !snapshot.copy ||
    !snapshot.saveDestinationRequired ||
    !snapshot.dirty ||
    snapshot.readOnly ||
    snapshot.recoveryId
  )
    throw new Error('The source has no current editable revision to save as a copy.');
  return {
    revision: snapshot.version,
    sequence: snapshot.copy.sequence,
    draftLineageId: snapshot.copy.lineage.id,
    pendingPrimerBindings: cleanSequenceFromEditorState(snapshot.copy.draft).pendingPrimerBindings,
  };
}

function fingerprint(capture: CopyCapture) {
  return canonicalJson(
    JSON.parse(
      JSON.stringify([
        capture.revision,
        capture.draftLineageId,
        capture.sequence,
        capture.pendingPrimerBindings,
      ])
    )
  );
}

export async function saveDirtySequenceCopiesAsNeeded(): Promise<void> {
  await flushFileDocumentClients();
  for (const item of await platform().fs.listDirtyDocuments()) {
    if (!item.saveDestinationRequired || item.readOnly || item.recovery || !item.dirty) continue;
    const snapshot = await inspectCopy(item.documentId);
    if (!snapshot.dirty) continue;
    const result = await saveEditedSequenceCopy(
      { documentId: item.documentId, sourcePath: item.path },
      nativeCapture(snapshot),
      snapshot
    );
    if (!result.ok) {
      if (result.error.code === 'cancelled') throw new SaveAllCancelled();
      throw result.error;
    }
  }
}

export function saveEditedSequenceCopy(
  document: PersistableSequenceDocument,
  capture: CopyCapture,
  admitted?: SequenceDocumentSnapshot
): Promise<SequencePersistenceResult> {
  const previous = saving.get(document.documentId);
  if (previous) {
    if (previous.revision === capture.revision) return previous.done;
    return previous.done.then(() => saveEditedSequenceCopy(document, capture, admitted));
  }
  const done = saveCopy(document, structuredClone(capture), admitted)
    .catch((error: unknown): SequencePersistenceResult => {
      const pending = copies.get(document.documentId);
      const wrote =
        pending?.revision === capture.revision && Boolean(pending.filePath || pending.publication);
      return {
        ok: false,
        outcome: 'failed',
        attempts: 1,
        ...(wrote ? { wrote: true, writtenRevision: capture.revision } : { wrote: false }),
        error: new SequencePersistenceError(
          error instanceof SaveAllCancelled ? 'cancelled' : 'write_failed',
          error instanceof Error ? error.message : String(error),
          error
        ),
      };
    })
    .finally(() => {
      if (saving.get(document.documentId)?.done === done) saving.delete(document.documentId);
    });
  saving.set(document.documentId, { revision: capture.revision, done });
  return done;
}

async function saveCopy(
  { documentId, sourcePath }: PersistableSequenceDocument,
  capture: CopyCapture,
  admitted?: SequenceDocumentSnapshot
): Promise<SequencePersistenceResult> {
  const native = getNativeSequenceDocumentClient();
  const captured = fingerprint(capture);
  await native?.flushDocument(documentId);
  const snapshot = admitted ?? (native ? await inspectCopy(documentId) : undefined);
  const verifyCurrent = () => {
    const state = useSequenceStore.getState();
    if (!snapshot && !state.sequences[documentId])
      throw new Error('The source draft is no longer available.');
    if (
      state.sequences[documentId] &&
      (state.getVersion(documentId) !== capture.revision || !state.isDirty(documentId))
    )
      throw new Error('The source changed while saving the copy. Its current edits remain open.');
  };
  verifyCurrent();
  if (
    snapshot &&
    (snapshot.path !== sourcePath || fingerprint(nativeCapture(snapshot)) !== captured)
  )
    throw new Error('The native draft changed before the edited copy could be saved.');
  let pending = copies.get(documentId);
  if (!pending || pending.captured !== captured) {
    const selected = await platform().dialog.save({
      purpose: 'edited-sequence-package',
      defaultPath: sourcePath.replace(/\.[^./\\]+$/u, '') + ' copy',
    });
    if (!selected) throw new SaveAllCancelled();
    const split = Math.max(selected.lastIndexOf('/'), selected.lastIndexOf('\\'));
    const destinationPath = selected.slice(0, split + 1);
    const name = selected.slice(split + 1);
    if (normalizeSequencePackageName(name) !== name)
      throw new Error('Choose a valid name for the new sequence package.');
    const root = findWorkspaceRootForPath(useWorkspaceStore.getState().folders, destinationPath);
    if (!root)
      throw new Error('Choose a folder in an open project for the editable sequence copy.');
    if (
      capture.pendingPrimerBindings.some(
        (binding) => binding.sourceWorkspaceRoot && binding.sourceWorkspaceRoot !== root
      )
    )
      throw new Error('Choose the same project to keep the linked primers with this edited copy.');
    if (await platform().fs.exists(selected))
      throw new Error(
        'A file or sequence package already exists at that destination. Choose a new name.'
      );
    verifyCurrent();
    pending = {
      revision: capture.revision,
      captured,
      destinationPath,
      name,
      content: serializeGenBank(capture.sequence),
    };
    copies.set(documentId, pending);
  }
  if (!pending.filePath) {
    try {
      const copied = await createDnaSequencePackage({
        destinationPath: pending.destinationPath,
        name: pending.name,
        exactPackageName: true,
        content: pending.content,
        publication: pending.publication,
        open: false,
      });
      pending.filePath = copied.filePath;
    } catch (error) {
      if (error instanceof SequenceCreationPendingError) pending.publication = error.creation;
      else copies.delete(documentId);
      throw error;
    }
  }
  const filePath = pending.filePath;
  const text = await platform().fs.readTextFile(filePath);
  if (text !== pending.content) {
    copies.delete(documentId);
    throw new Error(
      'The saved copy differs from the captured GenBank document. The source edits remain open.'
    );
  }
  if (capture.pendingPrimerBindings.length) {
    const target = await managedSequenceRepository.findByMemberPath(filePath);
    const root = findWorkspaceRootForPath(useWorkspaceStore.getState().folders, filePath);
    if (!target || !root)
      throw new Error('The copied sequence has no project identity for its linked primers.');
    const sequence = capture.sequence;
    const targetSequenceId = await ensureSequenceIdentity(
      target.document.id,
      filePath,
      sequence.name,
      sequence.length,
      !!sequence.circular,
      root
    );
    await persistRichPastePrimerBindings({
      bindings: capture.pendingPrimerBindings,
      draftLineageId: capture.draftLineageId,
      expectedFileSha256: 'sha256:' + (await sha256Hex(text)),
      targetDocumentId: target.document.id,
      targetFilePath: filePath,
      targetSequenceId,
      targetWorkspaceRoot: root,
    });
  }
  const tabId = await openSequenceFile({
    filePath,
    label: pending.name,
    strategy: { kind: 'focused' },
    sourceSurface: 'file_tree',
  });
  if (!tabId)
    throw new Error(
      'The edited copy was saved but could not be reopened. Its source draft remains available.'
    );
  if ((await platform().fs.readTextFile(filePath)) !== text) {
    copies.delete(documentId);
    throw new Error('The saved destination changed while reopening. The source edits remain open.');
  }
  await native?.flushDocument(documentId);
  verifyCurrent();
  let releasedSourceRevision: number;
  if (snapshot?.copy) {
    const released = await platform().fs.sequenceDocument({
      documentId,
      expectedVersion: capture.revision,
      expectedRevision: {
        revision: snapshot.revision,
        copyJson: JSON.stringify(snapshot.copy),
        bindingIdentity: snapshot.bindingIdentity,
      },
      operation: { kind: 'client-command', command: { method: 'discardEdits' } },
      projection: 'document',
    });
    if (released.dirty || released.recoveryId || released.path !== sourcePath)
      throw new Error('The source has more edits to save.');
    native?.observe(released);
    releasedSourceRevision = released.version;
  } else {
    useSequenceStore.getState().discardEdits(documentId);
    releasedSourceRevision = useSequenceStore.getState().getVersion(documentId);
  }
  copies.delete(documentId);
  const canvas = useCanvasStore.getState();
  for (const panel of Object.values(canvas.panels)) {
    for (const tab of panel.tabs) {
      const session = classifyTabSession(tab);
      if (
        session.kind === 'sequence' &&
        session.editor === 'sequence' &&
        tab.entityId === documentId &&
        tab.id !== tabId &&
        !useSequenceStore.getState().isDirty(documentId) &&
        !documentLifecycle.hasAdditionalEdits({ kind: 'sequence-document', documentId }, tab.id)
      )
        canvas.closeTab(panel.id, tab.id);
    }
  }
  return {
    ok: true,
    outcome: 'saved',
    attempts: 1,
    wrote: true,
    writtenRevision: capture.revision,
    copyDestination: { filePath, releasedSourceRevision },
  };
}
