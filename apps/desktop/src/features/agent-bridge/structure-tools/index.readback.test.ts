/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '../../canvas/public/store';
import { useStructure3dStore } from '../../page/public/embeds/structure3d/store';
import {
  ActiveMolstarViewerError,
  getPaneRendererHostCacheKey,
} from '../../page/public/embeds/structure3d/viewerCache';
import { MolViewSpecSceneError } from '../../page/public/embeds/structure3d/molstar/molViewSpec';
import { molecularDocumentOwner } from '../../../shared/molecular-document-owner';
import { molecularDocumentReferenceFor } from '../../../shared/molecular-document-reference';
import {
  molecularDocumentSchema,
  MOLECULAR_DOCUMENT_SCHEMA,
} from '../../../shared/molecular-document';
import { coordinateDigest, type MolecularView } from '../../../shared/molecular-view';
import {
  handleMolGetScene,
  handleMolGetState,
  handleMolListStructures,
  handleMolSaveView,
  handleMolCaptureScreenshot,
  handleMolSelectStoryStep,
} from './index';
import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { pageMolecularConnections } from '../../page/public/embeds/structure3d/molstar/molecularConnectionReadback';
import {
  molGetSceneOutputSchema,
  molGetStateOutputSchema,
  molListStructuresOutputSchema,
  molSaveViewOutputSchema,
  molCaptureScreenshotOutputSchema,
  molSelectStoryStepOutputSchema,
} from './output-schemas';

const savedReferences = vi.hoisted(() => ({ create: vi.fn() }));
import { handleMolSelectResidues } from './index';

const readback = vi.hoisted(() => {
  const a = {
    labelAsymId: 'A',
    authAsymId: 'A',
    authSeqId: 104,
    labelCompId: 'ASN',
    labelAtomId: 'ND2',
    element: 'N',
    instanceId: '1_555',
    atomIndex: 1,
    residueIndex: 1,
    moleculeType: 5,
    polymerType: 1,
    residueSelector: { label_asym_id: 'A', auth_seq_id: 104 },
    coordinateAvailable: true,
    selector: { label_asym_id: 'A', auth_seq_id: 104, label_atom_id: 'ND2' },
  };
  const b = {
    labelAsymId: 'E',
    authAsymId: 'C',
    authSeqId: 1,
    labelCompId: 'NAG',
    labelAtomId: 'C1',
    element: 'C',
    instanceId: '1_555',
    atomIndex: 2,
    residueIndex: 2,
    moleculeType: 1,
    polymerType: 0,
    residueSelector: { label_asym_id: 'E', auth_seq_id: 1 },
    coordinateAvailable: true,
    selector: { label_asym_id: 'E', auth_seq_id: 1, label_atom_id: 'C1' },
  };
  const connection = {
    id: 'covale1',
    structureIndex: 0,
    kind: 'covalent',
    source: 'deposited-struct_conn',
    sourceType: 'covale',
    bondPresent: true,
    attachment: true,
    a,
    b,
  };
  const { atomIndex: _atomIndexA, residueIndex: _residueIndexA, ...publicA } = a;
  const { atomIndex: _atomIndexB, residueIndex: _residueIndexB, ...publicB } = b;
  return {
    inspectionReady: false,
    withPlugin: vi.fn(),
    scene: vi.fn(),
    capture: vi.fn(),
    ready: vi.fn(),
    validateGeometry: vi.fn(),
    acceptSaved: vi.fn(),
    catalogLoad: vi.fn(),
    reference: vi.fn(),
    groups: [] as Array<Record<string, unknown>>,
    connection,
    sceneResult: {
      format: 'mvsj',
      renderProfileGuidance: 'Render defaults',
      supportedMajorVersion: 1,
      limitations: [],
      sceneOrigin: 'authored',
      scene: JSON.stringify({
        kind: 'single',
        root: {
          kind: 'root',
          children: [
            { kind: 'camera', params: { position: [0, 0, 40], target: [0, 0, 0], up: [0, 1, 0] } },
          ],
        },
        metadata: { version: '1', timestamp: '2026-10-21T00:00:00Z' },
      }),
      resource: { uri: 'structure.cif', format: 'mmcif', boundTo: 'current-structure-view' },
      resources: [{ uri: 'structure.cif', format: 'mmcif', boundTo: 'current-structure-view' }],
      renderProfile: { selection: 'native', resolvedProfile: null },
      guidance: 'Native controls are explicit; omitted opacity is opaque.',
      native: {
        colorSelectionGuidance: 'The readback fixture contains no compiled color-layer selections.',
        componentRefs: ['binding-region'],
        camera: {
          position: [0, 0, 40],
          target: [0, 0, 0],
          up: [0, 1, 0],
          mode: 'perspective',
          fov: 1,
          radius: 10,
          radiusMax: 20,
          fog: 50,
          clipFar: true,
          minNear: 1,
          minFar: 1,
        },
        molecularConnectionSummary: {
          total: 1,
          attachmentCount: 1,
          incompleteAttachmentCount: 1,
          countsByKind: { covalent: 1 },
          countsByStatus: { 'missing-attachment-geometry': 1 },
          page: { query: {}, offset: 0, limit: 32, matched: 1, returned: 1, nextOffset: null },
          guidance: 'Page',
        },
        molecularConnections: [
          {
            ...connection,
            a: publicA,
            b: publicB,
            status: 'missing-attachment-geometry',
            representationOwners: [],
          },
        ],
        components: [
          {
            label: 'Binding region',
            elementCount: 26,
            representations: [
              {
                type: 'ball-and-stick',
                color: null,
                visuals: ['element-sphere', 'inter-bond'],
                alpha: 1,
                typeParams: {
                  sizeFactor: 0.6,
                  sizeAspectRatio: 0.5,
                  visuals: ['element-sphere', 'inter-bond'],
                },
                colorTheme: 'element-symbol',
                colorThemeParams: { carbonColor: { name: 'uniform', params: { value: 0xffaa22 } } },
                sizeTheme: { name: 'physical', params: {} },
              },
            ],
          },
        ],
      },
    },
  };
});

vi.mock(
  '../../structure-drawer/public/state/structure-inspection-sessions',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../structure-drawer/public/state/structure-inspection-sessions')
    >()),
    inspectionViewStatus: () => (readback.inspectionReady ? 'ready' : null),
  })
);

vi.mock('../../page/public/embeds/structure3d/viewerCache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../page/public/embeds/structure3d/viewerCache')>()),
  withActivePlugin: (...args: unknown[]) => readback.withPlugin(...args),
}));
vi.mock('../../page/public/embeds/structure3d/molstar/molViewSpec', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../page/public/embeds/structure3d/molstar/molViewSpec')
  >()),
  activeMolViewSpecScene: () => readback.sceneResult.scene,
  sameLoadedMolViewSpecScene: () => true,
  getMolViewSpecScene: () => readback.scene(),
  captureMolViewSpecView: readback.capture,
  waitForMolViewSpecViewReady: readback.ready,
  validateMolViewSpecViewGeometry: readback.validateGeometry,
  selectMolViewSpecSnapshot: async () => ({ index: 1, title: 'Second step' }),
  requireUnchangedMolViewSpecBackground: () => {},
  acceptSavedMolViewSpecView: (...args: unknown[]) => readback.acceptSaved(...args),
}));
vi.mock('../../../db/entity-references', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../db/entity-references')>()),
  getEntityReference: readback.reference,
}));
vi.mock('../../molecular-documents/public/services', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../molecular-documents/public/services')>()),
  inspectMolecularDocumentBinding: vi.fn(async (attrs) => ({
    documentOwner: molecularDocumentOwner(attrs),
    documentReference: attrs.molecularDocumentReference,
  })),
  saveMolecularDocumentSnapshot: (...args: unknown[]) => savedReferences.create(...args),
}));
vi.mock('../../compute/public/molecular-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../compute/public/molecular-catalog')>()),
  loadCatalogStructure: (...args: unknown[]) => readback.catalogLoad(...args),
}));
vi.mock(
  '../../page/public/embeds/structure3d/molstar/molViewSpecSwatchSelection',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../page/public/embeds/structure3d/molstar/molViewSpecSwatchSelection')
    >()),
    nativeMolViewSpecColorGroups: () => readback.groups,
    resolveMolViewSpecColorGroupLociByStructure: () => [
      { loci: { kind: 'element-loci', elements: [] } },
    ],
  })
);

function registerView(structureViewId: string) {
  const attrs = {
    source: 'pdb' as const,
    sourceId: '3TYG',
    pdbId: '3TYG',
    molViewSpec: readback.sceneResult.scene,
    structureViewIdentity: { schemaVersion: 1 as const, structureViewId, bindingId: null },
  };
  useStructure3dStore.getState().registerStructure(structureViewId, attrs, structureViewId);
  return useCanvasStore.getState().openTab('main', {
    type: 'structure',
    entityId: structureViewId,
    label: structureViewId,
    initialStructureAttrs: attrs,
  });
}

function allowSuccessfulCapture() {
  readback.capture.mockReturnValue({
    scene: readback.sceneResult.scene,
    coordinates: { format: 'cif', text: 'controlled coordinates' },
    cameraSnapshot: JSON.stringify(readback.sceneResult.native.camera),
    pinnedAssets: [],
    initialSnapshotIndex: 0,
  });
}

const savedRevisionId = '6cf13483-9489-48cf-85f4-977b84e60a22';
async function savedDocumentResult(snapshot: MolecularView) {
  const document = molecularDocumentSchema.parse({
    schema: MOLECULAR_DOCUMENT_SCHEMA,
    id: 'e00eb626-270d-4bf0-b92f-5b827285559b',
    name: snapshot.title,
    currentReferenceId: savedRevisionId,
    history: [{ referenceId: savedRevisionId, snapshot }],
  });
  const documentReference = await molecularDocumentReferenceFor('readback-workspace', document);
  return {
    document,
    documentReference,
    catalogEntityId: `readback-workspace::${document.id}`,
    path: '/readback-workspace/Saved view.molview.json',
    workspaceRoot: '/readback-workspace',
    revision: 'a'.repeat(64),
    revisionReference: { id: savedRevisionId, data: JSON.stringify(snapshot) },
    reference: { id: 'saved-reference-1' },
  };
}

describe('molecular MCP readback integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readback.inspectionReady = false;
    readback.groups = [];
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
    readback.withPlugin.mockImplementation(async (_id, operation) =>
      operation({
        plugin: {
          helpers: { viewportScreenshot: { getImageDataUri: () => 'data:image/png;base64,YQ==' } },
        },
      })
    );
    savedReferences.create.mockImplementation(savedDocumentResult);
    readback.scene.mockReturnValue(readback.sceneResult);
    readback.capture.mockImplementation(() => {
      throw Object.assign(new Error('Capture boundary reached'), { code: 'TEST_CAPTURE_BOUNDARY' });
    });
    readback.ready.mockResolvedValue(undefined);
    readback.validateGeometry.mockResolvedValue(undefined);
    readback.acceptSaved.mockReturnValue(false);
    readback.reference.mockResolvedValue(null);
    registerView('view-a');
  });

  it('retains native suppressed ionic-coordination evidence through the MCP validator', async () => {
    const projected = pageMolecularConnections([
      {
        ...readback.connection,
        kind: 'metal-coordination',
        source: 'molstar-source-graph',
        attachment: false,
        status: 'suppressed-unsupported-coordination',
        depictionIssue: 'ionic-metal-to-metal',
        representationOwners: [],
      },
    ]);
    readback.scene.mockReturnValueOnce({
      ...readback.sceneResult,
      native: {
        ...readback.sceneResult.native,
        molecularConnections: projected.connections,
        molecularConnectionSummary: projected.summary,
      },
    });
    const scene = await handleMolGetScene({ structureViewId: 'view-a' });
    assertMcpOutput(molGetSceneOutputSchema, scene);
    expect(scene).toMatchObject({
      ok: true,
      native: {
        molecularConnections: [
          {
            status: 'suppressed-unsupported-coordination',
            depictionIssue: 'ionic-metal-to-metal',
          },
        ],
      },
    });
  });

  it('forwards active profile, complete native appearance, and factual connection coverage', async () => {
    const scene = await handleMolGetScene({
      structureViewId: 'view-a',
      includeParameterSchema: true,
    });
    assertMcpOutput(molGetSceneOutputSchema, scene);
    expect(scene).toMatchObject({ ok: true, structureViewId: 'view-a', ...readback.sceneResult });
    expect(scene).toMatchObject({
      parameterSchema: {
        schema: 'dnaforge.molecular-document-parameters.v1',
        parameters: expect.arrayContaining([expect.objectContaining({ name: 'position' })]),
        write: { tool: 'mol_apply_scene', atomic: true },
      },
      scientificReviewInventory: {
        version: 1,
        sceneDigestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        requiredForTrials: true,
        steps: [{ index: 0, groups: [] }],
      },
    });
    expect(scene).not.toHaveProperty('namedColorGroupSelections');
    expect(
      await handleMolGetScene({ structureViewId: 'view-a', includeColorGroupSelections: true })
    ).toMatchObject({ ok: true, namedColorGroupSelections: [] });
    const state = await handleMolGetState({ structureViewId: 'view-a' });
    assertMcpOutput(molGetStateOutputSchema, state);
    expect(state.structures).toHaveLength(1);
    expect(state.structures[0]).toMatchObject({
      viewerStatus: 'active',
      molecularConnections: readback.sceneResult.native.molecularConnections,
      native: {
        components: readback.sceneResult.native.components,
        camera: readback.sceneResult.native.camera,
      },
      renderProfile: readback.sceneResult.renderProfile,
    });
    expect(state.structures[0].native).not.toHaveProperty('molecularConnections');
  });

  it('keeps inactive views unknown and reads only the requested logical view', async () => {
    const firstTabId = useCanvasStore.getState().panels.main.activeTabId!;
    registerView('view-b');
    useCanvasStore.getState().setActiveTab('main', firstTabId);
    const state = await handleMolGetState({ structureViewId: 'view-a' });
    assertMcpOutput(molGetStateOutputSchema, state);
    expect(state.structures).toHaveLength(1);
    expect(readback.scene).toHaveBeenCalledTimes(1);
    expect(readback.withPlugin).toHaveBeenCalledTimes(1);
    const inactive = await handleMolGetState({ structureViewId: 'view-b' });
    expect(inactive.structures[0]).toMatchObject({
      viewerStatus: 'inactive',
      molecularConnections: null,
      native: null,
      renderProfile: null,
    });
    expect(readback.scene).toHaveBeenCalledTimes(1);
  });

  it('keeps structure discovery lightweight until detailed state is requested', async () => {
    const result = await handleMolListStructures();
    assertMcpOutput(molListStructuresOutputSchema, result);
    expect(readback.scene).not.toHaveBeenCalled();
  });
  it('returns validated saved-view, screenshot and story-step receipts from canonical handlers', async () => {
    allowSuccessfulCapture();
    const screenshot = await handleMolCaptureScreenshot({ structureViewId: 'view-a' });
    assertMcpOutput(molCaptureScreenshotOutputSchema, screenshot);
    expect(screenshot).toMatchObject({ ok: true, width: null, height: null, returns_image: true });
    const saved = await handleMolSaveView({
      structureViewId: 'view-a',
      title: 'Saved view',
      caption: '',
      evidence: [],
    });
    assertMcpOutput(molSaveViewOutputSchema, saved);
    expect(saved).toMatchObject({ ok: true, referenceId: 'saved-reference-1' });
    if (!saved.ok) throw new Error(saved.error);
    const selected = await handleMolSelectStoryStep({
      structureViewId: saved.structureViewId,
      index: 1,
    });
    assertMcpOutput(molSelectStoryStepOutputSchema, selected);
    expect(selected).toMatchObject({ ok: true, index: 1, title: 'Second step' });
  });

  it('does not commit a save after the selected measurement changes during capture', async () => {
    allowSuccessfulCapture();
    readback.validateGeometry.mockImplementationOnce(async () => {
      const current = useStructure3dStore.getState().expandedStructures['view-a'].data;
      useStructure3dStore.getState().updateStructureData('view-a', {
        ...current,
        activeMeasurementId: 'a-newly-selected-measurement',
      });
    });
    const result = await handleMolSaveView({
      structureViewId: 'view-a',
      title: 'Selected protein analysis',
      caption: '',
      evidence: [],
    });
    expect(result).toMatchObject({ ok: false, code: 'VIEW_CHANGED', stateChanged: false });
    expect(savedReferences.create).not.toHaveBeenCalled();
  });

  it('retains the inspection logical identity when adopting its saved document coordinates', async () => {
    allowSuccessfulCapture();
    readback.acceptSaved.mockReturnValue(true);
    const canvas = useCanvasStore.getState();
    const tabId = canvas.panels.main.activeTabId!;
    const attrs = useStructure3dStore.getState().expandedStructures['view-a'].data;
    const identity = attrs.structureViewIdentity;
    const request = { entityId: 'sequence', translation: 'M', hints: {} };
    canvas.updateTab('main', tabId, {
      structureInspection: { request },
    });
    readback.inspectionReady = true;
    const result = await handleMolSaveView({
      structureViewId: 'view-a',
      title: 'Selected protein analysis',
      caption: '',
      evidence: [],
    });
    expect(result).toMatchObject({ ok: true, revisionId: savedRevisionId });
    expect(useStructure3dStore.getState().expandedStructures['view-a'].data).toMatchObject({
      structureViewIdentity: identity,
      source: 'file',
      sourceId: 'controlled coordinates',
      molecularDocumentReference: { kind: 'molecular-document', revisionId: savedRevisionId },
    });
  });

  it.each(['reattached', 'deactivated'] as const)(
    'waits for the adopted document viewer and reports its actual outcome: %s',
    async (destination) => {
      allowSuccessfulCapture();
      readback.acceptSaved.mockReturnValue(true);
      const observation = {
        id: 'original-coordinate-observation',
        coordinateId: 'original-coordinate',
        coordinateSha256: await coordinateDigest('controlled coordinates'),
        format: 'cif',
        byteCount: 22,
        label: 'Imported coordinates',
        sourceKind: 'import',
        origin: { workspaceRoot: '/readback-workspace', filePath: '/readback-workspace/1URN.cif' },
        run: null,
        metrics: {},
        provenance: {},
        createdAt: 1,
      };
      readback.catalogLoad.mockResolvedValue({ observation });
      const rawFileAttrs = {
        ...useStructure3dStore.getState().expandedStructures['view-a'].data,
        source: 'file' as const,
        sourceId: 'controlled coordinates',
        coordinateFilePath: '/readback-workspace/1URN.cif',
        catalogSource: { observationId: observation.id },
        structureArtifactRef: {
          entityId: 'raw-coordinate-entity',
          revisionId: 'raw-coordinate-revision',
          structureId: 'structure:file:raw-coordinate-revision',
          coordinateDigestSha256: 'a'.repeat(64),
          artifactPath: '/readback-workspace/1URN.cif',
          format: 'mmcif' as const,
        },
      };
      useStructure3dStore.getState().updateStructureData('view-a', rawFileAttrs);
      const sourceTab = useCanvasStore.getState().panels.main.tabs[0];
      useCanvasStore.getState().updateTab('main', sourceTab.id, {
        initialStructureAttrs: rawFileAttrs,
      });
      const nativeAccess = readback.withPlugin.getMockImplementation()!;
      let nativeReady = false;
      let adoptionReads = 0;
      const unsubscribe = useCanvasStore.subscribe((state) => {
        for (const tab of state.panels.main.tabs) {
          if (!tab.entityId.startsWith('molecular-document:')) continue;
          useStructure3dStore
            .getState()
            .registerStructure(tab.entityId, tab.initialStructureAttrs!, tab.label);
        }
      });
      readback.withPlugin.mockImplementation(async (...args) => {
        if (
          useCanvasStore.getState().panels.main.tabs[0].entityId.startsWith('molecular-document:')
        ) {
          adoptionReads++;
          if (!nativeReady)
            throw new ActiveMolstarViewerError(
              'VIEWER_NOT_FOUND',
              'The native host is reattaching.'
            );
        }
        return nativeAccess(...args);
      });
      let settled = false;
      const saving = handleMolSaveView({
        structureViewId: 'view-a',
        title: 'Saved view',
        caption: '',
        evidence: [],
      }).then((result) => {
        settled = true;
        return result;
      });
      try {
        await vi.waitFor(() => expect(settled || adoptionReads > 0).toBe(true));
        expect(settled, settled ? JSON.stringify(await saving) : undefined).toBe(false);
        expect(adoptionReads).toBeGreaterThan(0);
        if (destination === 'deactivated') {
          const panel = useCanvasStore.getState().panels.main;
          useCanvasStore.setState({ panels: { main: { ...panel, activeTabId: null } } });
        }
        nativeReady = true;
        const saved = await saving;
        if (destination === 'deactivated') {
          expect(saved).toMatchObject({
            ok: false,
            code: 'VIEW_NOT_ACTIVE',
            stateChanged: true,
            partialEffects: [{ kind: 'saved-molecular-view', referenceId: savedRevisionId }],
          });
          return;
        }
        expect(saved).toMatchObject({ ok: true });
        if (!saved.ok) throw new Error(saved.error);
        const adopted =
          useStructure3dStore.getState().expandedStructures[saved.structureViewId].data;
        expect(adopted).toMatchObject({
          source: 'file',
          sourceId: 'controlled coordinates',
          coordinateSha256: saved.coordinateDigestSha256,
        });
        expect(adopted.coordinateFilePath).toBeUndefined();
        expect(adopted.structureArtifactRef).toBeUndefined();
        expect(adopted.structureBinding).toBeUndefined();
        expect(adopted.catalogSource).toBeUndefined();
        expect(adopted.catalogProvenance).toEqual(observation);
        expect(await handleMolGetScene({ structureViewId: saved.structureViewId })).toMatchObject({
          ok: true,
          structureViewId: saved.structureViewId,
        });
        readback.catalogLoad.mockRejectedValue(new Error('The original file has been absorbed.'));
        expect(
          await handleMolSaveView({
            structureViewId: saved.structureViewId,
            title: 'Saved view',
            caption: '',
            evidence: [],
          })
        ).toMatchObject({ ok: true });
        expect(readback.catalogLoad).toHaveBeenCalledTimes(1);
      } finally {
        nativeReady = true;
        await saving;
        unsubscribe();
      }
    }
  );

  it('reports the durable saved reference when the view changes after persistence', async () => {
    allowSuccessfulCapture();
    savedReferences.create.mockImplementationOnce(async (snapshot) => {
      const panel = useCanvasStore.getState().panels.main;
      useCanvasStore.setState({ panels: { main: { ...panel, activeTabId: null } } });
      return savedDocumentResult(snapshot);
    });
    const result = await handleMolSaveView({
      structureViewId: 'view-a',
      title: 'Saved view',
      caption: '',
      evidence: [],
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'VIEW_NOT_ACTIVE',
      stateChanged: true,
      partialEffects: [{ kind: 'saved-molecular-view', referenceId: savedRevisionId }],
    });
  });

  it('reports unknown effects when a reference write loses its receipt', async () => {
    allowSuccessfulCapture();
    savedReferences.create.mockRejectedValueOnce(new Error('Reference transport disconnected'));
    expect(
      await handleMolSaveView({
        structureViewId: 'view-a',
        title: 'Saved view',
        caption: '',
        evidence: [],
      })
    ).toMatchObject({ ok: false, stateChanged: 'unknown', partialEffects: [] });
  });

  it('uses the active document copy when an earlier pane retains an inactive copy', async () => {
    const id =
      'molecular-document:d91e97a1-86d5-414b-ae0b-b1e991dab968::63a77098-a2c0-40fa-8acc-81a2b1136ec2';
    registerView(id);
    const canvas = useCanvasStore.getState();
    const reportTabId = canvas.openTab('main', {
      type: 'page',
      entityId: 'ngs-report',
      label: 'NGS evidence report',
    });
    const panelId = canvas.splitPanel('main', 'vertical');
    canvas.openTab(panelId, {
      type: 'structure',
      entityId: id,
      label: 'Read-derived allele fraction',
      initialStructureAttrs: useStructure3dStore.getState().expandedStructures[id].data,
    });
    canvas.focusPanel('main');

    expect(await handleMolGetScene({ structureViewId: id })).toMatchObject({ ok: true });
    expect(readback.withPlugin).toHaveBeenLastCalledWith(expect.anything(), expect.any(Function), {
      cacheKey: getPaneRendererHostCacheKey(`pane:${panelId}`, 'loaded'),
      registrationId: id,
    });
    expect((await handleMolGetState({ structureViewId: id })).structures[0]).toMatchObject({
      viewerStatus: 'active',
    });
    expect(
      await handleMolSaveView({
        structureViewId: id,
        title: 'Read-derived allele fraction',
        caption: '',
        evidence: [],
      })
    ).toMatchObject({ ok: false, code: 'TEST_CAPTURE_BOUNDARY' });
    expect(readback.capture).toHaveBeenCalledOnce();
    expect(useCanvasStore.getState().panels.main.activeTabId).toBe(reportTabId);
  });

  it('uses the focused native pane when both copies of the same document are active', async () => {
    const id = 'molecular-document:catalog-document';
    registerView(id);
    const canvas = useCanvasStore.getState();
    const panelId = canvas.splitPanel('main', 'vertical');
    canvas.openTab(panelId, {
      type: 'structure',
      entityId: id,
      label: 'Read-derived allele fraction',
      initialStructureAttrs: useStructure3dStore.getState().expandedStructures[id].data,
    });
    for (const focusedPanelId of [panelId, 'main']) {
      canvas.focusPanel(focusedPanelId);
      expect(await handleMolGetScene({ structureViewId: id })).toMatchObject({ ok: true });
      expect(readback.withPlugin).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.any(Function),
        {
          cacheKey: getPaneRendererHostCacheKey(`pane:${focusedPanelId}`, 'loaded'),
          registrationId: id,
        }
      );
    }
  });

  it('refuses a selection before a transitioning molecular view has settled', async () => {
    readback.ready.mockRejectedValueOnce(
      new MolViewSpecSceneError('MVS_VIEW_NOT_STABLE', 'The molecular view is still moving.')
    );
    expect(
      await handleMolSelectResidues({ structureViewId: 'view-a', selection: 'chain A' })
    ).toMatchObject({ ok: false, code: 'MVS_VIEW_NOT_STABLE' });
    expect(readback.ready).toHaveBeenCalledOnce();
  });

  it('returns optional feature-center evidence and leaves unavailable native picking unknown', async () => {
    readback.groups = [
      {
        id: 'feature-a',
        label: 'Feature A',
        color: 0xffaa22,
        selectable: true,
        structureCount: 1,
        targets: [],
      },
    ];
    const ordinary = await handleMolGetScene({ structureViewId: 'view-a' });
    expect(ordinary).not.toHaveProperty('namedColorGroupSelections');
    const detailed = await handleMolGetScene({
      structureViewId: 'view-a',
      includeColorGroupSelections: true,
    });
    expect(detailed).toMatchObject({
      namedColorGroupSelections: [
        {
          label: 'Feature A',
          frontmostAtSampledCenters: {
            status: 'unavailable',
            reason: 'Native camera projection/picking is unavailable.',
          },
        },
      ],
    });
    expect(detailed).toHaveProperty('featureExposureNotes');
  });

  it('rejects placeholder save names before native capture or persistence', async () => {
    expect(
      await handleMolSaveView({
        structureViewId: 'view-a',
        title: 'View1',
        caption: '',
        evidence: [],
      })
    ).toMatchObject({ ok: false, code: 'MVS_VIEW_NAME_REQUIRED', stateChanged: false });
    readback.scene.mockReturnValue({
      ...readback.sceneResult,
      scene: JSON.stringify({
        kind: 'multiple',
        snapshots: [
          { root: { kind: 'root' }, metadata: { title: 'DNA strand routing' } },
          { root: { kind: 'root' }, metadata: { title: 'View2' } },
        ],
      }),
    });
    expect(
      await handleMolSaveView({
        structureViewId: 'view-a',
        title: 'Catalytic checkpoint',
        caption: '',
        evidence: [],
      })
    ).toMatchObject({
      ok: false,
      code: 'MVS_VIEW_NAME_REQUIRED',
      stateChanged: false,
      error: expect.stringContaining('snapshots[1].metadata.title'),
    });
  });

  it('uses the immutable camera baseline for UI Save while retaining the native all-view gate', async () => {
    const saved = {
      kind: 'molecular-view',
      version: 1,
      scene: readback.sceneResult.scene,
      cameraSnapshot: 'immutable authored camera',
      title: 'Authored checkpoint',
      caption: '',
      coordinates: { format: 'pdb', text: 'coords', sha256: 'a'.repeat(64) },
      source: {},
      evidence: [],
      preview: 'data:image/png;base64,AAAA',
      createdAt: 1,
    };
    const id = '10000000-0000-4000-8000-000000000001';
    readback.reference.mockResolvedValue({ id, data: JSON.stringify(saved) });
    const current = useStructure3dStore.getState().expandedStructures['view-a'].data;
    useStructure3dStore.getState().updateStructureData('view-a', {
      ...current,
      molViewSpecSavedReferenceId: id,
      molecularDocumentId: '20000000-0000-4000-8000-000000000001',
      molecularDocumentPath: '/project/Authored.dnaforge-molecular.json',
      molecularDocumentRevision: 'b'.repeat(64),
      molecularDocumentSavedReferenceId: id,
      cameraSnapshot: 'old exploratory attrs camera',
    });
    const result = await handleMolSaveView(
      { structureViewId: 'view-a', title: 'Authored checkpoint', caption: '', evidence: [] },
      { cameraPolicy: 'preserve-authored' }
    );
    expect(result).toMatchObject({ ok: false, code: 'TEST_CAPTURE_BOUNDARY' });
    expect(readback.ready).toHaveBeenCalledOnce();
    expect(readback.validateGeometry).toHaveBeenCalledOnce();
    expect(readback.reference).toHaveBeenCalledWith(id);
    expect(readback.capture).toHaveBeenCalledWith(expect.anything(), {
      cameraPolicy: 'preserve-authored',
      authoredCameraSnapshot: 'old exploratory attrs camera',
      savedCameraBaseline: { scene: saved.scene, cameraSnapshot: saved.cameraSnapshot },
    });
  });

  it('keeps agent saves as explicit current-camera captures without a baseline lookup', async () => {
    const result = await handleMolSaveView({
      structureViewId: 'view-a',
      title: 'Authored checkpoint',
      caption: '',
      evidence: [],
    });
    expect(result).toMatchObject({ ok: false, code: 'TEST_CAPTURE_BOUNDARY' });
    expect(readback.reference).not.toHaveBeenCalled();
    expect(readback.capture).toHaveBeenCalledWith(expect.anything(), {
      cameraPolicy: 'capture-current',
      authoredCameraSnapshot: undefined,
    });
  });
});
