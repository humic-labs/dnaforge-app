import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useRef, useState } from 'react';
import { PortalMenu } from './PortalMenu';

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
        <button data-testid="opt" onClick={() => setOpen(false)}>
          option
        </button>
        <span data-testid="inside">stays open on click</span>
      </PortalMenu>
    </div>
  );
}

describe('PortalMenu', () => {
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
