// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  loadWorkspaceDeliveryReceipts,
  rememberWorkspaceDeliveryReceipt,
} from './workspace-delivery-receipts';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe('workspace delivery receipts', () => {
  it('rejects a transport retry after a renderer reload', () => {
    const storage = memoryStorage();
    const firstRenderer = loadWorkspaceDeliveryReceipts(storage);

    expect(rememberWorkspaceDeliveryReceipt(firstRenderer, 'delivery-a', storage)).toBe(true);

    const reloadedRenderer = loadWorkspaceDeliveryReceipts(storage);
    expect(rememberWorkspaceDeliveryReceipt(reloadedRenderer, 'delivery-a', storage)).toBe(false);
  });

  it('retains only the newest 128 delivery receipts', () => {
    const storage = memoryStorage();
    const receipts = loadWorkspaceDeliveryReceipts(storage);

    for (let index = 0; index < 130; index += 1) {
      expect(rememberWorkspaceDeliveryReceipt(receipts, `delivery-${index}`, storage)).toBe(true);
    }

    const reloaded = loadWorkspaceDeliveryReceipts(storage);
    expect(reloaded).toHaveLength(128);
    expect(reloaded.has('delivery-0')).toBe(false);
    expect(reloaded.has('delivery-1')).toBe(false);
    expect(reloaded.has('delivery-2')).toBe(true);
    expect(reloaded.has('delivery-129')).toBe(true);
  });

  it('fails safely when stored receipt data is malformed', () => {
    const storage = memoryStorage();
    storage.setItem('dnaforge:workspace-delivery-receipts', '{not-json');

    expect(loadWorkspaceDeliveryReceipts(storage)).toEqual(new Set());
  });
});
