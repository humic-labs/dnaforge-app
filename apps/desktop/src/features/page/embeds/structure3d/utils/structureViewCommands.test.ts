// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { Structure3dAttrs, StructureScene, StructureViewState, ViewRecipe } from '../types';
import { createFocusInContextRecipe } from './viewRecipe';
import {
  clearStructureChainVisibilityMask,
  reduceStructureViewCommand,
} from './structureViewCommands';

const SCENE: StructureScene = {
  schemaVersion: 1,
  sceneId: 'scene:mg1655:atpG:1FS0',
  sceneKind: 'complex',
  primaryResourceId: 'RCSB:1FS0:ENTRY',
  queryAnchor: {
    memberId: 'member:atpG',
    label: 'atpG',
    targetSelection: {
      providerIdentityKey: 'RCSB:1FS0:ENTRY',
      pdbId: '1FS0',
      entityIds: ['2'],
      authAsymIds: ['G'],
    },
  },
  activeFocus: {
    memberId: 'member:atpG',
    role: 'query_anchor',
    mappingStatus: 'mapped_current_sequence',
    selection: {
      providerIdentityKey: 'RCSB:1FS0:ENTRY',
      pdbId: '1FS0',
      entityIds: ['2'],
      authAsymIds: ['G'],
    },
  },
  members: [],
  layers: [],
  provenance: { createdBy: 'structure-drawer', provider: 'pdb' },
};

const QUERY_RECIPE: ViewRecipe = {
  schemaVersion: 1,
  id: 'query-in-complex',
  name: 'Query in Complex',
  origin: 'builtin',
  layers: [],
};

const ILLUSTRATIVE_RECIPE: ViewRecipe = {
  schemaVersion: 1,
  id: 'illustrative',
  name: 'Illustrative',
  origin: 'builtin',
  layers: [],
};

const BASE_VIEW: StructureViewState = {
  schemaVersion: 1,
  activeRecipeId: 'query-in-complex',
  recipe: QUERY_RECIPE,
  detailChainInstanceIds: ['g-2-g'],
  showWater: false,
  spin: false,
};

function attrs(view: StructureViewState | undefined = BASE_VIEW): Structure3dAttrs {
  return {
    source: 'pdb',
    sourceId: 'RCSB:1FS0:ENTRY',
    providerIdentityKey: 'RCSB:1FS0:ENTRY',
    pdbId: '1FS0',
    scene: SCENE,
    ...(view ? { view } : {}),
  };
}

describe('structure view commands', () => {
  it('preserves explicit selected chain instances across recipe switches', () => {
    const next = reduceStructureViewCommand({
      attrs: attrs({
        ...BASE_VIEW,
        detailChainInstanceIds: ['g-2-g', 'e-1-e'],
        residueVisualization: {
          sideChains: {
            visibleBackbones: true,
            selection: true,
          },
        },
      }),
      command: {
        type: 'select-recipe',
        recipe: ILLUSTRATIVE_RECIPE,
      },
    });

    expect(next).toMatchObject({
      activeRecipeId: 'illustrative',
      detailChainInstanceIds: ['g-2-g', 'e-1-e'],
      residueVisualization: {
        sideChains: {
          visibleBackbones: true,
          selection: true,
        },
      },
      recipe: { id: 'illustrative' },
    });
  });

  it('does not import stale table-visible chain ids when explicit view state exists', () => {
    const next = reduceStructureViewCommand({
      attrs: attrs({
        ...BASE_VIEW,
        detailChainInstanceIds: ['g-2-g', 'e-1-e'],
      }),
      command: {
        type: 'set-detail-chain-visible',
        chainInstanceId: 'e-1-e',
        visible: false,
        fallbackDetailChainInstanceIds: ['g-2-g', 'e-1-e', 'stale-ui-row'],
      },
    });

    expect(next?.detailChainInstanceIds).toEqual(['g-2-g']);
  });

  it('uses only an explicit fallback catalog when no chain selection has been stamped yet', () => {
    const next = reduceStructureViewCommand({
      attrs: attrs({
        ...BASE_VIEW,
        detailChainInstanceIds: undefined,
      }),
      command: {
        type: 'set-detail-chain-visible',
        chainInstanceId: 'e-1-e',
        visible: true,
        fallbackDetailChainInstanceIds: ['g-2-g'],
      },
    });

    expect(next?.detailChainInstanceIds).toEqual(['g-2-g', 'e-1-e']);
  });

  it('uses attrs.view as the canonical command input', () => {
    const next = reduceStructureViewCommand({
      attrs: attrs({
        ...BASE_VIEW,
        activeRecipeId: 'query-in-complex',
        recipe: QUERY_RECIPE,
        detailChainInstanceIds: ['g-2-g'],
      }),
      command: {
        type: 'set-detail-chain-visible',
        chainInstanceId: 'e-1-e',
        visible: true,
        fallbackDetailChainInstanceIds: ['stale-ui-row'],
      },
    });

    expect(next).toMatchObject({
      activeRecipeId: 'query-in-complex',
      recipe: { id: 'query-in-complex' },
      detailChainInstanceIds: ['g-2-g', 'e-1-e'],
    });
  });

  it('routes global render controls through the canonical view state', () => {
    const colored = reduceStructureViewCommand({
      attrs: attrs(BASE_VIEW),
      command: { type: 'set-global-color-mode', colorMode: 'bfactor' },
    });
    const hydrated = reduceStructureViewCommand({
      attrs: attrs(colored ?? BASE_VIEW),
      command: { type: 'set-show-water', visible: true },
    });
    const spinning = reduceStructureViewCommand({
      attrs: attrs(hydrated ?? BASE_VIEW),
      command: { type: 'set-spin', enabled: true },
    });

    expect(spinning).toMatchObject({
      activeRecipeId: null,
      showWater: true,
      spin: true,
      recipe: { id: 'query-in-complex' },
    });
  });

  it('routes side-chain visualization controls through canonical view state', () => {
    const visibleBackbones = reduceStructureViewCommand({
      attrs: attrs(BASE_VIEW),
      command: {
        type: 'set-side-chain-visibility',
        target: 'visibleBackbones',
        visible: true,
      },
    });
    const selection = reduceStructureViewCommand({
      attrs: attrs(visibleBackbones ?? BASE_VIEW),
      command: {
        type: 'set-side-chain-visibility',
        target: 'selection',
        visible: true,
      },
    });

    expect(selection?.residueVisualization?.sideChains).toEqual({
      visibleBackbones: true,
      selection: true,
    });
  });

  it('persists physical chain visibility independently of recipe changes', () => {
    const hidden = reduceStructureViewCommand({
      attrs: attrs(BASE_VIEW),
      command: { type: 'set-chain-visible', chainInstanceId: 'chain-a', visible: false },
    });
    expect(hidden?.hiddenChainInstanceIds).toEqual(['chain-a']);
    const recolored = reduceStructureViewCommand({
      attrs: attrs(hidden ?? BASE_VIEW),
      command: { type: 'set-global-color-mode', colorMode: 'bfactor' },
    });
    expect(recolored?.hiddenChainInstanceIds).toEqual(['chain-a']);
    const restored = reduceStructureViewCommand({
      attrs: attrs(recolored ?? BASE_VIEW),
      command: { type: 'set-chain-visible', chainInstanceId: 'chain-a', visible: true },
    });
    expect(restored?.hiddenChainInstanceIds).toEqual([]);
    expect(clearStructureChainVisibilityMask(hidden ?? BASE_VIEW).hiddenChainInstanceIds).toEqual(
      []
    );
  });

  it('routes visual layer edits through canonical layer overrides', () => {
    const view: StructureViewState = {
      schemaVersion: 1,
      activeRecipeId: 'focus-in-context',
      recipe: createFocusInContextRecipe(),
      showWater: false,
      spin: false,
    };

    const hidden = reduceStructureViewCommand({
      attrs: attrs(view),
      command: {
        type: 'set-layer-visible',
        layerId: 'context-complex-surface',
        visible: false,
      },
    });
    const restyled = reduceStructureViewCommand({
      attrs: attrs(hidden ?? view),
      command: {
        type: 'set-layer-representation',
        layerId: 'context-complex-surface',
        representation: 'cartoon',
      },
    });
    const recolored = reduceStructureViewCommand({
      attrs: attrs(restyled ?? view),
      command: {
        type: 'set-layer-color',
        layerId: 'context-complex-surface',
        colorMode: 'bfactor',
      },
    });

    expect(recolored?.layerOverrides).toEqual([
      {
        layerId: 'context-complex-surface',
        visible: false,
        representation: { kind: 'cartoon' },
        color: { mode: 'bfactor' },
      },
    ]);
  });
});
