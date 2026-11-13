// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SequenceToolbarSidebar } from '../SequenceToolbarSidebar';
import { DEFAULT_VIEWER_CONFIG } from '../../types';

function renderToolbar(overrides?: Partial<Parameters<typeof SequenceToolbarSidebar>[0]>) {
  return render(
    <SequenceToolbarSidebar
      config={DEFAULT_VIEWER_CONFIG}
      onConfigChange={vi.fn()}
      {...overrides}
    />
  );
}

describe('SequenceToolbarSidebar — structure button ', () => {
  it('is always present, even with nothing to act on yet', () => {
    renderToolbar();
    expect(screen.getByTestId('toolbar-structure')).toBeInTheDocument();
  });

  it('is disabled when isStructureAvailable is false', () => {
    renderToolbar({ onOpenStructure: vi.fn(), isStructureAvailable: false });
    const button = screen.getByTestId('toolbar-structure');
    expect(button).toBeDisabled();
  });

  it('is enabled once isStructureAvailable is true', () => {
    renderToolbar({ onOpenStructure: vi.fn(), isStructureAvailable: true });
    const button = screen.getByTestId('toolbar-structure');
    expect(button).not.toBeDisabled();
  });

  it('renders an SVG icon and reflects the open state via data-active', () => {
    renderToolbar({
      onOpenStructure: vi.fn(),
      isStructureAvailable: true,
      isStructureDrawerOpen: true,
    });
    const button = screen.getByTestId('toolbar-structure');
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.getAttribute('data-active')).toBe('true');
  });

  it('calls onOpenStructure when clicked while available', () => {
    const onOpenStructure = vi.fn();
    renderToolbar({ onOpenStructure, isStructureAvailable: true, isStructureDrawerOpen: false });
    fireEvent.click(screen.getByTestId('toolbar-structure'));
    expect(onOpenStructure).toHaveBeenCalledTimes(1);
  });

  it('does not call onOpenStructure when clicked while disabled', () => {
    const onOpenStructure = vi.fn();
    renderToolbar({ onOpenStructure, isStructureAvailable: false });
    fireEvent.click(screen.getByTestId('toolbar-structure'));
    expect(onOpenStructure).not.toHaveBeenCalled();
  });
});
