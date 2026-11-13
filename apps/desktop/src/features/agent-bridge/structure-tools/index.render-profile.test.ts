/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { useCanvasStore } from '../../canvas/public/store';
import { useStructure3dStore } from '../../page/public/embeds/structure3d/store';
import {
  DEFAULT_MOLECULAR_RENDER_PROFILE,
  currentMolecularRenderProfile,
  resolveMolViewSpecRenderProfile,
} from '../../page/public/embeds/structure3d/molstar/molecularRenderProfile';
import { handleMolApplyScene as executeMolApplyScene } from './index';
import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { molApplySceneOutputSchema } from './output-schemas';
async function handleMolApplyScene(input: unknown) {
  const result = await executeMolApplyScene(input);
  if (result.ok) assertMcpOutput(molApplySceneOutputSchema, result);
  return result;
}
import { resolveMolecularDisplayGroups } from '../../page/public/embeds/structure3d/molstar/molecularDisplayGroups';

const renderer = vi.hoisted(() => ({ scene: '', apply: vi.fn() }));

vi.mock('../../page/public/embeds/structure3d/viewerCache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../page/public/embeds/structure3d/viewerCache')>()),
  withActivePlugin: vi.fn(async (_id, operation) =>
    operation({
      plugin: { managers: { structure: { hierarchy: { current: { structures: [] } } } } },
    })
  ),
}));

vi.mock('../../page/public/embeds/structure3d/molstar/molViewSpec', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../page/public/embeds/structure3d/molstar/molViewSpec')
  >()),

  resolveMolViewSpecAgentScene: (
    _plugin: unknown,
    scene: string,
    _resources: unknown,
    profile: 'default' | 'native' = 'default'
  ) => {
    const document = MVSData.fromMVSJ(scene);
    if (profile === 'native' && document.kind !== 'multiple')
      document.root.custom = { ...document.root.custom, dnaforge_render_profile: 'native' };
    return MVSData.toMVSJ(
      resolveMolecularDisplayGroups(resolveMolViewSpecRenderProfile(document, profile))
    );
  },
  activeMolViewSpecScene: () => renderer.scene,
  getMolViewSpecScene: () => ({
    format: 'mvsj',
    renderProfile: { selection: 'native', resolvedProfile: null },
    renderProfileGuidance: 'Defaults',
    supportedMajorVersion: 1,
    limitations: [],
    guidance: 'Edit scene',
    native: {
      colorSelectionGuidance: 'The profile fixture contains no compiled color-layer selections.',
      componentRefs: [],
      camera: null,
      molecularConnections: [],
      molecularConnectionSummary: {
        total: 0,
        attachmentCount: 0,
        incompleteAttachmentCount: 0,
        countsByKind: {},
        countsByStatus: {},
        page: { query: {}, offset: 0, limit: 32, matched: 0, returned: 0, nextOffset: null },
        guidance: 'Page',
      },
      components: [],
    },
    sceneOrigin: 'authored',
    scene: renderer.scene,
    resource: { uri: 'structure.cif', format: 'mmcif', boundTo: 'current-structure-view' },
    resources: [{ uri: 'structure.cif', format: 'mmcif', boundTo: 'current-structure-view' }],
  }),
  applyMolViewSpecScene: async (_plugin: unknown, scene: string, onRendered: () => void) => {
    renderer.apply(scene);
    renderer.scene = scene;
    onRendered();
  },
}));

function authoredScene() {
  const builder = MVSData.createBuilder();
  builder
    .download({ url: 'structure.cif' })
    .parse({ format: 'mmcif' })
    .modelStructure()
    .component({ selector: 'ligand' })
    .representation({ type: 'ball_and_stick' });
  builder.camera({ target: [0, 0, 0], position: [0, 0, 50], up: [0, 1, 0] });
  return builder.getState();
}

function atoms(document: ReturnType<typeof authoredScene>) {
  const node = document.root.children![0].children![0].children![0].children![0].children![0];
  if (node.kind !== 'representation' || node.params.type !== 'ball_and_stick')
    throw new Error('Expected a ball-and-stick representation.');
  return node;
}

describe('scene-tool render-profile persistence boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    renderer.scene = MVSData.toMVSJ(authoredScene());
    const attrs = {
      source: 'pdb' as const,
      sourceId: '1K4C',
      pdbId: '1K4C',
      molViewSpec: renderer.scene,
      structureViewIdentity: {
        schemaVersion: 1 as const,
        structureViewId: 'saved-view:run-a',
        bindingId: null,
      },
    };
    useStructure3dStore.getState().registerStructure('saved-view:run-a', attrs, 'Run A');
    useCanvasStore.getState().openTab('main', {
      type: 'structure',
      entityId: 'saved-view:run-a',
      label: 'Run A',
      initialStructureAttrs: attrs,
    });
  });

  it('loads and persists the same resolved scene, not an unrecorded second styling pass', async () => {
    const proposed = authoredScene();
    proposed.root.children![1].params = { target: [0, 0, 0], position: [0, 0, 25], up: [0, 1, 0] };
    const result = await handleMolApplyScene({
      structureViewId: 'saved-view:run-a',
      scene: MVSData.toMVSJ(proposed),
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, rendered: true });
    expect(renderer.apply).toHaveBeenCalledTimes(1);
    const resolved = JSON.parse(renderer.apply.mock.calls[0][0]);
    expect(resolved.root.custom.dnaforge_render_profile).toEqual(currentMolecularRenderProfile());
    expect(atoms(resolved).params.size_factor).toBe(
      DEFAULT_MOLECULAR_RENDER_PROFILE.ballAndStick.sizeFactor
    );
    const persisted =
      useStructure3dStore.getState().expandedStructures['saved-view:run-a'].data.molViewSpec;
    expect(persisted).toBe(renderer.apply.mock.calls[0][0]);
    expect(useCanvasStore.getState().panels.main.tabs[0].initialStructureAttrs?.molViewSpec).toBe(
      persisted
    );
  });

  it('rejects a native agent profile before changing the viewer or stored scene', async () => {
    const before = renderer.scene;
    expect(
      await handleMolApplyScene({
        structureViewId: 'saved-view:run-a',
        scene: MVSData.toMVSJ(authoredScene()),
        renderProfile: 'native',
      })
    ).toMatchObject({ ok: false, stateChanged: false });
    expect(renderer.apply).not.toHaveBeenCalled();
    expect(renderer.scene).toBe(before);
  });

  it('rejects invalid profile input before mutating the native viewer or stored scene', async () => {
    const before = renderer.scene;
    const proposed = authoredScene();
    atoms(proposed).custom = { dnaforge_carbon_color: 'not-a-color' };
    expect(
      await handleMolApplyScene({
        structureViewId: 'saved-view:run-a',
        scene: MVSData.toMVSJ(proposed),
      })
    ).toMatchObject({ ok: false, code: 'MVS_INVALID_RENDER_PROFILE', stateChanged: false });
    expect(renderer.apply).not.toHaveBeenCalled();
    expect(renderer.scene).toBe(before);
    expect(
      useStructure3dStore.getState().expandedStructures['saved-view:run-a'].data.molViewSpec
    ).toBe(before);
  });
});
