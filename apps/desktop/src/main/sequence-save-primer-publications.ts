import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  inspectResourceRevision,
  inspectResourceState,
  inspectWorkspaceVersion,
  listWorkspaceResources,
  parseWorkspaceVersionId,
  type RevisionGraph,
  type WorkspaceResourceSlotView,
  type WorkspaceVersionId,
} from '@waypoint/workspace-revisions';
import {
  createScientificReader,
  scientificIdentityResourceId,
  scientificIdentityPath,
} from '@waypoint/scientific-objects';
import {
  SEQUENCE_SAVE_PRIMER_PUBLICATION_EVENT_TYPE,
  type SequenceDocumentHistoryInput,
  type SequenceDocumentWriteReceipt,
} from '../shared/sequence-edit-lineage';
import {
  PRIMER_BINDING_OWNERSHIP_EVENT_TYPE,
  parsePrimerBindingOwnership,
  primerBindingOwnershipEventId,
} from '../shared/primer-artifacts/primer-binding-ownership';
import type { SavedPrimerArtifact } from '../shared/primer-artifacts/primer-artifact-owner';
import { assertWorkspaceSyncDatabaseFence } from './workspace-sync-database-fence';
import { ScientificObjectStore } from './scientific-object-store';
import { scientificNativeCodecs } from './scientific-native-codecs';

const identity = z.string().min(1).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const publicationSchema = z
  .object({
    formatVersion: z.literal(1),
    workspaceId: z.number().int().positive(),
    nativeActionId: z.string().uuid(),
    documentId: identity,
    draftLineageId: identity,
    saveOperationId: identity,
    saveVersionId: identity,
    saveResourceRevisionId: identity,
    saveEventId: identity,
    saveContentSha256: digest,
    baseVersionId: identity,
    primer: z
      .object({
        resourceId: identity,
        resourceRevisionId: identity,
        workspaceVersionId: identity,
        contentSha256: digest,
      })
      .strict(),
    ownedBindingIds: z.array(identity).min(1).max(10000),
    bindingIds: z.array(identity).max(10000),
    gitStatus: z.enum(['committed', 'not-git', 'failed']),
  })
  .strict();

export function retainSequenceSavePrimerPublication(input: {
  db: Database.Database;
  databaseFence: () => void;
  assertCurrent(): void;
  workspaceId: number;
  documentId: string;
  draftLineageId: string;
  receipt: SequenceDocumentWriteReceipt;
  baseVersionId: string;
  saved: SavedPrimerArtifact;
  ownedBindingIds: readonly string[];
  bindingIds: readonly string[];
}): string {
  assertWorkspaceSyncDatabaseFence(input.db, input.databaseFence);
  input.assertCurrent();
  const save = input.receipt.accepted;
  const primer = input.saved.acceptedRevision;
  if (!save || !primer || !input.receipt.revisionId || !input.saved.historyStatus)
    throw new Error('The native primer publication has no acknowledged sequence Save context.');
  const payload = publicationSchema.parse({
    formatVersion: 1,
    workspaceId: input.workspaceId,
    nativeActionId: input.receipt.nativeActionId,
    documentId: input.documentId,
    draftLineageId: input.draftLineageId,
    saveOperationId: save.operationId,
    saveVersionId: save.workspaceVersionId,
    saveResourceRevisionId: save.resourceRevisionId,
    saveEventId: input.receipt.revisionId,
    saveContentSha256: input.receipt.contentSha256,
    baseVersionId: input.baseVersionId,
    primer: {
      resourceId: primer.resourceId,
      resourceRevisionId: primer.resourceRevisionId,
      workspaceVersionId: primer.workspaceVersionId,
      contentSha256: primer.contentSha256,
    },
    ownedBindingIds: [...input.ownedBindingIds],
    bindingIds: [...new Set(input.bindingIds)],
    gitStatus: input.saved.historyStatus,
  });
  const accepted = new ScientificObjectStore(input.db, input.workspaceId).read();
  if (accepted.head !== primer.workspaceVersionId)
    throw new Error('The accepted primer changed before its native Save receipt was retained.');
  const id = `sequence-primer-publication:${randomUUID()}`;
  input.db.transaction(() => {
    assertWorkspaceSyncDatabaseFence(input.db, input.databaseFence);
    input.assertCurrent();
    input.db
      .prepare(
        "INSERT INTO catalog_entity_events(id,entity_id,event_type,actor,summary,payload,created_at) VALUES(?,?,?,'system',NULL,?,?)"
      )
      .run(
        id,
        input.documentId,
        SEQUENCE_SAVE_PRIMER_PUBLICATION_EVENT_TYPE,
        JSON.stringify(payload),
        Date.now()
      );
  })();
  return id;
}

export function sequenceSavePrimerPublicationSlots(input: {
  request: SequenceDocumentHistoryInput;
  db: Database.Database;
  workspaceId: number;
  store: ScientificObjectStore;
  graph: RevisionGraph;
  head: WorkspaceVersionId;
  draftLineageId: string;
}): readonly WorkspaceResourceSlotView[] | null {
  const ids = input.request.primerPublicationIds;
  if (ids === undefined) return [];
  const save = input.request.accepted;
  if (
    !save ||
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > 10000 ||
    new Set(ids).size !== ids.length
  )
    return null;
  const intents = input.db
    .prepare<[string, string], { id: string; payload: string | null }>(
      'SELECT id,payload FROM catalog_entity_events WHERE entity_id=? AND event_type=? ORDER BY id'
    )
    .all(input.request.documentId, PRIMER_BINDING_OWNERSHIP_EVENT_TYPE)
    .map((row) => {
      const intent = parsePrimerBindingOwnership(row.payload);
      if (
        row.id !== primerBindingOwnershipEventId(intent) ||
        intent.documentId !== input.request.documentId
      )
        throw new Error('The retained primer attachment belongs to another native owner.');
      return intent;
    });
  const selected = new Map<string, WorkspaceResourceSlotView>();
  let cursor = save.workspaceVersionId;
  for (const id of ids) {
    if (typeof id !== 'string' || !/^sequence-primer-publication:[a-f0-9-]{36}$/u.test(id))
      return null;
    const row = input.db
      .prepare<
        [string, string, string],
        { payload: string }
      >("SELECT payload FROM catalog_entity_events WHERE id=? AND entity_id=? AND event_type=? AND actor='system'")
      .get(id, input.request.documentId, SEQUENCE_SAVE_PRIMER_PUBLICATION_EVENT_TYPE);
    if (!row) return null;
    const raw: unknown = JSON.parse(row.payload);
    const parsed = publicationSchema.safeParse(raw);
    if (!parsed.success) return null;
    const publication = parsed.data;
    if (
      publication.workspaceId !== input.workspaceId ||
      publication.documentId !== input.request.documentId ||
      publication.nativeActionId !== input.request.nativeActionId ||
      publication.draftLineageId !== input.draftLineageId ||
      publication.saveOperationId !== save.operationId ||
      publication.saveVersionId !== save.workspaceVersionId ||
      publication.saveResourceRevisionId !== save.resourceRevisionId ||
      publication.saveEventId !== input.request.revisionId ||
      publication.saveContentSha256 !== input.request.contentSha256 ||
      publication.baseVersionId !== cursor ||
      new Set(publication.ownedBindingIds).size !== publication.ownedBindingIds.length ||
      publication.ownedBindingIds.some(
        (bindingId) =>
          !intents.some(
            (intent) =>
              intent.bindingId === bindingId &&
              intent.primerId === publication.primer.resourceId &&
              intent.draftLineageId === input.draftLineageId
          )
      )
    )
      return null;
    const base = parseWorkspaceVersionId(cursor),
      next = parseWorkspaceVersionId(publication.primer.workspaceVersionId);
    if (!base.ok || !next.ok) return null;
    const version = inspectWorkspaceVersion(input.graph, next.value),
      before = listWorkspaceResources(input.graph, base.value),
      after = listWorkspaceResources(input.graph, next.value);
    if (
      !version.ok ||
      !before.ok ||
      !after.ok ||
      (next.value !== base.value &&
        (version.value.parentIds.length !== 1 || version.value.parentIds[0] !== base.value))
    )
      return null;
    const prior = new Map(before.value.map((slot) => [slot.resourceId, slot]));
    const following = new Map(after.value.map((slot) => [slot.resourceId, slot]));
    if (before.value.some((slot) => !following.has(slot.resourceId))) return null;
    const primer = after.value.find(
      (slot) => slot.resourceId === publication.primer.resourceId && !slot.tombstone
    );
    if (
      !primer?.path ||
      primer.revisionId !== publication.primer.resourceRevisionId ||
      prior.get(primer.resourceId)?.path !== primer.path
    )
      return null;
    const revision = inspectResourceRevision(input.graph, primer.revisionId);
    const state =
      revision.ok && revision.value.stateHash
        ? inspectResourceState(input.graph, revision.value.stateHash)
        : null;
    if (
      !state?.ok ||
      state.value.layout !== 'file' ||
      state.value.blob.hash !== `sha256:${publication.primer.contentSha256}`
    )
      return null;
    selected.set(primer.resourceId, primer);
    const allowed = new Set<string>([
      primer.resourceId,
      scientificIdentityResourceId,
      ...publication.ownedBindingIds,
    ]);
    const reader = createScientificReader({
      graph: input.graph,
      head: next.value,
      readBlob: (blob) => input.store.readBlob(blob),
      codecs: scientificNativeCodecs,
    });
    for (const bindingId of publication.bindingIds) {
      const slot = after.value.find((entry) => entry.resourceId === bindingId && !entry.tombstone);
      const binding = slot && reader.current(slot.resourceId)?.document;
      if (
        !slot ||
        binding?.kind !== 'primer-binding' ||
        binding.primerId !== primer.resourceId ||
        binding.target.resourceId !== input.request.documentId ||
        binding.target.revisionId !== save.resourceRevisionId
      )
        return null;
      selected.set(slot.resourceId, slot);
    }
    for (const slot of after.value) {
      const previous = prior.get(slot.resourceId);
      if (
        previous &&
        previous.revisionId === slot.revisionId &&
        previous.path === slot.path &&
        previous.lastPath === slot.lastPath &&
        previous.tombstone === slot.tombstone
      )
        continue;
      if (!allowed.has(slot.resourceId) || !(slot.path ?? slot.lastPath)) return null;
      if (slot.resourceId === scientificIdentityResourceId) {
        if (slot.tombstone || slot.path !== scientificIdentityPath) return null;
      } else if (slot.resourceId !== primer.resourceId && !slot.tombstone) {
        const binding = reader.current(slot.resourceId)?.document;
        if (
          binding?.kind !== 'primer-binding' ||
          binding.primerId !== primer.resourceId ||
          binding.target.resourceId !== input.request.documentId ||
          binding.target.revisionId !== save.resourceRevisionId
        )
          return null;
      }
      selected.set(slot.resourceId, slot);
    }
    cursor = publication.primer.workspaceVersionId;
  }
  return cursor === input.head ? [...selected.values()] : null;
}
