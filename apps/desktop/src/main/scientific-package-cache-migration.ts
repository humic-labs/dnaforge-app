import {
  defineBlob,
  defineResourceState,
  listWorkspaceResources,
  parseOperationId,
  type WorkspaceMutation,
} from '@waypoint/workspace-revisions';
import type { ScientificObjectStore } from './scientific-object-store';
import { readAcceptedSequencePackage } from './scientific-sequence-package';
import { parseNativeJson } from './scientific-native-json';
import { reconcileScientificNativeProjectionsInsideTx } from './scientific-native-projection';
import type Database from 'better-sqlite3';

export function repairAcceptedSequencePackageCaches(
  db: Database.Database,
  store: ScientificObjectStore,
  workspaceId: number
): boolean {
  const { graph, head, reader } = store.read();
  if (!head) return false;
  const slots = listWorkspaceResources(graph, head);
  if (!slots.ok) throw new Error('Accepted package migration paths are unavailable.');
  const mutations: WorkspaceMutation[] = [],
    blobs: Uint8Array[] = [];
  for (const slot of slots.value) {
    if (!slot.path || slot.tombstone) continue;
    const product = reader.current(slot.resourceId);
    if (product?.document.kind !== 'sequence' || product.representation?.format !== 'genbank-v1')
      continue;
    const metadata = readAcceptedSequencePackage({
      store,
      graph,
      head,
      sequenceId: slot.resourceId,
      productPath: slot.path,
      productText: product.representation.text,
      verifyProductChecksum: false,
    });
    if (!metadata) continue;
    const raw = parseNativeJson(metadata.text);
    const expected = defineBlob(new TextEncoder().encode(product.representation.text)).hash;
    const recorded = raw.product as Record<string, unknown>;
    if (recorded.genBankChecksum === expected) continue;
    const bytes = new TextEncoder().encode(
      `${JSON.stringify(
        { ...raw, product: { ...recorded, genBankChecksum: expected } },
        null,
        2
      )}\n`
    );
    const state = defineResourceState({
      layout: 'file',
      resourceKind: metadata.resourceKind,
      mediaType: 'application/json',
      blob: defineBlob(bytes),
    });
    if (!state.ok) throw new Error('Accepted package cache migration is invalid.');
    mutations.push({
      kind: 'edit-resource',
      resourceId: metadata.resourceId,
      expectedRevision: metadata.revisionId,
      state: state.value,
    });
    blobs.push(bytes);
  }
  if (!mutations.length) return false;
  const operationId = parseOperationId(`sequence-package-cache-migration:${head}`);
  if (!operationId.ok) throw new Error('Accepted package migration identity is invalid.');
  const result = store.submit(
    { operationId: operationId.value, expectedHead: head, mutations, blobs },
    () => {
      reconcileScientificNativeProjectionsInsideTx(db, workspaceId);
    }
  );
  if (result.kind !== 'changed' && result.kind !== 'replay')
    throw new Error(`Accepted package cache migration failed: ${result.kind}`);
  return true;
}
