// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useClickDetection } from './useClickDetection';

function pointerEvent(
  target: Element,
  overrides: Partial<React.PointerEvent> = {}
): React.PointerEvent {
  return {
    button: 0,
    pointerId: 1,
    clientX: 100,
    clientY: 120,
    target,
    stopPropagation: vi.fn(),
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as React.PointerEvent;
}

function readEmptyClickDiagnostics() {
  return (
    window as typeof window & {
      __WAYPOINT_MOLSTAR_EMPTY_CLICK__?: {
        last: {
          stage: string;
          hasHoveredResidue?: boolean;
          hasModifier?: boolean;
          primaryCanvasClassification?: 'empty' | 'non-empty' | 'unknown';
          calledBlankPrimaryCanvasClick?: boolean;
        };
        events: Array<{
          stage: string;
          hasHoveredResidue?: boolean;
          hasModifier?: boolean;
          primaryCanvasClassification?: 'empty' | 'non-empty' | 'unknown';
          calledBlankPrimaryCanvasClick?: boolean;
        }>;
      };
    }
  ).__WAYPOINT_MOLSTAR_EMPTY_CLICK__;
}

describe('useClickDetection', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (
      window as typeof window & {
        __WAYPOINT_MOLSTAR_EMPTY_CLICK__?: unknown;
      }
    ).__WAYPOINT_MOLSTAR_EMPTY_CLICK__;
  });

  it('preserves selection and lets MolStar receive unmodified primary canvas clicks', () => {
    const canvas = document.createElement('canvas');
    const { result } = renderHook(() =>
      useClickDetection({
        hasHoveredResidue: false,
      })
    );
    const down = pointerEvent(canvas);
    const up = pointerEvent(canvas);

    act(() => {
      result.current.onPointerDownCapture(down);
      result.current.onPointerUpCapture(up);
    });

    expect(down.stopPropagation).not.toHaveBeenCalled();
    expect(up.stopPropagation).not.toHaveBeenCalled();
    expect(readEmptyClickDiagnostics()?.last).toMatchObject({
      stage: 'primary-canvas-click-preserve-selection',
      hasHoveredResidue: false,
      hasModifier: false,
      primaryCanvasClassification: 'unknown',
      calledBlankPrimaryCanvasClick: false,
    });
  });

  it('calls the blank primary canvas handler only when MolStar picking classifies the click as empty', () => {
    const canvas = document.createElement('canvas');
    const onBlankPrimaryCanvasClick = vi.fn();
    const classifyPrimaryCanvasClick = vi.fn(() => 'empty' as const);
    const { result } = renderHook(() =>
      useClickDetection({
        onBlankPrimaryCanvasClick,
        classifyPrimaryCanvasClick,
        hasHoveredResidue: false,
      })
    );

    act(() => {
      result.current.onPointerDownCapture(pointerEvent(canvas));
      result.current.onPointerUpCapture(pointerEvent(canvas));
    });

    expect(classifyPrimaryCanvasClick).toHaveBeenCalledWith({
      target: canvas,
      clientX: 100,
      clientY: 120,
    });
    expect(onBlankPrimaryCanvasClick).toHaveBeenCalledTimes(1);
    expect(readEmptyClickDiagnostics()?.last).toMatchObject({
      stage: 'primary-canvas-click-preserve-selection',
      primaryCanvasClassification: 'empty',
      calledBlankPrimaryCanvasClick: true,
    });
  });

  it('does not call the blank primary canvas handler for non-empty MolStar picks', () => {
    const canvas = document.createElement('canvas');
    const onBlankPrimaryCanvasClick = vi.fn();
    const { result } = renderHook(() =>
      useClickDetection({
        onBlankPrimaryCanvasClick,
        classifyPrimaryCanvasClick: () => 'non-empty',
        hasHoveredResidue: false,
      })
    );

    act(() => {
      result.current.onPointerDownCapture(pointerEvent(canvas));
      result.current.onPointerUpCapture(pointerEvent(canvas));
    });

    expect(onBlankPrimaryCanvasClick).not.toHaveBeenCalled();
    expect(readEmptyClickDiagnostics()?.last).toMatchObject({
      stage: 'primary-canvas-click-preserve-selection',
      primaryCanvasClassification: 'non-empty',
      calledBlankPrimaryCanvasClick: false,
    });
  });

  it('uses the live hover getter instead of stale render-time hover props', () => {
    const canvas = document.createElement('canvas');
    const getHasHoveredResidue = vi.fn(() => false);
    const { result } = renderHook(() =>
      useClickDetection({
        hasHoveredResidue: true,
        getHasHoveredResidue,
      })
    );

    act(() => {
      result.current.onPointerDownCapture(pointerEvent(canvas));
      result.current.onPointerUpCapture(pointerEvent(canvas));
    });

    expect(getHasHoveredResidue).toHaveBeenCalled();
    expect(readEmptyClickDiagnostics()?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'primary-canvas-click-preserve-selection',
          hasHoveredResidue: false,
        }),
      ])
    );
  });

  it('does not classify modified canvas clicks as blank-space preservation clicks', () => {
    const canvas = document.createElement('canvas');
    const { result } = renderHook(() =>
      useClickDetection({
        hasHoveredResidue: true,
      })
    );

    act(() => {
      result.current.onPointerDownCapture(pointerEvent(canvas, { metaKey: true }));
      result.current.onPointerUpCapture(pointerEvent(canvas, { metaKey: true }));
    });

    expect(readEmptyClickDiagnostics()?.events.map((event) => event.stage)).not.toContain(
      'primary-canvas-click-preserve-selection'
    );
    expect(readEmptyClickDiagnostics()?.last).toMatchObject({
      stage: 'left-canvas-pointerup-classified',
      hasModifier: true,
    });
  });

  it('ignores non-canvas clicks for primary canvas preservation diagnostics', () => {
    const div = document.createElement('div');
    const { result } = renderHook(() =>
      useClickDetection({
        hasHoveredResidue: false,
      })
    );

    act(() => {
      result.current.onPointerDownCapture(pointerEvent(div));
      result.current.onPointerUpCapture(pointerEvent(div));
    });

    expect(readEmptyClickDiagnostics()?.events.map((event) => event.stage)).not.toContain(
      'primary-canvas-click-preserve-selection'
    );
  });

  it('lets MolStar receive the full right-button pointer stream and opens once on release', () => {
    const canvas = document.createElement('canvas');
    const onRightClick = vi.fn();
    const { result } = renderHook(() =>
      useClickDetection({
        onRightClick,
        hasHoveredResidue: false,
      })
    );
    const down = pointerEvent(canvas, { button: 2, clientX: 10, clientY: 20 });
    const up = pointerEvent(canvas, { button: 2, clientX: 10, clientY: 20 });

    act(() => {
      result.current.onPointerDownCapture(down);
      result.current.onPointerUpCapture(up);
    });

    expect(down.stopPropagation).not.toHaveBeenCalled();
    expect(up.stopPropagation).not.toHaveBeenCalled();
    expect(onRightClick).toHaveBeenCalledTimes(1);
    expect(onRightClick).toHaveBeenCalledWith({ x: 10, y: 20, target: canvas });
  });

  it('suppresses the browser context menu without deciding click versus drag', () => {
    const canvas = document.createElement('canvas');
    const onRightClick = vi.fn();
    const { result } = renderHook(() =>
      useClickDetection({
        onRightClick,
        hasHoveredResidue: false,
      })
    );
    const contextMenu = pointerEvent(canvas, {
      button: 2,
      clientX: 10,
      clientY: 20,
    }) as unknown as React.MouseEvent;

    act(() => {
      result.current.onPointerDownCapture(pointerEvent(canvas, { button: 2 }));
      result.current.onContextMenu(contextMenu);
    });

    expect(contextMenu.preventDefault).toHaveBeenCalledTimes(1);
    expect(onRightClick).not.toHaveBeenCalled();
  });

  it('uses maximum observed movement so drag-out-and-back never becomes a click', () => {
    const canvas = document.createElement('canvas');
    const onRightClick = vi.fn();
    const { result } = renderHook(() =>
      useClickDetection({
        onRightClick,
        hasHoveredResidue: false,
      })
    );

    act(() => {
      result.current.onPointerDownCapture(
        pointerEvent(canvas, { button: 2, pointerId: 7, clientX: 10, clientY: 20 })
      );
      result.current.onPointerMoveCapture(
        pointerEvent(canvas, { button: 2, pointerId: 7, clientX: 40, clientY: 20 })
      );
      result.current.onPointerMoveCapture(
        pointerEvent(canvas, { button: 2, pointerId: 7, clientX: 10, clientY: 20 })
      );
      result.current.onPointerUpCapture(
        pointerEvent(canvas, { button: 2, pointerId: 7, clientX: 10, clientY: 20 })
      );
    });

    expect(onRightClick).not.toHaveBeenCalled();
  });

  it('treats a long stationary right-button hold as a click', () => {
    vi.useFakeTimers();
    const canvas = document.createElement('canvas');
    const onRightClick = vi.fn();
    const { result } = renderHook(() =>
      useClickDetection({
        onRightClick,
        hasHoveredResidue: false,
      })
    );

    act(() => {
      result.current.onPointerDownCapture(pointerEvent(canvas, { button: 2 }));
      vi.advanceTimersByTime(2_000);
      result.current.onPointerUpCapture(pointerEvent(canvas, { button: 2 }));
    });

    expect(onRightClick).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('clears a cancelled right-button gesture and ignores a later release', () => {
    const canvas = document.createElement('canvas');
    const onRightClick = vi.fn();
    const { result } = renderHook(() =>
      useClickDetection({
        onRightClick,
        hasHoveredResidue: false,
      })
    );

    act(() => {
      result.current.onPointerDownCapture(pointerEvent(canvas, { button: 2, pointerId: 9 }));
      result.current.onPointerCancelCapture(pointerEvent(canvas, { button: 2, pointerId: 9 }));
      result.current.onPointerUpCapture(pointerEvent(canvas, { button: 2, pointerId: 9 }));
    });

    expect(onRightClick).not.toHaveBeenCalled();
  });

  it('does not complete a gesture from a different pointer or outside the canvas', () => {
    const canvas = document.createElement('canvas');
    const outside = document.createElement('div');
    const onRightClick = vi.fn();
    const { result } = renderHook(() =>
      useClickDetection({
        onRightClick,
        hasHoveredResidue: false,
      })
    );

    act(() => {
      result.current.onPointerDownCapture(pointerEvent(canvas, { button: 2, pointerId: 11 }));
      result.current.onPointerUpCapture(pointerEvent(canvas, { button: 2, pointerId: 12 }));
      result.current.onPointerUpCapture(pointerEvent(outside, { button: 2, pointerId: 11 }));
    });

    expect(onRightClick).not.toHaveBeenCalled();
  });
});
