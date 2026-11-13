/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Structure3dAttrs, StructureViewState } from '../types';
import { availableViewRecipesForStructure } from '../utils/viewRecipeAvailability';
import { createFocusInContextRecipe, createQueryInComplexRecipe } from '../utils/viewRecipe';
import { ViewerControls } from './ViewerControls';

function focusView(): StructureViewState {
  return {
    schemaVersion: 1,
    activeRecipeId: 'focus-in-context',
    recipe: createFocusInContextRecipe(),
    showWater: false,
    spin: false,
  };
}

describe('ViewerControls', () => {
  const scene = {
    schemaVersion: 1 as const,
    sceneId: 'scene:focus-ui',
    sceneKind: 'complex' as const,
    primaryResourceId: 'RCSB:1FS0:ENTRY',
    queryAnchor: {
      memberId: 'member:query',
      targetSelection: { pdbId: '1FS0', authAsymIds: ['G'] },
    },
    activeFocus: {
      memberId: 'member:query',
      role: 'query_anchor' as const,
      mappingStatus: 'mapped_current_sequence' as const,
      selection: { pdbId: '1FS0', authAsymIds: ['G'] },
    },
    members: [
      {
        memberId: 'member:query',
        kind: 'protein' as const,
        displayName: 'ATP synthase gamma chain',
        selection: { pdbId: '1FS0', authAsymIds: ['G'] },
        mappingStatus: 'mapped_current_sequence' as const,
      },
      {
        memberId: 'member:partner',
        kind: 'protein' as const,
        displayName: 'ATP synthase epsilon chain',
        selection: { pdbId: '1FS0', authAsymIds: ['E'] },
        mappingStatus: 'mapped_workspace' as const,
      },
    ],
    layers: [],
    provenance: { createdBy: 'structure-drawer' as const, provider: 'pdb' as const },
  };

  it('hides the focus picker for query-anchored recipes that do not target active focus', () => {
    render(
      <ViewerControls
        colorMode="chain"
        showWater={false}
        spin={false}
        source="pdb"
        layout="bar"
        view={{
          schemaVersion: 1,
          activeRecipeId: 'query-in-complex',
          recipe: createQueryInComplexRecipe(),
          showWater: false,
          spin: false,
        }}
        scene={scene}
        onColorModeChange={vi.fn()}
        onShowWaterChange={vi.fn()}
        onSpinChange={vi.fn()}
        onFocusMemberChange={vi.fn()}
      />
    );

    expect(screen.queryByTestId('structure-focus-select')).not.toBeInTheDocument();
  });

  it('keeps the focus picker for recipes that explicitly target active focus', () => {
    render(
      <ViewerControls
        colorMode="chain"
        showWater={false}
        spin={false}
        source="pdb"
        layout="bar"
        view={focusView()}
        scene={scene}
        onColorModeChange={vi.fn()}
        onShowWaterChange={vi.fn()}
        onSpinChange={vi.fn()}
        onFocusMemberChange={vi.fn()}
      />
    );

    expect(screen.getByTestId('structure-focus-select')).toBeInTheDocument();
  });

  it('does not expose unfinished recipe layer controls from the shipped viewer controls', () => {
    render(
      <ViewerControls
        colorMode="chain"
        showWater={false}
        spin={false}
        source="pdb"
        layout="bar"
        activeRecipeId="focus-in-context"
        view={{
          ...focusView(),
          layerOverrides: [{ layerId: 'active-focus-cartoon', color: { mode: 'bfactor' } }],
        }}
        onColorModeChange={vi.fn()}
        onShowWaterChange={vi.fn()}
        onSpinChange={vi.fn()}
        onSelectRecipe={vi.fn()}
      />
    );

    expect(screen.queryByTestId('structure-layers-trigger')).not.toBeInTheDocument();
    expect(screen.queryByTestId('structure-layer-reset')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('structure-layer-toggle-context-complex-surface')
    ).not.toBeInTheDocument();
  });

  it('exposes side-chain visibility as a preset-independent control', () => {
    const onVisibleBackboneSideChainsChange = vi.fn();
    render(
      <ViewerControls
        colorMode="chain"
        showWater={false}
        spin={false}
        source="pdb"
        layout="bar"
        sideChains={{ visibleBackbones: false }}
        onColorModeChange={vi.fn()}
        onShowWaterChange={vi.fn()}
        onSpinChange={vi.fn()}
        onSelectRecipe={vi.fn()}
        onVisibleBackboneSideChainsChange={onVisibleBackboneSideChainsChange}
      />
    );

    fireEvent.click(screen.getByTestId('structure-visible-backbone-sidechains-toggle'));
    expect(onVisibleBackboneSideChainsChange).toHaveBeenCalledWith(true);
  });

  it('renders the same non-legacy recipe menu for AlphaFold and PDB monomers', () => {
    const cases: Array<{ source: string; attrs: Structure3dAttrs }> = [
      {
        source: 'alphafold',
        attrs: {
          source: 'alphafold',
          accession: 'P39702',
          sourceId: 'AF:P39702:F1:LATEST',
        },
      },
      {
        source: 'pdb',
        attrs: {
          source: 'pdb',
          pdbId: '1FS0',
          sourceId: 'RCSB:1FS0:ENTRY',
        },
      },
    ];

    for (const testCase of cases) {
      const { unmount } = render(
        <ViewerControls
          colorMode="chain"
          showWater={false}
          spin={false}
          source={testCase.source}
          layout="bar"
          activeRecipeId="cartoon"
          viewRecipes={availableViewRecipesForStructure(testCase.attrs)}
          onColorModeChange={vi.fn()}
          onShowWaterChange={vi.fn()}
          onSpinChange={vi.fn()}
          onSelectRecipe={vi.fn()}
        />
      );

      fireEvent.click(screen.getByTestId('structure-view-recipe-trigger'));
      const menu = screen.getByTestId('structure-view-recipe-menu');
      expect(
        within(menu)
          .getAllByRole('menuitemradio')
          .map((button) => button.textContent)
      ).toEqual(['Cartoon', 'Ball-and-Stick', 'Spacefill', 'Surface', 'Illustrative', 'Hybrid']);
      for (const legacyRecipeId of ['surface-detail', 'atomic-detail', 'confidence']) {
        expect(
          screen.queryByTestId(`structure-view-recipe-option-${legacyRecipeId}`)
        ).not.toBeInTheDocument();
      }
      unmount();
    }
  });
});
