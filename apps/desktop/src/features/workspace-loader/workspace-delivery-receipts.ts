const WORKSPACE_DELIVERY_RECEIPTS_KEY = 'dnaforge:workspace-delivery-receipts';
const MAX_WORKSPACE_DELIVERY_RECEIPTS = 128;

type SessionStorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function loadWorkspaceDeliveryReceipts(storage: SessionStorageLike): Set<string> {
  try {
    const stored = storage.getItem(WORKSPACE_DELIVERY_RECEIPTS_KEY);
    if (!stored) return new Set();
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .slice(-MAX_WORKSPACE_DELIVERY_RECEIPTS)
    );
  } catch {
    return new Set();
  }
}

export function rememberWorkspaceDeliveryReceipt(
  receipts: Set<string>,
  deliveryId: string,
  storage: SessionStorageLike
): boolean {
  if (receipts.has(deliveryId)) return false;

  receipts.add(deliveryId);
  while (receipts.size > MAX_WORKSPACE_DELIVERY_RECEIPTS) {
    const oldestDeliveryId = receipts.values().next().value;
    if (typeof oldestDeliveryId !== 'string') break;
    receipts.delete(oldestDeliveryId);
  }

  try {
    storage.setItem(WORKSPACE_DELIVERY_RECEIPTS_KEY, JSON.stringify([...receipts]));
  } catch {}
  return true;
}
