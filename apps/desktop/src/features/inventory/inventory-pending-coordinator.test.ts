import { expect, it, vi } from 'vitest';
import { inventoryTableCanonicalJson, inventoryTableSha256 } from '@waypoint/domain-services';
import type {
  InventoryAcceptedRequest,
  NativeInventoryReceipt,
} from '../../shared/inventory-command';
import {
  coordinatorForStorage,
  inventoryAttemptStorage,
  InventoryPendingCoordinator,
} from './inventory-pending-coordinator';
const request = (operationId = 'old-operation', project = 'project'): InventoryAcceptedRequest => ({
  operationId,
  commands: [
    { kind: 'create-storage', id: 'box', name: 'Box', slots: ['A'], placement: { kind: 'root' } },
  ],
  inventoryId: 'inventory',
  project,
  expectedRevision: 0,
});
const receipt = (operationId: string, project = 'project'): NativeInventoryReceipt => ({
  status: 'committed',
  inventoryId: 'inventory',
  operationId,
  revision: 1,
  actor: 'profile',
  recordedAt: 100,
  requestDigest: inventoryTableSha256(inventoryTableCanonicalJson(request(operationId, project))),
});
it('keeps retained request property order and passive storage bytes while merging only a named inventory', () => {
  const old = { request: request(), summary: 'Old change' },
    raw = JSON.stringify([old]);
  let saved = raw;
  const port = {
    getItem: vi.fn(() => saved),
    setItem: vi.fn((_key: string, value: string) => {
      saved = value;
    }),
  };
  const storage = inventoryAttemptStorage(port),
    owner = coordinatorForStorage(storage);
  expect(coordinatorForStorage(storage)).toBe(owner);
  owner.refresh();
  expect(port.setItem).not.toHaveBeenCalled();
  expect(saved).toBe(raw);
  expect(JSON.stringify(owner.peek(old.request)!.request)).toBe(JSON.stringify(old.request));
  const token = owner.retain({
    request: request('new-operation', 'other-project'),
    summary: 'Other project',
  });
  owner.confirm(token, receipt('new-operation', 'other-project'));
  owner.clear(token);
  expect(saved).toBe(raw);
  expect(port.setItem.mock.calls.every(([key]) => key === 'dnaforge.inventory.pending.v1')).toBe(
    true
  );
});
it('shares one pending scope and one in-flight lease without clobbering another accepted attempt', () => {
  let attempts: readonly { request: InventoryAcceptedRequest; summary: string }[] = [];
  const owner = new InventoryPendingCoordinator({
    read: () => attempts,
    write: (next) => {
      attempts = next;
    },
  });
  const first = owner.retain({ request: request(), summary: 'Old change' });
  expect(() => owner.retain({ request: request('different'), summary: 'Changed' })).toThrow(
    /previous inventory change/i
  );
  const release = owner.acquire(first, 'send');
  expect(() => owner.acquire(first, 'inspect')).toThrow(/already being confirmed/i);
  release();
  release();
  owner.acquire(first, 'inspect')();
  expect(attempts).toHaveLength(1);
});
it('rejects stale receipt and clear tokens and fails closed on persistence errors', () => {
  let attempts: readonly { request: InventoryAcceptedRequest; summary: string }[] = [];
  const owner = new InventoryPendingCoordinator({
    read: () => attempts,
    write: (next) => {
      attempts = next;
    },
  });
  const first = owner.retain({ request: request(), summary: 'Old' });
  owner.clear(first);
  owner.retain({ request: request('new'), summary: 'New' });
  expect(() => owner.confirm(first, receipt('old-operation'))).toThrow(/replaced/i);
  expect(() => owner.clear(first)).toThrow(/replaced/i);
  expect(attempts[0]!.request.operationId).toBe('new');
  const unavailable = new InventoryPendingCoordinator({
    read: () => [],
    write: () => {
      throw Error('Storage unavailable');
    },
  });
  expect(() => unavailable.retain({ request: request(), summary: 'No send' })).toThrow(
    'Storage unavailable'
  );
  expect(unavailable.getSnapshot().attempts).toEqual([]);
});
