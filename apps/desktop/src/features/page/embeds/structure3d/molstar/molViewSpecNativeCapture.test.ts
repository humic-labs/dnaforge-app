import { markExtensionDrawing } from './extension-render-capture';
import { molstarPluginFixture } from '@/test/fixtures/molstar-plugin';
import { describe, expect, it, vi } from 'vitest';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { CIF } from 'molstar/lib/mol-io/reader/cif';
import { trajectoryFromMmCIF } from 'molstar/lib/mol-model-formats/structure/mmcif';
import { Structure } from 'molstar/lib/mol-model/structure';
import { PluginStateObject } from 'molstar/lib/mol-plugin-state/objects';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra';
import {
  componentPropsFromSelector,
  representationProps,
  colorThemeForNode,
} from 'molstar/lib/extensions/mvs/load-helpers';
import { substructureFromSelector } from 'molstar/lib/extensions/mvs/components/selector';
import { isHydrogen } from 'molstar/lib/mol-repr/structure/visual/util/common';
import {
  captureMolViewSpecView,
  acceptSavedMolViewSpecView,
  commitCurrentMolViewSpecCamera,
  getMolViewSpecScene,
  validateMolViewSpecScene,
} from './molViewSpec';
import {
  MolecularNativeCaptureExtension,
  nativeMolecularSelector,
} from './molViewSpecNativeCapture';

const coordinates = `data_native_capture
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
ATOM 1 C CA . ALA A 1 1 0 0 0 1 10 1 ALA A CA 1
ATOM 2 C CB . ALA A 1 1 1 0 0 1 10 1 ALA A CB 1
ATOM 3 C CA . GLY A 1 2 3 0 0 1 10 2 GLY A CA 1
ATOM 4 C CA . ALA B 2 1 0 5 0 1 10 1 ALA B CA 1
#
`;

async function nativeView(includeHydrogens = false) {
  const text = includeHydrogens
    ? coordinates.replace(
        '#\n',
        `ATOM 5 H H1 . ALA A 1 1 1 1 0 1 10 1 ALA A H1 1
ATOM 6 D D1 . ALA A 1 1 1 -1 0 1 10 1 ALA A D1 1
ATOM 7 T T1 . ALA A 1 1 1 0 1 1 10 1 ALA A T1 1
#
`
      )
    : coordinates;
  const parsed = await CIF.parseText(text).run();
  if (parsed.isError) throw Error(parsed.message);
  const trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
  const source = Structure.ofModel(trajectory.representative);
  const selected = substructureFromSelector(
    source,
    componentPropsFromSelector({ label_asym_id: 'A' })
  );
  const props = {
    alpha: 0.4,
    sizeFactor: 0.27,
    tubularHelices: true,
    visuals: ['polymer-trace'],
    quality: 'custom',
  };
  const representation = {
    props,
    state: {
      visible: true,
      alphaFactor: 0.5,
      transform: Mat4.identity(),
      overpaint: { layers: [] },
      transparency: { layers: [] },
      substance: { layers: [] },
      clipping: { layers: [] },
      emissive: { layers: [] },
      themeStrength: { overpaint: 1, transparency: 1 },
    },
    theme: { color: { color: () => 0x224466, granularity: 'uniform' } },
    getAllLoci: () => [Structure.Loci(selected)],
  };
  const ref = {
    cell: {
      transform: { ref: 'native-representation' },
      state: { isHidden: false },
      params: {
        values: {
          type: { name: 'cartoon', params: props },
          colorTheme: { name: 'uniform', params: { value: 0x224466 } },
          sizeTheme: { name: 'uniform', params: { value: 1.3 } },
        },
      },
      obj: { data: { repr: representation } },
    },
  };
  const component = {
    cell: {
      transform: { ref: 'native-component' },
      state: { isHidden: false },
      obj: { label: 'Actual chain A', data: selected },
    },
    representations: [ref],
  };
  const camera = {
    target: [0, 0, 0],
    position: [0, 0, 30],
    up: [0, 1, 0],
    minNear: 1,
    mode: 'perspective',
    fov: Math.PI / 4,
  };
  const plugin = molstarPluginFixture({
    state: {
      data: {
        cells: new Map([['coordinates', { obj: new PluginStateObject.Data.String(text) }]]),
      },
    },
    managers: {
      asset: { set: vi.fn() },
      snapshot: { state: { entries: { toArray: () => [] } } },
      structure: {
        hierarchy: {
          current: { structures: [{ cell: { obj: { data: source } }, components: [component] }] },
        },
      },
    },
    canvas3d: { camera: { getSnapshot: () => structuredClone(camera) } },
  });
  return { plugin, source, selected, representation, ref, camera };
}

function exportedRepresentation(scene: string) {
  const document = MVSData.fromMVSJ(scene);
  if (document.kind === 'multiple') throw Error('Expected one captured raw view');
  return document.root.children![0].children![0].children![0].children![0].children![0];
}

describe('faithful native raw-view capture', () => {
  it('refuses to export an active extension as a native scene', async () => {
    const { plugin } = await nativeView();
    const release = markExtensionDrawing(plugin);
    expect(() => captureMolViewSpecView(plugin)).toThrow('Switch to a built-in view');
    release();
    expect(captureMolViewSpecView(plugin).scene).toBeTruthy();
  });

  it('captures actual native membership, appearance and camera without applying the proposed starter', async () => {
    const f = await nativeView();
    const captured = captureMolViewSpecView(f.plugin);
    expect(captured.coordinates.text).toBe(coordinates);
    expect(captured.scene).toBe(captureMolViewSpecView(f.plugin).scene);
    validateMolViewSpecScene(captured.scene, 'structure.cif');
    const document = JSON.parse(captured.scene);
    const component = document.root.children[0].children[0].children[0].children[0];
    const restored = substructureFromSelector(
      f.source,
      componentPropsFromSelector(component.params.selector)
    );
    expect(restored.elementCount).toBe(f.selected.elementCount);
    expect(restored.elementCount).toBe(3);
    const representation = exportedRepresentation(captured.scene);
    expect(representationProps(representation).type?.params).toMatchObject({
      alpha: 0.2,
      sizeFactor: 0.27,
      tubularHelices: true,
      visuals: ['polymer-trace'],
    });
    expect(colorThemeForNode(representation, {} as never)).toEqual({
      name: 'uniform',
      params: { value: 0x224466 },
    });
    expect(
      document.root.children.find((node: { kind: string }) => node.kind === 'camera').params.target
    ).toEqual(f.camera.target);
    expect(getMolViewSpecScene(f.plugin).sceneOrigin).toBe('starter');
    expect(acceptSavedMolViewSpecView(f.plugin, captured, captured.scene)).toBe(true);
    expect(getMolViewSpecScene(f.plugin).sceneOrigin).toBe('authored');
  });

  it('keeps a newer native edit instead of adopting an asynchronously completed raw save', async () => {
    const f = await nativeView();
    const captured = captureMolViewSpecView(f.plugin);
    f.representation.props.sizeFactor = 0.6;
    expect(acceptSavedMolViewSpecView(f.plugin, captured, captured.scene)).toBe(false);
    expect(getMolViewSpecScene(f.plugin).sceneOrigin).toBe('starter');
  });

  it('preserves authored scene and separate camera metadata while the user explores a different pose', async () => {
    const f = await nativeView();
    const original = captureMolViewSpecView(f.plugin);
    expect(acceptSavedMolViewSpecView(f.plugin, original, original.scene)).toBe(true);
    f.camera.position = [12, 8, 40];
    const exploratoryCamera = structuredClone(f.camera);
    const options = {
      cameraPolicy: 'preserve-authored' as const,
      authoredCameraSnapshot: JSON.stringify(exploratoryCamera),
      savedCameraBaseline: { scene: original.scene, cameraSnapshot: original.cameraSnapshot },
    };
    const retained = captureMolViewSpecView(f.plugin, options);
    expect(retained.scene).toBe(original.scene);
    expect(retained.cameraSnapshot).toBe(original.cameraSnapshot);
    expect(captureMolViewSpecView(f.plugin).scene).not.toBe(original.scene);
    expect(acceptSavedMolViewSpecView(f.plugin, retained, retained.scene, options)).toBe(true);
    expect(f.camera).toEqual(exploratoryCamera);
    expect(captureMolViewSpecView(f.plugin, options)).toEqual(retained);
  });

  it('records current framing only through the explicit action and keeps it during ordinary Save', async () => {
    const f = await nativeView();
    const original = captureMolViewSpecView(f.plugin);
    expect(acceptSavedMolViewSpecView(f.plugin, original, original.scene)).toBe(true);
    f.camera.position = [12, 8, 40];
    const committed = commitCurrentMolViewSpecCamera(f.plugin);
    expect(committed.scene).not.toBe(original.scene);
    expect(committed.cameraSnapshot).toBe(JSON.stringify(f.camera));
    f.camera.position = [24, 8, 40];
    const retained = captureMolViewSpecView(f.plugin, {
      cameraPolicy: 'preserve-authored',
      authoredCameraSnapshot: original.cameraSnapshot,
      savedCameraBaseline: { scene: original.scene, cameraSnapshot: original.cameraSnapshot },
    });
    expect(retained.scene).toBe(committed.scene);
    expect(retained.cameraSnapshot).toBe(committed.cameraSnapshot);
  });

  it('still captures the current pose on the first raw save under the UI camera policy', async () => {
    const f = await nativeView();
    f.camera.position = [12, 8, 40];
    const current = captureMolViewSpecView(f.plugin);
    expect(
      captureMolViewSpecView(f.plugin, {
        cameraPolicy: 'preserve-authored',
        authoredCameraSnapshot: 'old standalone camera metadata',
      })
    ).toEqual(current);
  });

  it('retains native size themes and exact partial atom selections at the MVS loading boundary', async () => {
    const f = await nativeView();
    Object.assign(f.ref.cell.params.values.sizeTheme, { name: 'physical', params: { scale: 1.7 } });
    const captured = captureMolViewSpecView(f.plugin);
    const node = exportedRepresentation(captured.scene);
    const update = vi.fn();
    const target = {
      selector: {},
      transformParams: representationProps(node),
      update: { to: () => ({ update }) },
    };
    MolecularNativeCaptureExtension.action(target as never, node as never, {} as never, undefined);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ sizeTheme: { name: 'physical', params: { scale: 1.7 } } })
    );
    const partial = substructureFromSelector(
      f.source,
      componentPropsFromSelector({ atom_index: 1 })
    );
    const selector = nativeMolecularSelector(partial, f.source);
    expect(selector).toEqual([
      { atom_index: 1, instance_id: f.source.units[0].conformation.operator.instanceId },
    ]);
    expect(
      substructureFromSelector(f.source, componentPropsFromSelector(selector)).elementCount
    ).toBe(1);
  });

  it('records hidden native representations and rejects unsupported states explicitly', async () => {
    const f = await nativeView();
    f.ref.cell.state.isHidden = true;
    const captured = captureMolViewSpecView(f.plugin);
    expect(exportedRepresentation(captured.scene).custom?.is_hidden).toBe(true);
    f.ref.cell.params.values.type.name = 'label';
    expect(() => captureMolViewSpecView(f.plugin)).toThrow(
      /cannot be saved exactly.*representation/i
    );
  });

  it('suppresses H, D and T with the native all-hydrogen policy and ignores invisible hydrogen geometry', async () => {
    const f = await nativeView(true);
    f.ref.cell.params.values.type.name = 'spacefill';
    Object.assign(f.representation.props, {
      ignoreHydrogens: false,
      ignoreHydrogensVariant: 'all',
    });
    const hydrogenSymbols: string[] = [];
    for (const unit of f.source.units) {
      for (const atom of Array.from(unit.elements)) {
        if (isHydrogen(f.source, unit, atom, 'all'))
          hydrogenSymbols.push(unit.model.atomicHierarchy.atoms.type_symbol.value(atom));
      }
    }
    expect(hydrogenSymbols.sort()).toEqual(['D', 'H', 'T']);
    expect(() => captureMolViewSpecView(f.plugin)).toThrow(/visible hydrogens/i);

    f.ref.cell.state.isHidden = true;
    expect(exportedRepresentation(captureMolViewSpecView(f.plugin).scene).custom?.is_hidden).toBe(
      true
    );
    f.ref.cell.state.isHidden = false;
    Object.assign(f.representation.props, { ignoreHydrogens: true });
    expect(
      representationProps(exportedRepresentation(captureMolViewSpecView(f.plugin).scene)).type
        ?.params
    ).toMatchObject({ ignoreHydrogens: true, ignoreHydrogensVariant: 'all' });
  });
});
