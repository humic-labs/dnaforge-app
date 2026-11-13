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
      onOpenPrimers={vi.fn()}
      isPrimersPanelOpen={false}
      {...overrides}
    />
  );
}

describe('SequenceToolbarSidebar — primers button icon ', () => {
  it('renders the PrimerIcon SVG, not the literal "P"', () => {
    renderToolbar();
    const button = screen.getByTestId('toolbar-primers');
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.textContent?.trim()).not.toBe('P');
  });

  it('reflects the open state via data-active and still triggers onOpenPrimers', () => {
    const onOpenPrimers = vi.fn();
    renderToolbar({ onOpenPrimers, isPrimersPanelOpen: true });
    const button = screen.getByTestId('toolbar-primers');
    expect(button.getAttribute('data-active')).toBe('true');
    expect(button.querySelector('svg')).not.toBeNull();
    fireEvent.click(button);
    expect(onOpenPrimers).toHaveBeenCalledTimes(1);
  });
});

describe('SequenceToolbarSidebar — managed sequence metadata', () => {
  it('shows a distinct metadata control only when the managed package supplies it', () => {
    const onOpenMetadata = vi.fn();
    const { rerender } = renderToolbar({ onOpenMetadata, isMetadataOpen: false });
    const button = screen.getByTestId('toolbar-metadata');
    expect(button.querySelector('svg')).not.toBeNull();
    fireEvent.click(button);
    expect(onOpenMetadata).toHaveBeenCalledTimes(1);

    rerender(<SequenceToolbarSidebar config={DEFAULT_VIEWER_CONFIG} onConfigChange={vi.fn()} />);
    expect(screen.queryByTestId('toolbar-metadata')).not.toBeInTheDocument();
  });
});

describe('SequenceToolbarSidebar — annotation color mode', () => {
  it('emits a controlled config update when the color lens changes', () => {
    const onConfigChange = vi.fn();
    renderToolbar({ onConfigChange });

    fireEvent.click(screen.getByTestId('toolbar-view-gear'));
    fireEvent.click(screen.getByTestId('toolbar-annotation-color-mode'));
    fireEvent.click(screen.getByTestId('toolbar-annotation-color-mode-manual'));

    expect(onConfigChange).toHaveBeenCalledWith({
      ...DEFAULT_VIEWER_CONFIG,
      annotationColorMode: 'manual',
    });
  });
});

describe('SequenceToolbarSidebar — split placement controls', () => {
  it('places the entire View section directly below the Tools controls', () => {
    renderToolbar({
      rendererVisibility: 'both',
      onRendererVisibilityChange: vi.fn(),
      mapPlacement: 'bottom',
      onMapPlacementChange: vi.fn(),
    });

    const visibility = screen.getByTestId('sequence-renderer-visibility-toggle');
    const display = screen.getByTestId('sequence-toolbar-display-section');
    const tools = screen.getByTestId('sequence-toolbar-tools-section');
    const view = screen.getByTestId('sequence-toolbar-view-section');
    expect(view.contains(visibility)).toBe(true);
    expect(visibility.contains(screen.getByTestId('sequence-map-placement-horizontal'))).toBe(true);
    expect(display.compareDocumentPosition(view)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(tools.compareDocumentPosition(view)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(tools.nextElementSibling).toBe(view);
  });

  it('keeps the split placements as top-level choices, never a sub-view', () => {
    renderToolbar({
      rendererVisibility: 'sequence',
      onRendererVisibilityChange: vi.fn(),
      mapPlacement: 'bottom',
      onMapPlacementChange: vi.fn(),
    });

    expect(screen.queryByTestId('sequence-map-placement-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sequence-renderer-visibility-both')).not.toBeInTheDocument();
    expect(screen.getByTestId('sequence-map-placement-horizontal')).toBeInTheDocument();
    expect(screen.getByTestId('sequence-map-placement-vertical')).toBeInTheDocument();
  });

  it('renders large icon-bounded view controls without a separate active highlight box', () => {
    renderToolbar({
      rendererVisibility: 'both',
      onRendererVisibilityChange: vi.fn(),
      mapPlacement: 'right',
      onMapPlacementChange: vi.fn(),
    });

    const viewButtons = [
      screen.getByTestId('sequence-renderer-visibility-sequence'),
      screen.getByTestId('sequence-renderer-visibility-map'),
      screen.getByTestId('sequence-map-placement-horizontal'),
      screen.getByTestId('sequence-map-placement-vertical'),
    ];

    for (const button of viewButtons) {
      const icon = button.querySelector('svg[data-sidebar-view-icon]');
      expect(icon).not.toBeNull();
      expect(icon?.getAttribute('width')).toBe('32');
      expect(icon?.getAttribute('height')).toBe('32');
      expect(button.className).not.toContain('bg-accent/10');
      expect(button.querySelector('.bg-accent')).toBeNull();
    }
  });
});
