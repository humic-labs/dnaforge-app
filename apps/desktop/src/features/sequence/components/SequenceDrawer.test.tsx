import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SequenceDrawer } from './SequenceDrawer';

describe('SequenceDrawer', () => {
  it('renders children when open', () => {
    render(
      <SequenceDrawer width={350} onWidthChange={vi.fn()}>
        <div>Drawer Content</div>
      </SequenceDrawer>
    );
    expect(screen.getByText('Drawer Content')).toBeDefined();
  });

  it('renders with correct width style', () => {
    const { container } = render(
      <SequenceDrawer width={400} onWidthChange={vi.fn()}>
        <div>Content</div>
      </SequenceDrawer>
    );
    const drawer = container.firstChild as HTMLElement;
    expect(drawer.style.width).toBe('400px');
  });

  it.each([500, 346])(
    'starts resize from the painted %ipx width rather than an unclamped preference',
    (paintedWidth) => {
      const onWidthChange = vi.fn();
      const { container } = render(
        <SequenceDrawer width={500} onWidthChange={onWidthChange}>
          <div>Content</div>
        </SequenceDrawer>
      );
      const drawer = container.firstChild as HTMLElement;
      vi.spyOn(drawer, 'getBoundingClientRect').mockReturnValue({ width: paintedWidth } as DOMRect);
      fireEvent.mouseDown(screen.getByTestId('drawer-drag-handle'), { clientX: 600 });
      fireEvent.mouseMove(document, { clientX: 620 });
      fireEvent.mouseUp(document);
      expect(onWidthChange).toHaveBeenLastCalledWith(paintedWidth - 20);
      expect(document.body.style.cursor).toBe('');
      expect(document.body.style.userSelect).toBe('');
    }
  );

  it('has a drag handle', () => {
    render(
      <SequenceDrawer width={350} onWidthChange={vi.fn()}>
        <div>Content</div>
      </SequenceDrawer>
    );
    expect(screen.getByTestId('drawer-drag-handle')).toBeDefined();
  });
});
