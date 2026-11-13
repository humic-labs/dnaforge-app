import type { CatalogDatabase } from '../../db/catalog-repository';

export const PRIMER_BINDING_OWNERSHIP_EVENT_TYPE = 'rich_paste_primer_binding_intent_v1';

export interface PrimerBindingOwnership {
  documentId: string;
  draftLineageId: string;
  pendingId: string;
  primerId: string;
  sequenceId: number;
  bindingId: string;
}

export interface PrimerBindingOwnershipStore {
  load(documentId: string, draftLineageId: string): Promise<PrimerBindingOwnership[]>;
  record(intent: PrimerBindingOwnership): Promise<void>;
}

export function primerBindingOwnershipEventId(intent: PrimerBindingOwnership): string {
  return `${PRIMER_BINDING_OWNERSHIP_EVENT_TYPE}:${JSON.stringify([
    intent.documentId,
    intent.draftLineageId,
    intent.pendingId,
  ])}`;
}

export function parsePrimerBindingOwnership(payload: string | null): PrimerBindingOwnership {
  const value: unknown = payload === null ? null : JSON.parse(payload);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('documentId' in value) ||
    typeof value.documentId !== 'string' ||
    !value.documentId ||
    !('draftLineageId' in value) ||
    typeof value.draftLineageId !== 'string' ||
    !value.draftLineageId ||
    !('pendingId' in value) ||
    typeof value.pendingId !== 'string' ||
    !value.pendingId ||
    !('primerId' in value) ||
    typeof value.primerId !== 'string' ||
    !value.primerId ||
    !('sequenceId' in value) ||
    typeof value.sequenceId !== 'number' ||
    !Number.isSafeInteger(value.sequenceId) ||
    !('bindingId' in value) ||
    typeof value.bindingId !== 'string' ||
    !value.bindingId
  ) {
    throw new Error('The saved primer attachment ownership record is invalid.');
  }
  return {
    documentId: value.documentId,
    draftLineageId: value.draftLineageId,
    pendingId: value.pendingId,
    primerId: value.primerId,
    sequenceId: value.sequenceId,
    bindingId: value.bindingId,
  };
}

export function createPrimerBindingOwnershipStore(
  database: () => Pick<CatalogDatabase, 'select' | 'recordCatalogEvent'>
): PrimerBindingOwnershipStore {
  return {
    async load(documentId, draftLineageId) {
      const rows = await database().select<{ id: string; payload: string | null }[]>(
        `SELECT id, payload FROM catalog_entity_events WHERE entity_id = ? AND event_type = ? ORDER BY id`,
        [documentId, PRIMER_BINDING_OWNERSHIP_EVENT_TYPE]
      );
      const intents = rows
        .map((row) => {
          const intent = parsePrimerBindingOwnership(row.payload);
          if (
            intent.documentId !== documentId ||
            primerBindingOwnershipEventId(intent) !== row.id
          ) {
            throw new Error('Primer attachment ownership belongs to a different document.');
          }
          return intent;
        })
        .filter((intent) => intent.draftLineageId === draftLineageId);
      if (new Set(intents.map((intent) => intent.bindingId)).size !== intents.length) {
        throw new Error('Saved primer attachment ownership contains duplicate native IDs.');
      }
      return intents;
    },
    async record(intent) {
      const db = database();
      const id = primerBindingOwnershipEventId(intent);
      const rows = await db.select<Array<{ created_at: number }>>(
        'SELECT created_at FROM catalog_entity_events WHERE id=?',
        [id]
      );
      await db.recordCatalogEvent({
        id,
        entityId: intent.documentId,
        eventType: PRIMER_BINDING_OWNERSHIP_EVENT_TYPE,
        actor: 'user',
        summary: null,
        payload: { ...intent },
        createdAt: rows[0]?.created_at ?? Date.now(),
      });
    },
  };
}
