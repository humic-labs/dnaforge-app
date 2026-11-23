import { markExtensionDrawing } from './extension-render-capture';
import { OrderedSet } from 'molstar/lib/mol-data/int';
import { Mesh } from 'molstar/lib/mol-geo/geometry/mesh/mesh';
import { EmptyLoci } from 'molstar/lib/mol-model/loci';
import { Shape, ShapeGroup } from 'molstar/lib/mol-model/shape';
import { Structure, StructureElement, Unit } from 'molstar/lib/mol-model/structure';
import { ShapeRepresentation } from 'molstar/lib/mol-repr/shape/representation';
import { Color } from 'molstar/lib/mol-util/color';
import { ValueCell } from 'molstar/lib/mol-util';
import type { MolstarPlugin } from './cache';
import { extensionRibbonMaterial, type RibbonMaterial } from './extension-render-material';

interface ResidueKey {
  chainId: string;
  resSeq: number;
  iCode: string;
  name: string;
}
interface Ribbon extends RibbonMaterial {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  residues: ResidueKey[];
}

function validateRibbon(input: unknown): asserts input is Ribbon {
  if (!input || typeof input !== 'object') throw new Error('The extension returned no ribbon.');
  const r = input as Partial<Ribbon>;
  const vertices = (r.positions?.length ?? 0) / 3;
  if (
    !Number.isInteger(vertices) ||
    vertices < 3 ||
    vertices > 2_000_000 ||
    !(r.indices instanceof Uint32Array) ||
    !r.indices.length ||
    r.indices.length % 3 !== 0 ||
    r.indices.length > 12_000_000 ||
    !Array.isArray(r.residues) ||
    !r.residues.length ||
    r.residues.length > 500_000 ||
    typeof r.shaderGLSL !== 'string' ||
    r.shaderGLSL.length > 65536 ||
    typeof r.helpersGLSL !== 'string' ||
    r.helpersGLSL.length > 65536
  )
    throw new Error('Unsupported extension ribbon format.');
  for (const [field, width] of [
    ['positions', 3],
    ['normals', 3],
    ['tangents', 3],
    ['info', 4],
    ['surf', 4],
    ['phys', 4],
  ] as const) {
    const data = r[field];
    if (
      !(data instanceof Float32Array) ||
      data.length !== vertices * width ||
      !data.every(Number.isFinite)
    )
      throw new Error(`Invalid ribbon attribute ${field}.`);
  }
  for (const index of r.indices)
    if (index >= vertices) throw new Error('Ribbon triangle refers to a missing vertex.');
  for (let v = 0; v < vertices; v++) {
    const group = r.info![v * 4 + 1];
    if (!Number.isInteger(group) || group < 0 || group >= r.residues.length)
      throw new Error('Missing ribbon residue.');
  }
  for (const k of r.residues) {
    if (
      !k ||
      typeof k.chainId !== 'string' ||
      typeof k.iCode !== 'string' ||
      typeof k.name !== 'string' ||
      !Number.isSafeInteger(k.resSeq)
    )
      throw new Error('Invalid ribbon residue identity.');
  }
}

type Copy = {
  transform: Unit.Atomic['conformation']['operator']['matrix'];
  loci: Map<number, StructureElement.Loci>;
  groupsByUnit: Map<number, Map<number, number>>;
};

function residueKey(chain: string, seq: number, insertion: string, name: string) {
  return JSON.stringify([chain, seq, insertion, name]);
}

function resolveCopies(structure: Structure, residues: ResidueKey[]) {
  const groups = new Map(
    residues.map((r, i) => [residueKey(r.chainId, r.resSeq, r.iCode, r.name), i])
  );
  if (groups.size !== residues.length)
    throw new Error('The extension returned ambiguous residue identities.');
  const copies = new Map<string, Copy>();
  for (const unit of structure.units) {
    if (!Unit.isAtomic(unit)) continue;
    const h = unit.model.atomicHierarchy;
    const groupsByResidue = new Map<number, number>();
    for (let i = 0; i < unit.elements.length; ) {
      const atom = unit.elements[i];
      const residue = unit.residueIndex[atom];
      const start = i++;
      while (i < unit.elements.length && unit.residueIndex[unit.elements[i]] === residue) i++;
      const group = groups.get(
        residueKey(
          h.chains.auth_asym_id.value(unit.chainIndex[atom]),
          h.residues.auth_seq_id.value(residue),
          h.residues.pdbx_PDB_ins_code.value(residue),
          h.atoms.label_comp_id.value(atom)
        )
      );
      if (group === undefined) continue;
      const op = unit.conformation.operator;
      let copy = copies.get(op.instanceId);
      if (!copy) {
        copy = { transform: op.matrix, loci: new Map(), groupsByUnit: new Map() };
        copies.set(op.instanceId, copy);
      }
      const indices = OrderedSet.ofBounds(
        start as StructureElement.UnitIndex,
        i as StructureElement.UnitIndex
      );
      const existing = copy.loci.get(group);
      if (existing)
        throw new Error('The extension residue matches multiple units in the same assembly copy.');
      copy.loci.set(group, StructureElement.Loci(structure, [{ unit, indices }]));
      groupsByResidue.set(residue, group);
      copy.groupsByUnit.set(unit.id, groupsByResidue);
    }
  }
  if (!copies.size) throw new Error('The ribbon residues do not match the loaded structure.');
  return copies;
}

function makeRepresentation(
  structure: Structure,
  data: Ribbon,
  copy: Copy,
  groups: Float32Array,
  material: ReturnType<typeof extensionRibbonMaterial>
) {
  let indices = data.indices;
  if (copy.loci.size !== data.residues.length) {
    const included: number[] = [];
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i],
        b = indices[i + 1],
        c = indices[i + 2];
      if (copy.loci.has(groups[a]) && copy.loci.has(groups[b]) && copy.loci.has(groups[c]))
        included.push(a, b, c);
    }
    if (!included.length) return;
    indices = Uint32Array.from(included);
  }
  const mesh = Mesh.create(
    data.positions,
    indices,
    data.normals,
    groups,
    groups.length,
    indices.length / 3
  );
  ValueCell.update(mesh.varyingGroup, true);
  mesh.meta.dnaforgeMeshMaterial = material;
  const shape = Shape.create(
    'Extension ribbon',
    data,
    mesh,
    () => Color(0xffffff),
    () => 1,
    (group) => {
      const r = data.residues[group];
      return `${r.chainId} ${r.name} ${r.resSeq}${r.iCode}`;
    },
    [copy.transform],
    data.residues.length
  );
  const repr = ShapeRepresentation(() => shape, Mesh.Utils);
  const originalPick = repr.getLoci;
  repr.getLoci = (id) => {
    const picked = originalPick(id);
    return ShapeGroup.isLoci(picked) ? (copy.loci.get(id.groupId) ?? EmptyLoci) : EmptyLoci;
  };
  const originalMark = repr.mark;
  repr.mark = (loci, action) => {
    if (!StructureElement.Loci.is(loci)) return originalMark(loci, action);
    if (loci.structure.root !== structure.root) return false;
    const remapped = StructureElement.Loci.remap(loci, structure);
    const matched = new Set<number>();
    for (const { unit, indices } of remapped.elements) {
      if (!Unit.isAtomic(unit)) continue;
      const byResidue = copy.groupsByUnit.get(unit.id);
      if (!byResidue) continue;
      OrderedSet.forEach(indices, (index) => {
        const group = byResidue.get(unit.residueIndex[unit.elements[index]]);
        if (group !== undefined) matched.add(group);
      });
    }
    if (!matched.size) return false;
    return originalMark(
      ShapeGroup.Loci(shape, [
        { ids: OrderedSet.ofSortedArray([...matched].sort((a, b) => a - b)), instance: 0 },
      ]),
      action
    );
  };
  return { repr, shape };
}

export async function activateExtensionRender(
  plugin: MolstarPlugin,
  result: unknown,
  signal: AbortSignal
): Promise<() => void> {
  signal.throwIfAborted();
  validateRibbon(result);
  const canvas = plugin.canvas3d;
  if (!canvas) throw new Error('The protein viewer is unavailable.');
  const entries = plugin.managers.structure.hierarchy.current.structures;
  const entry = entries[0];
  const structure = entry?.transform?.cell.obj?.data ?? entry?.cell.obj?.data;
  if (entries.length !== 1 || !structure || structure.models.length !== 1)
    throw new Error('Select a single molecular structure to display this extension.');
  const copies = resolveCopies(structure, result.residues);
  if (copies.size * result.positions.length > 36_000_000)
    throw new Error('This assembly exceeds the prototype ribbon drawing limit.');
  const groups = Float32Array.from(
    { length: result.positions.length / 3 },
    (_, i) => result.info[i * 4 + 1]
  );
  const material = extensionRibbonMaterial(result);
  const representations = [...copies.values()]
    .map((copy) => makeRepresentation(structure, result, copy, groups, material))
    .filter((value) => !!value);
  if (!representations.length) throw new Error('No matching ribbon geometry for this assembly.');
  const hidden = entry.components
    .flatMap((component) => component.representations)
    .filter((ref) => {
      const native = ref.cell.obj?.data.repr;
      return (
        native?.state.visible &&
        ['cartoon', 'backbone', 'putty'].includes(ref.cell.params?.values.type?.name ?? '')
      );
    });
  let releaseCaptureGuard: (() => void) | undefined;
  let attached = false;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    releaseCaptureGuard?.();
    signal.removeEventListener('abort', dispose);
    for (const { repr } of representations) {
      canvas.remove(repr);
      repr.destroy();
    }
    if (attached)
      for (const ref of hidden) {
        const native = ref.cell.obj?.data.repr;
        if (
          native &&
          plugin.state.data.cells.get(ref.cell.transform.ref) === ref.cell &&
          !ref.cell.state.isHidden
        )
          native.setState({ visible: true });
      }
    canvas.syncVisibility();
    canvas.requestDraw();
  };
  try {
    for (const { repr, shape } of representations) {
      await repr
        .createOrUpdate({ doubleSided: true, ignoreLight: true, quality: 'custom' }, shape)
        .run();
      signal.throwIfAborted();
    }
    if (entry !== plugin.managers.structure.hierarchy.current.structures[0])
      throw new Error('The molecular view changed during extension activation.');
    for (const { repr } of representations) canvas.add(repr);
    attached = true;
    releaseCaptureGuard = markExtensionDrawing(plugin);
    for (const ref of hidden) ref.cell.obj!.data.repr.setState({ visible: false });
    canvas.commit(true);
    canvas.syncVisibility();
    canvas.requestDraw();
    signal.addEventListener('abort', dispose, { once: true });
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}
