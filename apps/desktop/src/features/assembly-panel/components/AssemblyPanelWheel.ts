export const ASSEMBLY_DRAWER_WHEEL_AXIS_LOCK_MS = 180;

export type AssemblyDrawerWheelAxis = 'vertical' | 'horizontal';
export type AssemblyDrawerWheelAction = 'vertical-scroll' | 'horizontal-scroll' | 'suppress';

export interface AssemblyDrawerWheelAxisLock {
  axis: AssemblyDrawerWheelAxis;
  expiresAtMs: number;
}

export interface AssemblyDrawerWheelDecision {
  action: AssemblyDrawerWheelAction | null;
  lock: AssemblyDrawerWheelAxisLock | null;
}

export function shouldRouteWheelToAssemblyDrawer(
  deltaX: number,
  deltaY: number,
  target: EventTarget | null
): boolean {
  return (
    resolveAssemblyDrawerWheelInteraction({
      deltaX,
      deltaY,
      target,
      lock: null,
      nowMs: 0,
    }).action === 'vertical-scroll'
  );
}

export function resolveAssemblyDrawerWheelInteraction({
  deltaX,
  deltaY,
  target,
  lock,
  nowMs,
}: {
  deltaX: number;
  deltaY: number;
  target: EventTarget | null;
  lock: AssemblyDrawerWheelAxisLock | null;
  nowMs: number;
}): AssemblyDrawerWheelDecision {
  const activeLock = lock && lock.expiresAtMs > nowMs ? lock : null;
  if (!isAssemblyHorizontalScrollTarget(target)) {
    return {
      action: null,
      lock: activeLock,
    };
  }

  if (activeLock) {
    return {
      action: lockedWheelAction(activeLock.axis, deltaX, deltaY),
      lock: extendWheelLock(activeLock.axis, nowMs),
    };
  }

  const axis = dominantWheelAxis(deltaX, deltaY);
  if (!axis) {
    return {
      action: null,
      lock: null,
    };
  }

  return {
    action: lockedWheelAction(axis, deltaX, deltaY),
    lock: extendWheelLock(axis, nowMs),
  };
}

function isAssemblyHorizontalScrollTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('[data-assembly-horizontal-scroll="true"]'));
}

function dominantWheelAxis(deltaX: number, deltaY: number): AssemblyDrawerWheelAxis | null {
  if (Math.abs(deltaX) > Math.abs(deltaY)) return 'horizontal';
  if (Math.abs(deltaY) > 0) return 'vertical';
  return null;
}

function lockedWheelAction(
  axis: AssemblyDrawerWheelAxis,
  deltaX: number,
  deltaY: number
): AssemblyDrawerWheelAction {
  if (axis === 'vertical') return 'vertical-scroll';
  return Math.abs(deltaX) > Math.abs(deltaY) ? 'horizontal-scroll' : 'suppress';
}

function extendWheelLock(
  axis: AssemblyDrawerWheelAxis,
  nowMs: number
): AssemblyDrawerWheelAxisLock {
  return {
    axis,
    expiresAtMs: nowMs + ASSEMBLY_DRAWER_WHEEL_AXIS_LOCK_MS,
  };
}
