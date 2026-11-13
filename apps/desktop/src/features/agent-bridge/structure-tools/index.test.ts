import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import {
  molListStructuresOutputSchema,
  molGetSceneOutputSchema,
  molApplySceneOutputSchema,
  molActivateViewOutputSchema,
  molOpenTabOutputSchema,
  molSetColorOutputSchema,
  molSetRepresentationOutputSchema,
  molSetSideChainsOutputSchema,
} from './output-schemas';
/**
 * @vitest-environment jsdom
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { useCanvasStore } from '../../canvas/store';
import { useStructure3dStore } from '../../page/embeds/structure3d/store';
import { validateAlphaFoldId } from '../../page/embeds/structure3d/api/structure-service-client';
import { fetchStructureData } from '../../page/embeds/structure3d/utils/structureData';
import { openDocument } from '../../document-opening/public/open-document';
import {
  handleMolListStructures as executeMolListStructures,
  handleMolGetScene as executeMolGetScene,
  handleMolApplyScene as executeMolApplyScene,
  handleMolActivateView as executeMolActivateView,
  handleMolOpenTab as executeMolOpenTab,
  handleMolSetColor as executeMolSetColor,
  handleMolSetRepresentation as executeMolSetRepresentation,
  handleMolSetSideChains as executeMolSetSideChains,
  MOLSTAR_MCP_REPRESENTATION_RECIPE_IDS,
  molGetStateSchema,
  molSetColorSchema,
  molSetRepresentationSchema,
  molSetSideChainsSchema,
} from './index';
import type { Structure3dAttrs } from '../../page/embeds/structure3d/types';

vi.mock('../../document-opening/public/open-document', () => ({
  openDocument: vi.fn(),
}));

vi.mock('../../page/embeds/structure3d/utils/structureData', () => ({
  fetchStructureData: vi.fn(async () => ({ data: 'mock_structure', format: 'mmcif' })),
  structureFetchIdentityCacheIdentity: vi.fn(
    (identity: { provider: 'rcsb' | 'alphafold'; externalId: string; format?: string }) =>
      identity.format === 'pdb' ? `${identity.externalId}:pdb` : identity.externalId
  ),
}));

vi.mock('../../page/embeds/structure3d/api/structure-service-client', () => ({
  validateAlphaFoldId: vi.fn(async (accession: string) => ({
    valid: true,
    providerIdentityKey: `AF:${accession.toUpperCase()}:F1:V6:MODEL:AF-${accession.toUpperCase()}-F1-model_v6`,
    latestVersion: 6,
    fragment: 'F1',
    modelId: `AF-${accession.toUpperCase()}-F1-model_v6`,
  })),
}));

const PDB_VIEWER_ID = 'provider:RCSB:1TUP:ENTRY';
const AF_VIEWER_ID = 'provider:AF:P0AD86:F1:V6:MODEL:AF-P0AD86-F1-model_v6';

function resetStores() {
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
  });
  useStructure3dStore.setState({
    expandedStructures: {},
    interactionState: {},
    selectionAnchor: {},
    selectionRangeBase: {},
  });
}

describe('structure renderer tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('opens a workspace coordinate file through canonical document opening beside the working chat', async () => {
    const canvas = useCanvasStore.getState();
    const chatPanelId = canvas.splitPanel('main', 'vertical');
    const chatTabId = canvas.openTab(chatPanelId, {
      type: 'chat',
      entityId: 'file-structure-chat',
      label: 'Structure analysis',
    });
    canvas.focusPanel(chatPanelId);
    vi.mocked(openDocument).mockImplementationOnce(async (request) => {
      expect(request.target).toEqual({
        kind: 'file',
        path: '/workspace/Data/1URN.cif',
        tabType: 'structure',
      });
      expect(request.placement).toEqual({ kind: 'panel', panelId: 'main' });
      const tabId = useCanvasStore.getState().openTab('main', {
        type: 'structure',
        entityId: 'view:pinned-1URN',
        label: 'U1A / RNA',
        loadStatus: 'loaded',
        initialStructureAttrs: { source: 'file', coordinateFilePath: '/workspace/Data/1URN.cif' },
      });
      return {
        status: 'presented',
        tabId,
        panelId: 'main',
        tabType: 'structure',
        disposition: 'created',
        content: 'loading',
      };
    });
    const result = await handleMolOpenTab(
      {
        structure: { kind: 'file', path: 'Data/1URN.cif' },
        label: 'U1A / RNA',
      },
      { folders: [{ name: 'Data', path: '/workspace/Data', addedAt: 0 }] }
    );
    expect(result).toMatchObject({
      ok: true,
      structureViewId: 'view:pinned-1URN',
      source: { kind: 'file', path: '/workspace/Data/1URN.cif' },
    });
    expect(openDocument).toHaveBeenCalledOnce();
    expect(fetchStructureData).not.toHaveBeenCalled();
    const next = useCanvasStore.getState();
    expect(next.focusedPanelId).toBe(chatPanelId);
    expect(next.panels[chatPanelId].activeTabId).toBe(chatTabId);
    expect(next.panels.main.activeTabId).toBe(result.tabId);
  });

  it('cannot return success for an unavailable local coordinate file', async () => {
    vi.mocked(openDocument).mockImplementationOnce(async () => {
      const canvas = useCanvasStore.getState();
      const target = Object.keys(canvas.panels).find((id) => id !== 'main') ?? 'main';
      const tabId = canvas.openTab(target, {
        type: 'structure',
        entityId: 'missing-view',
        label: 'missing.cif',
        loadStatus: 'missing',
      });
      return {
        status: 'presented',
        tabId,
        panelId: target,
        tabType: 'structure',
        disposition: 'created',
        content: 'missing',
      };
    });
    await expect(
      handleMolOpenTab(
        { structure: { kind: 'file', path: 'missing.cif' } },
        {
          folders: [{ name: 'Data', path: '/workspace/Data', addedAt: 0 }],
        }
      )
    ).resolves.toMatchObject({
      ok: false,
      code: 'FILE_UNAVAILABLE',
    });
  });

  it('rejects local file requests outside the workspace or cancelled before opening', async () => {
    const folders = [{ name: 'Data', path: '/workspace/Data', addedAt: 0 }];
    await expect(
      handleMolOpenTab({ structure: { kind: 'file', path: '/outside/1URN.cif' } }, { folders })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/outside every open project/),
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      handleMolOpenTab(
        { structure: { kind: 'file', path: '1URN.cif' } },
        { folders, abortSignal: controller.signal }
      )
    ).resolves.toMatchObject({ ok: false });
    expect(openDocument).not.toHaveBeenCalled();
    expect(fetchStructureData).not.toHaveBeenCalled();
  });

  it('opens agent structure content beside a right-hand chat without hiding or defocusing chat', async () => {
    const canvas = useCanvasStore.getState();
    const chatPanelId = canvas.splitPanel('main', 'vertical');
    const chatTabId = canvas.openTab(chatPanelId, {
      type: 'chat',
      entityId: 'protein-exploration-chat',
      label: 'Protein exploration',
    });
    canvas.focusPanel(chatPanelId);

    const result = await handleMolOpenTab({
      structure: { kind: 'pdb', pdbId: '1tup' },
    });

    const next = useCanvasStore.getState();
    expect(Object.keys(next.panels)).toHaveLength(2);
    expect(next.panels[chatPanelId].activeTabId).toBe(chatTabId);
    expect(next.panels.main.activeTabId).toBe(result.tabId);
    expect(next.focusedPanelId).toBe(chatPanelId);
  });

  it('opens a PDB structure in the structure store and canvas', async () => {
    const result = await handleMolOpenTab({
      structure: { kind: 'pdb', pdbId: '1tup' },
      label: 'p53 core domain',
    });

    expect(result).toMatchObject({
      ok: true,
      viewerId: PDB_VIEWER_ID,
      label: 'p53 core domain',
    });
    expect(fetchStructureData).toHaveBeenCalledWith('1TUP', 'rcsb');
    expect(useStructure3dStore.getState().expandedStructures[PDB_VIEWER_ID]).toMatchObject({
      label: 'p53 core domain',
      data: {
        source: 'pdb',
        sourceId: '1TUP',
        pdbId: '1TUP',
      },
    });
    const tabs = Object.values(useCanvasStore.getState().panels).flatMap((panel) => panel.tabs);
    expect(tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'structure',
          entityId: PDB_VIEWER_ID,
          label: 'p53 core domain',
          initialStructureAttrs: expect.objectContaining({
            providerIdentityKey: 'RCSB:1TUP:ENTRY',
            source: 'pdb',
            sourceId: '1TUP',
          }),
        }),
      ])
    );
  });

  it('lists and updates registered structure view settings by viewer id', async () => {
    await handleMolOpenTab({ structure: { kind: 'uniprot', accession: 'P0AD86' } });
    expect(validateAlphaFoldId).toHaveBeenCalledWith('P0AD86', undefined);

    await handleMolSetRepresentation({
      viewerId: AF_VIEWER_ID,
      representation: 'illustrative',
    });
    await handleMolSetColor({
      viewerId: AF_VIEWER_ID,
      colorMode: 'plddt',
    });
    await handleMolSetSideChains({
      viewerId: AF_VIEWER_ID,
      target: 'visible_backbones',
      visible: true,
    });
    await handleMolSetSideChains({
      viewerId: AF_VIEWER_ID,
      target: 'selection',
      visible: true,
    });
    const attrs = useStructure3dStore.getState().expandedStructures[AF_VIEWER_ID]?.data;
    expect(attrs).toMatchObject({
      view: {
        activeRecipeId: null,
        recipe: {
          id: 'illustrative',
          layers: [expect.objectContaining({ representation: { kind: 'illustrative' } })],
        },
        residueVisualization: {
          sideChains: {
            visibleBackbones: true,
            selection: true,
          },
        },
      },
    });
    expect(attrs).not.toHaveProperty('representation');
    expect(attrs).not.toHaveProperty('colorMode');
    expect(attrs).not.toHaveProperty('activePresetId');

    const listed = await handleMolListStructures();
    expect(listed.structures).toEqual([
      expect.objectContaining({
        structureId: AF_VIEWER_ID,
        viewerId: AF_VIEWER_ID,
        representation: 'illustrative',
        colorMode: 'plddt',
        sideChains: {
          visibleBackbones: true,
          selection: true,
        },
        viewerStatus: 'inactive',
        currentSelection: expect.objectContaining({
          selection: null,
          selectedResidues: [],
          molstarSelectedResidues: [],
        }),
      }),
    ]);
  });

  it('exposes binding/view identity and fails closed for an ambiguous legacy coordinate id', async () => {
    const attrsFor = (bindingId: string, structureViewId: string): Structure3dAttrs => ({
      source: 'pdb',
      sourceId: 'RCSB:1ABC:ENTRY',
      providerIdentityKey: 'RCSB:1ABC:ENTRY',
      pdbId: '1ABC',
      structureBinding: {
        schemaVersion: 1,
        bindingId,
        structureId: 'structure:RCSB:1ABC:ENTRY',
        coordinateRevision: {
          kind: 'provider',
          pinStatus: 'provider-revision',
          revisionId: 'coordinate-revision',
          providerIdentityKey: 'RCSB:1ABC:ENTRY',
        },
        polymerRevision: {
          moleculeId: `protein:${bindingId}`,
          moleculeKind: 'protein',
          sequenceDigestSha256: bindingId.padEnd(64, '0'),
        },
        mappingRevisionId: `mapping:${bindingId}`,
        physicalChainScope: [],
      },
      structureViewIdentity: {
        schemaVersion: 1,
        structureViewId,
        bindingId,
      },
    });
    useStructure3dStore
      .getState()
      .registerStructure('view:a', attrsFor('binding:a', 'view:a'), 'A');
    useStructure3dStore
      .getState()
      .registerStructure('view:b', attrsFor('binding:b', 'view:b'), 'B');
    useCanvasStore.getState().openTab('main', {
      type: 'structure',
      entityId: 'view:a',
      label: 'A',
    });
    useCanvasStore.getState().openTab('main', {
      type: 'structure',
      entityId: 'view:b',
      label: 'B',
    });
    useStructure3dStore.getState().setSelected('binding:a', [{ chain: 'A', position: 7 }]);

    const listed = await handleMolListStructures();
    expect(listed.structures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          structureId: 'structure:RCSB:1ABC:ENTRY',
          structureViewId: 'view:a',
          bindingId: 'binding:a',
          selectedResidues: [{ chain: 'A', position: 7 }],
        }),
        expect.objectContaining({
          structureId: 'structure:RCSB:1ABC:ENTRY',
          structureViewId: 'view:b',
          bindingId: 'binding:b',
          selectedResidues: [],
        }),
      ])
    );

    await expect(
      handleMolSetColor({
        viewerId: 'structure:RCSB:1ABC:ENTRY',
        colorMode: 'chain',
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'AMBIGUOUS_VIEWER',
      details: {
        candidates: expect.arrayContaining([
          expect.objectContaining({ structureViewId: 'view:a', bindingId: 'binding:a' }),
          expect.objectContaining({ structureViewId: 'view:b', bindingId: 'binding:b' }),
        ]),
      },
    });

    await expect(
      handleMolSetColor({ structureViewId: 'view:a', colorMode: 'plddt' })
    ).resolves.toMatchObject({ ok: true });
    expect(useStructure3dStore.getState().expandedStructures['view:a']?.data.view).toBeDefined();
    expect(useStructure3dStore.getState().expandedStructures['view:b']?.data.view).toBeUndefined();

    await expect(
      handleMolSetColor({ bindingId: 'binding:b', colorMode: 'bfactor' })
    ).resolves.toMatchObject({ ok: true });
    expect(useStructure3dStore.getState().expandedStructures['view:b']?.data.view).toBeDefined();
  });

  it('lists a standalone coordinate artifact as one controllable unbound logical view', async () => {
    const coordinateDigestSha256 = 'a'.repeat(64);
    const structureId = `structure:file:catalog-1:${coordinateDigestSha256}`;
    const structureViewId = `structure-view:file:catalog-1:${coordinateDigestSha256}`;
    useStructure3dStore.getState().registerStructure(
      structureViewId,
      {
        source: 'file',
        sourceId: '/lab/1FS0.bcif',
        label: '1FS0.bcif',
        structureArtifactRef: {
          entityId: 'catalog-1',
          revisionId: `structure-coordinate:file:v1:${coordinateDigestSha256}`,
          structureId,
          coordinateDigestSha256,
          artifactPath: '/lab/1FS0.bcif',
          format: 'binary-cif',
        },
        structureViewIdentity: {
          schemaVersion: 1,
          structureViewId,
          bindingId: null,
        },
      },
      '1FS0.bcif'
    );
    useCanvasStore.getState().openTab('main', {
      type: 'structure',
      entityId: structureViewId,
      label: '1FS0.bcif',
    });

    await expect(handleMolListStructures()).resolves.toMatchObject({
      ok: true,
      structures: [
        {
          registrationId: structureViewId,
          structureId,
          structureViewId,
          bindingId: null,
          viewerId: structureId,
          label: '1FS0.bcif',
          source: 'file',
          sourceId: null,
          coordinateArtifact: {
            entityId: 'catalog-1',
            revisionId: `structure-coordinate:file:v1:${coordinateDigestSha256}`,
            coordinateDigestSha256,
            format: 'binary-cif',
          },
        },
      ],
    });
  });

  it('requires one explicit logical target for mutations and rejects conflicting target ids', () => {
    expect(
      molSetColorSchema.safeParse({ bindingId: 'binding:a', colorMode: 'chain' }).success
    ).toBe(true);
    expect(
      molSetColorSchema.safeParse({ structureViewId: 'view:a', colorMode: 'chain' }).success
    ).toBe(true);
    expect(molSetColorSchema.safeParse({ colorMode: 'chain' }).success).toBe(false);
    expect(
      molSetColorSchema.safeParse({
        structureViewId: 'view:a',
        viewerId: 'legacy:a',
        colorMode: 'chain',
      }).success
    ).toBe(false);
    expect(molGetStateSchema.safeParse({}).success).toBe(true);
    expect(
      molGetStateSchema.safeParse({ bindingId: 'binding:a', viewerId: 'legacy:a' }).success
    ).toBe(false);
  });

  it('only accepts shipped representation controls from MCP automation', () => {
    expect([...MOLSTAR_MCP_REPRESENTATION_RECIPE_IDS]).toEqual([
      'cartoon',
      'ball-and-stick',
      'spacefill',
      'surface',
      'illustrative',
      'hybrid',
      'query-in-complex',
      'query-in-complex-surface',
      'assembly-overview',
    ]);
    for (const shippedRecipeId of MOLSTAR_MCP_REPRESENTATION_RECIPE_IDS) {
      expect(
        molSetRepresentationSchema.safeParse({
          viewerId: AF_VIEWER_ID,
          representation: shippedRecipeId,
        }).success
      ).toBe(true);
    }
    for (const removedPreset of [
      'surface-detail',
      'atomic-detail',
      'confidence',
      'focus-in-context',
      'interface',
      'ligand-site',
    ]) {
      expect(
        molSetRepresentationSchema.safeParse({
          viewerId: AF_VIEWER_ID,
          representation: removedPreset,
        }).success
      ).toBe(false);
    }
  });

  it('only accepts explicit side-chain visualization targets from MCP automation', () => {
    expect(
      molSetSideChainsSchema.safeParse({
        viewerId: AF_VIEWER_ID,
        target: 'visible_backbones',
        visible: true,
      }).success
    ).toBe(true);
    expect(
      molSetSideChainsSchema.safeParse({
        viewerId: AF_VIEWER_ID,
        target: 'selection',
        visible: false,
      }).success
    ).toBe(true);
    expect(
      molSetSideChainsSchema.safeParse({
        viewerId: AF_VIEWER_ID,
        target: 'all_atoms',
        visible: true,
      }).success
    ).toBe(false);
  });

  it('rejects missing PDB ids with a typed not-found error before opening a tab', async () => {
    vi.mocked(fetchStructureData).mockRejectedValueOnce({
      code: 'NOT_FOUND',
      statusCode: 404,
      message: 'PDB id not found',
    });

    await expect(
      handleMolOpenTab({
        structure: { kind: 'pdb', pdbId: '9xyz' },
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'PDB_NOT_FOUND',
      retriable: false,
    });
    expect(useStructure3dStore.getState().expandedStructures).toEqual({});
  });

  it('rejects missing UniProt accessions with a typed not-found error before opening a tab', async () => {
    vi.mocked(validateAlphaFoldId).mockResolvedValueOnce({ valid: false });

    await expect(
      handleMolOpenTab({
        structure: { kind: 'uniprot', accession: 'P0MISS' },
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'UNIPROT_NOT_FOUND',
      retriable: false,
    });
    expect(useStructure3dStore.getState().expandedStructures).toEqual({});
  });

  it('rejects structure URLs outside the allowlist', async () => {
    await expect(
      handleMolOpenTab({
        structure: { kind: 'url', url: 'https://example.com/model.cif' },
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'URL_NOT_ALLOWED',
    });
  });

  it('allows ModelArchive structure URLs from the plan allowlist', async () => {
    const result = await handleMolOpenTab({
      structure: { kind: 'url', url: 'https://modelarchive.org/ma-bak-cepc-0003.cif' },
    });

    expect(result).toMatchObject({
      ok: true,
      viewerId: 'url:https://modelarchive.org/ma-bak-cepc-0003.cif',
      source: { kind: 'url', url: 'https://modelarchive.org/ma-bak-cepc-0003.cif' },
    });
  });

  it('does not echo inline structure data in the open-tab response', async () => {
    const pdbData = 'HEADER    INLINE TEST\nEND\n';
    const result = await handleMolOpenTab({
      structure: { kind: 'data', format: 'pdb', data: pdbData },
    });

    expect(result).toMatchObject({
      ok: true,
      source: {
        kind: 'data',
        format: 'pdb',
        byteLength: pdbData.length,
      },
    });
    expect(JSON.stringify(result)).not.toContain(pdbData);
    expect(fetchStructureData).not.toHaveBeenCalled();
  });

  it('does not echo inline structure data when listing registered structures', async () => {
    const pdbData = 'HEADER    INLINE TEST\nATOM      1  N   MET A   1\nEND\n';
    await handleMolOpenTab({
      structure: { kind: 'data', format: 'pdb', data: pdbData },
      label: 'Inline structure',
    });

    const listed = await handleMolListStructures();

    expect(JSON.stringify(listed)).not.toContain(pdbData);
    expect(listed.structures).toEqual([
      expect.objectContaining({
        label: 'Inline structure',
        source: 'file',
        sourceId: null,
      }),
    ]);
  });

  it('does not expose or control a historical registration after its last structure tab closes', async () => {
    await handleMolOpenTab({ structure: { kind: 'pdb', pdbId: '1tup' } });

    useCanvasStore.setState({
      panels: { main: { id: 'main', tabs: [], activeTabId: null } },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
    });

    expect(useStructure3dStore.getState().expandedStructures[PDB_VIEWER_ID]).toBeDefined();
    await expect(handleMolListStructures()).resolves.toEqual({ ok: true, structures: [] });
    await expect(
      handleMolSetColor({ viewerId: PDB_VIEWER_ID, colorMode: 'chain' })
    ).resolves.toMatchObject({
      ok: false,
      code: 'VIEWER_NOT_FOUND',
    });
  });

  it('does not control an inactive saved view through another tab with the same coordinates', async () => {
    const first = 'saved-view:first';
    const second = 'saved-view:second';
    const artifact = {
      structureId: 'shared-coordinate-resource',
      entityId: 'shared-coordinate-resource',
      revisionId: 'revision-1',
      coordinateDigestSha256: 'a'.repeat(64),
      format: 'mmcif' as const,
    };
    const canvas = useCanvasStore.getState();
    const firstTabId = canvas.openTab('main', {
      type: 'structure',
      entityId: first,
      label: 'First saved view',
      initialStructureAttrs: {
        source: 'file',
        structureArtifactRef: artifact,
        molViewSpec: '{"first":true}',
      },
    });
    canvas.openTab('main', {
      type: 'structure',
      entityId: second,
      label: 'Second saved view',
      initialStructureAttrs: {
        source: 'file',
        structureArtifactRef: artifact,
        molViewSpec: '{"second":true}',
      },
    });
    useStructure3dStore
      .getState()
      .registerStructure(
        first,
        { source: 'file', structureArtifactRef: artifact, molViewSpec: '{"first":true}' },
        'First saved view'
      );
    useStructure3dStore
      .getState()
      .registerStructure(
        second,
        { source: 'file', structureArtifactRef: artifact, molViewSpec: '{"second":true}' },
        'Second saved view'
      );

    const listed = await handleMolListStructures();
    expect(listed.structures.find((item) => item.structureViewId === first)?.viewerStatus).toBe(
      'inactive'
    );
    expect(await handleMolGetScene({ structureViewId: first })).toMatchObject({
      ok: false,
      code: 'VIEW_NOT_ACTIVE',
      error: expect.stringContaining('mol_activate_view'),
    });
    expect(
      await handleMolApplyScene({ structureViewId: first, scene: '{"changed":true}' })
    ).toMatchObject({
      ok: false,
      code: 'VIEW_NOT_ACTIVE',
      stateChanged: false,
    });
    expect(useStructure3dStore.getState().expandedStructures[first].data.molViewSpec).toBe(
      '{"first":true}'
    );

    expect(await handleMolActivateView({ structureViewId: first })).toMatchObject({
      ok: true,
      structureViewId: first,
      tabId: firstTabId,
    });
    expect(useCanvasStore.getState().panels.main.activeTabId).toBe(firstTabId);
    expect(await handleMolGetScene({ structureViewId: second })).toMatchObject({
      ok: false,
      code: 'VIEW_NOT_ACTIVE',
    });
    expect(await handleMolActivateView({ structureViewId: 'saved-view:absent' })).toMatchObject({
      ok: false,
      code: 'VIEWER_NOT_FOUND',
    });
  });
});

async function handleMolListStructures(...args: Parameters<typeof executeMolListStructures>) {
  const result = await executeMolListStructures(...args);
  if (result.ok) assertMcpOutput(molListStructuresOutputSchema, result);
  return result;
}

async function handleMolGetScene(...args: Parameters<typeof executeMolGetScene>) {
  const result = await executeMolGetScene(...args);
  if (result.ok) assertMcpOutput(molGetSceneOutputSchema, result);
  return result;
}

async function handleMolApplyScene(...args: Parameters<typeof executeMolApplyScene>) {
  const result = await executeMolApplyScene(...args);
  if (result.ok) assertMcpOutput(molApplySceneOutputSchema, result);
  return result;
}

async function handleMolActivateView(...args: Parameters<typeof executeMolActivateView>) {
  const result = await executeMolActivateView(...args);
  if (result.ok) assertMcpOutput(molActivateViewOutputSchema, result);
  return result;
}

async function handleMolOpenTab(...args: Parameters<typeof executeMolOpenTab>) {
  const result = await executeMolOpenTab(...args);
  if (result.ok) assertMcpOutput(molOpenTabOutputSchema, result);
  return result;
}

async function handleMolSetColor(...args: Parameters<typeof executeMolSetColor>) {
  const result = await executeMolSetColor(...args);
  if (result.ok) assertMcpOutput(molSetColorOutputSchema, result);
  return result;
}

async function handleMolSetRepresentation(...args: Parameters<typeof executeMolSetRepresentation>) {
  const result = await executeMolSetRepresentation(...args);
  if (result.ok) assertMcpOutput(molSetRepresentationOutputSchema, result);
  return result;
}

async function handleMolSetSideChains(...args: Parameters<typeof executeMolSetSideChains>) {
  const result = await executeMolSetSideChains(...args);
  if (result.ok) assertMcpOutput(molSetSideChainsOutputSchema, result);
  return result;
}
