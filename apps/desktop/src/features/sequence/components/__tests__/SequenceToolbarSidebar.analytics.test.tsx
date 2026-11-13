import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SequenceToolbarSidebar } from '../SequenceToolbarSidebar';
import { DEFAULT_VIEWER_CONFIG } from '../../types';

afterEach(cleanup);

it('names the sequence toolbar and its controls for masked analytics', () => {
  render(
    <SequenceToolbarSidebar
      config={DEFAULT_VIEWER_CONFIG}
      onConfigChange={vi.fn()}
      onOpenPrimers={vi.fn()}
      rendererVisibility="both"
      onRendererVisibilityChange={vi.fn()}
      mapPlacement="left"
      onMapPlacementChange={vi.fn()}
    />
  );
  const rail = screen.getByTestId('sequence-tool-rail');
  expect(rail.getAttribute('data-ph-name')).toBe('sequence-tool-rail');
  fireEvent.click(screen.getByTestId('toolbar-view-gear'));
  const controls = rail.querySelectorAll('button');
  expect(controls.length).toBeGreaterThan(3);
  for (const control of controls) expect(control.getAttribute('data-ph-name')).toBeTruthy();
});
