import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useLayoutEffect, useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useMenu, type MenuItem } from '@waypoint/ui-components';

const items: readonly MenuItem[] = [
  { id: 'one', textValue: 'One column' },
  { id: 'blocked', textValue: 'Unavailable', disabled: true },
  { id: 'two', textValue: 'Two columns' },
  { id: 'three', textValue: 'Three columns' },
];

const nestedMenus: Record<string, readonly MenuItem[]> = {
  root: [
    { id: 'alpha', textValue: 'Alpha' },
    { id: 'blocked', textValue: 'Blocked', disabled: true },
    { id: 'branch', textValue: 'Branch', submenuId: 'child' },
    { id: 'omega', textValue: 'Omega' },
  ],
  child: [{ id: 'copy', textValue: 'Copy' }],
};

function NestedMenuHarness() {
  const surface = useRef<HTMLDivElement>(null);
  const menu = useMenu({
    items: nestedMenus.root,
    menus: { child: nestedMenus.child },
    selectedId: 'branch',
    onFocusItem: (itemId, menuId) => {
      surface.current
        ?.querySelector<HTMLButtonElement>(`[data-item="${menuId}:${itemId}"]`)
        ?.focus();
    },
  });
  useLayoutEffect(() => {
    if (menu.state.phase === 'positioning') menu.positioned();
  }, [menu]);
  return (
    <>
      <button onClick={() => menu.openMenu()}>Open nested menu</button>
      <div ref={surface} onKeyDown={menu.handleKeyDown}>
        {menu.isOpen &&
          menu.state.levels.map((level) => (
            <div
              key={level.menuId}
              data-menu-id={level.menuId}
              data-testid={`level-${level.menuId}`}
            >
              {nestedMenus[level.menuId].map((item) => (
                <button
                  key={item.id}
                  data-item={`${level.menuId}:${item.id}`}
                  disabled={item.disabled}
                  onPointerMove={() => menu.point(item.id, level.menuId)}
                >
                  {item.textValue}
                </button>
              ))}
            </div>
          ))}
      </div>
    </>
  );
}

describe('shared menu controller', () => {
  it('routes arrow keys from the actually focused level after hover opens a submenu', () => {
    render(<NestedMenuHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open nested menu' }));
    const branch = screen.getByRole('button', { name: 'Branch' });
    expect(branch).toHaveFocus();
    fireEvent.pointerMove(branch);
    expect(screen.getByTestId('level-child')).toBeInTheDocument();
    expect(branch).toHaveFocus();
    fireEvent.keyDown(branch, { key: 'ArrowDown' });
    const omega = screen.getByRole('button', { name: 'Omega' });
    expect(omega).toHaveFocus();
    expect(screen.queryByTestId('level-child')).not.toBeInTheDocument();
    fireEvent.keyDown(omega, { key: 'Home' });
    const alpha = screen.getByRole('button', { name: 'Alpha' });
    expect(alpha).toHaveFocus();
    fireEvent.keyDown(alpha, { key: 'ArrowDown' });
    expect(branch).toHaveFocus();
    fireEvent.pointerMove(branch);
    fireEvent.keyDown(branch, { key: 'ArrowRight' });
    const copy = screen.getByRole('button', { name: 'Copy' });
    expect(copy).toHaveFocus();
    expect(screen.getAllByTestId('level-child')).toHaveLength(1);
    fireEvent.keyDown(copy, { key: 'ArrowLeft' });
    expect(branch).toHaveFocus();
    expect(screen.queryByTestId('level-child')).not.toBeInTheDocument();
  });

  it('focuses the selected row after placement and moves keyboard focus without committing selection', () => {
    const onFocusItem = vi.fn();
    const onActivate = vi.fn();
    const { result } = renderHook(() =>
      useMenu({ items, selectedId: 'two', onFocusItem, onActivate })
    );
    act(() => result.current.openMenu());
    expect(onFocusItem).not.toHaveBeenCalled();
    act(() => result.current.positioned());
    expect(onFocusItem).toHaveBeenLastCalledWith('two', 'root');
    act(() => result.current.move('previous'));
    expect(onFocusItem).toHaveBeenLastCalledWith('one', 'root');
    act(() => result.current.move('last'));
    expect(onFocusItem).toHaveBeenLastCalledWith('three', 'root');
    expect(onActivate).not.toHaveBeenCalled();
    onFocusItem.mockClear();
    act(() => result.current.point('two'));
    expect(onFocusItem).not.toHaveBeenCalled();
  });

  it('discards queued focus from a session closed before its DOM commit', async () => {
    const onFocusItem = vi.fn();
    const { result } = renderHook(() => useMenu({ items, onFocusItem }));
    act(() => {
      const menu = result.current;
      menu.openMenu('one');
      const session = menu.stateRef.current.session;
      menu.positioned(session);
      menu.close('outside-pointer', session);
      menu.openMenu('three');
    });
    expect(onFocusItem).not.toHaveBeenCalled();
    act(() => result.current.positioned());
    await act(async () => {});
    expect(onFocusItem).toHaveBeenCalledExactlyOnceWith('three', 'root');
  });

  it('keeps committed selection separate from keyboard and pointer activity', () => {
    const onActivate = vi.fn();
    const { result } = renderHook(() => useMenu({ items, selectedId: 'two', onActivate }));
    act(() => result.current.openMenu());
    act(() => result.current.positioned());
    expect(result.current.activeId).toBe('two');
    act(() => result.current.move('next'));
    expect(result.current.activeId).toBe('three');
    act(() => result.current.point('one'));
    expect(result.current.activeId).toBe('one');
    expect(onActivate).not.toHaveBeenCalled();
    act(() => result.current.close('escape'));
    act(() => result.current.openMenu());
    expect(result.current.activeId).toBe('two');
  });

  it('preserves active identity through live reordering and invalidates removed commands', () => {
    const onActivate = vi.fn();
    const { result, rerender } = renderHook(
      ({ options }) => useMenu({ items: options, selectedId: 'two', onActivate }),
      { initialProps: { options: items } }
    );
    act(() => result.current.openMenu());
    act(() => result.current.positioned());
    rerender({ options: [...items].reverse() });
    expect(result.current.activeId).toBe('two');
    rerender({ options: items.filter((item) => item.id !== 'two') });
    expect(result.current.activeId).toBe('one');
    act(() => result.current.activate('two'));
    expect(onActivate).not.toHaveBeenCalled();
    expect(result.current.isOpen).toBe(true);
  });

  it('closes synchronously and invokes a selected command only once', () => {
    const order: string[] = [];
    const onActivate = vi.fn(() => order.push('invoke'));
    const onClose = vi.fn(() => order.push('closed'));
    const { result } = renderHook(() => useMenu({ items, onActivate, onClose }));
    act(() => result.current.openMenu());
    act(() => result.current.positioned());
    const unsubscribe = result.current.subscribeClose(() => order.push('focus-policy'));
    act(() => {
      result.current.activate('one');
      result.current.activate('one');
    });
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith('one', 'root');
    expect(onClose).toHaveBeenCalledExactlyOnceWith('selection');
    expect(order.indexOf('focus-policy')).toBeLessThan(order.indexOf('invoke'));
    expect(result.current.isOpen).toBe(false);
    unsubscribe();
  });

  it('rejects a delayed dismissal after the next session opens', () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useMenu({ items, onClose }));
    act(() => result.current.openMenu());
    const session = result.current.state.session;
    act(() => result.current.close('outside-pointer', session));
    act(() => result.current.openMenu('three'));
    act(() => result.current.close('window-blur', session));
    expect(result.current.isOpen).toBe(true);
    expect(result.current.activeId).toBe('three');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not invoke a disabled row even when activation is requested directly', () => {
    const onActivate = vi.fn();
    const { result } = renderHook(() => useMenu({ items, onActivate }));
    act(() => result.current.openMenu());
    act(() => result.current.positioned());
    act(() => result.current.activate('blocked'));
    expect(onActivate).not.toHaveBeenCalled();
    expect(result.current.isOpen).toBe(true);
  });

  it('revokes callbacks retained by an unmounted menu', () => {
    const onActivate = vi.fn();
    const { result, unmount } = renderHook(() => useMenu({ items, onActivate }));
    act(() => result.current.openMenu());
    act(() => result.current.positioned());
    const obsolete = result.current;
    unmount();
    act(() => obsolete.activate('one'));
    expect(onActivate).not.toHaveBeenCalled();
  });
});
