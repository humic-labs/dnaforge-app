// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { StructureViewState } from '../types';
import { createFocusInContextRecipe } from './viewRecipe';
import {
  clearVisualLayerOverrides,
  setVisualLayerAlpha,
  setVisualLayerColor,
  setVisualLayerRepresentation,
  setVisualLayerTarget,
  setVisualLayerVisibility,
  viewRecipeWithLayerOverrides,
  visualLayersForView,
} from './viewLayerOverrides';

function focusView(): StructureViewState {
  return {
    schemaVersion: 1,
    activeRecipeId: 'focus-in-context',
    recipe: createFocusInContextRecipe(),
    showWater: false,
    spin: false,
  };
}

describe('view layer overrides', () => {
  it('stores visibility overrides without mutating the base recipe', () => {
    const view = focusView();
    const nextView = setVisualLayerVisibility(view, 'context-complex-surface', false);

    expect(
      view.recipe.layers.find((layer) => layer.id === 'context-complex-surface')?.visible
    ).toBe(true);
    expect(nextView.layerOverrides).toEqual([
      { layerId: 'context-complex-surface', visible: false },
    ]);
    expect(
      visualLayersForView(nextView).find((layer) => layer.id === 'context-complex-surface')?.visible
    ).toBe(false);
  });

  it('removes redundant visibility overrides when returning to the base recipe value', () => {
    const hiddenView = setVisualLayerVisibility(focusView(), 'context-complex-surface', false);
    const restoredView = setVisualLayerVisibility(hiddenView, 'context-complex-surface', true);

    expect(restoredView.layerOverrides).toBeUndefined();
    expect(
      visualLayersForView(restoredView).find((layer) => layer.id === 'context-complex-surface')
        ?.visible
    ).toBe(true);
  });

  it('returns an effective recipe with layer overrides applied', () => {
    const view = setVisualLayerVisibility(focusView(), 'active-focus-cartoon', false);
    const effectiveRecipe = viewRecipeWithLayerOverrides(view);

    expect(effectiveRecipe).not.toBe(view.recipe);
    expect(
      effectiveRecipe.layers.find((layer) => layer.id === 'active-focus-cartoon')
    ).toMatchObject({
      visible: false,
      representation: { kind: 'cartoon' },
    });
  });

  it('stores representation overrides independently from the base recipe', () => {
    const view = setVisualLayerRepresentation(focusView(), 'active-focus-cartoon', 'surface');

    expect(view.layerOverrides).toEqual([
      { layerId: 'active-focus-cartoon', representation: { kind: 'surface' } },
    ]);
    expect(
      visualLayersForView(view).find((layer) => layer.id === 'active-focus-cartoon')?.representation
    ).toEqual({ kind: 'surface' });
    expect(
      view.recipe.layers.find((layer) => layer.id === 'active-focus-cartoon')?.representation
    ).toEqual({ kind: 'cartoon' });
  });

  it('stores target overrides independently from the base recipe', () => {
    const view = setVisualLayerTarget(focusView(), 'active-focus-cartoon', {
      kind: 'query-anchor',
    });

    expect(view.layerOverrides).toEqual([
      { layerId: 'active-focus-cartoon', target: { kind: 'query-anchor' } },
    ]);
    expect(
      visualLayersForView(view).find((layer) => layer.id === 'active-focus-cartoon')?.target
    ).toEqual({ kind: 'query-anchor' });
    expect(view.recipe.layers.find((layer) => layer.id === 'active-focus-cartoon')?.target).toEqual(
      { kind: 'active-focus' }
    );
  });

  it('removes redundant target overrides when returning to the base recipe target', () => {
    const changedView = setVisualLayerTarget(focusView(), 'active-focus-cartoon', {
      kind: 'query-anchor',
    });
    const restoredView = setVisualLayerTarget(changedView, 'active-focus-cartoon', {
      kind: 'active-focus',
    });

    expect(restoredView.layerOverrides).toBeUndefined();
    expect(
      visualLayersForView(restoredView).find((layer) => layer.id === 'active-focus-cartoon')?.target
    ).toEqual({ kind: 'active-focus' });
  });

  it('stores color overrides independently from the base recipe', () => {
    const view = setVisualLayerColor(focusView(), 'context-complex-surface', 'bfactor');

    expect(view.layerOverrides).toEqual([
      { layerId: 'context-complex-surface', color: { mode: 'bfactor' } },
    ]);
    expect(
      visualLayersForView(view).find((layer) => layer.id === 'context-complex-surface')?.color
    ).toEqual({ mode: 'bfactor' });
    expect(
      view.recipe.layers.find((layer) => layer.id === 'context-complex-surface')?.color
    ).toEqual({ mode: 'context-muted' });
  });

  it('stores surface alpha overrides while preserving the base layer material settings', () => {
    const view = setVisualLayerAlpha(focusView(), 'context-complex-surface', 0.35);
    const effectiveLayer = visualLayersForView(view).find(
      (layer) => layer.id === 'context-complex-surface'
    );

    expect(view.layerOverrides).toEqual([
      { layerId: 'context-complex-surface', material: { alpha: 0.35 } },
    ]);
    expect(effectiveLayer?.material).toMatchObject({
      alpha: 0.35,
      quality: 'auto',
    });
  });

  it('clears all layer overrides back to the active recipe baseline', () => {
    const view = setVisualLayerColor(
      setVisualLayerRepresentation(focusView(), 'context-complex-surface', 'cartoon'),
      'context-complex-surface',
      'bfactor'
    );

    const restoredView = clearVisualLayerOverrides(view);

    expect(restoredView.layerOverrides).toBeUndefined();
    expect(
      visualLayersForView(restoredView).find((layer) => layer.id === 'context-complex-surface')
    ).toMatchObject({
      representation: { kind: 'surface' },
      color: { mode: 'context-muted' },
    });
  });
});
