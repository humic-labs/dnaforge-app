/** @vitest-environment jsdom */

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldDeferMenuActivation, useMenuAim } from '@waypoint/ui-components';

const submenuOnRight = {
  left: 300,
  right: 500,
  top: 40,
  bottom: 180,
};

describe('submenu pointer grace', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('defers a sibling hover while the pointer crosses its safe triangle toward the submenu', () => {
    expect(
      shouldDeferMenuActivation({
        previous: { x: 120, y: 70 },
        current: { x: 260, y: 110 },
        submenuRect: submenuOnRight,
      })
    ).toBe(true);
  });

  it('does not defer when the pointer moves vertically through sibling options', () => {
    expect(
      shouldDeferMenuActivation({
        previous: { x: 260, y: 70 },
        current: { x: 250, y: 110 },
        submenuRect: submenuOnRight,
      })
    ).toBe(false);
  });

  it('supports a submenu opening to the left', () => {
    expect(
      shouldDeferMenuActivation({
        previous: { x: 420, y: 70 },
        current: { x: 260, y: 110 },
        submenuRect: { left: 20, right: 220, top: 40, bottom: 180 },
      })
    ).toBe(true);
  });

  it('does not defer when the pointer is outside the submenu corridor', () => {
    expect(
      shouldDeferMenuActivation({
        previous: { x: 120, y: 70 },
        current: { x: 260, y: 210 },
        submenuRect: submenuOnRight,
      })
    ).toBe(false);
  });

  it('cancels a delayed sibling activation when the pointer reaches the open submenu', () => {
    vi.useFakeTimers();
    const activate = vi.fn();
    const submenu = document.createElement('div');
    vi.spyOn(submenu, 'getBoundingClientRect').mockReturnValue({
      ...submenuOnRight,
      x: submenuOnRight.left,
      y: submenuOnRight.top,
      width: submenuOnRight.right - submenuOnRight.left,
      height: submenuOnRight.bottom - submenuOnRight.top,
      toJSON: () => ({}),
    });
    const { result, unmount } = renderHook(() => useMenuAim());

    act(() => {
      document.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: 120, clientY: 70 })
      );
      result.current.requestActivation({
        pointer: { clientX: 260, clientY: 110 },
        submenuElement: submenu,
        activate,
      });
    });
    expect(activate).not.toHaveBeenCalled();

    act(() => {
      document.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: 310, clientY: 110 })
      );
      vi.advanceTimersByTime(300);
    });
    expect(activate).not.toHaveBeenCalled();
    unmount();
  });

  it('runs a delayed sibling activation when the pointer stops inside the corridor', () => {
    vi.useFakeTimers();
    const activate = vi.fn();
    const submenu = document.createElement('div');
    vi.spyOn(submenu, 'getBoundingClientRect').mockReturnValue({
      ...submenuOnRight,
      x: submenuOnRight.left,
      y: submenuOnRight.top,
      width: submenuOnRight.right - submenuOnRight.left,
      height: submenuOnRight.bottom - submenuOnRight.top,
      toJSON: () => ({}),
    });
    const { result, unmount } = renderHook(() => useMenuAim());

    act(() => {
      document.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: 120, clientY: 70 })
      );
      result.current.requestActivation({
        pointer: { clientX: 260, clientY: 110 },
        submenuElement: submenu,
        activate,
      });
      vi.advanceTimersByTime(299);
    });
    expect(activate).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(activate).toHaveBeenCalledOnce();
    unmount();
  });

  it('runs the sibling activation immediately when the pointer leaves the safe triangle', () => {
    vi.useFakeTimers();
    const activate = vi.fn();
    const submenu = document.createElement('div');
    vi.spyOn(submenu, 'getBoundingClientRect').mockReturnValue({
      ...submenuOnRight,
      x: submenuOnRight.left,
      y: submenuOnRight.top,
      width: submenuOnRight.right - submenuOnRight.left,
      height: submenuOnRight.bottom - submenuOnRight.top,
      toJSON: () => ({}),
    });
    const { result, unmount } = renderHook(() => useMenuAim());

    act(() => {
      document.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: 120, clientY: 70 })
      );
      result.current.requestActivation({
        pointer: { clientX: 260, clientY: 110 },
        submenuElement: submenu,
        activate,
      });
      document.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: 180, clientY: 210 })
      );
    });

    expect(activate).toHaveBeenCalledOnce();
    unmount();
  });
});

describe('submenu intent lifetime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['session', 'closed', 'unmounted', 'candidate'] as const)(
    'does not activate obsolete intent after its %s changes',
    (change) => {
      vi.useFakeTimers();
      const activate = vi.fn();
      const submenu = document.createElement('div');
      document.body.append(submenu);
      vi.spyOn(submenu, 'getBoundingClientRect').mockReturnValue({
        ...submenuOnRight,
        x: submenuOnRight.left,
        y: submenuOnRight.top,
        width: submenuOnRight.right - submenuOnRight.left,
        height: submenuOnRight.bottom - submenuOnRight.top,
        toJSON: () => ({}),
      });
      let candidateCurrent = true;
      const { result, rerender, unmount } = renderHook(
        ({ session, enabled }) => useMenuAim({ session, enabled }),
        { initialProps: { session: 1, enabled: true } }
      );
      act(() => {
        document.dispatchEvent(
          new MouseEvent('pointermove', { bubbles: true, clientX: 120, clientY: 70 })
        );
        result.current.requestActivation({
          pointer: { clientX: 260, clientY: 110 },
          submenuElement: submenu,
          activate,
          isCurrent: () => candidateCurrent,
        });
      });
      expect(activate).not.toHaveBeenCalled();
      if (change === 'session') rerender({ session: 2, enabled: true });
      if (change === 'closed') {
        rerender({ session: 1, enabled: false });
        rerender({ session: 1, enabled: true });
      }
      if (change === 'unmounted') unmount();
      if (change === 'candidate') candidateCurrent = false;
      act(() => vi.advanceTimersByTime(300));
      expect(activate).not.toHaveBeenCalled();
      if (change !== 'unmounted') unmount();
      submenu.remove();
    }
  );
});
