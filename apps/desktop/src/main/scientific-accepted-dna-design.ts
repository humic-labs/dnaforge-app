import type Database from 'better-sqlite3';
import {
  inspectAcceptedDnaProductionSelection,
  verifyAcceptedDnaProductionWitness,
  type AcceptedDnaProductionWitness,
  type VerifiedAcceptedDnaProduction,
} from '@waypoint/scientific-artifacts';
import type {
  AcceptedDnaProductionSelection,
  InventoryImportBindingObservation,
} from '@waypoint/domain-services';
import { ScientificObjectStore } from './scientific-object-store';
import { scientificHistoryWorkspaceIdentity } from './scientific-history-identity';
import { canonicalNativeMutationRequest } from './native-mutation-request';
export interface NativeAcceptedDnaProductionLease {
  readonly verified: VerifiedAcceptedDnaProduction;
  readonly materialId: string;
  assertCurrent(): void;
}
export interface NativeAcceptedDnaProductionCapture {
  readonly witness: AcceptedDnaProductionWitness;
  readonly verified: VerifiedAcceptedDnaProduction;
  refreshCurrent(): NativeAcceptedDnaProductionLease;
}
export function captureAcceptedDnaProductionDesign(input: {
  db: Database.Database;
  workspaceId: number;
  projectId: string;
  workspaceScope: string;
  selection: AcceptedDnaProductionSelection;
  remainingWireBytes: number;
  observeMaterial: () => InventoryImportBindingObservation;
}): NativeAcceptedDnaProductionCapture {
  const { db } = input,
    store = new ScientificObjectStore(db, input.workspaceId);
  const witness = db
    .transaction(() => ({
      schema: 'dnaforge.accepted-dna-production-witness.v1' as const,
      owner: {
        projectId: input.projectId,
        workspaceScope: input.workspaceScope,
        scientificWorkspaceId: scientificHistoryWorkspaceIdentity(db, input.workspaceId),
      },
      selection: input.selection,
      ...store.exportHistoryWithBodies(input.remainingWireBytes),
    }))
    .deferred();
  if (Buffer.byteLength(JSON.stringify(witness), 'utf8') > input.remainingWireBytes)
    throw new Error('Scientific proof exceeds the inline budget.');
  const verified = verifyAcceptedDnaProductionWitness(witness);
  return {
    witness,
    verified,
    refreshCurrent: () =>
      db
        .transaction(() => {
          if (
            scientificHistoryWorkspaceIdentity(db, input.workspaceId) !==
            witness.owner.scientificWorkspaceId
          )
            throw new Error('SCIENTIFIC_SOURCE_CHANGED: The logical scientific owner changed.');
          const snapshot = store.read(),
            fresh = inspectAcceptedDnaProductionSelection({
              ...snapshot,
              readBlob: (blob) => store.readBlob(blob),
              owner: witness.owner,
              selection: input.selection,
              requiredAcceptedAncestor: verified.capturedAcceptedHead,
            });
          if (
            canonicalNativeMutationRequest(fresh.binding) !==
            canonicalNativeMutationRequest(verified.binding)
          )
            throw new Error('SCIENTIFIC_SOURCE_CHANGED: Selected DNA design changed.');
          const material = input.observeMaterial();
          if (
            material.kind !== 'admitted' ||
            material.destinationMaterialId !== input.selection.revision.resourceId
          )
            throw new Error(
              'SCIENTIFIC_SOURCE_CHANGED: The selected design material is unavailable.'
            );
          const fingerprint = canonicalNativeMutationRequest(material),
            assertSource = store.captureCurrentReadGuard();
          return {
            verified: fresh,
            materialId: material.destinationMaterialId,
            assertCurrent: () => {
              assertSource();
              if (canonicalNativeMutationRequest(input.observeMaterial()) !== fingerprint)
                throw new Error(
                  'SCIENTIFIC_SOURCE_CHANGED: The design material projection changed.'
                );
            },
          };
        })
        .deferred(),
  };
}
