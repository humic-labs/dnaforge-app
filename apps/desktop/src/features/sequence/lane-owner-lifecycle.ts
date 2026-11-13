import { useLaneContractStore } from './lane-contract-store';

interface LaneOwnerRetention {
  retainCount: number;
  clearTimer: ReturnType<typeof globalThis.setTimeout> | null;
}

const retentions = new Map<string, LaneOwnerRetention>();

export function retainLaneOwner(ownerId: string): () => void {
  const retention = retentions.get(ownerId) ?? { retainCount: 0, clearTimer: null };
  if (retention.clearTimer !== null) {
    globalThis.clearTimeout(retention.clearTimer);
    retention.clearTimer = null;
  }
  retention.retainCount += 1;
  retentions.set(ownerId, retention);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    retention.retainCount = Math.max(0, retention.retainCount - 1);
    if (retention.retainCount !== 0 || retention.clearTimer !== null) return;
    retention.clearTimer = globalThis.setTimeout(() => {
      retention.clearTimer = null;
      if (retention.retainCount !== 0) return;
      retentions.delete(ownerId);
      useLaneContractStore.getState().clearOwner(ownerId);
    }, 0);
  };
}
