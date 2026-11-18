import {
  inventoryTableCanonicalJson as canonical,
  inventoryTableSha256,
} from './inventory-table-binding';
import type { InventoryTableSha256 } from './inventory-table-types';
import type {
  InventoryScientificCitation,
  InventoryScientificCitationChoices,
  InventoryScientificCitationIdentity,
  InventoryScientificCitationPredecessor,
  InventoryScientificCitationWithdrawal,
  InventoryScientificCitationWithdrawalChoices,
  InventoryScientificCitationWithdrawalIdentity,
} from './inventory-scientific-citation-types';

function text(value: string, field: string, max = 1024): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > max)
    throw new TypeError(`The scientific citation requires ${field}.`);
  return value;
}
function sha(value: InventoryTableSha256): InventoryTableSha256 {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value))
    throw new TypeError('The scientific citation requires an exact SHA-256 pin.');
  return value;
}
function predecessor(value: InventoryScientificCitationPredecessor | null) {
  if (value === null) return null;
  return {
    citationId: text(value.citationId, 'the predecessor citation ID', 512),
    citationIntentSha256: sha(value.citationIntentSha256),
    withdrawalId: text(value.withdrawalId, 'the predecessor withdrawal ID', 512),
    withdrawalIntentSha256: sha(value.withdrawalIntentSha256),
  };
}
export function inventoryScientificCitationId(
  identity: InventoryScientificCitationIdentity
): string {
  return `scientific-citation:${inventoryTableSha256(canonical(['dnaforge.inventory-scientific-citation.v1', text(identity.namespace, 'a citation namespace'), text(identity.citationId, 'a stable citation ID')])).slice(7)}`;
}
export function inventoryScientificCitationWithdrawalId(
  identity: InventoryScientificCitationWithdrawalIdentity
): string {
  return `scientific-citation-withdrawal:${inventoryTableSha256(canonical(['dnaforge.inventory-scientific-citation-withdrawal.v1', text(identity.namespace, 'a withdrawal namespace'), text(identity.withdrawalId, 'a stable withdrawal ID')])).slice(7)}`;
}
function target(input: InventoryScientificCitationChoices) {
  if (input.context.kind !== 'notebook-page' && input.context.kind !== 'protocol-run')
    throw new TypeError('Choose a supported explicit citation source kind.');
  return {
    workId: text(input.workId, 'the exact physical work ID', 512),
    workIntentSha256: sha(input.workIntentSha256),
    context: {
      kind: input.context.kind,
      entityId: text(input.context.entityId, 'the canonical cited source ID', 512),
      sourceSha256: sha(input.context.sourceSha256),
    },
    reinstates: predecessor(input.reinstates),
  };
}
export function inventoryScientificCitationIntentSha256(
  input: InventoryScientificCitationChoices
): InventoryTableSha256 {
  inventoryScientificCitationId(input.identity);
  return inventoryTableSha256(
    canonical({
      schema: 'dnaforge.inventory-scientific-citation-intent.v1',
      identity: { namespace: input.identity.namespace, citationId: input.identity.citationId },
      ...target(input),
      reason: text(input.reason, 'the citation reason', 2000),
    })
  );
}
export function inventoryScientificCitationSemanticKey(
  input: InventoryScientificCitationChoices
): string {
  const value = target(input);
  return canonical([
    'dnaforge.inventory-scientific-citation-target.v1',
    value.workId,
    value.workIntentSha256,
    value.context.kind,
    value.context.entityId,
    value.context.sourceSha256,
    value.reinstates,
  ]);
}
export function inventoryScientificCitationWithdrawalIntentSha256(
  input: InventoryScientificCitationWithdrawalChoices
): InventoryTableSha256 {
  inventoryScientificCitationWithdrawalId(input.identity);
  return inventoryTableSha256(
    canonical({
      schema: 'dnaforge.inventory-scientific-citation-withdrawal-intent.v1',
      identity: { namespace: input.identity.namespace, withdrawalId: input.identity.withdrawalId },
      citationId: text(input.citationId, 'the exact citation ID', 512),
      citationIntentSha256: sha(input.citationIntentSha256),
      workId: text(input.workId, 'the exact physical work ID', 512),
      workIntentSha256: sha(input.workIntentSha256),
      reason: text(input.reason, 'the withdrawal reason', 2000),
    })
  );
}
export function inventoryScientificCitationChoices(
  record: InventoryScientificCitation
): InventoryScientificCitationChoices {
  return {
    identity: { ...record.identity },
    workId: record.workId,
    workIntentSha256: record.workIntentSha256,
    context: {
      kind: record.context.kind,
      entityId: record.context.entityId,
      sourceSha256: record.context.source.sha256,
    },
    reinstates: record.reinstates ? { ...record.reinstates } : null,
    reason: record.reason,
  };
}
export function inventoryScientificCitationWithdrawalChoices(
  record: InventoryScientificCitationWithdrawal
): InventoryScientificCitationWithdrawalChoices {
  return {
    identity: { ...record.identity },
    citationId: record.citationId,
    citationIntentSha256: record.citationIntentSha256,
    workId: record.workId,
    workIntentSha256: record.workIntentSha256,
    reason: record.reason,
  };
}
