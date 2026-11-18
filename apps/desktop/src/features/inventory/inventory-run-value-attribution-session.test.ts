import { expect, it, vi } from 'vitest';
import { unavailableInventoryClient } from '../../shared/inventory-client';
import { inventoryApplyRunValueAttributionRequestSchema } from '../../shared/inventory-run-value-attributions';
import {
  InventoryPendingCoordinator,
  type InventoryAttempt,
} from './inventory-pending-coordinator';
import { InventoryRunValueAttributionSession } from './inventory-run-value-attribution-session';
const scope = { project: 'project', inventoryId: 'inventory' };
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
function pending() {
  let attempts: readonly InventoryAttempt[] = [];
  return new InventoryPendingCoordinator({
    read: () => attempts,
    write: (next) => {
      attempts = next;
    },
  });
}
function attempt(): InventoryAttempt {
  return {
    summary: 'Associate a saved value',
    request: inventoryApplyRunValueAttributionRequestSchema.parse({
      ...scope,
      kind: 'record-run-value-attribution',
      operationId: 'original-operation',
      expectedRevision: 99,
      expectedPlanDigest: `sha256:${'a'.repeat(64)}`,
      choices: {
        identity: { namespace: 'manual', attributionId: 'once' },
        runValue: {
          entityId: 'project::run',
          sourceSha256: `sha256:${'b'.repeat(64)}`,
          collection: 'outputs',
          key: 'result',
          rowSha256: `sha256:${'c'.repeat(64)}`,
        },
        physical: {
          observationId: `plate-plan-observation:${'d'.repeat(64)}`,
          observationIntentSha256: `sha256:${'e'.repeat(64)}`,
          subject: { kind: 'output-action', actionId: 'action', stockId: 'aliquot' },
        },
        predecessor: null,
        reason: 'Describes this recorded aliquot',
      },
    }),
  };
}
it('refuses a retained request for another Run without changing its original bytes', () => {
  const owner = pending(),
    original = attempt();
  owner.retain(original);
  const session = new InventoryRunValueAttributionSession(
    scope,
    { kind: 'add', runId: 'project::other' },
    unavailableInventoryClient(),
    owner,
    storage()
  );
  const bytes = JSON.stringify(owner.peek(scope));
  expect(() => session.resume(original)).toThrow(/another Run/);
  expect(JSON.stringify(owner.peek(scope))).toBe(bytes);
  session.detach();
});
it('does not read or preview when the stable draft cannot be persisted', async () => {
  const native = unavailableInventoryClient();
  native.runValueAttributions = vi.fn();
  native.previewRunValueAttribution = vi.fn();
  const session = new InventoryRunValueAttributionSession(
    scope,
    { kind: 'add', runId: 'project::run' },
    native,
    pending(),
    {
      getItem: () => null,
      setItem: () => {
        throw Error('Storage unavailable');
      },
    }
  );
  await session.preview();
  expect(session.getSnapshot().phase.kind).toBe('failed');
  expect(native.runValueAttributions).not.toHaveBeenCalled();
  expect(native.previewRunValueAttribution).not.toHaveBeenCalled();
  session.detach();
});
it('keeps a mismatched rejection unknown and retries only the exact retained request', async () => {
  const native = unavailableInventoryClient(),
    owner = pending(),
    original = attempt();
  owner.retain(original);
  native.applyRunValueAttribution = vi
    .fn()
    .mockResolvedValue({
      status: 'rejected',
      inventoryId: scope.inventoryId,
      operationId: 'another-operation',
      code: 'INVENTORY_REVISION_CONFLICT',
      message: 'Wrong result',
    });
  const session = new InventoryRunValueAttributionSession(
    scope,
    { kind: 'add', runId: 'project::run' },
    native,
    owner,
    storage()
  );
  session.resume(original);
  await session.retry();
  expect(session.getSnapshot().phase.kind).toBe('unknown');
  expect(owner.peek(scope)?.request).toEqual(original.request);
  expect(native.applyRunValueAttribution).toHaveBeenCalledWith(original.request);
  session.detach();
});
