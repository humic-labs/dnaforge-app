import { expect, it, vi } from 'vitest';
import { unavailableInventoryClient } from '../../shared/inventory-client';
import { inventoryApplyScientificCitationRequestSchema } from '../../shared/inventory-scientific-citations';
import {
  InventoryPendingCoordinator,
  type InventoryAttempt,
} from './inventory-pending-coordinator';
import { InventoryScientificCitationSession } from './inventory-scientific-citation-session';
const target = {
  project: 'project',
  inventoryId: 'inventory',
  workId: `scientific-work:${'a'.repeat(64)}`,
  workIntentSha256: `sha256:${'b'.repeat(64)}` as const,
};
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
    summary: 'Add citation',
    request: inventoryApplyScientificCitationRequestSchema.parse({
      kind: 'record-scientific-citation',
      project: target.project,
      inventoryId: target.inventoryId,
      expectedRevision: 93,
      expectedPlanDigest: `sha256:${'d'.repeat(64)}`,
      operationId: 'original-operation',
      choices: {
        identity: { namespace: 'manual-citations', citationId: 'citation-once' },
        workId: target.workId,
        workIntentSha256: target.workIntentSha256,
        context: {
          kind: 'notebook-page',
          entityId: 'project::page',
          sourceSha256: `sha256:${'c'.repeat(64)}`,
        },
        reinstates: null,
        reason: 'Existing saved experiment context',
      },
    }),
  };
}
it('refuses a saved attempt under different immutable work pins without altering its durable request', () => {
  const native = unavailableInventoryClient(),
    owner = pending(),
    original = attempt();
  owner.retain(original);
  const session = new InventoryScientificCitationSession(
    native,
    owner,
    { ...target, workIntentSha256: `sha256:${'f'.repeat(64)}` },
    { kind: 'add' },
    storage()
  );
  const bytes = JSON.stringify(owner.peek(target)!.request);
  expect(() => session.resume(original)).toThrow(/another inventory/i);
  expect(session.getSnapshot().phase.kind).toBe('editing');
  expect(JSON.stringify(owner.peek(target)!.request)).toBe(bytes);
  session.dispose();
});
it('sends no read or preview when the stable citation draft cannot be persisted', async () => {
  const native = unavailableInventoryClient();
  native.scientificCitations = vi.fn();
  native.previewScientificCitation = vi.fn();
  native.applyScientificCitation = vi.fn();
  const session = new InventoryScientificCitationSession(
    native,
    pending(),
    target,
    { kind: 'add' },
    {
      getItem: () => null,
      setItem: () => {
        throw Error('Storage unavailable');
      },
    }
  );
  await session.preview();
  await session.submit();
  expect(session.getSnapshot().phase.kind).toBe('failed');
  expect(native.scientificCitations).not.toHaveBeenCalled();
  expect(native.previewScientificCitation).not.toHaveBeenCalled();
  expect(native.applyScientificCitation).not.toHaveBeenCalled();
  session.dispose();
});
