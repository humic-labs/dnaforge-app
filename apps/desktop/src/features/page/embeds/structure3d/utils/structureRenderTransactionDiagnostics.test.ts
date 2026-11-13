// @vitest-environment node

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearStructureRenderTransactionDiagnostics,
  getStructureRenderTransactionDiagnostic,
  getStructureRenderTransactionDiagnostics,
  recordStructureRenderTransactionDiagnostic,
  removeStructureRenderTransactionDiagnostic,
} from './structureRenderTransactionDiagnostics';
import type { StructureRenderTransaction } from './structureRenderTransaction';

beforeEach(() => {
  clearStructureRenderTransactionDiagnostics();
});

describe('structure render transaction diagnostics registry', () => {
  it('stores diagnostics by exact visible viewer cache key', () => {
    const transaction = fakeTransaction('wprtx_loaded');
    recordStructureRenderTransactionDiagnostic({
      key: 'provider:RCSB:9Q87:ENTRY::renderer::instance:drawer',
      structureKey: 'provider:RCSB:9Q87:ENTRY',
      viewerReady: true,
      isConnected: true,
      transaction,
      molstarPlan: {
        namespace: 'waypoint.structure3d',
        components: [{ tag: 'waypoint.structure3d.component.query-anchor-cartoon.query' }],
      },
    });

    expect(
      getStructureRenderTransactionDiagnostic('provider:RCSB:9Q87:ENTRY::renderer::instance:drawer')
    ).toMatchObject({
      key: 'provider:RCSB:9Q87:ENTRY::renderer::instance:drawer',
      viewerReady: true,
      transaction: { planHash: 'wprtx_loaded' },
      molstarPlan: {
        components: [{ tag: 'waypoint.structure3d.component.query-anchor-cartoon.query' }],
      },
    });
    expect(getStructureRenderTransactionDiagnostics('9Q87')).toHaveLength(1);
    expect(getStructureRenderTransactionDiagnostics('7ZP8')).toHaveLength(0);
  });

  it('removes stale diagnostics when a viewer unmounts', () => {
    recordStructureRenderTransactionDiagnostic({
      key: 'preview-key:preview',
      structureKey: 'provider:RCSB:7ZP8:ENTRY',
      viewerReady: false,
      isConnected: false,
      transaction: fakeTransaction('wprtx_preview'),
    });

    removeStructureRenderTransactionDiagnostic('preview-key:preview');

    expect(getStructureRenderTransactionDiagnostics()).toEqual([]);
  });
});

function fakeTransaction(planHash: string): StructureRenderTransaction {
  return {
    schemaVersion: 1,
    renderIntent: planHash.endsWith('preview') ? 'preview' : 'loaded',
    sceneId: null,
    activeRecipeId: null,
    chainCatalogStatus: 'pending',
    planHash,
    layers: [],
    table: {
      sourcePaletteId: 'molstar:pending-chain-catalog',
      rows: [],
      chainColors: {},
    },
    molstar: {
      sourcePaletteId: 'molstar:pending-chain-catalog',
      chainColors: {},
      representations: [],
    },
    canvas: {
      outlineEnabled: false,
      aoEnabled: false,
    },
    invariants: {
      previewAllowsSurface: false,
      hasSurfaceLayer: false,
      surfaceLayerKeys: [],
    },
  };
}
