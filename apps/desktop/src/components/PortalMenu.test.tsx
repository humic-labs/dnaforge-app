import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useRef, useState } from 'react';
import { PortalMenu } from './PortalMenu';
import { useMenu, type MenuCloseReason } from '@waypoint/ui-components';

let rectSpy: ReturnType<typeof vi.spyOn> | undefined;
beforeEach(() => {
  rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 400,
    bottom: 420,
    left: 100,
    right: 200,
    width: 100,
    height: 20,
    x: 100,
    y: 400,
    toJSON: () => ({}),
  } as DOMRect);
});
afterEach(() => rectSpy?.mockRestore());

function Harness({
  horizontalAlign = 'end',
  preferredSide,
  placement = 'dropdown',
  allowFlip,
}: {
  horizontalAlign?: 'start' | 'end';
  preferredSide?: 'top' | 'bottom';
  placement?: 'dropdown' | 'submenu';
  allowFlip?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <div data-testid="clip" style={{ overflow: 'hidden', width: 120, height: 40 }}>
      <button ref={btnRef} data-testid="trigger" onClick={() => setOpen((v) => !v)}>
        open
      </button>
      <PortalMenu
        open={open}
        anchorRef={btnRef}
        horizontalAlign={horizontalAlign}
        preferredSide={preferredSide}
        placement={placement}
        allowFlip={allowFlip}
        data-testid="menu"
        onRequestClose={() => setOpen(false)}
      >
        <button role="menuitem" data-testid="opt" onClick={() => setOpen(false)}>
          option
        </button>
        <span data-testid="inside">stays open on click</span>
      </PortalMenu>
    </div>
  );
}

describe('PortalMenu', () => {
  it.each([5, 45])('aligns the first submenu row after a %ipx inset', (inset) => {
    rectSpy?.mockImplementation(function (this: HTMLElement) {
      const surface = this.getAttribute('data-testid') === 'menu';
      const option = this.getAttribute('data-testid') === 'opt';
      const menuTop = Number.parseFloat(screen.queryByTestId('menu')?.style.top ?? '400');
      const top = surface ? menuTop : option ? menuTop + inset : 400;
      const height = surface ? 160 : 28;
      return {
        top,
        bottom: top + height,
        left: 100,
        right: 200,
        width: 100,
        height,
        x: 100,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    });
    render(<Harness placement="submenu" />);
    fireEvent.click(screen.getByTestId('trigger'));
    expect(screen.getByTestId('opt').getBoundingClientRect().top).toBe(
      screen.getByTestId('trigger').getBoundingClientRect().top
    );
  });

  it('opens below a part when requested without changing the composer default', () => {
    const view = render(<Harness preferredSide="bottom" />);
    fireEvent.click(screen.getByTestId('trigger'));
    expect(screen.getByTestId('menu').style.top).toBe('424px');
    expect(screen.getByTestId('menu').style.bottom).toBe('');
    view.unmount();
    render(<Harness />);
    fireEvent.click(screen.getByTestId('trigger'));
    expect(screen.getByTestId('menu').style.top).toBe('');
    expect(screen.getByTestId('menu').style.bottom).not.toBe('');
  });
  it('keeps a below-field menu below when space is limited and bounds its height', () => {
    rectSpy?.mockReturnValue({
      top: 620,
      bottom: 660,
      left: 100,
      right: 200,
      width: 100,
      height: 40,
      x: 100,
      y: 620,
      toJSON: () => ({}),
    } as DOMRect);
    render(<Harness preferredSide="bottom" allowFlip={false} />);
    fireEvent.click(screen.getByTestId('trigger'));
    const menu = screen.getByTestId('menu');
    expect(menu).toHaveAttribute('data-placement', 'below');
    expect(menu.style.top).toBe('664px');
    expect(parseFloat(menu.style.maxHeight)).toBeLessThanOrEqual(window.innerHeight - 672);
  });

  it('mounts under <body>, escaping an overflow-hidden ancestor', () => {
    render(<Harness />);
    expect(screen.queryByTestId('menu')).toBeNull();
    fireEvent.click(screen.getByTestId('trigger'));
    const menu = screen.getByTestId('menu');
    expect(screen.getByTestId('clip').contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
  });

  it('clamps a left-overflowing menu back on-screen (re-pins by left)', () => {
    rectSpy?.mockImplementation(function (this: HTMLElement) {
      const wide = this.getAttribute?.('role') === 'listbox';
      return wide
        ? ({
            top: 200,
            bottom: 440,
            left: -210,
            right: 110,
            width: 320,
            height: 240,
            x: -210,
            y: 200,
            toJSON: () => ({}),
          } as DOMRect)
        : ({
            top: 500,
            bottom: 520,
            left: 10,
            right: 110,
            width: 100,
            height: 20,
            x: 10,
            y: 500,
            toJSON: () => ({}),
          } as DOMRect);
    });
    render(<Harness />);
    fireEvent.click(screen.getByTestId('trigger'));
    const menu = screen.getByTestId('menu');
    expect(menu.style.left).toBe('8px');
    expect(menu.style.right).toBe('');
  });

  it('can align a wide menu from the trigger start edge', () => {
    render(<Harness horizontalAlign="start" />);
    fireEvent.click(screen.getByTestId('trigger'));
    const menu = screen.getByTestId('menu');
    expect(menu.style.left).toBe('100px');
    expect(menu.style.right).toBe('');
  });

  it('closes on Escape and on an outside click, but NOT on a click inside the menu', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('trigger'));
    fireEvent.mouseDown(screen.getByTestId('inside'));
    expect(screen.getByTestId('menu')).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByTestId('menu')).toBeNull();
    fireEvent.click(screen.getByTestId('trigger'));
    expect(screen.getByTestId('menu')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('menu')).toBeNull();
  });

  it('closes when an open menu anchor becomes hidden after placement', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('trigger'));
    expect(screen.getByTestId('menu')).toBeInTheDocument();

    rectSpy?.mockReturnValue({
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    act(() => {
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('scroll'));
    });

    expect(screen.queryByTestId('menu')).toBeNull();
  });

  it('opens a submenu to the left near the right edge and clamps it above the bottom edge', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    rectSpy?.mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute?.('data-testid') === 'menu') {
        return {
          top: 400,
          bottom: 660,
          left: 720,
          right: 976,
          width: 256,
          height: 260,
          x: 720,
          y: 400,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return {
        top: 400,
        bottom: 430,
        left: 980,
        right: 1000,
        width: 20,
        height: 30,
        x: 980,
        y: 400,
        toJSON: () => ({}),
      } as DOMRect;
    });

    render(<Harness placement="submenu" />);
    fireEvent.click(screen.getByTestId('trigger'));
    const menu = screen.getByTestId('menu');
    expect(menu.style.right).toBe('48px');
    expect(menu.style.left).toBe('');
    expect(menu.style.top).toBe('332px');
    expect(menu.style.bottom).toBe('');
  });
});

function FocusHarness({
  onClose,
  role = 'menu',
}: {
  onClose: (reason: MenuCloseReason) => void;
  role?: 'menu' | 'dialog';
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const menu = useMenu({
    items: [{ id: 'dialog', textValue: 'Open dialog' }],
    onActivate: () => setDialogOpen(true),
    onClose,
  });
  return (
    <>
      <button data-testid="before-menu">Before</button>
      <button ref={anchorRef} data-testid="focus-trigger" onClick={() => menu.openMenu()}>
        Open actions
      </button>
      <button data-testid="after-menu">After</button>
      <PortalMenu
        open={menu.isOpen}
        menu={menu}
        anchorRef={anchorRef}
        onRequestClose={() => {}}
        role={role}
        data-testid="focus-menu"
      >
        <button data-testid="focus-option" onClick={() => menu.activate('dialog')}>
          Open dialog
        </button>
        <input aria-label="Search actions" />
        {role === 'dialog' && <input aria-label="Additional details" />}
      </PortalMenu>
      {dialogOpen && (
        <div role="dialog">
          <input autoFocus aria-label="Dialog name" />
        </div>
      )}
    </>
  );
}

function openFocusMenu() {
  const trigger = screen.getByTestId('focus-trigger');
  act(() => trigger.focus());
  fireEvent.click(trigger);
  const option = screen.getByTestId('focus-option');
  act(() => option.focus());
  return { trigger, option };
}

describe('PortalMenu close focus', () => {
  it.each([false, true])(
    'resumes the opening control’s Tab order at the dialog boundary (backwards=%s)',
    async (backwards) => {
      const onClose = vi.fn();
      render(<FocusHarness onClose={onClose} role="dialog" />);
      const { option } = openFocusMenu();
      const boundary = backwards
        ? option
        : screen.getByRole('textbox', { name: 'Additional details' });
      act(() => boundary.focus());
      fireEvent.keyDown(boundary, { key: 'Tab', shiftKey: backwards });
      await act(async () => {});
      expect(screen.getByTestId(backwards ? 'before-menu' : 'after-menu')).toHaveFocus();
      expect(onClose).toHaveBeenCalledExactlyOnceWith('tab');
    }
  );

  it('keeps dialog Tab native inside the form and closes without restoring after focus leaves', async () => {
    const onClose = vi.fn();
    render(<FocusHarness onClose={onClose} role="dialog" />);
    const { trigger } = openFocusMenu();
    const restore = vi.spyOn(trigger, 'focus');
    const search = screen.getByRole('textbox', { name: 'Search actions' });
    const details = screen.getByRole('textbox', { name: 'Additional details' });
    act(() => search.focus());
    const internalTab = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    fireEvent(search, internalTab);
    expect(internalTab.defaultPrevented).toBe(false);
    act(() => details.focus());
    expect(details).toHaveFocus();
    expect(screen.getByTestId('focus-menu')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(details, { key: 'Tab' });
    const destination = screen.getByTestId('after-menu');
    act(() => destination.focus());
    await act(async () => {});
    expect(destination).toHaveFocus();
    expect(screen.queryByTestId('focus-menu')).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledExactlyOnceWith('tab');
    expect(restore).not.toHaveBeenCalled();
  });

  it.each([' ', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])(
    'preserves native text editing for %j bubbling from a search input',
    (key) => {
      const onClose = vi.fn();
      render(<FocusHarness onClose={onClose} />);
      openFocusMenu();
      const search = screen.getByRole('textbox', { name: 'Search actions' });
      act(() => search.focus());
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      fireEvent(search, event);
      expect(event.defaultPrevented).toBe(false);
      expect(search).toHaveFocus();
      expect(screen.getByTestId('focus-menu')).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    }
  );

  it('returns Escape to its trigger and reports the reason once', async () => {
    const onClose = vi.fn();
    render(<FocusHarness onClose={onClose} />);
    const { trigger, option } = openFocusMenu();
    fireEvent.keyDown(option, { key: 'Escape' });
    await act(async () => {});
    expect(screen.queryByTestId('focus-menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(onClose).toHaveBeenCalledExactlyOnceWith('escape');
  });

  it('allows an outside pointer destination to take focus without touching the trigger', async () => {
    const onClose = vi.fn();
    render(<FocusHarness onClose={onClose} />);
    const { trigger } = openFocusMenu();
    const restore = vi.spyOn(trigger, 'focus');
    const destination = screen.getByTestId('after-menu');
    fireEvent.mouseDown(destination);
    act(() => destination.focus());
    await act(async () => {});
    expect(destination).toHaveFocus();
    expect(restore).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledExactlyOnceWith('outside-pointer');
  });

  it.each([
    { shiftKey: false, destination: 'after-menu' },
    { shiftKey: true, destination: 'before-menu' },
  ])(
    'continues Tab navigation from a portaled input with shift=$shiftKey',
    async ({ shiftKey, destination }) => {
      const onClose = vi.fn();
      render(<FocusHarness onClose={onClose} />);
      const { trigger } = openFocusMenu();
      const restore = vi.spyOn(trigger, 'focus');
      const search = screen.getByRole('textbox', { name: 'Search actions' });
      act(() => search.focus());
      fireEvent.keyDown(search, { key: 'Tab', shiftKey });
      await act(async () => {});
      expect(screen.queryByTestId('focus-menu')).not.toBeInTheDocument();
      expect(screen.getByTestId(destination)).toHaveFocus();
      expect(restore).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledExactlyOnceWith('tab');
    }
  );

  it('does not restore browser focus when its window loses focus', async () => {
    const onClose = vi.fn();
    render(<FocusHarness onClose={onClose} />);
    const { trigger } = openFocusMenu();
    const restore = vi.spyOn(trigger, 'focus');
    fireEvent(window, new Event('blur'));
    await act(async () => {});
    expect(screen.queryByTestId('focus-menu')).not.toBeInTheDocument();
    expect(restore).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledExactlyOnceWith('window-blur');
  });

  it('keeps focus in a dialog opened by a menu command after queued cleanup', async () => {
    const onClose = vi.fn();
    render(<FocusHarness onClose={onClose} />);
    const { option } = openFocusMenu();
    fireEvent.click(option);
    await act(async () => {});
    expect(screen.getByRole('textbox', { name: 'Dialog name' })).toHaveFocus();
    expect(screen.queryByTestId('focus-menu')).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledExactlyOnceWith('selection');
  });
});
