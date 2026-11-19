import { molstarPluginFixture } from '@/test/fixtures/molstar-plugin';
/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { CIF } from 'molstar/lib/mol-io/reader/cif';
import { trajectoryFromMmCIF } from 'molstar/lib/mol-model-formats/structure/mmcif';
import { Structure, StructureSymmetry } from 'molstar/lib/mol-model/structure';
import { PluginStateObject } from 'molstar/lib/mol-plugin-state/objects';
import { Task } from 'molstar/lib/mol-task';
import { componentPropsFromSelector } from 'molstar/lib/extensions/mvs/load-helpers';
import { substructureFromSelector } from 'molstar/lib/extensions/mvs/components/selector';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra';
import {
  getMolViewSpecScene,
  holdMolViewSpecStoryFrames,
  readMolViewSpecNativeState,
  configureMolViewSpecCanvasBackground,
  requireUnchangedMolViewSpecBackground,
  requireSerializableMolViewSpecVisibility,
  prepareMolViewSpecForOpening,
  resetMolViewSpecRuntime,
  sameMolViewSpecDisplayTree,
  sameLoadedMolViewSpecScene,
  stripMolViewSpecCanvasNodes,
  validateMolViewSpecScene,
  authorMolViewSpecRoot,
  resolveMolViewSpecAgentScene,
} from './molViewSpec';
import { molViewSpecColorGroups } from './molViewSpecLegend';
import type { MolstarPlugin } from './cache';
import { requirePreservedPolymerContext } from './molecularSceneSelections';
import { scheduleMolstarFrameKicks } from './viewerFrameKicks';

describe('hydrogen visibility at the saved-scene opening boundary', () => {
  it('hides all hydrogen atoms in every saved story step, including conflicting native flags', () => {
    const builder = MVSData.createBuilder();
    const component = builder
      .download({ url: 'structure.cif' })
      .parse({ format: 'mmcif' })
      .modelStructure()
      .component({ selector: 'all' });
    for (const type of ['ball_and_stick', 'spacefill', 'line', 'surface'] as const) {
      component.representation({ type, ignore_hydrogens: false });
    }
    const state = builder.getState();
    const nodes = state.root.children![0].children![0].children![0].children![0].children!;
    for (const node of nodes)
      node.custom = {
        molstar_representation_params: {
          ignoreHydrogens: false,
          ignoreHydrogensVariant: 'non-polar',
        },
      };
    const document = {
      kind: 'multiple' as const,
      metadata: state.metadata,
      snapshots: [structuredClone(state), structuredClone(state)],
    };
    const opened = prepareMolViewSpecForOpening(document).document;
    if (opened.kind !== 'multiple') throw new Error('Expected a story.');
    for (const snapshot of opened.snapshots) {
      const representations =
        snapshot.root.children![0].children![0].children![0].children![0].children!;
      for (const node of representations) {
        expect(node.params).toMatchObject({ ignore_hydrogens: true });
        expect(node.custom?.molstar_representation_params).toMatchObject({
          ignoreHydrogens: true,
          ignoreHydrogensVariant: 'all',
        });
      }
    }
    expect(nodes[0].custom?.molstar_representation_params).toMatchObject({
      ignoreHydrogens: false,
    });
  });
});

describe('story snapshot frame continuity', () => {
  it.each([false, true])(
    'holds delayed frame kicks and native resume/tick calls across nested audits (failure: %s)',
    async (fail) => {
      let drawPaused = false;
      let selectedIndex = 5;
      const presented: number[] = [];
      let drawListener: (() => void) | undefined;
      const present = () => {
        if (drawPaused) return;
        presented.push(selectedIndex);
        drawListener?.();
      };
      const canvas = {
        props: { camera: { manualReset: false } },
        pause: (noDraw = false) => {
          drawPaused = noDraw;
        },
        resume: () => {
          drawPaused = false;
        },
        animate: () => {
          drawPaused = false;
          present();
        },
        tick: (_time: number, options?: { manualDraw?: boolean }) => {
          if (!options?.manualDraw) present();
        },
        commit: present,
        requestDraw: present,
        didDraw: {
          subscribe: (listener: () => void) => {
            listener();
            drawListener = listener;
            return { unsubscribe: () => (drawListener = undefined) };
          },
        },
        setProps: (props: { camera: { manualReset: boolean } }) => {
          canvas.props.camera.manualReset = props.camera.manualReset;
        },
      };
      const original = {
        pause: canvas.pause,
        resume: canvas.resume,
        animate: canvas.animate,
        tick: canvas.tick,
      };
      const loop = { isAnimating: true, stop: vi.fn(), start: vi.fn() };
      const plugin = molstarPluginFixture({ canvas3d: canvas, animationLoop: loop });
      const held = holdMolViewSpecStoryFrames(plugin, async () => {
        selectedIndex = 0;
        const delayedKicks: Array<() => void> = [];
        const cancel = scheduleMolstarFrameKicks(plugin, {
          requestAnimationFrame: (callback) => {
            delayedKicks.push(() => callback(0));
            return 1;
          },
          setTimeout: (callback) => {
            delayedKicks.push(callback);
            const timer = setTimeout(() => {}, 0);
            clearTimeout(timer);
            return timer;
          },
          clearTimeout: () => {},
        });
        await holdMolViewSpecStoryFrames(plugin, async () => {
          for (const [index, kick] of delayedKicks.entries()) {
            selectedIndex = index % 6;
            kick();
            canvas.resume();
            canvas.pause(false);
            canvas.tick(index);
          }
        });
        cancel();
        selectedIndex = 5;
        if (fail) throw new Error('Audit failed');
      });
      if (fail) await expect(held).rejects.toThrow('Audit failed');
      else await held;
      expect(presented).toEqual(fail ? [] : [5]);
      expect(canvas.props.camera.manualReset).toBe(false);
      expect(drawPaused).toBe(false);
      expect(canvas.pause).toBe(original.pause);
      expect(canvas.resume).toBe(original.resume);
      expect(canvas.animate).toBe(original.animate);
      expect(canvas.tick).toBe(original.tick);
      expect(loop.stop).not.toHaveBeenCalled();
      expect(loop.start).not.toHaveBeenCalled();
    }
  );

  it('holds replacement frames, restores controls, and awaits a real resumed draw before camera navigation', async () => {
    for (const manualReset of [false, true]) {
      for (const fail of [false, true]) {
        let drawPaused = false;
        let automaticReset = manualReset;
        let resolveReplacement!: () => void;
        const replacement = new Promise<void>((resolve) => {
          resolveReplacement = resolve;
        });
        const commit = vi.fn(() => {
          expect(drawPaused).toBe(true);
          expect(automaticReset).toBe(true);
        });
        const loop = { isAnimating: true, stop: vi.fn(), start: vi.fn() };
        let drawListener: (() => void) | undefined;
        const unsubscribe = vi.fn();
        const requestDraw = vi.fn();
        const resume = vi.fn(() => {
          drawPaused = false;
        });
        const animate = vi.fn();
        const plugin = molstarPluginFixture({
          canvas3d: {
            props: { camera: { manualReset } },
            pause: (held: boolean) => {
              drawPaused = held;
            },
            resume,
            animate,
            requestDraw,
            didDraw: {
              subscribe: (listener: () => void) => {
                listener();
                drawListener = listener;
                return { unsubscribe };
              },
            },
            setProps: (props: { camera: { manualReset: boolean } }) => {
              automaticReset = props.camera.manualReset;
            },
            commit,
          },
          animationLoop: loop,
        });
        const held = holdMolViewSpecStoryFrames(plugin, async () => {
          await replacement;
          if (fail) throw new Error('Native snapshot replacement failed');
        });
        expect(drawPaused).toBe(true);
        expect(automaticReset).toBe(true);
        expect(commit).not.toHaveBeenCalled();
        resolveReplacement();
        if (fail) await expect(held).rejects.toThrow('Native snapshot replacement failed');
        else {
          let finished = false;
          void held.then(() => {
            finished = true;
          });
          await vi.waitFor(() => expect(requestDraw).toHaveBeenCalledOnce());
          expect(finished).toBe(false);
          expect(drawPaused).toBe(false);
          drawListener?.();
          await held;
          expect(unsubscribe).toHaveBeenCalledOnce();
        }
        expect(commit).toHaveBeenCalledTimes(fail ? 0 : 1);
        expect(drawPaused).toBe(false);
        expect(automaticReset).toBe(manualReset);
        expect(loop.stop).not.toHaveBeenCalled();
        expect(loop.start).not.toHaveBeenCalled();
        expect(loop.isAnimating).toBe(true);
        expect(resume).toHaveBeenCalledOnce();
        expect(animate).not.toHaveBeenCalled();
      }
    }
  });
});

describe('native color readback transport size', () => {
  it('summarizes compiled color selections while preserving themes, layer order and editable MVS selectors', async () => {
    const source = await nativeStarterSource();
    const plugin = nativeStarterPlugin(source);
    const selectors = Array.from({ length: 2000 }, (_, atom_index) => ({
      atom_index,
      instance_id: '1_555',
    }));
    const compiled = componentPropsFromSelector(selectors);
    expect(compiled.name).toBe('expression');
    const theme = {
      name: 'element-symbol',
      params: {
        carbonColor: { name: 'uniform', params: { value: 0x237ac9 } },
        saturation: 0,
        lightness: 0,
      },
    };
    const colorThemeParams = {
      layers: Array.from({ length: 5 }, () => ({ theme, selection: compiled })),
      background: 0xffffff,
    };
    const untouched = structuredClone(colorThemeParams);
    const structure = plugin.managers.structure.hierarchy.current.structures[0];
    structure.components.push({
      cell: {
        transform: { ref: 'native-context' },
        obj: { label: 'Native context', data: source },
      },
      representations: [
        {
          cell: {
            params: {
              values: {
                type: { name: 'ball-and-stick', params: { alpha: 1 } },
                colorTheme: { name: 'mvs-multilayer', params: colorThemeParams },
                sizeTheme: { name: 'uniform', params: { value: 0.55 } },
              },
            },
          },
        },
      ],
    } as (typeof structure.components)[number]);
    const native = readMolViewSpecNativeState(plugin);
    const layers = native.components[0].representations[0].colorThemeParams.layers;
    expect(layers).toHaveLength(5);
    for (const layer of layers) {
      expect(layer.theme).toEqual(theme);
      expect(layer.selection).toEqual({
        name: 'expression',
        paramsSummarized: true,
        exactSource: 'canonical-mvs-scene',
      });
    }
    expect(colorThemeParams).toEqual(untouched);
    colorThemeParams.layers[0].selection = { name: 'static', params: 'all' } as typeof compiled;
    const staticNative = readMolViewSpecNativeState(plugin);
    expect(
      (
        staticNative.components[0].representations[0].colorThemeParams
          .layers as typeof colorThemeParams.layers
      )[0].selection
    ).toEqual({ name: 'static', params: 'all' });
    const builder = MVSData.createBuilder();
    builder
      .download({ url: 'structure.pdb' })
      .parse({ format: 'pdb' })
      .modelStructure()
      .component({ selector: selectors })
      .representation({ type: 'ball_and_stick' })
      .color({ color: '#237ac9' });
    const scene = MVSData.toMVSJ(builder.getState());
    const payload = { scene, native };
    const frame = {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        item: {
          type: 'mcpToolCall',
          result: {
            content: [{ type: 'text', text: JSON.stringify(payload) }],
            structuredContent: payload,
          },
        },
      },
    };
    expect(new TextEncoder().encode(JSON.stringify(frame)).length).toBeLessThan(1_048_576);
    expect(
      JSON.parse(scene).root.children[0].children[0].children[0].children[0].params.selector
    ).toEqual(selectors);
  });
});

const NATIVE_STARTER_CIF = `data_STARTER_NATIVE_SOURCE
_entity.id 1
_entity.type polymer
_entity_poly.entity_id 1
_entity_poly.type 'polypeptide(L)'
_struct_asym.id A
_struct_asym.entity_id 1
_chem_comp.id ALA
_chem_comp.type 'L-peptide linking'
_pdbx_struct_assembly.id paired
_pdbx_struct_assembly.details 'test pair'
_pdbx_struct_assembly_gen.assembly_id paired
_pdbx_struct_assembly_gen.oper_expression '(1,2)'
_pdbx_struct_assembly_gen.asym_id_list A
loop_
_pdbx_struct_oper_list.id
_pdbx_struct_oper_list.matrix[1][1]
_pdbx_struct_oper_list.matrix[1][2]
_pdbx_struct_oper_list.matrix[1][3]
_pdbx_struct_oper_list.vector[1]
_pdbx_struct_oper_list.matrix[2][1]
_pdbx_struct_oper_list.matrix[2][2]
_pdbx_struct_oper_list.matrix[2][3]
_pdbx_struct_oper_list.vector[2]
_pdbx_struct_oper_list.matrix[3][1]
_pdbx_struct_oper_list.matrix[3][2]
_pdbx_struct_oper_list.matrix[3][3]
_pdbx_struct_oper_list.vector[3]
1 1 0 0 0 0 1 0 0 0 0 1 0
2 1 0 0 12 0 1 0 0 0 0 1 0
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_alt_id
_atom_site.label_comp_id
_atom_site.label_asym_id
_atom_site.label_entity_id
_atom_site.label_seq_id
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.occupancy
_atom_site.B_iso_or_equiv
_atom_site.auth_seq_id
_atom_site.auth_comp_id
_atom_site.auth_asym_id
_atom_site.auth_atom_id
_atom_site.pdbx_PDB_model_num
ATOM 1 C CA . ALA A 1 1 0 0 0 1 10 1 ALA A CA 4
ATOM 2 C CA . ALA A 1 1 0 5 0 1 10 1 ALA A CA 9
#
`;

async function nativeStarterSource() {
  const parsed = await CIF.parseText(NATIVE_STARTER_CIF).run();
  if (parsed.isError) throw new Error(parsed.message);
  const trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
  const model = await Task.resolveInContext(trajectory.getFrameAtIndex(1));
  return Structure.ofModel(model);
}

function nativeStarterPlugin(source: Structure, transformed?: Structure): MolstarPlugin {
  return molstarPluginFixture({
    state: {
      data: {
        cells: new Map([
          [
            'coordinates',
            {
              obj: new PluginStateObject.Data.String(NATIVE_STARTER_CIF),
            },
          ],
        ]),
      },
    },
    managers: {
      asset: { set: vi.fn() },
      structure: {
        hierarchy: {
          current: {
            structures: [
              {
                cell: { obj: { data: source } },
                ...(transformed ? { transform: { cell: { obj: { data: transformed } } } } : {}),
                components: [],
              },
            ],
          },
        },
      },
    },
  });
}

function starterStructureNode(plugin: MolstarPlugin) {
  const document = JSON.parse(getMolViewSpecScene(plugin).scene);
  return document.root.children[0].children[0].children[0];
}

function scene(url = 'structure.pdb') {
  const builder = MVSData.createBuilder();
  builder
    .download({ url })
    .parse({ format: 'pdb' })
    .modelStructure()
    .component({ selector: 'all' })
    .representation({ type: 'ball_and_stick' })
    .color({ color: '#3388ff' });
  builder.camera({ target: [0, 0, 0], position: [0, 0, 60], up: [0, 1, 0] });
  return MVSData.toMVSJ(builder.getState());
}

describe('standard MolViewSpec scene contract', () => {
  it('authors an explicit bare root with official metadata while complete scenes remain strict', () => {
    const document = JSON.parse(scene());
    expect(() =>
      validateMolViewSpecScene(JSON.stringify({ root: document.root }), 'structure.pdb')
    ).toThrow(/Missing MolViewSpec metadata/);
    const authored = validateMolViewSpecScene(
      authorMolViewSpecRoot(document.root, 'structure.pdb'),
      'structure.pdb'
    );
    expect(authored.root).toEqual(document.root);
    expect(Number(authored.metadata.version.split('.')[0])).toBe(MVSData.SupportedVersion);
    expect(Number.isFinite(Date.parse(authored.metadata.timestamp))).toBe(true);
    expect(() => authorMolViewSpecRoot({ kind: 'component' }, 'structure.pdb')).toThrow(
      expect.objectContaining({ code: 'MVS_INVALID_SCENE', stateChanged: false })
    );
    expect(() =>
      authorMolViewSpecRoot(
        { kind: 'root', custom: { oversized: 'x'.repeat(2_000_001) } },
        'structure.pdb'
      )
    ).toThrow(expect.objectContaining({ code: 'MVS_INVALID_SCENE', stateChanged: false }));
    expect(() => authorMolViewSpecRoot(document.root, 'other-file.pdb')).toThrow(
      expect.objectContaining({ code: 'MVS_UNSUPPORTED_RESOURCE', stateChanged: false })
    );
    document.metadata.version = '999';
    expect(() => validateMolViewSpecScene(JSON.stringify(document), 'structure.pdb')).toThrow(
      expect.objectContaining({ code: 'MVS_UNSUPPORTED_VERSION', stateChanged: false })
    );
  });

  it('rejects agent profile bypasses before inspecting or constructing a scene', () => {
    for (const profile of ['native', { id: 'legacy', version: 11 }] as const) {
      expect(() =>
        resolveMolViewSpecAgentScene(
          {} as MolstarPlugin,
          'unparsed agent scene',
          'structure.cif',
          profile as Parameters<typeof resolveMolViewSpecAgentScene>[3]
        )
      ).toThrowError(expect.objectContaining({ code: 'MVS_AGENT_RENDER_PROFILE_OWNED' }));
    }
  });

  it('cannot use another structure copy to conceal lost source-qualified context', async () => {
    const source = await nativeStarterSource();
    const current = JSON.parse(getMolViewSpecScene(nativeStarterPlugin(source)).scene);
    const a = current.root.children[0].children[0].children[0];
    a.ref = 'first';
    const b = structuredClone(a);
    b.ref = 'second';
    current.root.children[0].children[0].children.push(b);
    const proposed = structuredClone(current);
    proposed.root.children[0].children[0].children[0].children = [];
    expect(() => requirePreservedPolymerContext(current, 0, proposed, source, 'first')).toThrow(
      'removes existing polymer context'
    );
  });

  it('checks retained story context against its own step, not an active comparison duplicate', async () => {
    const source = await nativeStarterSource();
    const starter = JSON.parse(getMolViewSpecScene(nativeStarterPlugin(source)).scene);
    const overview = structuredClone(starter.root);
    overview.children[0].children[0].children[0].ref = 'assembly';
    const comparison = structuredClone(starter.root);
    comparison.children[0].children[0].children[0].ref = 'compared-copy';
    const current = {
      kind: 'multiple' as const,
      metadata: starter.metadata,
      snapshots: [{ root: overview }, { root: comparison }],
    };

    expect(() =>
      requirePreservedPolymerContext(current, 1, structuredClone(current), source, 'compared-copy')
    ).not.toThrow();

    const removedOverview = structuredClone(current);
    removedOverview.snapshots[0].root.children[0].children[0].children[0].children = [];
    expect(() =>
      requirePreservedPolymerContext(current, 1, removedOverview, source, 'assembly')
    ).toThrowError(expect.objectContaining({ code: 'MVS_POLYMER_CONTEXT_REQUIRED' }));

    const replacement = { ...starter, root: overview };
    expect(() =>
      requirePreservedPolymerContext(current, 1, replacement, source, 'compared-copy')
    ).toThrowError(expect.objectContaining({ code: 'MVS_POLYMER_CONTEXT_REQUIRED' }));
  });
  it('automatically designates every authored molecular representation for the legend', async () => {
    const plugin = nativeStarterPlugin(await nativeStarterSource());
    const current = getMolViewSpecScene(plugin);
    const historical = JSON.parse(current.scene);
    historical.root.custom.dnaforge_render_profile.version = 2;
    delete historical.root.custom.dnaforge_render_profile.presentation;
    const compiled = resolveMolViewSpecAgentScene(
      plugin,
      JSON.stringify(historical),
      'structure.cif'
    );
    expect(JSON.parse(compiled).root.custom.dnaforge_render_profile).toMatchObject({
      version: 12,
      surfaceOwnership: 'single-side-v1',
    });
    expect(molViewSpecColorGroups(compiled, 0).map((group) => group.label)).toContain(
      'Polymer context'
    );
    const document = JSON.parse(compiled);
    const reps = document.root.children[0].children[0].children[0].children.flatMap(
      (c: { children: unknown[] }) => c.children
    );
    expect(
      reps.every(
        (r: { custom?: { dnaforge_display_group?: unknown } }) => r.custom?.dnaforge_display_group
      )
    ).toBe(true);
  });

  it('shows the root declaration needed to intentionally omit loaded polymer context', async () => {
    const plugin = nativeStarterPlugin(await nativeStarterSource());
    const current = getMolViewSpecScene(plugin);
    const document = JSON.parse(current.scene);
    document.root.children[0].children[0].children[0].children = [
      {
        kind: 'component',
        params: { selector: 'protein' },
        children: [{ kind: 'representation', params: { type: 'ball_and_stick' } }],
      },
    ];
    expect(() =>
      resolveMolViewSpecAgentScene(plugin, JSON.stringify(document), 'structure.cif')
    ).toThrowError(
      expect.objectContaining({
        code: 'MVS_POLYMER_CONTEXT_REQUIRED',
        message: expect.stringContaining('"fields":["preservePolymerContext"]'),
      })
    );
    const override = {
      reason: 'Show local atomic geometry without occlusion from the polymer ribbon.',
      fields: ['preservePolymerContext'],
    };
    document.root.custom.dnaforge_presentation_override = override;
    const compiled = resolveMolViewSpecAgentScene(
      plugin,
      JSON.stringify(document),
      'structure.cif'
    );
    expect(JSON.parse(compiled).root.custom.dnaforge_presentation_override).toEqual(override);
  });
  it('retains source-qualified context while adding another pinned resource', async () => {
    const plugin = nativeStarterPlugin(await nativeStarterSource());
    const document = JSON.parse(getMolViewSpecScene(plugin).scene);
    const extra = structuredClone(document.root.children[0]);
    extra.params.url = 'asset-2.cif';
    for (const component of extra.children[0].children[0].children)
      for (const representation of component.children ?? [])
        if (representation.kind === 'representation') representation.params.type = 'cartoon';
    document.root.children.push(extra);
    const resources = ['structure.cif', 'asset-2.cif'];
    expect(() =>
      resolveMolViewSpecAgentScene(plugin, JSON.stringify(document), resources)
    ).not.toThrow();
    const rebound = structuredClone(document);
    rebound.root.children[0].params.url = 'asset-2.cif';
    expect(() => resolveMolViewSpecAgentScene(plugin, JSON.stringify(rebound), resources)).toThrow(
      'rebound'
    );
    document.root.custom.dnaforge_presentation_override = {
      reason: 'Compare two independently pinned conformations with their own context.',
      fields: ['preservePolymerContext'],
    };
    const compiled = resolveMolViewSpecAgentScene(plugin, JSON.stringify(document), resources);
    expect(JSON.parse(compiled).root.custom.dnaforge_presentation_override.reason).toContain(
      'independently pinned'
    );
    expect(molViewSpecColorGroups(compiled, 0).every((g) => g.selectable)).toBe(true);
  });

  it('recreates the native assembly and selected trajectory frame without losing instance selectors', async () => {
    const modelSource = await nativeStarterSource();
    const source = await StructureSymmetry.buildAssembly(modelSource, 'paired').run();
    const node = starterStructureNode(nativeStarterPlugin(source));
    expect(node.params).toMatchObject({
      type: 'assembly',
      assembly_id: 'paired',
      model_index: 1,
      block_header: 'STARTER_NATIVE_SOURCE',
    });
    const reopened = await StructureSymmetry.buildAssembly(
      modelSource,
      node.params.assembly_id
    ).run();
    expect(
      reopened.units.map((unit) => ({
        instanceId: unit.conformation.operator.instanceId,
        matrix: [...unit.conformation.operator.matrix],
      }))
    ).toEqual(
      source.units.map((unit) => ({
        instanceId: unit.conformation.operator.instanceId,
        matrix: [...unit.conformation.operator.matrix],
      }))
    );
    const selector = componentPropsFromSelector({
      label_asym_id: 'A',
      instance_id: source.units[1].conformation.operator.instanceId,
    });
    expect(substructureFromSelector(reopened, selector).elementCount).toBe(1);
  });

  it('keeps the starter scene stable across readbacks for screenshot fencing', async () => {
    const plugin = nativeStarterPlugin(await nativeStarterSource());
    const clock = vi.spyOn(Date.prototype, 'toISOString');
    try {
      clock.mockReturnValue('2026-10-20T00:00:00.000Z');
      const before = getMolViewSpecScene(plugin).scene;
      clock.mockReturnValue('2026-10-20T00:00:01.000Z');
      expect(getMolViewSpecScene(plugin).scene).toBe(before);
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps an explicitly loaded model even when assembly definitions are available', async () => {
    const source = await nativeStarterSource();
    expect(starterStructureNode(nativeStarterPlugin(source)).params).toMatchObject({
      type: 'model',
      model_index: 1,
      block_header: 'STARTER_NATIVE_SOURCE',
    });
  });

  it('retains a native assembly placement in the standard MVS transform', async () => {
    const source = await StructureSymmetry.buildAssembly(
      await nativeStarterSource(),
      'paired'
    ).run();
    const placement = Mat4.fromTranslation(Mat4(), [2, 3, 4]);
    const transformed = Structure.transform(source, placement);
    const node = starterStructureNode(nativeStarterPlugin(source, transformed));
    expect(node.params).toMatchObject({ type: 'assembly', assembly_id: 'paired' });
    expect(
      node.children.find((child: { kind: string }) => child.kind === 'transform').params.matrix
    ).toEqual([...placement]);
  });

  it('allows a deliberate in-scene label while validating named color swatches', () => {
    const clean = JSON.parse(scene());
    const componentLabel = structuredClone(clean);
    componentLabel.root.children[0].children[0].children[0].children[0].children.push({
      kind: 'label',
      params: { text: 'HNH' },
    });
    componentLabel.root.children[0].children[0].children[0].children[0].children[0].children[0].custom =
      { dnaforge_legend_label: 'HNH nuclease' };
    expect(() =>
      validateMolViewSpecScene(JSON.stringify(componentLabel), 'structure.pdb')
    ).not.toThrow();
  });
  it('rejects saving a view whose UI-only chain mask would be lost', () => {
    expect(() => requireSerializableMolViewSpecVisibility(['chain-a'])).toThrow(
      /Restore the hidden chains or hide them in the MolViewSpec scene/
    );
    expect(() => requireSerializableMolViewSpecVisibility([])).not.toThrow();
  });
  it('opens a story without spending its wraparound camera transition', () => {
    const root = JSON.parse(scene()).root;
    const document = MVSData.fromMVSJ(
      JSON.stringify({
        kind: 'multiple',
        metadata: { version: '1', timestamp: new Date().toISOString() },
        snapshots: [
          {
            root,
            metadata: { title: 'Overview', linger_duration_ms: 8000, transition_duration_ms: 500 },
          },
          {
            root,
            metadata: { title: 'Detail', linger_duration_ms: 8000, transition_duration_ms: 1000 },
          },
        ],
      })
    );
    const opening = prepareMolViewSpecForOpening(document);
    expect(opening.wraparoundTransitionMs).toBe(1000);
    expect(opening.document.kind).toBe('multiple');
    if (opening.document.kind !== 'multiple' || document.kind !== 'multiple') return;
    expect(opening.document.snapshots[0].metadata.transition_duration_ms).toBe(500);
    expect(opening.document.snapshots[1].metadata.transition_duration_ms).toBe(0);
    expect(document.snapshots[1].metadata.transition_duration_ms).toBe(1000);
    expect(MVSData.isValid(opening.document)).toBe(true);
  });

  it('opens metadata-free story steps with native timing defaults and retains authored bytes', () => {
    const root = JSON.parse(scene()).root;
    const authored = JSON.stringify({
      kind: 'multiple',
      metadata: { version: '1', timestamp: new Date().toISOString() },
      snapshots: [{ root }, { root, metadata: { title: 'Detail' } }],
    });
    const document = validateMolViewSpecScene(authored, 'structure.pdb');
    const opening = prepareMolViewSpecForOpening(document);
    expect(opening.wraparoundTransitionMs).toBeUndefined();
    if (opening.document.kind !== 'multiple') throw Error('Expected native story');
    expect(opening.document.snapshots.map((snapshot) => snapshot.metadata)).toEqual([
      { linger_duration_ms: 1000 },
      { title: 'Detail', linger_duration_ms: 1000 },
    ]);
    expect(MVSData.toMVSJ(document)).toBe(authored);
  });

  it('hides descendants of an inactive source without rewriting authored visibility', () => {
    const authored = MVSData.fromMVSJ(scene());
    if (authored.kind === 'multiple') throw Error('Expected single scene');
    const structure = authored.root.children![0].children![0].children![0];
    structure.custom = { is_hidden: true };
    const representation = structure.children![0].children![0];
    representation.custom = { is_hidden: false };
    structure.children!.push(
      {
        kind: 'primitives',
        params: { opacity: 0.6, label_opacity: 0.8 },
        children: [],
      },
      {
        kind: 'primitives_from_uri',
        params: { uri: 'decoration.json', format: 'mvs-node-json' },
      }
    );
    const untouched = structuredClone(authored);
    const opening = prepareMolViewSpecForOpening(authored).document;
    if (opening.kind === 'multiple') throw Error('Expected single opening');
    const opened = opening.root.children![0].children![0].children![0];
    expect(opened.children![0].custom?.is_hidden).toBe(true);
    expect(opened.children![0].children![0].custom?.is_hidden).toBe(true);
    expect(opened.children!.find((node) => node.kind === 'primitives')?.params).toMatchObject({
      opacity: 0,
      label_opacity: 0,
    });
    expect(opened.children!.some((node) => node.kind === 'primitives_from_uri')).toBe(false);
    expect(authored).toEqual(untouched);

    const active = structuredClone(authored);
    if (active.kind === 'multiple') throw Error('Expected single active scene');
    active.root.children![0].children![0].children![0].custom = { is_hidden: false };
    const activeOpening = prepareMolViewSpecForOpening(active).document;
    if (activeOpening.kind === 'multiple') throw Error('Expected single active opening');
    expect(
      activeOpening.root.children![0].children![0].children![0].children![0].children![0].custom
        ?.is_hidden
    ).toBe(false);
    const activeStructure = activeOpening.root.children![0].children![0].children![0];
    expect(
      activeStructure.children!.find((node) => node.kind === 'primitives')?.params
    ).toMatchObject({
      opacity: 0.6,
      label_opacity: 0.8,
    });
    expect(activeStructure.children!.some((node) => node.kind === 'primitives_from_uri')).toBe(
      true
    );
  });

  it('distinguishes an unchanged apply from a real visible scene edit', () => {
    const current = scene();
    const sameDisplay = JSON.parse(current);
    sameDisplay.metadata.title = 'A new label is not a new view';
    expect(sameMolViewSpecDisplayTree(JSON.stringify(sameDisplay), current, 'structure.pdb')).toBe(
      true
    );

    const changedDisplay = JSON.parse(current);
    changedDisplay.root.children[0].children[0].children[0].children.push({
      kind: 'component',
      params: { selector: 'polymer' },
      children: [{ kind: 'representation', params: { type: 'cartoon' } }],
    });
    expect(
      sameMolViewSpecDisplayTree(JSON.stringify(changedDisplay), current, 'structure.pdb')
    ).toBe(false);
  });

  it('treats reordered JSON object members as the same display tree', () => {
    const current = JSON.parse(scene());
    current.root.custom = { first: 1, second: 2 };
    const reordered = structuredClone(current);
    reordered.root.custom = { second: 2, first: 1 };
    expect(
      sameMolViewSpecDisplayTree(
        JSON.stringify(reordered),
        JSON.stringify(current),
        'structure.pdb'
      )
    ).toBe(true);
  });

  it('keeps the host canvas transparent even when a saved scene contains a canvas node', () => {
    const plugin = molstarPluginFixture({ canvas3d: { setProps: vi.fn() } });
    const builder = MVSData.createBuilder();
    builder.canvas({ background_color: '#2b2f36' });
    configureMolViewSpecCanvasBackground(plugin, builder.getState());
    expect(plugin.canvas3d!.setProps).toHaveBeenLastCalledWith({ transparentBackground: true });

    const saved = JSON.parse(scene());
    saved.root.children.push({ kind: 'canvas', params: { background_color: '#2b2f36' } });
    const clean = stripMolViewSpecCanvasNodes(
      validateMolViewSpecScene(JSON.stringify(saved), 'structure.pdb')
    );
    expect(clean.root.children.some((node) => node.kind === 'canvas')).toBe(false);
    expect(MVSData.isValid(clean)).toBe(true);
    expect(sameLoadedMolViewSpecScene(MVSData.toMVSJ(clean), JSON.stringify(saved))).toBe(true);
    const different = structuredClone(saved);
    different.root.children.find(
      (node: { kind: string }) => node.kind === 'camera'
    ).params.position = [1, 2, 3];
    expect(sameLoadedMolViewSpecScene(MVSData.toMVSJ(clean), JSON.stringify(different))).toBe(
      false
    );
  });

  it('removes colored canvases from every step of an older saved story', () => {
    const first = MVSData.fromMVSJ(scene()) as Parameters<typeof MVSData.stateToStates>[0];
    const second = MVSData.fromMVSJ(scene()) as Parameters<typeof MVSData.stateToStates>[0];
    first.root.children?.push({ kind: 'canvas', params: { background_color: '#ffffff' } });
    second.root.children?.push({ kind: 'canvas', params: { background_color: '#123456' } });
    const story = MVSData.createMultistate([
      { root: first.root, metadata: { title: 'Overview' } },
      { root: second.root, metadata: { title: 'Detail' } },
    ]);
    const clean = stripMolViewSpecCanvasNodes(story);
    expect(clean.kind).toBe('multiple');
    if (clean.kind !== 'multiple') return;
    expect(
      clean.snapshots.every((step) => step.root.children?.every((node) => node.kind !== 'canvas'))
    ).toBe(true);
    expect(MVSData.isValid(clean)).toBe(true);
  });

  it('restores the transparent host canvas when a different structure replaces an MVS scene', () => {
    const plugin = molstarPluginFixture({
      canvas3d: { setProps: vi.fn() },
      managers: { asset: { clearTag: vi.fn() } },
    });
    resetMolViewSpecRuntime(plugin);
    expect(plugin.canvas3d!.setProps).toHaveBeenCalledWith({ transparentBackground: true });
    expect(plugin.managers.asset.clearTag).toHaveBeenCalledWith('dnaforge-mvs-coordinate');
  });

  it('accepts an official builder scene and preserves its camera and appearance', () => {
    const document = validateMolViewSpecScene(scene(), 'structure.pdb');
    expect(MVSData.isValid(document)).toBe(true);
    expect(MVSData.toMVSJ(document)).toContain('#3388ff');
    expect(MVSData.toMVSJ(document)).toContain('camera');
  });

  it('preserves authored atomistic colors and opacity without adding a style rule', () => {
    const input = JSON.parse(scene());
    const structure = input.root.children[0].children[0].children[0];
    const atomistic = structure.children[0].children[0];
    atomistic.children.push({ kind: 'opacity', params: { opacity: 0.55 } });
    structure.children.push({
      kind: 'component',
      params: { selector: 'protein' },
      children: [
        {
          kind: 'representation',
          params: { type: 'cartoon' },
          children: [{ kind: 'opacity', params: { opacity: 0.25 } }],
        },
      ],
    });

    const output = validateMolViewSpecScene(JSON.stringify(input), 'structure.pdb');
    expect(output.root).toEqual(input.root);
    expect(MVSData.isValid(output)).toBe(true);
  });

  it('accepts atom-specific distance annotations from the installed MVS schema', () => {
    const builder = MVSData.createBuilder();
    const structure = builder
      .download({ url: 'structure.pdb' })
      .parse({ format: 'pdb' })
      .modelStructure();
    structure.component({ selector: 'protein' }).representation({ type: 'cartoon' });
    structure.primitives().distance({
      start: { auth_asym_id: 'A', auth_seq_id: 57, auth_atom_id: 'NE2' },
      end: { auth_asym_id: 'A', auth_seq_id: 195, auth_atom_id: 'OG' },
      label_template: '{{distance}} Å',
    });

    const document = validateMolViewSpecScene(MVSData.toMVSJ(builder.getState()), 'structure.pdb');
    expect(MVSData.isValid(document)).toBe(true);
    expect(JSON.stringify(document)).toContain('distance_measurement');
    expect(JSON.stringify(document)).toContain('auth_atom_id');
  });

  it('rejects malformed JSON before any native mutation', () => {
    expect(() => validateMolViewSpecScene('{bad', 'structure.pdb')).toThrow(
      expect.objectContaining({ code: 'MVS_INVALID_SCENE', stateChanged: false })
    );
  });

  it('uses the official schema to reject invented representation names', () => {
    const invalid = scene().replace('ball_and_stick', 'invented_pymol_mode');
    expect(() => validateMolViewSpecScene(invalid, 'structure.pdb')).toThrow(
      expect.objectContaining({ code: 'MVS_INVALID_SCENE', stateChanged: false })
    );
  });

  it('rejects the string selector attempted by the live agent and accepts chain expressions', () => {
    const document = JSON.parse(scene());
    const component = document.root.children[0].children[0].children[0].children[0];
    component.params.selector = 'auth_asym_id G';
    expect(() => validateMolViewSpecScene(JSON.stringify(document), 'structure.pdb')).toThrow(
      expect.objectContaining({ code: 'MVS_INVALID_SCENE', stateChanged: false })
    );
    component.params.selector = { label_asym_id: 'B' };
    expect(
      MVSData.isValid(validateMolViewSpecScene(JSON.stringify(document), 'structure.pdb'))
    ).toBe(true);
  });

  it('rejects unknown expression fields that the upstream partial schema otherwise ignores', () => {
    const document = JSON.parse(scene());
    document.root.children[0].children[0].children[0].children[0].params.selector = {
      and: [{ auth_asym_id: 'G' }, 'polymer'],
    };
    expect(() => validateMolViewSpecScene(JSON.stringify(document), 'structure.pdb')).toThrow(
      expect.objectContaining({ code: 'MVS_INVALID_SCENE', stateChanged: false })
    );
  });

  it('reports external assets as unsupported instead of fetching or silently dropping them', () => {
    expect(() =>
      validateMolViewSpecScene(scene('https://example.org/other.pdb'), 'structure.pdb')
    ).toThrow(expect.objectContaining({ code: 'MVS_UNSUPPORTED_RESOURCE', stateChanged: false }));
  });

  it('accepts only declared pinned resources in a multi-structure story', () => {
    const first = MVSData.fromMVSJ(scene('structure.pdb')) as Parameters<
      typeof MVSData.stateToStates
    >[0];
    const second = MVSData.fromMVSJ(scene('asset-2.pdb')) as Parameters<
      typeof MVSData.stateToStates
    >[0];
    const story = MVSData.toMVSJ(
      MVSData.createMultistate([
        { root: first.root, metadata: { title: 'First', linger_duration_ms: 1000 } },
        { root: second.root, metadata: { title: 'Second', linger_duration_ms: 1000 } },
      ])
    );
    expect(validateMolViewSpecScene(story, ['structure.pdb', 'asset-2.pdb']).kind).toBe('multiple');
    expect(() => validateMolViewSpecScene(story, 'structure.pdb')).toThrow(
      expect.objectContaining({ code: 'MVS_UNSUPPORTED_RESOURCE' })
    );
    expect(() => validateMolViewSpecScene(story, ['structure.pdb', 'asset-3.pdb'])).toThrow(
      expect.objectContaining({ code: 'MVS_UNSUPPORTED_RESOURCE' })
    );
  });

  it('rejects an incompatible major format version', () => {
    const document = JSON.parse(scene());
    document.metadata.version = '999.0';
    expect(() => validateMolViewSpecScene(JSON.stringify(document), 'structure.pdb')).toThrow(
      expect.objectContaining({ code: 'MVS_UNSUPPORTED_VERSION', stateChanged: false })
    );
  });

  it('accepts distinct views of the same coordinate resource as one standard story', () => {
    const first = MVSData.fromMVSJ(scene()) as Parameters<typeof MVSData.stateToStates>[0];
    const second = MVSData.fromMVSJ(scene()) as Parameters<typeof MVSData.stateToStates>[0];
    second.root.children?.push({ kind: 'canvas', params: { background_color: '#123456' } });
    const document = MVSData.createMultistate([
      { root: first.root, metadata: { title: 'Overview', linger_duration_ms: 1000 } },
      { root: second.root, metadata: { title: 'Detail', linger_duration_ms: 1000 } },
    ]);
    const valid = validateMolViewSpecScene(MVSData.toMVSJ(document), 'structure.pdb');
    expect(valid).toEqual(document);
    expect(sameMolViewSpecDisplayTree(MVSData.toMVSJ(document), scene(), 'structure.pdb')).toBe(
      false
    );
  });

  it('rejects an agent scene that changes or removes the existing background', () => {
    const current = JSON.parse(scene());
    current.root.children.push({ kind: 'canvas', params: { background_color: '#fefefe' } });
    const changed = structuredClone(current);
    changed.root.children.find(
      (node: { kind: string }) => node.kind === 'canvas'
    ).params.background_color = '#123456';
    expect(() =>
      requireUnchangedMolViewSpecBackground(
        JSON.stringify(current),
        JSON.stringify(changed),
        'structure.pdb'
      )
    ).toThrow(expect.objectContaining({ code: 'MVS_BACKGROUND_LOCKED', stateChanged: false }));
    changed.root.children = changed.root.children.filter(
      (node: { kind: string }) => node.kind !== 'canvas'
    );
    expect(() =>
      requireUnchangedMolViewSpecBackground(
        JSON.stringify(current),
        JSON.stringify(changed),
        'structure.pdb'
      )
    ).toThrow(expect.objectContaining({ code: 'MVS_BACKGROUND_LOCKED', stateChanged: false }));
    const restyled = structuredClone(current);
    restyled.root.children.find(
      (node: { kind: string }) => node.kind === 'camera'
    ).params.position = [0, 0, 40];
    expect(() =>
      requireUnchangedMolViewSpecBackground(
        JSON.stringify(current),
        JSON.stringify(restyled),
        'structure.pdb'
      )
    ).not.toThrow();
  });

  it('preserves the transparent host background of a starter scene', () => {
    const current = scene();
    const proposed = JSON.parse(current);
    proposed.root.children.push({ kind: 'canvas', params: { background_color: '#ffffff' } });
    expect(() =>
      requireUnchangedMolViewSpecBackground(current, JSON.stringify(proposed), 'structure.pdb')
    ).toThrow(expect.objectContaining({ code: 'MVS_BACKGROUND_LOCKED', stateChanged: false }));
  });

  it('rejects a changed background in any story step before applying the story', () => {
    const current = JSON.parse(scene());
    current.root.children.push({ kind: 'canvas', params: { background_color: '#fefefe' } });
    const second = structuredClone(current);
    second.root.children.find(
      (node: { kind: string }) => node.kind === 'canvas'
    ).params.background_color = '#123456';
    const story = MVSData.createMultistate([
      { root: current.root, metadata: { title: 'Overview' } },
      { root: second.root, metadata: { title: 'Detail' } },
    ]);
    expect(() =>
      requireUnchangedMolViewSpecBackground(
        JSON.stringify(current),
        MVSData.toMVSJ(story),
        'structure.pdb'
      )
    ).toThrow(expect.objectContaining({ code: 'MVS_BACKGROUND_LOCKED', stateChanged: false }));
    expect(() =>
      requireUnchangedMolViewSpecBackground(
        MVSData.toMVSJ(story),
        MVSData.toMVSJ(story),
        'structure.pdb',
        0,
        1
      )
    ).toThrow(expect.objectContaining({ code: 'MVS_BACKGROUND_LOCKED', stateChanged: false }));
  });

  it('checks every story step for unsupported coordinate resources', () => {
    const first = MVSData.fromMVSJ(scene()) as Parameters<typeof MVSData.stateToStates>[0];
    const second = MVSData.fromMVSJ(scene('other.pdb')) as Parameters<
      typeof MVSData.stateToStates
    >[0];
    const document = MVSData.createMultistate([
      { root: first.root, metadata: { title: 'Overview', linger_duration_ms: 1000 } },
      { root: second.root, metadata: { title: 'Detail', linger_duration_ms: 1000 } },
    ]);
    expect(() => validateMolViewSpecScene(MVSData.toMVSJ(document), 'structure.pdb')).toThrow(
      expect.objectContaining({ code: 'MVS_UNSUPPORTED_RESOURCE', stateChanged: false })
    );
  });
});
