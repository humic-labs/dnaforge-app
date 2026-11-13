import type { HoveredResidueKey } from '../../../../structure-drawer/public/state/hovered-residue-store';
import type { ResidueLocation } from '../types';

export const STRUCTURE_HOVER_SYNC_DELAY_MS = 32;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface HoverStoreLike<T> {
  getSnapshot: () => T | null;
  set: (next: T | null) => void;
}

export interface HoverSyncTimerApi {
  setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
}

export interface DeferredStructureHoverSync<T> {
  schedule: (next: T | null) => void;
  dispose: () => void;
}

export interface InboundHoverOwner {
  structureId: string;
  residue: ResidueLocation;
}

export function createDeferredStructureHoverSync<T>(
  store: HoverStoreLike<T>,
  options: {
    delayMs?: number;
    timers?: HoverSyncTimerApi;
  } = {}
): DeferredStructureHoverSync<T> {
  const delayMs = options.delayMs ?? STRUCTURE_HOVER_SYNC_DELAY_MS;
  const timers = options.timers ?? {
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (handle) => clearTimeout(handle),
  };

  let timer: TimerHandle | null = null;
  let queued: T | null = null;
  let scheduledFrom: T | null = null;

  const clearPending = () => {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  };

  const flush = () => {
    timer = null;
    const current = store.getSnapshot();
    if (current !== scheduledFrom) return;
    store.set(queued);
  };

  return {
    schedule(next) {
      queued = next;
      scheduledFrom = store.getSnapshot();
      clearPending();
      timer = timers.setTimeout(flush, delayMs);
    },
    dispose() {
      clearPending();
    },
  };
}

export function decideOutboundWrite(
  hovered: ResidueLocation | null | undefined,
  structureId: string
): HoveredResidueKey | null {
  if (!hovered) return null;
  if (hovered.compId) return null;
  return {
    structureId,
    chain: hovered.chain,
    position: hovered.position,
    ...(hovered.baseChain ? { baseChain: hovered.baseChain } : {}),
    ...(hovered.labelAsymId ? { labelAsymId: hovered.labelAsymId } : {}),
    ...(hovered.authAsymId ? { authAsymId: hovered.authAsymId } : {}),
    ...(hovered.entityId ? { entityId: hovered.entityId } : {}),
    ...(hovered.operator ? { operator: hovered.operator } : {}),
  };
}

export function decideInboundDispatch(
  storeValue: HoveredResidueKey | null,
  structureId: string,
  localHovered: ResidueLocation | null | undefined
): ResidueLocation | null {
  if (!storeValue) return null;
  if (storeValue.structureId !== structureId) return null;
  if (
    localHovered &&
    !localHovered.compId &&
    localHovered.chain === storeValue.chain &&
    localHovered.position === storeValue.position &&
    localHovered.baseChain === storeValue.baseChain &&
    localHovered.labelAsymId === storeValue.labelAsymId &&
    localHovered.authAsymId === storeValue.authAsymId &&
    localHovered.entityId === storeValue.entityId &&
    localHovered.labelSeqId === storeValue.labelSeqId &&
    localHovered.operator === storeValue.operator
  ) {
    return null;
  }
  return {
    chain: storeValue.chain,
    position: storeValue.position,
    ...(storeValue.baseChain ? { baseChain: storeValue.baseChain } : {}),
    ...(storeValue.labelAsymId ? { labelAsymId: storeValue.labelAsymId } : {}),
    ...(storeValue.authAsymId ? { authAsymId: storeValue.authAsymId } : {}),
    ...(storeValue.entityId ? { entityId: storeValue.entityId } : {}),
    ...(storeValue.labelSeqId !== undefined ? { labelSeqId: storeValue.labelSeqId } : {}),
    ...(storeValue.operator ? { operator: storeValue.operator } : {}),
  };
}

function sameNonLigandResidue(
  left: ResidueLocation | null | undefined,
  right: ResidueLocation | null | undefined
): boolean {
  return (
    !!left &&
    !!right &&
    !left.compId &&
    !right.compId &&
    left.chain === right.chain &&
    left.position === right.position &&
    left.baseChain === right.baseChain &&
    left.labelAsymId === right.labelAsymId &&
    left.authAsymId === right.authAsymId &&
    left.entityId === right.entityId &&
    left.labelSeqId === right.labelSeqId &&
    left.operator === right.operator
  );
}

export function isInboundHoverProjection(
  structureId: string,
  localHovered: ResidueLocation | null | undefined,
  lastInboundHover: InboundHoverOwner | null
): boolean {
  return (
    !!lastInboundHover &&
    lastInboundHover.structureId === structureId &&
    sameNonLigandResidue(localHovered, lastInboundHover.residue)
  );
}

export function shouldClearInboundHover(
  storeValue: HoveredResidueKey | null,
  structureId: string,
  localHovered: ResidueLocation | null | undefined,
  lastInboundHover: InboundHoverOwner | null
): boolean {
  if (storeValue !== null) return false;
  return isInboundHoverProjection(structureId, localHovered, lastInboundHover);
}

export function shouldClearOnUnmount(
  storeValue: HoveredResidueKey | null,
  structureId: string
): boolean {
  return storeValue !== null && storeValue.structureId === structureId;
}
