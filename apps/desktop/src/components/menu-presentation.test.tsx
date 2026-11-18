import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MenuSurface } from '@waypoint/ui-components';

describe('shared menu appearance boundary', () => {
  it('accepts placement without allowing runtime appearance overrides', () => {
    const runtime: Record<string, unknown> = {
      className: 'private-padding',
      style: { padding: 31, backgroundColor: 'magenta' },
      layout: { position: 'fixed', left: 12, top: 24, width: 220, padding: 37, color: 'red' },
      privateContent: true,
    };
    render(
      <MenuSurface {...runtime} data-testid="surface">
        Choice
      </MenuSurface>
    );
    const surface = screen.getByTestId('surface');
    expect(surface).toHaveClass('wp-menu', 'ph-no-capture', 'rr-block');
    expect(surface).not.toHaveClass('private-padding');
    expect(surface.style.padding).toBe('');
    expect(surface.style.backgroundColor).toBe('');
    expect(surface.style.color).toBe('');
    expect(surface.style.position).toBe('fixed');
    expect(surface.style.left).toBe('12px');
    expect(surface.style.top).toBe('24px');
    expect(surface.style.width).toBe('220px');
  });

  it('keeps layout motion limited to geometry', () => {
    const runtime: Record<string, unknown> = {
      layout: { transition: 'background-color 5s', display: 'flex', flexDirection: 'column' },
      motionMs: 140,
    };
    render(
      <MenuSurface {...runtime} data-testid="surface">
        Choice
      </MenuSurface>
    );
    const surface = screen.getByTestId('surface');
    expect(surface.style.display).toBe('flex');
    expect(surface.style.flexDirection).toBe('column');
    expect(surface.style.transition).toBe(
      'top 140ms ease-out, left 140ms ease-out, width 140ms ease-out, height 140ms ease-out'
    );
  });
});
