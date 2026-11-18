import { captureInputOwnership } from '@waypoint/platform/input-ownership';
import { useCallback, useEffect, useMemo, useRef } from 'react';

export interface MenuAimPoint {
  x: number;
  y: number;
}

export interface MenuAimRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface PointerCoordinates {
  clientX: number;
  clientY: number;
}

export interface MenuAimRequest {
  pointer: PointerCoordinates;
  submenuElement: HTMLElement | null;
  activate: () => void;
  isCurrent?: () => boolean;
}

export interface MenuAimController {
  requestActivation: (request: MenuAimRequest) => void;
  activateImmediately: (activate: () => void) => void;
  cancelPendingActivation: () => void;
}

interface PendingActivation {
  isCurrent: () => boolean;
  activate: () => void;
  submenuElement: HTMLElement;
  triangle: readonly [MenuAimPoint, MenuAimPoint, MenuAimPoint];
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_ACTIVATION_DELAY_MS = 300;
const SUBMENU_EDGE_SLOP_PX = 8;

function cross(a: MenuAimPoint, b: MenuAimPoint, point: MenuAimPoint): number {
  return (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
}

export function isPointInTriangle(
  point: MenuAimPoint,
  [a, b, c]: readonly [MenuAimPoint, MenuAimPoint, MenuAimPoint]
): boolean {
  const ab = cross(a, b, point);
  const bc = cross(b, c, point);
  const ca = cross(c, a, point);
  const hasNegative = ab < 0 || bc < 0 || ca < 0;
  const hasPositive = ab > 0 || bc > 0 || ca > 0;
  return !(hasNegative && hasPositive);
}

function isPointInRect(point: MenuAimPoint, rect: MenuAimRect): boolean {
  return (
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
  );
}

function buildSafeTriangle(
  previous: MenuAimPoint,
  submenuRect: MenuAimRect
): readonly [MenuAimPoint, MenuAimPoint, MenuAimPoint] {
  const submenuCenterX = (submenuRect.left + submenuRect.right) / 2;
  const nearEdgeX = submenuCenterX >= previous.x ? submenuRect.left : submenuRect.right;
  return [
    previous,
    { x: nearEdgeX, y: submenuRect.top - SUBMENU_EDGE_SLOP_PX },
    { x: nearEdgeX, y: submenuRect.bottom + SUBMENU_EDGE_SLOP_PX },
  ];
}

export function shouldDeferMenuActivation({
  previous,
  current,
  submenuRect,
}: {
  previous: MenuAimPoint;
  current: MenuAimPoint;
  submenuRect: MenuAimRect;
}): boolean {
  if (isPointInRect(current, submenuRect)) return false;

  const submenuCenterX = (submenuRect.left + submenuRect.right) / 2;
  const submenuOpensRight = submenuCenterX >= previous.x;
  const movingTowardSubmenu = submenuOpensRight
    ? current.x > previous.x && current.x < submenuRect.left
    : current.x < previous.x && current.x > submenuRect.right;

  return (
    movingTowardSubmenu && isPointInTriangle(current, buildSafeTriangle(previous, submenuRect))
  );
}

export function useMenuAim({
  activationDelayMs = DEFAULT_ACTIVATION_DELAY_MS,
  session = 0,
  enabled = true,
}: {
  activationDelayMs?: number;
  session?: string | number;
  enabled?: boolean;
} = {}): MenuAimController {
  const lifecycle = useRef({ session, enabled, mounted: true });
  lifecycle.current.session = session;
  lifecycle.current.enabled = enabled;
  const latestPointerRef = useRef<MenuAimPoint | null>(null);
  const previousPointerRef = useRef<MenuAimPoint | null>(null);
  const pendingRef = useRef<PendingActivation | null>(null);

  const cancelPendingActivation = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingRef.current = null;
  }, []);

  const finishPendingActivation = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingRef.current = null;
    if (pending.isCurrent()) pending.activate();
  }, []);

  useEffect(() => {
    cancelPendingActivation();
    previousPointerRef.current = null;
    latestPointerRef.current = null;
  }, [session, enabled, cancelPendingActivation]);

  useEffect(() => {
    lifecycle.current.mounted = enabled;
    if (!enabled) return;
    const handlePointerMove = (event: PointerEvent) => {
      const next = { x: event.clientX, y: event.clientY };
      const pending = pendingRef.current;
      if (pending) {
        const submenuRect = pending.submenuElement.getBoundingClientRect();
        if (isPointInRect(next, submenuRect)) {
          cancelPendingActivation();
        } else if (!isPointInTriangle(next, pending.triangle)) {
          finishPendingActivation();
        }
      }
      previousPointerRef.current = latestPointerRef.current;
      latestPointerRef.current = next;
    };

    document.addEventListener('pointermove', handlePointerMove, true);
    return () => {
      lifecycle.current.mounted = false;
      document.removeEventListener('pointermove', handlePointerMove, true);
      cancelPendingActivation();
    };
  }, [enabled, cancelPendingActivation, finishPendingActivation]);

  const requestActivation = useCallback(
    ({ pointer, submenuElement, activate, isCurrent }: MenuAimRequest) => {
      const ownsInput = submenuElement?.isConnected
        ? captureInputOwnership(submenuElement, 'pointer')
        : () => true;
      const valid = () =>
        lifecycle.current.mounted &&
        lifecycle.current.enabled &&
        lifecycle.current.session === session &&
        ownsInput() &&
        (isCurrent?.() ?? true);
      if (!valid()) return;
      const current = { x: pointer.clientX, y: pointer.clientY };
      const latest = latestPointerRef.current;
      const previous =
        latest && (latest.x !== current.x || latest.y !== current.y)
          ? latest
          : previousPointerRef.current;
      if (!latest || latest.x !== current.x || latest.y !== current.y) {
        previousPointerRef.current = latest;
        latestPointerRef.current = current;
      }

      if (!submenuElement || !previous) {
        cancelPendingActivation();
        if (valid()) activate();
        return;
      }

      const submenuRect = submenuElement.getBoundingClientRect();
      const existing = pendingRef.current;
      if (
        existing?.submenuElement === submenuElement &&
        isPointInTriangle(current, existing.triangle)
      ) {
        existing.activate = activate;
        existing.isCurrent = valid;
        return;
      }

      if (!shouldDeferMenuActivation({ previous, current, submenuRect })) {
        cancelPendingActivation();
        if (valid()) activate();
        return;
      }

      cancelPendingActivation();
      const pending: PendingActivation = {
        isCurrent: valid,
        activate,
        submenuElement,
        triangle: buildSafeTriangle(previous, submenuRect),
        timer: setTimeout(() => {
          if (pendingRef.current === pending) finishPendingActivation();
        }, activationDelayMs),
      };
      pendingRef.current = pending;
    },
    [session, activationDelayMs, cancelPendingActivation, finishPendingActivation]
  );

  const activateImmediately = useCallback(
    (activate: () => void) => {
      cancelPendingActivation();
      if (
        lifecycle.current.mounted &&
        lifecycle.current.enabled &&
        lifecycle.current.session === session
      )
        activate();
    },
    [session, cancelPendingActivation]
  );

  return useMemo(
    () => ({ requestActivation, activateImmediately, cancelPendingActivation }),
    [activateImmediately, cancelPendingActivation, requestActivation]
  );
}
