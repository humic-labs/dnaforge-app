import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceFolder } from '../../stores/workspaceStore';

const { mockPlatform, mockGetCurrentCatalogFileForEntity } = vi.hoisted(() => ({
  mockPlatform: {
    fs: {
      readTextFile: vi.fn(),
      stat: vi.fn(),
    },
    workspace: {
      discoverArtifacts: vi.fn(async () => ({ entityArtifactPaths: [] })),
    },
  },
  mockGetCurrentCatalogFileForEntity: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => mockPlatform,
  initPlatform: vi.fn().mockResolvedValue(mockPlatform),
}));

vi.mock('../../db/workspace-catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/workspace-catalog')>();
  return {
    ...actual,
    getCurrentCatalogFileForEntity: mockGetCurrentCatalogFileForEntity,

    getCurrentSequenceFileForDocumentId: mockGetCurrentCatalogFileForEntity,
    getCatalogEntity: vi.fn().mockResolvedValue(null),
  };
});

vi.mock('../page/embeds/structure3d/utils/structureData', () => ({
  fetchStructureData: vi.fn(async () => ({ data: 'mock_structure', format: 'mmcif' })),
  fetchStructureFromUrl: vi.fn(async () => ({ data: 'mock_structure', format: 'mmcif' })),
  structureFetchIdentityCacheIdentity: vi.fn(
    (identity: { provider: 'rcsb' | 'alphafold'; externalId: string; format?: string }) =>
      identity.format === 'pdb' ? `${identity.externalId}:pdb` : identity.externalId
  ),
}));

vi.mock('../page/public/embeds/structure3d/api/structure-service-client', () => ({
  validateAlphaFoldId: vi.fn(async (accession: string) => ({
    valid: true,
    providerIdentityKey: `AF:${accession.toUpperCase()}:F1:V6:MODEL:AF-${accession.toUpperCase()}-F1-model_v6`,
    latestVersion: 6,
    fragment: 'F1',
    modelId: `AF-${accession.toUpperCase()}-F1-model_v6`,
  })),
}));

vi.mock('molstar/lib/mol-script/transpilers/pymol/parser', () => ({
  transpiler: vi.fn((source: string) => ({ source })),
}));

vi.mock('molstar/lib/mol-script/script', () => ({
  Script: {
    getStructureSelection: vi.fn((expression: unknown, structure: unknown) => ({
      expression,
      structure,
    })),
  },
}));

vi.mock('../page/public/embeds/structure3d/molstar/molViewSpec', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../page/public/embeds/structure3d/molstar/molViewSpec')
  >()),
  getMolViewSpecScene: vi.fn(() => ({
    native: {
      colorSelectionGuidance: 'The harness scene contains no color-layer selections.',
      camera: null,
      componentRefs: [],
      components: [],
      molecularConnections: [],
      molecularConnectionSummary: {
        total: 0,
        attachmentCount: 0,
        incompleteAttachmentCount: 0,
        countsByKind: {},
        countsByStatus: {},
        page: { query: {}, offset: 0, limit: 32, matched: 0, returned: 0, nextOffset: null },
        guidance: 'The harness scene contains no molecular connections.',
      },
    },
    renderProfile: { selection: 'default', resolvedProfile: 'native' },
  })),
}));

vi.mock('molstar/lib/mol-model/structure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('molstar/lib/mol-model/structure')>();
  return {
    ...actual,
    StructureSelection: {
      ...actual.StructureSelection,
      toLociWithSourceUnits: vi.fn(() => ({ kind: 'harness-loci' })),
    },
  };
});

vi.mock('molstar/lib/mol-model/loci', async (importOriginal) => {
  const actual = await importOriginal<typeof import('molstar/lib/mol-model/loci')>();
  return {
    ...actual,
    Loci: {
      ...actual.Loci,
      isEmpty: vi.fn((loci: { empty?: boolean } | null | undefined) => loci?.empty === true),
    },
  };
});

import { StructureSelection } from 'molstar/lib/mol-model/structure';
import { useCanvasStore } from '../canvas/store';
import { useStructureDrawerStore } from '../structure-drawer';
import { productionStructureResolver } from '../structure-drawer/api/production-structure-resolver';
import { useStructure3dStore } from '../page/embeds/structure3d/store';
import { fetchStructureData } from '../page/embeds/structure3d/utils/structureData';
import {
  clearViewerCache,
  getViewerCacheKey,
  getPaneRendererHostCacheKey,
  registerActiveWrapper,
  viewerCache,
  type CachedViewer,
  type MolstarPlugin,
} from '../page/embeds/structure3d/viewerCache';
import {
  callRendererTool,
  type RendererAuditRecord,
  type RendererAuditSink,
  type RendererBridgeContext,
  type RendererToolCallResponse,
} from './renderer-bridge';
import { ALLOWED_RENDERER_TOOLS, type RendererToolName } from './renderer-tools';

const WORKSPACE = '/home/user/lab';
const SEQUENCE_SOURCE_PATH = `${WORKSPACE}/plasmids/harness.gb`;
const SEQUENCE_DOCUMENT_ID = 'sequence-document-harness';
const folders: WorkspaceFolder[] = [{ name: 'lab', path: WORKSPACE, addedAt: 1 }];
const PDB_VIEWER_ID = 'provider:RCSB:1TUP:ENTRY';
const AF_VIEWER_ID = 'provider:AF:P0AD86:F1:V6:MODEL:AF-P0AD86-F1-model_v6';
function makeAuditSink(): { sink: RendererAuditSink; records: RendererAuditRecord[] } {
  const records: RendererAuditRecord[] = [];
  const sink: RendererAuditSink = {
    write: vi.fn(async (record) => {
      records.push(record);
      return `harness-audit-${records.length}`;
    }),
  };
  return { sink, records };
}

function finalAuditRecords(records: RendererAuditRecord[]): RendererAuditRecord[] {
  return records.filter((record) => record.status !== 'accepted');
}

function capabilitiesFor(toolName: RendererToolName): string[] {
  return [
    ...ALLOWED_RENDERER_TOOLS[toolName].required_capabilities,
    ...(toolName === 'mol_open_tab' ? ['external-fetch:structure'] : []),
  ];
}

let actionCounter = 0;

async function runTool(
  toolName: RendererToolName,
  args: unknown,
  auditSink: RendererAuditSink,
  contextOverrides: Partial<RendererBridgeContext> = {}
): Promise<RendererToolCallResponse> {
  actionCounter += 1;
  return callRendererTool(
    {
      tool_name: toolName,
      args,
      agent_identity: 'fixture-harness',
      action_id: `fixture-harness-${actionCounter}-${toolName}`,
    },
    {
      folders,
      agentCapabilities: capabilitiesFor(toolName),
      auditSink,
      ...contextOverrides,
    }
  );
}

function expectSuccess<T = unknown>(response: RendererToolCallResponse): T {
  expect(response.ok, JSON.stringify(response, null, 2)).toBe(true);
  if (!response.ok) throw new Error(`Expected success, got ${response.error.code}`);
  return response.result as T;
}

function expectFailure(response: RendererToolCallResponse) {
  expect(response.ok, JSON.stringify(response, null, 2)).toBe(false);
  if (response.ok) throw new Error('Expected failure');
  return response.error;
}

function resetHarnessState(): void {
  actionCounter = 0;
  clearViewerCache();
  document.body.replaceChildren();
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
  useStructureDrawerStore.getState().setResolver(productionStructureResolver);
  useStructureDrawerStore.setState({
    requestId: 0,
    request: null,
    status: 'idle',
    resolved: null,
    cacheHit: false,
    error: null,
    abortController: null,
    currentStep: null,
  });
}

function setupGenBankMocks(): void {
  mockGetCurrentCatalogFileForEntity.mockResolvedValue({
    id: 'binding-harness',
    entity_id: SEQUENCE_DOCUMENT_ID,
    workspace_id: 1,
    path: SEQUENCE_SOURCE_PATH,
    relative_path: 'plasmids/harness.gb',
    file_kind: 'genbank',
    content_hash: null,
    object_uuid: null,
    size_bytes: 2048,
    modified_at: null,
    status: 'current',
    last_seen_at: null,
    missing_since: null,
    created_at: 1,
    updated_at: 1,
  });
  mockPlatform.fs.stat.mockResolvedValue({ size: 2048 });
  mockPlatform.fs.readTextFile.mockResolvedValue(
    [
      'LOCUS       harness              90 bp    DNA     linear   SYN 01-JAN-2026',
      'DEFINITION  harness.',
      'FEATURES             Location/Qualifiers',
      '     CDS             1..66',
      '                     /label="thrL"',
      '                     /translation="MKRISTTITTTITITTGNGAG"',
      '                     /db_xref="UniProtKB/Swiss-Prot:P0AD86"',
      '                     /db_xref="PDB:1TUP"',
      '                     /locus_tag="b0001"',
      '                     /gene="thrL"',
      '     promoter        70..90',
      '                     /label="promoter"',
      'ORIGIN',
      `        1 ${'ATG'.repeat(30)}`,
      '//',
    ].join('\n')
  );
}

function openSequenceTab(): void {
  useCanvasStore.getState().openTab('main', {
    type: 'sequence',
    entityId: SEQUENCE_DOCUMENT_ID,
    label: 'harness.gb',
    sequenceDocument: { kind: 'catalog-sequence', entityId: SEQUENCE_DOCUMENT_ID },
  });
}

function seedActiveMolstarViewer(
  viewerId: string,
  options: { cacheKey?: string; initialSelectedUnitIndices?: number[] } = {}
) {
  let selectionEntries: Array<{
    selection: { elements: Array<{ unit: unknown; indices: number[] }> };
  }> = [];
  const deselectAll = vi.fn(() => {
    selectionEntries = [];
  });
  const setFromLoci = vi.fn();
  const focusLoci = vi.fn(async () => undefined);
  const getImageDataUri = vi.fn(async () => 'data:image/png;base64,iVBORw0KGgo=');
  const getSnapshot = vi.fn(() => ({
    mode: 'perspective',
    fov: Math.PI / 4,
    radiusMax: 20,
    fog: 50,
    clipFar: true,
    minNear: 1,
    minFar: 0,
    position: [1, 2, 3],
    target: [0, 0, 0],
    up: [0, 1, 0],
    radius: 10,
  }));
  const getSizeAndViewport = vi.fn(() => ({
    width: 2048,
    height: 1024,
    viewport: { x: 0, y: 0, width: 2048, height: 1024 },
  }));
  let screenshotValues = {
    resolution: { name: 'viewport', params: {} },
    format: { name: 'png', params: {} },
  };
  const screenshotValuesNext = vi.fn((next: typeof screenshotValues) => {
    screenshotValues = next;
  });
  const structureData = {
    units: [
      {
        id: 1,
        elements: [0, 1],
        chainIndex: { 0: 0, 1: 0 },
        residueIndex: { 0: 0, 1: 1 },
        conformation: { operator: { name: '1_555' } },
        model: {
          atomicHierarchy: {
            chains: {
              label_asym_id: { value: () => 'A' },
              auth_asym_id: { value: () => 'A' },
            },
            residues: {
              auth_seq_id: { value: (idx: number) => idx + 1 },
              label_seq_id: { value: (idx: number) => idx + 1 },
            },
            atoms: {
              label_comp_id: { value: (idx: number) => (idx === 0 ? 'ALA' : 'GLY') },
              B_iso_or_equiv: { value: () => 90 },
            },
          },
        },
      },
    ],
  };
  const selectionEntryForIndices = (indices: number[]) => ({
    selection: {
      elements: [{ unit: structureData.units[0], indices }],
    },
  });
  if (options.initialSelectedUnitIndices) {
    selectionEntries = [selectionEntryForIndices(options.initialSelectedUnitIndices)];
  }
  const select = vi.fn(() => {
    selectionEntries = [selectionEntryForIndices([0, 1])];
  });
  const plugin = {
    canvas3d: { camera: { getSnapshot }, commit: vi.fn() },
    helpers: {
      viewportScreenshot: {
        get values() {
          return screenshotValues;
        },
        behaviors: { values: { next: screenshotValuesNext } },
        getSizeAndViewport,
        getImageDataUri,
      },
    },
    managers: {
      structure: {
        hierarchy: {
          current: {
            structures: [{ cell: { obj: { data: structureData } } }],
          },
        },
        focus: { setFromLoci },
        selection: {
          entries: {
            forEach: (
              callback: (entry: {
                selection: { elements: Array<{ unit: unknown; indices: number[] }> };
              }) => void
            ) => selectionEntries.forEach(callback),
          },
          elementCount: vi.fn(() =>
            selectionEntries.reduce(
              (sum, entry) =>
                sum +
                entry.selection.elements.reduce(
                  (elementSum, element) => elementSum + element.indices.length,
                  0
                ),
              0
            )
          ),
          stats: {
            get label() {
              const count = selectionEntries.reduce(
                (sum, entry) =>
                  sum +
                  entry.selection.elements.reduce(
                    (elementSum, element) => elementSum + element.indices.length,
                    0
                  ),
                0
              );
              return `${count} atom${count === 1 ? '' : 's'}`;
            },
          },
        },
      },
      camera: { focusLoci },
      interactivity: { lociSelects: { deselectAll, select } },
    },
  } as unknown as MolstarPlugin;
  const wrapper = document.createElement('div');
  wrapper.dataset.structureAgentHost = viewerId;
  const container = document.createElement('div');
  document.body.appendChild(wrapper);
  wrapper.appendChild(container);
  const cached: CachedViewer = {
    container,
    plugin,
    isLoading: false,
    error: null,
    lastUsed: Date.now(),
  };
  const panel = Object.values(useCanvasStore.getState().panels).find((item) =>
    item.tabs.some((tab) => tab.type === 'structure' && tab.entityId === viewerId)
  );
  const cacheKey =
    options.cacheKey ??
    (panel ? getPaneRendererHostCacheKey(`pane:${panel.id}`, 'loaded') : viewerId);
  viewerCache.set(cacheKey, cached);
  registerActiveWrapper(viewerId, wrapper, plugin, cacheKey);
  return {
    select,
    deselectAll,
    setFromLoci,
    focusLoci,
    getImageDataUri,
    getSnapshot,
    getSizeAndViewport,
    screenshotValuesNext,
  };
}

describe(' Molstar MCP harness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetHarnessState();
    setupGenBankMocks();
  });

  it('reports an accepted file tab before its renderer mounts and expires its handle on close', async () => {
    const { sink } = makeAuditSink();
    const canvas = useCanvasStore.getState();
    const structureViewId = 'structure-view:file:v1:fixture';
    const file = {
      type: 'structure' as const,
      entityId: structureViewId,
      label: 'Coordinate fixture',
      initialStructureAttrs: {
        source: 'file' as const,
        sourceId: 'data_fixture',
        structureViewIdentity: { schemaVersion: 1 as const, structureViewId, bindingId: null },
      },
    };
    const tabId = canvas.openTab('main', file);
    const viewHandle = `structure-tab:${tabId}`;

    expect(expectSuccess(await runTool('mol_list_structures', {}, sink))).toMatchObject({
      structures: [{ structureViewId, viewHandle, viewerStatus: 'loading' }],
    });
    expect(expectSuccess(await runTool('mol_get_state', { viewHandle }, sink))).toMatchObject({
      structures: [{ structureViewId, viewHandle, viewerStatus: 'loading' }],
    });
    expect(
      expectFailure(await runTool('mol_capture_screenshot', { viewHandle }, sink))
    ).toMatchObject({ code: 'PLUGIN_NOT_READY', retriable: true });

    canvas.closeTab('main', tabId);
    expect(expectFailure(await runTool('mol_get_state', { viewHandle }, sink))).toMatchObject({
      code: 'VIEW_CLOSED',
      retriable: false,
    });
    const reopenedTabId = canvas.openTab('main', file);
    expect(reopenedTabId).not.toBe(tabId);
    expect(
      expectSuccess(await runTool('mol_get_state', { structureViewId }, sink))
    ).toMatchObject({
      structures: [{ structureViewId, viewHandle: `structure-tab:${reopenedTabId}` }],
    });
    expect(
      expectFailure(await runTool('mol_capture_screenshot', { viewHandle }, sink))
    ).toMatchObject({ code: 'VIEW_CLOSED', retriable: false });
  });

  it('completes standalone structure tab management through the renderer bridge', async () => {
    const { sink, records } = makeAuditSink();

    const openResult = expectSuccess<{ viewerId: string; tabId: string }>(
      await runTool(
        'mol_open_tab',
        { structure: { kind: 'pdb', pdbId: '1tup' }, label: 'p53 core domain' },
        sink
      )
    );
    expect(openResult.viewerId).toBe(PDB_VIEWER_ID);
    expect(openResult.tabId).toBeTruthy();

    const listResult = expectSuccess<{ structures: Array<{ viewerId: string }> }>(
      await runTool('mol_list_structures', {}, sink)
    );
    expect(listResult.structures).toEqual([
      expect.objectContaining({ viewerId: PDB_VIEWER_ID, label: 'p53 core domain' }),
    ]);

    expectSuccess(
      await runTool(
        'mol_set_representation',
        { viewerId: PDB_VIEWER_ID, representation: 'illustrative' },
        sink
      )
    );
    expectSuccess(
      await runTool('mol_set_color', { viewerId: PDB_VIEWER_ID, colorMode: 'bfactor' }, sink)
    );

    const stateResult = expectSuccess<{
      structures: Array<{ viewerId: string; representation: string; colorMode: string }>;
    }>(await runTool('mol_get_state', { viewerId: PDB_VIEWER_ID }, sink));
    expect(stateResult.structures).toEqual([
      expect.objectContaining({
        viewerId: PDB_VIEWER_ID,
        representation: 'illustrative',
        colorMode: 'bfactor',
      }),
    ]);

    expect(finalAuditRecords(records)).toHaveLength(5);
    expect(finalAuditRecords(records).every((record) => record.status === 'completed')).toBe(true);
    expect(finalAuditRecords(records).map((record) => record.tool_name)).toEqual([
      'mol_open_tab',
      'mol_list_structures',
      'mol_set_representation',
      'mol_set_color',
      'mol_get_state',
    ]);
  });

  it('rejects structure-opening renderer tools without external structure fetch scope', async () => {
    const { sink, records } = makeAuditSink();

    const openTabFailure = expectFailure(
      await runTool('mol_open_tab', { structure: { kind: 'pdb', pdbId: '1tup' } }, sink, {
        agentCapabilities: ['modify-tabs'],
      })
    );
    expect(openTabFailure).toMatchObject({
      code: 'INSUFFICIENT_SCOPE',
      domain: 'core',
      retriable: false,
      details: {
        required: expect.arrayContaining(['modify-tabs', 'external-fetch:structure']),
        provided: ['modify-tabs'],
      },
    });

    const drawerFailure = expectFailure(
      await runTool(
        'mol_open_drawer',
        { documentId: SEQUENCE_DOCUMENT_ID, annotationIndex: 0 },
        sink,
        { agentCapabilities: ['read-sequences', 'modify-tabs'] }
      )
    );
    expect(drawerFailure).toMatchObject({
      code: 'INSUFFICIENT_SCOPE',
      domain: 'core',
      retriable: false,
      details: {
        required: expect.arrayContaining([
          'read-sequences',
          'modify-tabs',
          'external-fetch:structure',
        ]),
        provided: ['read-sequences', 'modify-tabs'],
      },
    });
    expect(useStructure3dStore.getState().expandedStructures).toEqual({});
    expect(
      finalAuditRecords(records).map((record) => [
        record.tool_name,
        record.status,
        record.error?.code,
      ])
    ).toEqual([
      ['mol_open_tab', 'rejected', 'INSUFFICIENT_SCOPE'],
      ['mol_open_drawer', 'rejected', 'INSUFFICIENT_SCOPE'],
    ]);
  });

  it('rejects external.xref without xref-resolution scope', async () => {
    const { sink, records } = makeAuditSink();

    const failure = expectFailure(
      await runTool('external.xref', { provider: 'uniprot', external_id: 'P00875' }, sink, {
        agentCapabilities: ['external-fetch:annotation'],
      })
    );

    expect(failure).toMatchObject({
      code: 'INSUFFICIENT_SCOPE',
      domain: 'core',
      retriable: false,
      details: {
        required: ['external-fetch:xref-resolution'],
        provided: ['external-fetch:annotation'],
      },
    });
    expect(
      finalAuditRecords(records).map((record) => [
        record.tool_name,
        record.status,
        record.error?.code,
      ])
    ).toEqual([['external.xref', 'rejected', 'INSUFFICIENT_SCOPE']]);
  });

  it('cancels mol_open_tab preflight without registering a structure or tab', async () => {
    const { sink, records } = makeAuditSink();
    const controller = new AbortController();
    let preflightStarted!: () => void;
    const preflightStartedPromise = new Promise<void>((resolve) => {
      preflightStarted = resolve;
    });
    vi.mocked(fetchStructureData).mockImplementationOnce(
      (_id, _provider, signal) =>
        new Promise<never>((_resolve, reject) => {
          preflightStarted();
          signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('Structure preflight canceled');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true }
          );
        })
    );

    const responsePromise = runTool(
      'mol_open_tab',
      { structure: { kind: 'pdb', pdbId: '1tup' } },
      sink,
      { abortSignal: controller.signal }
    );
    await preflightStartedPromise;
    controller.abort();

    const failure = expectFailure(await responsePromise);

    expect(failure).toMatchObject({
      code: 'CANCELED',
      domain: 'core',
      retriable: false,
    });
    expect(useStructure3dStore.getState().expandedStructures).toEqual({});
    expect(useCanvasStore.getState().panels.main.tabs).toEqual([]);
    expect(
      finalAuditRecords(records).map((record) => [
        record.tool_name,
        record.status,
        record.error?.code,
      ])
    ).toEqual([['mol_open_tab', 'failed', 'CANCELED']]);
  });

  it('completes active viewer selection, focus, and screenshot image payload flow', async () => {
    const { sink, records } = makeAuditSink();
    expectSuccess(
      await runTool('mol_open_tab', { structure: { kind: 'uniprot', accession: 'P0AD86' } }, sink)
    );
    const pluginCalls = seedActiveMolstarViewer(AF_VIEWER_ID);

    expectSuccess(
      await runTool(
        'mol_select_residues',
        { viewerId: AF_VIEWER_ID, selection: 'chain A and resi 1-5' },
        sink
      )
    );
    expect(pluginCalls.deselectAll).toHaveBeenCalledOnce();
    expect(pluginCalls.select).toHaveBeenCalledWith({ loci: { kind: 'harness-loci' } });

    const stateResult = expectSuccess<{
      structures: Array<{
        viewerStatus: string;
        currentSelection: {
          selection: null;
          lastMcpSelectionExpression: string | null;
          molstarSelectedResidues: Array<{
            chain: string;
            position: number;
            compId: string;
            selectedAtomCount: number;
            totalResidueAtomCount: number;
            labelAsymId?: string;
            authAsymId?: string;
          }>;
          molstarElementCount: number | null;
          molstarStatsLabel: string | null;
        };
        camera: unknown;
        chains: Array<{ chainId: string; residueRange: { start: number; end: number } }>;
      }>;
    }>(await runTool('mol_get_state', { viewerId: AF_VIEWER_ID, detail: 'full' }, sink));
    expect(stateResult.structures[0], JSON.stringify(stateResult.structures[0])).toMatchObject({
      viewerStatus: 'active',
      currentSelection: {
        selection: null,
        lastMcpSelectionExpression: 'chain A and resi 1-5',
      },
      camera: { radius: 10 },
      chains: [
        {
          chainId: 'A',
          residueRange: { start: 1, end: 2 },
          residueRanges: [{ start: 1, end: 2 }],
        },
      ],
    });
    expect(stateResult.structures[0].currentSelection).toMatchObject({
      selection: null,
      lastMcpSelectionExpression: 'chain A and resi 1-5',
      molstarElementCount: 2,
      molstarStatsLabel: '2 atoms',
      molstarSelectedResidues: [
        {
          chain: 'A',
          labelAsymId: 'A',
          authAsymId: 'A',
          position: 1,
          compId: 'ALA',
          selectedAtomCount: 1,
          totalResidueAtomCount: 1,
        },
        {
          chain: 'A',
          labelAsymId: 'A',
          authAsymId: 'A',
          position: 2,
          compId: 'GLY',
          selectedAtomCount: 1,
          totalResidueAtomCount: 1,
        },
      ],
    });
    expect(pluginCalls.getSnapshot).toHaveBeenCalledOnce();

    expectSuccess(
      await runTool(
        'mol_focus',
        { viewerId: AF_VIEWER_ID, selection: 'chain A and resi 1-5' },
        sink
      )
    );
    expect(pluginCalls.focusLoci).toHaveBeenCalledWith(
      { kind: 'harness-loci' },
      { minRadius: 5, extraRadius: 4, durationMs: 250 }
    );

    const screenshot = expectSuccess<{
      returns_image: boolean;
      data: string;
      mimeType: string;
      viewerId: string;
      byteLength: number;
    }>(await runTool('mol_capture_screenshot', { viewerId: AF_VIEWER_ID }, sink));
    expect(screenshot).toMatchObject({
      returns_image: true,
      data: 'iVBORw0KGgo=',
      mimeType: 'image/png',
      viewerId: AF_VIEWER_ID,
    });
    expect(screenshot.byteLength).toBeGreaterThan(0);
    expect(pluginCalls.getSizeAndViewport).toHaveBeenCalled();
    expect(pluginCalls.screenshotValuesNext).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: { name: 'custom', params: { width: 768, height: 768 } },
      })
    );

    expect(finalAuditRecords(records).map((record) => [record.tool_name, record.status])).toEqual([
      ['mol_open_tab', 'completed'],
      ['mol_select_residues', 'completed'],
      ['mol_get_state', 'completed'],
      ['mol_focus', 'completed'],
      ['mol_capture_screenshot', 'completed'],
    ]);
  });

  it('highlights exact disjoint residues through the audited renderer bridge', async () => {
    const { sink, records } = makeAuditSink();
    expectSuccess(
      await runTool('mol_open_tab', { structure: { kind: 'uniprot', accession: 'P0AD86' } }, sink)
    );
    seedActiveMolstarViewer(AF_VIEWER_ID);

    const result = expectSuccess<{
      ok: boolean;
      highlighted: boolean;
      residueCount: number;
      viewerId: string;
    }>(
      await runTool(
        'highlight_residues',
        {
          structureRef: AF_VIEWER_ID,
          chain: 'A',
          regions: [
            { start: 1, end: 1 },
            { start: 2, end: 2 },
          ],
          label: 'CLI exact residues',
        },
        sink
      )
    );

    expect(result).toMatchObject({
      ok: true,
      highlighted: true,
      residueCount: 2,
      viewerId: AF_VIEWER_ID,
    });
    expect(
      useStructure3dStore.getState().expandedStructures[AF_VIEWER_ID]?.data.highlightGroups
    ).toEqual([
      expect.objectContaining({
        id: `agent-highlight:${AF_VIEWER_ID}`,
        label: 'CLI exact residues',
        selections: [
          {
            chain: 'A',
            ranges: [
              [1, 1],
              [2, 2],
            ],
          },
        ],
      }),
    ]);
    expect(finalAuditRecords(records).map((record) => [record.tool_name, record.status])).toEqual([
      ['mol_open_tab', 'completed'],
      ['highlight_residues', 'completed'],
    ]);
  });

  it('reports live MolStar residue state separately from the last MCP selection expression', async () => {
    const { sink } = makeAuditSink();
    expectSuccess(
      await runTool('mol_open_tab', { structure: { kind: 'uniprot', accession: 'P0AD86' } }, sink)
    );
    const pluginCalls = seedActiveMolstarViewer(AF_VIEWER_ID);

    expectSuccess(
      await runTool(
        'mol_select_residues',
        { viewerId: AF_VIEWER_ID, selection: 'chain A and resi 1-5' },
        sink
      )
    );
    pluginCalls.deselectAll();

    const stateResult = expectSuccess<{
      structures: Array<{
        currentSelection: {
          selection: null;
          lastMcpSelectionExpression: string | null;
          molstarSelectedResidues: Array<unknown>;
          molstarElementCount: number | null;
        };
      }>;
    }>(await runTool('mol_get_state', { viewerId: AF_VIEWER_ID, detail: 'full' }, sink));

    expect(stateResult.structures[0].currentSelection).toEqual(
      expect.objectContaining({
        selection: null,
        lastMcpSelectionExpression: 'chain A and resi 1-5',
        molstarSelectedResidues: [],
        molstarElementCount: 0,
      })
    );
  });

  it('reads MolStar selection from the exact mounted viewer instance for each registered structure', async () => {
    const { sink } = makeAuditSink();
    expectSuccess(
      await runTool('mol_open_tab', { structure: { kind: 'uniprot', accession: 'P0AD86' } }, sink)
    );
    const sourceEntry = useStructure3dStore.getState().expandedStructures[AF_VIEWER_ID];
    const drawerStructureId = 'structure-drawer:protein:AF-P0AD86';
    useStructure3dStore
      .getState()
      .registerStructure(drawerStructureId, sourceEntry.data, 'P0AD86 drawer');

    seedActiveMolstarViewer(AF_VIEWER_ID, {
      initialSelectedUnitIndices: [0],
    });
    seedActiveMolstarViewer(AF_VIEWER_ID, {
      cacheKey: getViewerCacheKey(AF_VIEWER_ID, `structure-panel:${drawerStructureId}`),
      initialSelectedUnitIndices: [1],
    });

    const stateResult = expectSuccess<{
      structures: Array<{
        structureId: string;
        currentSelection: {
          molstarSelectedResidues: Array<{ position: number; compId: string }>;
        };
      }>;
    }>(await runTool('mol_get_state', { detail: 'full' }, sink));
    const byStructureId = new Map(
      stateResult.structures.map((structure) => [structure.structureId, structure])
    );

    expect(
      byStructureId.get(AF_VIEWER_ID)?.currentSelection.molstarSelectedResidues,
      JSON.stringify(stateResult)
    ).toEqual([expect.objectContaining({ position: 1, compId: 'ALA' })]);
    expect(byStructureId.get(drawerStructureId)?.currentSelection.molstarSelectedResidues).toEqual([
      expect.objectContaining({ position: 2, compId: 'GLY' }),
    ]);
  });

  it('downscales and retries screenshots once before failing the response-size limit', async () => {
    const { sink } = makeAuditSink();
    expectSuccess(
      await runTool('mol_open_tab', { structure: { kind: 'uniprot', accession: 'P0AD86' } }, sink)
    );
    const pluginCalls = seedActiveMolstarViewer(AF_VIEWER_ID);
    const largeBase64 = 'A'.repeat(Math.ceil((501 * 1024 * 4) / 3));
    pluginCalls.getImageDataUri
      .mockResolvedValueOnce(`data:image/png;base64,${largeBase64}`)
      .mockResolvedValueOnce('data:image/png;base64,iVBORw0KGgo=');

    const screenshot = expectSuccess<{
      byteLength: number;
      warnings?: string[];
      downscaled: boolean;
      width: number;
      height: number;
    }>(await runTool('mol_capture_screenshot', { viewerId: AF_VIEWER_ID }, sink));

    expect(pluginCalls.getImageDataUri).toHaveBeenCalledTimes(2);
    expect(pluginCalls.screenshotValuesNext).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: { name: 'custom', params: { width: 384, height: 384 } },
      })
    );
    expect(screenshot).toMatchObject({
      warnings: ['Screenshot exceeded 500 KiB; downscaled once.'],
      downscaled: true,
      width: 384,
      height: 384,
    });
    expect(screenshot.byteLength).toBeLessThanOrEqual(500 * 1024);
  });

  it('clears stale active selections when a selection matches zero atoms', async () => {
    const { sink } = makeAuditSink();
    expectSuccess(
      await runTool('mol_open_tab', { structure: { kind: 'uniprot', accession: 'P0AD86' } }, sink)
    );
    const pluginCalls = seedActiveMolstarViewer(AF_VIEWER_ID);

    expectSuccess(
      await runTool(
        'mol_select_residues',
        { viewerId: AF_VIEWER_ID, selection: 'chain A and resi 1-5' },
        sink
      )
    );
    vi.mocked(StructureSelection.toLociWithSourceUnits).mockReturnValueOnce({
      empty: true,
    } as never);

    const emptySelection = expectSuccess<{ warnings: string[] }>(
      await runTool(
        'mol_select_residues',
        { viewerId: AF_VIEWER_ID, selection: 'chain Z and resi 999' },
        sink
      )
    );

    expect(emptySelection.warnings).toEqual(['Selection matched no atoms.']);
    expect(pluginCalls.deselectAll).toHaveBeenCalledTimes(2);
    expect(pluginCalls.select).toHaveBeenCalledTimes(1);
  });

  it('completes sequence annotation discovery and structure drawer resolver flow', async () => {
    const { sink, records } = makeAuditSink();
    openSequenceTab();
    useStructureDrawerStore.getState().setResolver(async (request) => ({
      cacheHit: false,
      result: {
        source: 'uniprot_xref',
        identity: 1,
        structure: { kind: 'uniprot', accession: 'P0AD86' },
        confidenceNote: `CDS ${request.cdsLabel}`,
      },
    }));

    const annotations = expectSuccess<{
      total: number;
      returned: number;
      truncated: boolean;
      hint: string | null;
      matchCount: number;
      annotations: Array<{
        rawIndex: number;
        type: string;
        range: { start: number; end: number };
        locusTag: string | null;
        geneName: string | null;
        dbXrefs: string[];
        qualifiers: Record<string, string[]>;
      }>;
    }>(
      await runTool(
        'seq_list_annotations',
        { documentId: SEQUENCE_DOCUMENT_ID, kind: 'CDS', filter: { locusTag: 'b0001' } },
        sink
      )
    );
    expect(annotations.matchCount).toBe(1);
    expect(annotations).toMatchObject({
      total: 1,
      returned: 1,
      truncated: false,
      hint: null,
    });
    expect(annotations.annotations[0]).toMatchObject({
      rawIndex: 0,
      type: 'CDS',
      range: { start: 1, end: 66 },
      locusTag: 'b0001',
      geneName: 'thrL',
      dbXrefs: ['UniProtKB/Swiss-Prot:P0AD86', 'PDB:1TUP'],
      qualifiers: { locus_tag: ['b0001'] },
    });

    const drawer = expectSuccess<{ status: string; bytesReady: boolean; resolved: unknown }>(
      await runTool(
        'mol_open_drawer',
        {
          documentId: SEQUENCE_DOCUMENT_ID,
          annotationIndex: annotations.annotations[0].rawIndex,
        },
        sink
      )
    );
    expect(drawer.status).toBe('rendering');
    expect(drawer.bytesReady).toBe(true);
    expect(drawer.resolved).toMatchObject({
      source: 'uniprot_xref',
      structure: { kind: 'uniprot', accession: 'P0AD86' },
    });

    const drawerState = useStructureDrawerStore.getState();
    expect(drawerState.request).toMatchObject({
      translation: 'MKRISTTITTTITITTGNGAG',
      cdsLabel: 'thrL',
      entityId: SEQUENCE_DOCUMENT_ID,
      hints: {
        dbXrefs: ['UniProtKB/Swiss-Prot:P0AD86', 'PDB:1TUP'],
        locusTag: 'b0001',
        geneName: 'thrL',
      },
    });
    expect(finalAuditRecords(records).map((record) => [record.tool_name, record.status])).toEqual([
      ['seq_list_annotations', 'completed'],
      ['mol_open_drawer', 'completed'],
    ]);
  });

  it('reports drawer provider failures as retriable provider errors, not no-match', async () => {
    const { sink, records } = makeAuditSink();
    openSequenceTab();
    useStructureDrawerStore.getState().setResolver(async () => {
      throw Object.assign(
        new Error('Structure sidecar provider failure /external/uniprot/by-sequence: HTTP 502'),
        { name: 'SidecarProviderError' }
      );
    });

    const failure = expectFailure(
      await runTool(
        'mol_open_drawer',
        {
          documentId: SEQUENCE_DOCUMENT_ID,
          annotationIndex: 0,
        },
        sink
      )
    );

    expect(failure).toMatchObject({
      code: 'PROVIDER_ERROR',
      domain: 'core',
      retriable: true,
      details: {
        documentId: SEQUENCE_DOCUMENT_ID,
        annotationIndex: 0,
        code: 'provider_error',
      },
    });
    expect(
      finalAuditRecords(records).map((record) => [
        record.tool_name,
        record.status,
        record.error?.code,
      ])
    ).toEqual([['mol_open_drawer', 'failed', 'PROVIDER_ERROR']]);
  });

  it('opens the drawer with the application resolver before any sequence component mounts', async () => {
    const { sink, records } = makeAuditSink();
    expect(useCanvasStore.getState().panels.main.tabs).toEqual([]);
    expect(useStructureDrawerStore.getState()).not.toHaveProperty('_resolver');
    openSequenceTab();
    expect(document.querySelector('[data-testid^="tab-content-container-"]')).toBeNull();

    const drawer = expectSuccess<{ status: string; bytesReady: boolean; resolved: unknown }>(
      await runTool(
        'mol_open_drawer',
        {
          documentId: SEQUENCE_DOCUMENT_ID,
          annotationIndex: 0,
        },
        sink
      )
    );

    expect(drawer).toMatchObject({
      status: 'rendering',
      bytesReady: true,
      resolved: {
        source: 'pdb_xref',
        structure: { kind: 'pdb', pdbId: '1TUP' },
      },
    });
    expect(useStructureDrawerStore.getState().error).toBeNull();
    expect(finalAuditRecords(records).map((record) => [record.tool_name, record.status])).toEqual([
      ['mol_open_drawer', 'completed'],
    ]);
  });

  it('cancels mol_open_drawer resolution and closes the drawer when the tool aborts', async () => {
    const { sink, records } = makeAuditSink();
    openSequenceTab();
    const controller = new AbortController();
    let resolverStarted!: () => void;
    const resolverStartedPromise = new Promise<void>((resolve) => {
      resolverStarted = resolve;
    });
    useStructureDrawerStore.getState().setResolver(
      async (_request, signal) =>
        new Promise((resolve, reject) => {
          resolverStarted();
          signal.addEventListener(
            'abort',
            () => {
              const error = new Error('Resolver canceled');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true }
          );
        })
    );

    const responsePromise = runTool(
      'mol_open_drawer',
      {
        documentId: SEQUENCE_DOCUMENT_ID,
        annotationIndex: 0,
      },
      sink,
      { abortSignal: controller.signal }
    );
    await resolverStartedPromise;
    controller.abort();

    const failure = expectFailure(await responsePromise);

    expect(failure).toMatchObject({
      code: 'CANCELED',
      domain: 'core',
      retriable: false,
    });
    expect(useStructureDrawerStore.getState().status).toBe('idle');
    expect(
      finalAuditRecords(records).map((record) => [
        record.tool_name,
        record.status,
        record.error?.code,
      ])
    ).toEqual([['mol_open_drawer', 'failed', 'CANCELED']]);
  });

  it('fails mol_open_drawer when structure bytes preflight hits a provider outage', async () => {
    const { sink, records } = makeAuditSink();
    openSequenceTab();
    useStructureDrawerStore.getState().setResolver(async () => ({
      cacheHit: false,
      result: {
        source: 'protein_sequence',
        identity: 1,
        structure: {
          kind: 'uniprot',
          accession: 'P0AD86',
          providerIdentityKey: 'AF:P0AD86:F1:LATEST',
          fragment: 'F1',
          version: 'LATEST',
        },
        recommendedCandidateId: 'alphafold:AF:P0AD86:F1:LATEST:all',
        candidates: [],
      },
    }));
    vi.mocked(fetchStructureData).mockRejectedValueOnce(
      Object.assign(
        new Error('Structure sidecar provider failure /external/structure/bytes: HTTP 502'),
        { name: 'SidecarProviderError' }
      )
    );

    const failure = expectFailure(
      await runTool(
        'mol_open_drawer',
        {
          documentId: SEQUENCE_DOCUMENT_ID,
          annotationIndex: 0,
        },
        sink
      )
    );

    expect(failure).toMatchObject({
      code: 'PROVIDER_ERROR',
      domain: 'core',
      retriable: true,
    });
    expect(fetchStructureData).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'alphafold',
        externalId: 'AF:P0AD86:F1:LATEST',
        accession: 'P0AD86',
      }),
      'alphafold'
    );
    expect(
      finalAuditRecords(records).map((record) => [
        record.tool_name,
        record.status,
        record.error?.code,
      ])
    ).toEqual([['mol_open_drawer', 'failed', 'PROVIDER_ERROR']]);
  });

  it('cancels mol_open_drawer byte preflight and closes the drawer cleanly', async () => {
    const { sink, records } = makeAuditSink();
    openSequenceTab();
    const controller = new AbortController();
    let preflightStarted!: () => void;
    const preflightStartedPromise = new Promise<void>((resolve) => {
      preflightStarted = resolve;
    });
    useStructureDrawerStore.getState().setResolver(async () => ({
      cacheHit: false,
      result: {
        source: 'protein_sequence',
        identity: 1,
        structure: {
          kind: 'uniprot',
          accession: 'P0AD86',
          providerIdentityKey: 'AF:P0AD86:F1:LATEST',
          fragment: 'F1',
          version: 'LATEST',
        },
        recommendedCandidateId: 'alphafold:AF:P0AD86:F1:LATEST:all',
        candidates: [],
      },
    }));
    vi.mocked(fetchStructureData).mockImplementationOnce(
      (_id, _provider, signal) =>
        new Promise<never>((_resolve, reject) => {
          preflightStarted();
          signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('Structure preflight canceled');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true }
          );
        })
    );

    const responsePromise = runTool(
      'mol_open_drawer',
      {
        documentId: SEQUENCE_DOCUMENT_ID,
        annotationIndex: 0,
      },
      sink,
      { abortSignal: controller.signal }
    );
    await preflightStartedPromise;
    controller.abort();

    const failure = expectFailure(await responsePromise);

    expect(failure).toMatchObject({
      code: 'CANCELED',
      domain: 'core',
      retriable: false,
    });
    expect(useStructureDrawerStore.getState().status).toBe('idle');
    expect(
      finalAuditRecords(records).map((record) => [
        record.tool_name,
        record.status,
        record.error?.code,
      ])
    ).toEqual([['mol_open_drawer', 'failed', 'CANCELED']]);
  });

  it('fails closed with typed domain errors and audited failed status', async () => {
    const { sink, records } = makeAuditSink();

    const badUrl = expectFailure(
      await runTool(
        'mol_open_tab',
        { structure: { kind: 'url', url: 'https://example.com/a.cif' } },
        sink
      )
    );
    expect(badUrl).toMatchObject({
      code: 'URL_NOT_ALLOWED',
      domain: 'core',
      retriable: false,
    });

    const missingViewer = expectFailure(
      await runTool('mol_capture_screenshot', { viewerId: 'pdb:4040' }, sink)
    );
    expect(missingViewer).toMatchObject({
      code: 'VIEWER_NOT_FOUND',
      domain: 'core',
      retriable: true,
    });

    expect(
      finalAuditRecords(records).map((record) => [
        record.tool_name,
        record.status,
        record.error?.code,
      ])
    ).toEqual([
      ['mol_open_tab', 'failed', 'URL_NOT_ALLOWED'],
      ['mol_capture_screenshot', 'failed', 'VIEWER_NOT_FOUND'],
    ]);
  });
});
