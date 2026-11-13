import type { EditorPendingPrimerBinding } from '@waypoint/workspace-editor/model';
import { primerArtifactRelativePath } from './primer-artifact-path';
import type {
  createPrimerArtifactOwner,
  OwnedPrimerBindingMutation,
} from './primer-artifact-owner';
import type { createPrimerApplicationOwner } from './primer-application-owner';
import type { BoundPrimer, Primer } from './types';
import type { PrimerBindingOwnershipStore } from './primer-binding-ownership';
type ArtifactOwner = ReturnType<typeof createPrimerArtifactOwner>;
type ApplicationOwner = ReturnType<typeof createPrimerApplicationOwner>;
export interface RichPastePrimerPersistence {
  listLegacyBoundPrimers(sequenceId: number): Promise<BoundPrimer[]>;
  getPrimer(id: string): Promise<Primer | null>;
  readSavedTarget: ArtifactOwner['readSavedPrimerBindingTarget'];
  persistOwnedArtifactBindings: ArtifactOwner['persistOwnedPrimerArtifactBindings'];
  persistOwnedLegacyBinding: ApplicationOwner['persistOwnedPrimerBinding'];
  deleteLegacyBinding: ApplicationOwner['deleteBinding'];
  notifyBindingsChanged(sequenceId: number): void;
}
export interface PersistRichPastePrimerBindingsInput {
  bindings: readonly EditorPendingPrimerBinding[];
  draftLineageId: string;
  expectedFileSha256: string;
  targetDocumentId: string;
  targetFilePath: string;
  targetSequenceId: number;
  targetWorkspaceRoot: string;
}

export async function persistRichPastePrimerBindings(
  input: PersistRichPastePrimerBindingsInput,
  persistence: RichPastePrimerPersistence,
  ownership: PrimerBindingOwnershipStore
): Promise<OwnedPrimerBindingMutation[]> {
  const pending = new Map<string, EditorPendingPrimerBinding>();
  for (const binding of input.bindings) {
    if (!binding.pendingId)
      throw new Error('The pasted primer binding has no stable edit identity.');
    if (binding.sourceWorkspaceRoot && binding.sourceWorkspaceRoot !== input.targetWorkspaceRoot) {
      throw new Error('Primer bindings cannot yet be transferred between projects.');
    }
    const previous = pending.get(binding.pendingId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(binding)) {
      throw new Error('A pasted primer identity describes conflicting attachments.');
    }
    pending.set(binding.pendingId, binding);
  }
  const previousIntents = await ownership.load(input.targetDocumentId, input.draftLineageId);
  if (pending.size === 0 && previousIntents.length === 0) return [];
  const target = {
    workspaceRoot: input.targetWorkspaceRoot,
    targetFilePath: input.targetFilePath,
    targetDocumentId: input.targetDocumentId,
    bindingSequenceId: input.targetSequenceId,
    expectedFileSha256: input.expectedFileSha256,
  };
  await persistence.readSavedTarget(target);
  for (const binding of pending.values()) {
    if (!previousIntents.some((intent) => intent.pendingId === binding.pendingId)) {
      await ownership.record({
        documentId: input.targetDocumentId,
        draftLineageId: input.draftLineageId,
        pendingId: binding.pendingId,
        primerId: binding.primerId,
        sequenceId: input.targetSequenceId,
        bindingId: globalThis.crypto.randomUUID(),
      });
    }
  }
  const intents = await ownership.load(input.targetDocumentId, input.draftLineageId);
  const groups = new Map<string, typeof intents>();
  for (const intent of intents) {
    const binding = pending.get(intent.pendingId);
    if (
      intent.documentId !== input.targetDocumentId ||
      intent.draftLineageId !== input.draftLineageId ||
      intent.sequenceId !== input.targetSequenceId ||
      (binding && binding.primerId !== intent.primerId)
    ) {
      throw new Error('The saved primer attachment intent belongs to another target.');
    }
    const group = groups.get(intent.primerId) ?? [];
    group.push(intent);
    groups.set(intent.primerId, group);
  }
  if ([...pending.keys()].some((id) => !intents.some((intent) => intent.pendingId === id))) {
    throw new Error('The primer attachment ownership intent was not persisted.');
  }
  const existing = await persistence.listLegacyBoundPrimers(input.targetSequenceId);
  const receipts: OwnedPrimerBindingMutation[] = [];
  for (const [primerId, owned] of groups) {
    const primer = await persistence.getPrimer(primerId);
    if (!primer) throw new Error(`Copied primer ${primerId} is no longer available.`);
    const ownedIds = new Set(owned.map((intent) => intent.bindingId));
    const desired = [...pending.values()]
      .filter((binding) => binding.primerId === primerId)
      .map((binding) => {
        const intent = owned.find((candidate) => candidate.pendingId === binding.pendingId);
        if (!intent) throw new Error('The primer attachment ownership intent was not persisted.');
        return { bindingId: intent.bindingId, ...binding };
      });
    for (const row of existing) {
      if (
        ownedIds.has(row.binding.id) &&
        (row.id !== primerId || row.binding.sequenceId !== input.targetSequenceId)
      ) {
        throw new Error('A copied primer binding ID belongs to another attachment.');
      }
    }
    if (primerArtifactRelativePath(primer)) {
      const persisted = await persistence.persistOwnedArtifactBindings({
        primer,
        workspaceRoot: input.targetWorkspaceRoot,
        targetDocumentId: input.targetDocumentId,
        targetFilePath: input.targetFilePath,
        bindingSequenceId: input.targetSequenceId,
        expectedFileSha256: input.expectedFileSha256,
        ownedBindingIds: [...ownedIds],
        bindings: desired,
      });
      receipts.push(...persisted.bindingMutations);
      continue;
    }
    const key = (binding: { start: number; end: number; strand: number }) =>
      `${binding.start}:${binding.end}:${binding.strand}`;
    const completed = new Map(
      existing
        .filter((row) => row.id === primerId && !ownedIds.has(row.binding.id))
        .map((row) => [
          key({
            start: row.binding.bindingStart,
            end: row.binding.bindingEnd,
            strand: row.binding.strand,
          }),
          row.binding.id,
        ])
    );
    const retainedIds = new Set<string>();
    for (const binding of desired) {
      const duplicateId = completed.get(key(binding));
      if (duplicateId) {
        receipts.push({ bindingId: duplicateId, bindingMutation: 'duplicate' });
        continue;
      }
      const persisted = await persistence.persistOwnedLegacyBinding({
        bindingId: binding.bindingId,
        primerId,
        sequenceId: input.targetSequenceId,
        bindingStart: binding.start,
        bindingEnd: binding.end,
        strand: binding.strand,
      });
      if (
        persisted.id !== binding.bindingId ||
        persisted.primerId !== primerId ||
        persisted.sequenceId !== input.targetSequenceId ||
        persisted.bindingStart !== binding.start ||
        persisted.bindingEnd !== binding.end ||
        persisted.strand !== binding.strand
      ) {
        throw new Error('The persisted primer attachment does not match its owned save capture.');
      }
      retainedIds.add(persisted.id);
      completed.set(key(binding), persisted.id);
      receipts.push({
        bindingId: persisted.id,
        bindingMutation: existing.some((row) => row.binding.id === persisted.id)
          ? 'updated'
          : 'created',
      });
    }
    for (const row of existing) {
      if (ownedIds.has(row.binding.id) && !retainedIds.has(row.binding.id)) {
        await persistence.deleteLegacyBinding(row.binding.id);
      }
    }
  }
  await persistence.readSavedTarget(target);
  if (intents.length > 0) persistence.notifyBindingsChanged(input.targetSequenceId);
  return receipts;
}
