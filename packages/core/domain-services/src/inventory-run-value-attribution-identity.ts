import {
  inventoryTableCanonicalJson as canonical,
  inventoryTableSha256,
} from './inventory-table-binding';
import { inventoryPlatePlanText } from './inventory-plate-plan-definition';
import { inventoryRunValueCollection } from './inventory-run-value-attribution-value';
import type { InventoryTableSha256 } from './inventory-table-types';
import type {
  InventoryRunValueAttribution,
  InventoryRunValueAttributionChoices,
  InventoryRunValueAttributionIdentity,
  InventoryRunValueAttributionWithdrawal,
  InventoryRunValueAttributionWithdrawalChoices,
  InventoryRunValueAttributionWithdrawalIdentity,
} from './inventory-run-value-attribution-types';

function text(value: string, field: string, max = 512) {
  inventoryPlatePlanText(value, max, field);
  return value;
}
function sha(value: InventoryTableSha256) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value))
    throw new TypeError('Run value attribution requires an exact SHA-256 pin.');
  return value;
}
export function inventoryRunValueAttributionId(
  identity: InventoryRunValueAttributionIdentity
): string {
  return `run-value-attribution:${inventoryTableSha256(canonical(['dnaforge.inventory-run-value-attribution.v1', text(identity.namespace, 'attribution namespace', 1024), text(identity.attributionId, 'stable attribution identity', 1024)])).slice(7)}`;
}
export function inventoryRunValueAttributionWithdrawalId(
  identity: InventoryRunValueAttributionWithdrawalIdentity
): string {
  return `run-value-attribution-withdrawal:${inventoryTableSha256(canonical(['dnaforge.inventory-run-value-attribution-withdrawal.v1', text(identity.namespace, 'withdrawal namespace', 1024), text(identity.withdrawalId, 'stable withdrawal identity', 1024)])).slice(7)}`;
}
function target(input: InventoryRunValueAttributionChoices) {
  inventoryRunValueCollection(input.runValue.collection);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(input.runValue.key) || input.runValue.key.length > 1024)
    throw new TypeError('Choose the exact portable saved Run slot key.');
  const subject = input.physical.subject;
  if (subject.kind !== 'source-stock' && subject.kind !== 'output-action')
    throw new TypeError('Choose an exact recorded source stock or output action.');
  return {
    runValue: {
      entityId: text(input.runValue.entityId, 'canonical saved Run'),
      sourceSha256: sha(input.runValue.sourceSha256),
      collection: input.runValue.collection,
      key: input.runValue.key,
      rowSha256: sha(input.runValue.rowSha256),
    },
    physical: {
      observationId: text(input.physical.observationId, 'physical observation'),
      observationIntentSha256: sha(input.physical.observationIntentSha256),
      subject:
        subject.kind === 'source-stock'
          ? { kind: subject.kind, stockId: text(subject.stockId, 'recorded source stock') }
          : {
              kind: subject.kind,
              actionId: text(subject.actionId, 'recorded output action'),
              stockId: text(subject.stockId, 'recorded output stock'),
            },
    },
    predecessor:
      input.predecessor === null
        ? null
        : {
            attributionId: text(input.predecessor.attributionId, 'predecessor attribution'),
            attributionIntentSha256: sha(input.predecessor.attributionIntentSha256),
            withdrawalId: text(input.predecessor.withdrawalId, 'predecessor withdrawal'),
            withdrawalIntentSha256: sha(input.predecessor.withdrawalIntentSha256),
          },
  };
}
export function inventoryRunValueAttributionIntentSha256(
  input: InventoryRunValueAttributionChoices
) {
  inventoryRunValueAttributionId(input.identity);
  return inventoryTableSha256(
    canonical({
      schema: 'dnaforge.inventory-run-value-attribution-intent.v1',
      identity: { ...input.identity },
      ...target(input),
      reason: text(input.reason, 'attribution reason', 2000),
    })
  );
}
export function inventoryRunValueAttributionSemanticKey(
  input: InventoryRunValueAttributionChoices
): string {
  const fields = target(input);
  return canonical([
    'dnaforge.inventory-run-value-attribution-target.v1',
    fields.runValue,
    fields.physical,
    fields.predecessor,
  ]);
}
export function inventoryRunValueAttributionWithdrawalIntentSha256(
  input: InventoryRunValueAttributionWithdrawalChoices
) {
  inventoryRunValueAttributionWithdrawalId(input.identity);
  return inventoryTableSha256(
    canonical({
      schema: 'dnaforge.inventory-run-value-attribution-withdrawal-intent.v1',
      identity: { ...input.identity },
      attributionId: text(input.attributionId, 'exact attribution'),
      attributionIntentSha256: sha(input.attributionIntentSha256),
      reason: text(input.reason, 'withdrawal reason', 2000),
    })
  );
}
export function inventoryRunValueAttributionChoices(
  record: InventoryRunValueAttribution
): InventoryRunValueAttributionChoices {
  return structuredClone({
    identity: record.identity,
    runValue: record.runValue,
    physical: record.physical,
    predecessor: record.predecessor,
    reason: record.reason,
  });
}
export function inventoryRunValueAttributionWithdrawalChoices(
  record: InventoryRunValueAttributionWithdrawal
): InventoryRunValueAttributionWithdrawalChoices {
  return structuredClone({
    identity: record.identity,
    attributionId: record.attributionId,
    attributionIntentSha256: record.attributionIntentSha256,
    reason: record.reason,
  });
}
