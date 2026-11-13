import type { GitReadTabCloseAbortReason } from './git-read-ipc';

const CLOSE_GESTURE_TTL_MS = 5_000;
const MAX_PENDING_CLOSE_GESTURES = 32;
export const SEQUENCE_TAB_CLOSE_COMMITTED_EVENT = 'waypoint:sequence-tab-close-committed';

export interface SequenceTabCloseCommittedDetail {
  readonly tabId: string;
  readonly closeGestureToken: string;
  readonly activeAbortControllerCount: number;
}

interface PendingCloseGesture {
  readonly reason: GitReadTabCloseAbortReason;
  readonly createdAt: number;
}

const pendingCloseGestures = new Map<string, PendingCloseGesture>();
const activeCloseAbortControllers = new Map<string, Set<AbortController>>();

function pruneExpiredCloseGestures(now: number): void {
  for (const [tabId, entry] of pendingCloseGestures) {
    if (now - entry.createdAt <= CLOSE_GESTURE_TTL_MS) continue;
    pendingCloseGestures.delete(tabId);
  }
}

export function recordSequenceTabCloseGesture(tabId: string): GitReadTabCloseAbortReason {
  const now = Date.now();
  pruneExpiredCloseGestures(now);
  const reason: GitReadTabCloseAbortReason = Object.freeze({
    kind: 'tab-close',
    closeGestureToken: crypto.randomUUID(),
  });
  pendingCloseGestures.delete(tabId);
  pendingCloseGestures.set(tabId, { reason, createdAt: now });
  while (pendingCloseGestures.size > MAX_PENDING_CLOSE_GESTURES) {
    const oldestTabId = pendingCloseGestures.keys().next().value;
    if (typeof oldestTabId !== 'string') break;
    pendingCloseGestures.delete(oldestTabId);
  }
  const activeControllers = activeCloseAbortControllers.get(tabId) ?? new Set<AbortController>();
  for (const controller of activeControllers) {
    controller.abort(reason);
  }
  if (typeof window !== 'undefined') {
    const detail: SequenceTabCloseCommittedDetail = {
      tabId,
      closeGestureToken: reason.closeGestureToken,
      activeAbortControllerCount: activeControllers.size,
    };
    window.dispatchEvent(
      new CustomEvent<SequenceTabCloseCommittedDetail>(SEQUENCE_TAB_CLOSE_COMMITTED_EVENT, {
        detail,
      })
    );
  }
  return reason;
}

export function registerSequenceTabCloseAbortController(
  tabId: string,
  controller: AbortController
): () => void {
  const controllers = activeCloseAbortControllers.get(tabId) ?? new Set<AbortController>();
  controllers.add(controller);
  activeCloseAbortControllers.set(tabId, controllers);
  return () => {
    const currentControllers = activeCloseAbortControllers.get(tabId);
    if (!currentControllers) return;
    currentControllers.delete(controller);
    if (currentControllers.size === 0) {
      activeCloseAbortControllers.delete(tabId);
    }
  };
}

export function consumeSequenceTabCloseGesture(
  tabId: string
): GitReadTabCloseAbortReason | undefined {
  const now = Date.now();
  pruneExpiredCloseGestures(now);
  const entry = pendingCloseGestures.get(tabId);
  pendingCloseGestures.delete(tabId);
  return entry?.reason;
}
