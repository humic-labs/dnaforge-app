import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Structure3dAttrs } from '../types';
import {
  createAssemblyOverviewRecipe,
  createHybridRecipe,
  createIllustrativeRecipe,
  createQueryInComplexRecipe,
  createQueryInComplexSurfaceRecipe,
} from '../utils/viewRecipe';
import { useViewerSettings } from './useViewerSettings';

describe('useViewerSettings', () => {
  it('selects recipes by writing only attrs.view', () => {
    const updateAttrs = vi.fn();
    const attrs: Structure3dAttrs = { source: 'pdb', sourceId: '1ABC' };
    const { result } = renderHook(() => useViewerSettings({ attrs, updateAttrs }));

    act(() => result.current.handleSelectRecipe(createHybridRecipe()));

    expect(updateAttrs).toHaveBeenCalledTimes(1);
    const patch = updateAttrs.mock.calls[0][0];
    expect(Object.keys(patch)).toEqual(['view']);
    expect(patch.view).toMatchObject({
      activeRecipeId: 'hybrid',
      recipe: { id: 'hybrid' },
    });
  });

  it('changes global color through the recipe instead of flat attrs', () => {
    const updateAttrs = vi.fn();
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: '1ABC',
      view: {
        schemaVersion: 1,
        activeRecipeId: 'illustrative',
        recipe: createIllustrativeRecipe(),
        showWater: false,
        spin: false,
      },
    };
    const { result } = renderHook(() => useViewerSettings({ attrs, updateAttrs }));

    act(() => result.current.handleColorModeChange('plddt'));

    const patch = updateAttrs.mock.calls[0][0];
    expect(Object.keys(patch)).toEqual(['view']);
    expect(patch.view.activeRecipeId).toBeNull();
    expect(patch.view.recipe.layers[0].color.mode).toBe('plddt');
  });

  it('preserves chain-detail selections when switching recipes', () => {
    const updateAttrs = vi.fn();
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: '1ABC',
      view: {
        schemaVersion: 1,
        activeRecipeId: 'query-in-complex',
        recipe: createQueryInComplexRecipe(),
        detailChainInstanceIds: ['chain:A'],
        showWater: false,
        spin: false,
      },
    };
    const { result } = renderHook(() => useViewerSettings({ attrs, updateAttrs }));

    act(() => result.current.handleSelectRecipe(createIllustrativeRecipe()));

    const patch = updateAttrs.mock.calls[0][0];
    expect(patch.view.detailChainInstanceIds).toEqual(['chain:A']);
    expect(patch.view.activeRecipeId).toBe('illustrative');
  });

  it('reduces rapid follow-up commands against the pending emitted view instead of stale attrs', () => {
    const updateAttrs = vi.fn();
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: '1ABC',
      view: {
        schemaVersion: 1,
        activeRecipeId: 'query-in-complex-surface',
        recipe: createQueryInComplexSurfaceRecipe(),
        detailChainInstanceIds: ['chain:A'],
        showWater: false,
        spin: false,
      },
    };
    const { result } = renderHook(() =>
      useViewerSettings({
        attrs,
        getLatestAttrs: () => attrs,
        updateAttrs,
      })
    );

    act(() => {
      result.current.handleSelectRecipe(createAssemblyOverviewRecipe());
      result.current.handleColorModeChange('chain');
    });

    expect(updateAttrs).toHaveBeenCalledTimes(2);
    const colorPatch = updateAttrs.mock.calls[1][0];
    expect(colorPatch.view.activeRecipeId).toBeNull();
    expect(colorPatch.view.detailChainInstanceIds).toEqual(['chain:A']);
    expect(colorPatch.view.recipe.layers.map((layer: { id: string }) => layer.id)).toEqual([
      'opaque-context-surface',
      'query-anchor-highlight-cartoon',
      'assembly-ligands-ball-and-stick',
    ]);
    expect(
      colorPatch.view.recipe.layers.some(
        (layer: { id: string }) => layer.id === 'whole-structure-surface-overlay'
      )
    ).toBe(false);
    expect(
      colorPatch.view.recipe.layers.map((layer: { color: { mode: string } }) => layer.color.mode)
    ).toEqual(['context-muted', 'chain', 'element']);
  });
});
