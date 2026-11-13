import { useEffect, useRef, useCallback } from 'react';

interface PointerStart {
  x: number;
  y: number;
  time: number;
}

interface SecondaryPointerGesture {
  pointerId: number;
  originX: number;
  originY: number;
  maxDistanceSquared: number;
}

const MAX_CLICK_DISTANCE = 5;
const MAX_CLICK_DISTANCE_SQUARED = MAX_CLICK_DISTANCE * MAX_CLICK_DISTANCE;

type ClickDetectionDiagnosticEvent = {
  stage: string;
  at: number;
  button?: number;
  x?: number;
  y?: number;
  targetTag?: string | null;
  isCanvasTarget?: boolean;
  isClick?: boolean;
  hasHoveredResidue?: boolean;
  hasModifier?: boolean;
  primaryCanvasClassification?: 'empty' | 'non-empty' | 'unknown';
  calledBlankPrimaryCanvasClick?: boolean;
};

function isClickEvent(start: PointerStart | null, endX: number, endY: number): boolean {
  if (!start) return false;

  const dx = Math.abs(endX - start.x);
  const dy = Math.abs(endY - start.y);
  const duration = Date.now() - start.time;

  return dx < MAX_CLICK_DISTANCE && dy < MAX_CLICK_DISTANCE && duration < 500;
}

function isCanvasTarget(target: EventTarget | null): boolean {
  return (target as HTMLElement)?.tagName === 'CANVAS';
}

function recordClickDetectionDiagnostic(event: ClickDetectionDiagnosticEvent): void {
  if (typeof window === 'undefined') return;
  if (!import.meta.env.DEV && import.meta.env.MODE !== 'test') return;
  const testWindow = window as typeof window & {
    __WAYPOINT_MOLSTAR_EMPTY_CLICK__?: {
      last: ClickDetectionDiagnosticEvent;
      events: ClickDetectionDiagnosticEvent[];
    };
  };
  const current = testWindow.__WAYPOINT_MOLSTAR_EMPTY_CLICK__;
  testWindow.__WAYPOINT_MOLSTAR_EMPTY_CLICK__ = {
    last: event,
    events: [...(current?.events ?? []), event].slice(-50),
  };
}

interface UseClickDetectionOptions {
  onRightClick?: (position: { x: number; y: number; target: EventTarget | null }) => void;
  onBlankPrimaryCanvasClick?: () => void;
  classifyPrimaryCanvasClick?: (event: {
    target: EventTarget | null;
    clientX: number;
    clientY: number;
  }) => 'empty' | 'non-empty' | 'unknown';
  hasHoveredResidue: boolean;
  getHasHoveredResidue?: () => boolean;
}

interface ClickDetectionHandlers {
  onPointerDownCapture: (e: React.PointerEvent) => void;
  onPointerMoveCapture: (e: React.PointerEvent) => void;
  onPointerUpCapture: (e: React.PointerEvent) => void;
  onPointerCancelCapture: (e: React.PointerEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

export function useClickDetection({
  onRightClick,
  onBlankPrimaryCanvasClick,
  classifyPrimaryCanvasClick,
  hasHoveredResidue,
  getHasHoveredResidue,
}: UseClickDetectionOptions): ClickDetectionHandlers {
  const primaryPointerStartRef = useRef<PointerStart | null>(null);
  const secondaryGestureRef = useRef<SecondaryPointerGesture | null>(null);
  const latestRef = useRef({
    onRightClick,
    onBlankPrimaryCanvasClick,
    classifyPrimaryCanvasClick,
    hasHoveredResidue,
    getHasHoveredResidue,
  });
  latestRef.current = {
    onRightClick,
    onBlankPrimaryCanvasClick,
    classifyPrimaryCanvasClick,
    hasHoveredResidue,
    getHasHoveredResidue,
  };

  useEffect(() => {
    return () => {
      primaryPointerStartRef.current = null;
      secondaryGestureRef.current = null;
    };
  }, []);

  const readHasHoveredResidue = useCallback(
    () => latestRef.current.getHasHoveredResidue?.() ?? latestRef.current.hasHoveredResidue,
    []
  );

  const updateSecondaryGesture = useCallback(
    (event: { pointerId: number; clientX: number; clientY: number }) => {
      const gesture = secondaryGestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      const dx = event.clientX - gesture.originX;
      const dy = event.clientY - gesture.originY;
      gesture.maxDistanceSquared = Math.max(gesture.maxDistanceSquared, dx * dx + dy * dy);
    },
    []
  );

  const finishSecondaryGesture = useCallback(
    (event: {
      pointerId: number;
      clientX: number;
      clientY: number;
      target: EventTarget | null;
    }) => {
      const gesture = secondaryGestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      updateSecondaryGesture(event);
      secondaryGestureRef.current = null;
      if (
        gesture.maxDistanceSquared <= MAX_CLICK_DISTANCE_SQUARED &&
        isCanvasTarget(event.target)
      ) {
        latestRef.current.onRightClick?.({
          x: event.clientX,
          y: event.clientY,
          target: event.target,
        });
      }
    },
    [updateSecondaryGesture]
  );

  const cancelSecondaryGesture = useCallback((pointerId?: number) => {
    const gesture = secondaryGestureRef.current;
    if (!gesture || (pointerId !== undefined && pointerId !== gesture.pointerId)) return;
    secondaryGestureRef.current = null;
  }, []);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => updateSecondaryGesture(event);
    const handlePointerUp = (event: PointerEvent) => finishSecondaryGesture(event);
    const handlePointerCancel = (event: PointerEvent) => cancelSecondaryGesture(event.pointerId);
    const handleWindowBlur = () => cancelSecondaryGesture();
    window.addEventListener('pointermove', handlePointerMove, true);
    window.addEventListener('pointerup', handlePointerUp, true);
    window.addEventListener('pointercancel', handlePointerCancel, true);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove, true);
      window.removeEventListener('pointerup', handlePointerUp, true);
      window.removeEventListener('pointercancel', handlePointerCancel, true);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [cancelSecondaryGesture, finishSecondaryGesture, updateSecondaryGesture]);

  const onPointerDownCapture = useCallback(
    (e: React.PointerEvent) => {
      recordClickDetectionDiagnostic({
        stage: 'pointerdown',
        at: performance.now(),
        button: e.button,
        x: e.clientX,
        y: e.clientY,
        targetTag: (e.target as HTMLElement | null)?.tagName ?? null,
        isCanvasTarget: isCanvasTarget(e.target),
        hasHoveredResidue: readHasHoveredResidue(),
      });
      if (e.button === 2 && isCanvasTarget(e.target)) {
        secondaryGestureRef.current = {
          pointerId: e.pointerId,
          originX: e.clientX,
          originY: e.clientY,
          maxDistanceSquared: 0,
        };
        return;
      }

      if (e.button === 0 && isCanvasTarget(e.target)) {
        primaryPointerStartRef.current = { x: e.clientX, y: e.clientY, time: Date.now() };
      }
    },
    [readHasHoveredResidue]
  );

  const onPointerMoveCapture = useCallback(
    (e: React.PointerEvent) => {
      updateSecondaryGesture(e);
    },
    [updateSecondaryGesture]
  );

  const onPointerUpCapture = useCallback(
    (e: React.PointerEvent) => {
      const start = primaryPointerStartRef.current;
      if (e.button === 0) primaryPointerStartRef.current = null;
      const targetIsCanvas = isCanvasTarget(e.target);
      recordClickDetectionDiagnostic({
        stage: 'pointerup',
        at: performance.now(),
        button: e.button,
        x: e.clientX,
        y: e.clientY,
        targetTag: (e.target as HTMLElement | null)?.tagName ?? null,
        isCanvasTarget: targetIsCanvas,
        hasHoveredResidue: readHasHoveredResidue(),
      });

      if (e.button === 2) {
        finishSecondaryGesture(e);
        return;
      }

      if (e.button === 0 && targetIsCanvas && start) {
        const isClick = isClickEvent(start, e.clientX, e.clientY);
        const hasModifier = Boolean(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);
        recordClickDetectionDiagnostic({
          stage: 'left-canvas-pointerup-classified',
          at: performance.now(),
          button: e.button,
          x: e.clientX,
          y: e.clientY,
          targetTag: (e.target as HTMLElement | null)?.tagName ?? null,
          isCanvasTarget: true,
          isClick,
          hasHoveredResidue: readHasHoveredResidue(),
          hasModifier,
        });

        if (isClick && !hasModifier) {
          const classification =
            latestRef.current.classifyPrimaryCanvasClick?.({
              target: e.target,
              clientX: e.clientX,
              clientY: e.clientY,
            }) ?? 'unknown';
          const shouldCallBlankPrimaryCanvasClick = classification === 'empty';
          recordClickDetectionDiagnostic({
            stage: 'primary-canvas-click-preserve-selection',
            at: performance.now(),
            button: e.button,
            x: e.clientX,
            y: e.clientY,
            targetTag: (e.target as HTMLElement | null)?.tagName ?? null,
            isCanvasTarget: true,
            isClick: true,
            hasHoveredResidue: readHasHoveredResidue(),
            hasModifier,
            primaryCanvasClassification: classification,
            calledBlankPrimaryCanvasClick: shouldCallBlankPrimaryCanvasClick,
          });
          if (shouldCallBlankPrimaryCanvasClick) {
            latestRef.current.onBlankPrimaryCanvasClick?.();
          }
        }
      }
    },
    [finishSecondaryGesture, readHasHoveredResidue]
  );

  const onPointerCancelCapture = useCallback(
    (e: React.PointerEvent) => {
      cancelSecondaryGesture(e.pointerId);
      if (e.button === 0) primaryPointerStartRef.current = null;
    },
    [cancelSecondaryGesture]
  );

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    if (isCanvasTarget(e.target)) {
      e.preventDefault();
    }
  }, []);

  return {
    onPointerDownCapture,
    onPointerMoveCapture,
    onPointerUpCapture,
    onPointerCancelCapture,
    onContextMenu,
  };
}
