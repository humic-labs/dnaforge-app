// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SequenceToolbarSidebar } from '../SequenceToolbarSidebar';
import { DEFAULT_VIEWER_CONFIG } from '../../types';

afterEach(cleanup);

function renderSplit(
  mapPlacement: 'left' | 'right' | 'top' | 'bottom',
  rendererVisibility: 'sequence' | 'map' | 'both' = 'both'
) {
  const onMapPlacementChange = vi.fn();
  const onRendererVisibilityChange = vi.fn();
  render(
    <SequenceToolbarSidebar
      config={DEFAULT_VIEWER_CONFIG}
      onConfigChange={vi.fn()}
      onOpenPrimers={vi.fn()}
      isPrimersPanelOpen={false}
      rendererVisibility={rendererVisibility}
      onRendererVisibilityChange={onRendererVisibilityChange}
      mapPlacement={mapPlacement}
      onMapPlacementChange={onMapPlacementChange}
    />
  );
  return { onMapPlacementChange, onRendererVisibilityChange };
}

const tooltipTextFor = (testId: string) =>
  screen.getByTestId(testId).parentElement?.querySelector('div')?.textContent?.trim() ?? null;

const iconOf = (testId: string) =>
  screen
    .getByTestId(testId)
    .querySelector('svg[data-sidebar-view-icon]')
    ?.getAttribute('data-sidebar-view-icon');

describe('SequenceToolbarSidebar — split placement is two axis toggles', () => {
  it('exposes exactly FOUR flat view icons and no split sub-view', () => {
    renderSplit('left');
    const group = screen.getByTestId('sequence-renderer-visibility-toggle');
    const buttons = [...group.querySelectorAll('[data-testid]')].filter((b) =>
      b
        .getAttribute('data-testid')
        ?.match(
          /^sequence-(renderer-visibility-(sequence|map)|map-placement-(horizontal|vertical))$/
        )
    );
    expect(buttons.map((b) => b.getAttribute('data-testid'))).toEqual([
      'sequence-renderer-visibility-sequence',
      'sequence-renderer-visibility-map',
      'sequence-map-placement-horizontal',
      'sequence-map-placement-vertical',
    ]);
    expect(screen.queryByTestId('sequence-renderer-visibility-both')).toBeNull();
    expect(screen.queryByTestId('sequence-map-placement-toggle')).toBeNull();
    for (const p of ['left', 'right', 'top', 'bottom']) {
      expect(screen.queryByTestId(`sequence-map-placement-${p}`)).toBeNull();
    }
  });

  it('enters the split with a single placement action', () => {
    const { onMapPlacementChange, onRendererVisibilityChange } = renderSplit('top', 'sequence');
    fireEvent.click(screen.getByTestId('sequence-map-placement-horizontal'));
    expect(onMapPlacementChange).toHaveBeenCalledWith('right');
    expect(onRendererVisibilityChange).not.toHaveBeenCalled();
  });

  it.each([
    { from: 'left', to: 'right' },
    { from: 'right', to: 'left' },
  ] as const)('clicking the active horizontal button flips $from -> $to', ({ from, to }) => {
    const { onMapPlacementChange } = renderSplit(from);
    fireEvent.click(screen.getByTestId('sequence-map-placement-horizontal'));
    expect(onMapPlacementChange).toHaveBeenCalledWith(to);
  });

  it.each([
    { from: 'top', to: 'bottom' },
    { from: 'bottom', to: 'top' },
  ] as const)('clicking the active vertical button flips $from -> $to', ({ from, to }) => {
    const { onMapPlacementChange } = renderSplit(from);
    fireEvent.click(screen.getByTestId('sequence-map-placement-vertical'));
    expect(onMapPlacementChange).toHaveBeenCalledWith(to);
  });

  it('clicking the inactive axis switches axis to its default orientation', () => {
    const { onMapPlacementChange } = renderSplit('top');
    fireEvent.click(screen.getByTestId('sequence-map-placement-horizontal'));
    expect(onMapPlacementChange).toHaveBeenCalledWith('right');
  });

  it('defaults: side by side => map right, top/bottom => map bottom', () => {
    const a = renderSplit('top', 'sequence');
    fireEvent.click(screen.getByTestId('sequence-map-placement-horizontal'));
    expect(a.onMapPlacementChange).toHaveBeenCalledWith('right');
    cleanup();
    const b = renderSplit('left', 'sequence');
    fireEvent.click(screen.getByTestId('sequence-map-placement-vertical'));
    expect(b.onMapPlacementChange).toHaveBeenCalledWith('bottom');
  });

  it('an inactive axis previews its default orientation in the glyph', () => {
    renderSplit('top');
    expect(iconOf('sequence-map-placement-horizontal')).toBe('placement-right');
    cleanup();
    renderSplit('left');
    expect(iconOf('sequence-map-placement-vertical')).toBe('placement-bottom');
  });

  it('the glyph mirrors the live placement, so repeated clicks visibly swap it', () => {
    renderSplit('left');
    expect(iconOf('sequence-map-placement-horizontal')).toBe('placement-left');
    cleanup();
    renderSplit('right');
    expect(iconOf('sequence-map-placement-horizontal')).toBe('placement-right');
    cleanup();
    renderSplit('top');
    expect(iconOf('sequence-map-placement-vertical')).toBe('placement-top');
    cleanup();
    renderSplit('bottom');
    expect(iconOf('sequence-map-placement-vertical')).toBe('placement-bottom');
  });

  it('marks only the active axis', () => {
    renderSplit('bottom');
    expect(screen.getByTestId('sequence-map-placement-vertical').getAttribute('data-active')).toBe(
      'true'
    );
    expect(
      screen.getByTestId('sequence-map-placement-horizontal').getAttribute('data-active')
    ).not.toBe('true');
  });
});

describe('SequenceToolbarSidebar — every sequence-bearing glyph shows bases', () => {
  it('the side-by-side glyph stacks AC over GT', () => {
    renderSplit('left');
    const icon = screen
      .getByTestId('sequence-map-placement-horizontal')
      .querySelector('svg[data-sidebar-view-icon]');
    const rows = [...icon!.querySelectorAll('text[data-glyph-row]')].map((t) =>
      t.textContent?.trim()
    );
    expect(rows).toEqual(['AC', 'GT']);
  });

  it('the top/bottom glyph fits ACGT on one line', () => {
    renderSplit('top');
    const icon = screen
      .getByTestId('sequence-map-placement-vertical')
      .querySelector('svg[data-sidebar-view-icon]');
    const rows = [...icon!.querySelectorAll('text[data-glyph-row]')].map((t) =>
      t.textContent?.trim()
    );
    expect(rows).toEqual(['ACGT']);
  });

  it('draws two rows of nucleotides instead of abstract lines', () => {
    renderSplit('left');
    const icon = screen
      .getByTestId('sequence-renderer-visibility-sequence')
      .querySelector('svg[data-sidebar-view-icon="sequence"]');
    expect(icon).not.toBeNull();
    const rows = [...icon!.querySelectorAll('text[data-glyph-row]')].map((t) =>
      t.textContent?.trim()
    );
    expect(rows).toEqual(['ACGT', 'TATC']);
    expect(icon!.querySelectorAll('path')).toHaveLength(0);
  });
});

describe('SequenceToolbarSidebar — split tooltips describe the layout, not the map', () => {
  it.each([
    { testId: 'sequence-map-placement-horizontal', tooltip: 'Side by side' },
    { testId: 'sequence-map-placement-vertical', tooltip: 'Top and bottom' },
  ])('$testId shows the tooltip "$tooltip"', ({ testId, tooltip }) => {
    renderSplit('left');
    expect(tooltipTextFor(testId)).toBe(tooltip);
  });

  it('the visible tooltip does not change when the orientation flips', () => {
    renderSplit('right');
    expect(tooltipTextFor('sequence-map-placement-horizontal')).toBe('Side by side');
    cleanup();
    renderSplit('left');
    expect(tooltipTextFor('sequence-map-placement-horizontal')).toBe('Side by side');
  });
});

describe('SequenceToolbarSidebar — the split buttons announce which side the map is on', () => {
  it.each([
    {
      placement: 'right',
      testId: 'sequence-map-placement-horizontal',
      spoken: 'Side by side, map on the right',
    },
    {
      placement: 'left',
      testId: 'sequence-map-placement-horizontal',
      spoken: 'Side by side, map on the left',
    },
    {
      placement: 'bottom',
      testId: 'sequence-map-placement-vertical',
      spoken: 'Top and bottom, map on the bottom',
    },
    {
      placement: 'top',
      testId: 'sequence-map-placement-vertical',
      spoken: 'Top and bottom, map on top',
    },
  ] as const)('$placement is spoken as "$spoken"', ({ placement, testId, spoken }) => {
    renderSplit(placement);
    expect(screen.getByTestId(testId).getAttribute('aria-label')).toBe(spoken);
  });

  it('the spoken name changes when the orientation flips, while the tooltip does not', () => {
    renderSplit('right');
    const spokenBefore = screen
      .getByTestId('sequence-map-placement-horizontal')
      .getAttribute('aria-label');
    const tooltipBefore = tooltipTextFor('sequence-map-placement-horizontal');
    cleanup();
    renderSplit('left');
    expect(
      screen.getByTestId('sequence-map-placement-horizontal').getAttribute('aria-label')
    ).not.toBe(spokenBefore);
    expect(tooltipTextFor('sequence-map-placement-horizontal')).toBe(tooltipBefore);
  });
});
