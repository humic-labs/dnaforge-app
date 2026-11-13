import { ParamDefinition as PD } from 'molstar/lib/mol-util/param-definition';
import { Unit, Structure, type ElementIndex } from 'molstar/lib/mol-model/structure';
import { isNucleic } from 'molstar/lib/mol-model/structure/model/types';
import { StructureSubsetBuilder } from 'molstar/lib/mol-model/structure/structure/util/subset-builder';
import { componentPropsFromSelector } from 'molstar/lib/extensions/mvs/load-helpers';
import { substructureFromSelector } from 'molstar/lib/extensions/mvs/components/selector';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra';
import { Sphere3D } from 'molstar/lib/mol-math/geometry';
import { Mesh } from 'molstar/lib/mol-geo/geometry/mesh/mesh';
import { MeshBuilder } from 'molstar/lib/mol-geo/geometry/mesh/mesh-builder';
import { addCylinder } from 'molstar/lib/mol-geo/geometry/mesh/builder/cylinder';
import { addSphere } from 'molstar/lib/mol-geo/geometry/mesh/builder/sphere';
import { Segmentation } from 'molstar/lib/mol-data/int';
import { UnitsMeshParams, UnitsMeshVisual } from 'molstar/lib/mol-repr/structure/units-visual';
import { UnitsRepresentation } from 'molstar/lib/mol-repr/structure/units-representation';
import { Representation, type RepresentationContext } from 'molstar/lib/mol-repr/representation';
import {
  StructureRepresentationStateBuilder,
  StructureRepresentationProvider,
  type StructureRepresentation,
} from 'molstar/lib/mol-repr/structure/representation';
import {
  CartoonParams,
  CartoonRepresentationProvider,
  getCartoonParams,
} from 'molstar/lib/mol-repr/structure/representation/cartoon';
import {
  BallAndStickParams,
  BallAndStickRepresentationProvider,
  getBallAndStickParams,
} from 'molstar/lib/mol-repr/structure/representation/ball-and-stick';
import { LineRepresentationProvider } from 'molstar/lib/mol-repr/structure/representation/line';
import { InteractionsRepresentationProvider } from 'molstar/lib/mol-model-props/computed/representations/interactions';
import { coordinationDepictionStructure } from './molecularCoordination';
import { primaryMolecularConformer } from './molecularPrimaryConformer';
import { PolymerTraceVisual } from 'molstar/lib/mol-repr/structure/visual/polymer-trace-mesh';
import { PolymerGapVisual } from 'molstar/lib/mol-repr/structure/visual/polymer-gap-cylinder';
import { PolymerDirectionVisual } from 'molstar/lib/mol-repr/structure/visual/polymer-direction-wedge';
import { NucleotideBlockVisual } from 'molstar/lib/mol-repr/structure/visual/nucleotide-block-mesh';
import { NucleotideRingVisual } from 'molstar/lib/mol-repr/structure/visual/nucleotide-ring-mesh';
import { NucleotideAtomicRingFillVisual } from 'molstar/lib/mol-repr/structure/visual/nucleotide-atomic-ring-fill';
import { NucleotideAtomicBondVisual } from 'molstar/lib/mol-repr/structure/visual/nucleotide-atomic-bond';
import { NucleotideAtomicElementVisual } from 'molstar/lib/mol-repr/structure/visual/nucleotide-atomic-element';
import {
  NucleotideLocationIterator,
  getNucleotideElementLoci,
  eachNucleotideElement,
  getNucleotideBaseType,
  createNucleicIndices,
  setPurinIndices,
  setPyrimidineIndices,
  hasPurinIndices,
  hasPyrimidineIndices,
} from 'molstar/lib/mol-repr/structure/visual/util/nucleotide';
import type { ThemeRegistryContext } from 'molstar/lib/mol-theme/theme';
import type { PluginContext } from 'molstar/lib/mol-plugin/context';
import {
  NUCLEOTIDE_BASE_PLANE_VISUAL,
  NUCLEOTIDE_CONNECTOR_VISUAL,
  type MolecularProfileNode,
} from './nucleotidePresentationSettings';

export {
  NUCLEOTIDE_BASE_PLANE_VISUAL,
  NUCLEOTIDE_CONNECTOR_VISUAL,
} from './nucleotidePresentationSettings';
import {
  filterNucleotideAtomicStructure,
  type NucleotideAtomicMode,
} from './nucleotideAtomicSelection';
export {
  filterNucleotideAtomicStructure,
  type NucleotideAtomicMode,
} from './nucleotideAtomicSelection';

const exclusionCache = new WeakMap<Structure, Map<string, Map<number, Set<number>>>>();
function excludedResidues(
  structure: Structure,
  selectors: readonly unknown[]
): Map<number, Set<number>> {
  if (!selectors.length) return new Map();
  let cache = exclusionCache.get(structure);
  if (!cache) exclusionCache.set(structure, (cache = new Map()));
  const key = JSON.stringify(selectors);
  const cached = cache.get(key);
  if (cached) return cached;
  const residues = new Map<number, Set<number>>();
  for (const selector of selectors) {
    const selected = substructureFromSelector(
      structure,
      componentPropsFromSelector(selector as Parameters<typeof componentPropsFromSelector>[0])
    );
    for (const unit of selected.units ?? []) {
      if (!Unit.isAtomic(unit)) continue;
      const set = residues.get(unit.id) ?? new Set<number>();
      for (let i = 0; i < unit.elements.length; i++) {
        const atom = unit.elements[i];
        const residue = unit.model.atomicHierarchy.residueAtomSegments.index[atom];
        if (isNucleic(unit.model.atomicHierarchy.derived.residue.moleculeType[residue]))
          set.add(residue);
      }
      residues.set(unit.id, set);
    }
  }
  cache.set(key, residues);
  return residues;
}

export function filterNucleotideVisualStructure(
  structure: Structure,
  selectors: readonly unknown[]
): Structure {
  if (!selectors.length) return structure;
  const exclusions = excludedResidues(structure, selectors);
  const subset = new StructureSubsetBuilder(structure, true);
  for (const unit of structure.units) {
    subset.beginUnit(unit.id);
    const ignored = exclusions.get(unit.id);
    for (let i = 0; i < unit.elements.length; i++) {
      const atom = unit.elements[i];
      if (
        !Unit.isAtomic(unit) ||
        !ignored?.has(unit.model.atomicHierarchy.residueAtomSegments.index[atom])
      )
        subset.addElement(atom);
    }
    subset.commitUnit();
  }
  return subset.elementCount === structure.elementCount ? structure : subset.getStructure();
}

const meshParams = {
  ...UnitsMeshParams,
  sizeFactor: PD.Numeric(0.2, { min: 0, max: 10, step: 0.01 }),
  thicknessFactor: PD.Numeric(1, { min: 0, max: 2, step: 0.01 }),
  radialSegments: PD.Numeric(16, { min: 2, max: 56, step: 2 }),
  dnaforgeNucleotideExclude: PD.Value<unknown[]>([]),
};
type MeshProps = PD.Values<typeof meshParams>;
type Shape = 'plane' | 'connector' | 'ring';

const purineStrip = new Uint32Array([
  0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 14, 15, 12, 13, 8, 9, 10, 11, 0, 1,
]);
const purineTop = new Uint32Array([8, 12, 14, 16, 6, 4, 2, 0, 10]);
const purineBottom = new Uint32Array([9, 11, 1, 3, 5, 7, 17, 15, 13]);
const pyrimidineStrip = new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0, 1]);
const pyrimidineTop = new Uint32Array([0, 10, 8, 6, 4, 2]);
const pyrimidineBottom = new Uint32Array([1, 3, 5, 7, 9, 11]);

export function createNucleotidePresentationMesh(
  unit: Unit,
  structure: Structure,
  props: Pick<
    MeshProps,
    'sizeFactor' | 'thicknessFactor' | 'radialSegments' | 'dnaforgeNucleotideExclude'
  >,
  shape: Shape,
  previous?: Mesh
): Mesh {
  if (!Unit.isAtomic(unit) || !unit.nucleotideElements.length) return Mesh.createEmpty(previous);
  const state = MeshBuilder.createState(unit.nucleotideElements.length * 100, 100, previous);
  const ignored = excludedResidues(structure, props.dnaforgeNucleotideExclude ?? []).get(unit.id);
  const { chainAtomSegments, residueAtomSegments } = unit.model.atomicHierarchy;
  const chainIt = Segmentation.transientSegments(chainAtomSegments, unit.elements);
  const residueIt = Segmentation.transientSegments(residueAtomSegments, unit.elements);
  const normal = Vec3(),
    shift = Vec3(),
    tmp = Vec3(),
    start = Vec3(),
    end = Vec3();
  let group = 0;
  while (chainIt.hasNext) {
    residueIt.setSegment(chainIt.move());
    while (residueIt.hasNext) {
      const { index: residue } = residueIt.move();
      if (!isNucleic(unit.model.atomicHierarchy.derived.residue.moleculeType[residue])) continue;
      state.currentGroup = group++;
      if (ignored?.has(residue)) continue;
      const indices = createNucleicIndices();
      const { isPurine, isPyrimidine } = getNucleotideBaseType(unit, residue);
      if (isPurine) setPurinIndices(indices, unit, residue);
      else if (isPyrimidine) setPyrimidineIndices(indices, unit, residue);
      else continue;
      const attachment = isPurine ? indices.N9 : indices.N1;
      if (shape !== 'plane' && attachment !== -1 && indices.trace !== -1) {
        unit.conformation.invariantPosition(attachment, start);
        unit.conformation.invariantPosition(indices.trace, end);
        addCylinder(state, start, end, 1, {
          radiusTop: props.sizeFactor,
          radiusBottom: props.sizeFactor,
          radialSegments: props.radialSegments,
        });
        if (shape === 'ring') addSphere(state, start, props.sizeFactor, 0);
      }
      if (
        shape === 'connector' ||
        !(isPurine ? hasPurinIndices(indices) : hasPyrimidineIndices(indices))
      )
        continue;
      const atoms = isPurine
        ? [
            indices.N1,
            indices.C2,
            indices.N3,
            indices.C4,
            indices.C5,
            indices.C6,
            indices.N7,
            indices.C8,
            indices.N9,
          ]
        : [indices.N1, indices.C2, indices.N3, indices.C4, indices.C5, indices.C6];
      const points = atoms.map((atom) =>
        unit.conformation.invariantPosition(atom as ElementIndex, Vec3())
      );
      Vec3.triangleNormal(normal, points[0], points[3], points[4]);
      Vec3.scale(shift, normal, props.sizeFactor * props.thicknessFactor);
      const positions = new Float32Array(points.length * 6);
      for (let i = 0; i < points.length; i++) {
        Vec3.toArray(Vec3.add(tmp, points[i], shift), positions, i * 6);
        Vec3.toArray(Vec3.sub(tmp, points[i], shift), positions, i * 6 + 3);
      }
      MeshBuilder.addTriangleStrip(state, positions, isPurine ? purineStrip : pyrimidineStrip);
      MeshBuilder.addTriangleFan(state, positions, isPurine ? purineTop : pyrimidineTop);
      MeshBuilder.addTriangleFan(state, positions, isPurine ? purineBottom : pyrimidineBottom);
    }
  }
  const mesh = MeshBuilder.getMesh(state);
  mesh.setBoundingSphere(Sphere3D.expand(Sphere3D(), unit.boundary.sphere, props.sizeFactor));
  return mesh;
}

function nucleotideVisual(shape: Shape, materialId: number) {
  return UnitsMeshVisual(
    {
      defaultProps: PD.getDefaultValues(meshParams),
      createGeometry: (_ctx, unit, structure, _theme, props, previous) =>
        createNucleotidePresentationMesh(unit, structure, props, shape, previous),
      createLocationIterator: NucleotideLocationIterator.fromGroup,
      getLoci: getNucleotideElementLoci,
      eachLocation: eachNucleotideElement,
      setUpdateState: (state, next, current) => {
        state.createGeometry =
          next.sizeFactor !== current.sizeFactor ||
          next.thicknessFactor !== current.thicknessFactor ||
          next.radialSegments !== current.radialSegments ||
          JSON.stringify(next.dnaforgeNucleotideExclude) !==
            JSON.stringify(current.dnaforgeNucleotideExclude);
      },
    },
    materialId
  );
}

const extendedCartoonParams = {
  ...CartoonParams,
  dnaforgeNucleotideExclude: PD.Value<unknown[]>([]),
  visuals: PD.MultiSelect<string>(CartoonParams.visuals.defaultValue, [
    ...CartoonParams.visuals.options,
    [NUCLEOTIDE_BASE_PLANE_VISUAL, 'Nucleotide base planes'],
    [NUCLEOTIDE_CONNECTOR_VISUAL, 'Schematic nucleotide attachments'],
  ]),
};
function extendedGetParams(ctx: ThemeRegistryContext, structure: Structure) {
  return {
    ...getCartoonParams(ctx, structure),
    dnaforgeNucleotideExclude: extendedCartoonParams.dnaforgeNucleotideExclude,
    visuals: {
      ...extendedCartoonParams.visuals,
      defaultValue: getCartoonParams(ctx, structure).visuals.defaultValue,
    },
  };
}
type ExtendedParams = typeof extendedCartoonParams;
function filterNativeNucleotideRepresentation(
  representation: StructureRepresentation<ExtendedParams>
) {
  const nativeUpdate = representation.createOrUpdate;
  return Object.create(representation, {
    createOrUpdate: {
      value: (props: Partial<PD.Values<ExtendedParams>> = {}, data?: Structure) =>
        nativeUpdate(
          props,
          data
            ? filterNucleotideVisualStructure(
                data,
                props.dnaforgeNucleotideExclude ??
                  representation.props?.dnaforgeNucleotideExclude ??
                  []
              )
            : undefined
        ),
    },
  }) as StructureRepresentation<ExtendedParams>;
}
function extendedCartoon(
  ctx: RepresentationContext,
  getParams: (ctx: ThemeRegistryContext, structure: Structure) => ExtendedParams
) {
  return Representation.createMulti(
    'Cartoon',
    ctx,
    getParams,
    StructureRepresentationStateBuilder,
    {
      'polymer-trace': () =>
        UnitsRepresentation('Polymer trace mesh', ctx, getParams, PolymerTraceVisual),
      'polymer-gap': () =>
        UnitsRepresentation('Polymer gap cylinder', ctx, getParams, PolymerGapVisual),
      'nucleotide-block': () =>
        filterNativeNucleotideRepresentation(
          UnitsRepresentation('Nucleotide block mesh', ctx, getParams, NucleotideBlockVisual)
        ),
      'nucleotide-ring': () =>
        filterNativeNucleotideRepresentation(
          UnitsRepresentation('Nucleotide ring mesh', ctx, getParams, NucleotideRingVisual)
        ),
      'nucleotide-atomic-ring-fill': () =>
        filterNativeNucleotideRepresentation(
          UnitsRepresentation(
            'Nucleotide atomic ring fill',
            ctx,
            getParams,
            NucleotideAtomicRingFillVisual
          )
        ),
      'nucleotide-atomic-bond': () =>
        filterNativeNucleotideRepresentation(
          UnitsRepresentation('Nucleotide atomic bond', ctx, getParams, NucleotideAtomicBondVisual)
        ),
      'nucleotide-atomic-element': () =>
        filterNativeNucleotideRepresentation(
          UnitsRepresentation(
            'Nucleotide atomic element',
            ctx,
            getParams,
            NucleotideAtomicElementVisual
          )
        ),
      'direction-wedge': () =>
        UnitsRepresentation('Polymer direction wedge', ctx, getParams, PolymerDirectionVisual),
      [NUCLEOTIDE_BASE_PLANE_VISUAL]: () =>
        UnitsRepresentation('Nucleotide base planes', ctx, getParams, (id) =>
          nucleotideVisual('plane', id)
        ),
      [NUCLEOTIDE_CONNECTOR_VISUAL]: () =>
        UnitsRepresentation('Schematic nucleotide attachments', ctx, getParams, (id) =>
          nucleotideVisual('connector', id)
        ),
    }
  );
}

export const NucleotideCartoonRepresentationProvider = StructureRepresentationProvider({
  ...CartoonRepresentationProvider,
  factory: extendedCartoon,
  getParams: extendedGetParams,
  defaultValues: PD.getDefaultValues(extendedCartoonParams),
  getData: (structure: Structure) => structure,
  mustRecreate: undefined,
});
const extendedAtomParams = {
  ...BallAndStickParams,
  dnaforgeNucleotideKeepAtoms: PD.Value<unknown[]>([]),
  dnaforgeNucleotideAtomicMode: PD.Select<NucleotideAtomicMode>('full', [
    ['full', 'Selected atoms'],
    ['base-only', 'Nucleotide bases only'],
  ]),
};
export const NucleotideBallAndStickRepresentationProvider = StructureRepresentationProvider({
  ...BallAndStickRepresentationProvider,
  factory: BallAndStickRepresentationProvider.factory as unknown as StructureRepresentationProvider<
    typeof extendedAtomParams,
    'ball-and-stick'
  >['factory'],
  getParams: (ctx: ThemeRegistryContext, structure: Structure) => ({
    ...getBallAndStickParams(ctx, structure),
    dnaforgeNucleotideAtomicMode: extendedAtomParams.dnaforgeNucleotideAtomicMode,
    dnaforgeNucleotideKeepAtoms: extendedAtomParams.dnaforgeNucleotideKeepAtoms,
  }),
  defaultValues: PD.getDefaultValues(extendedAtomParams),
  getData: (structure: Structure, props: PD.Values<typeof extendedAtomParams>) => {
    const filtered = filterNucleotideAtomicStructure(
      structure,
      props.dnaforgeNucleotideAtomicMode,
      props.dnaforgeNucleotideKeepAtoms
    );
    return coordinationDepictionStructure(
      props.includeParent && props.dnaforgeNucleotideAtomicMode !== 'base-only'
        ? filtered.asParent()
        : filtered
    );
  },
  mustRecreate: (
    before: PD.Values<typeof extendedAtomParams>,
    after: PD.Values<typeof extendedAtomParams>
  ) =>
    before.includeParent !== after.includeParent ||
    JSON.stringify(before.dnaforgeNucleotideKeepAtoms) !==
      JSON.stringify(after.dnaforgeNucleotideKeepAtoms) ||
    before.dnaforgeNucleotideAtomicMode !== after.dnaforgeNucleotideAtomicMode,
});

const CoordinationLineRepresentationProvider = StructureRepresentationProvider({
  ...LineRepresentationProvider,
  getData: (structure, props) =>
    coordinationDepictionStructure(props.includeParent ? structure.asParent() : structure),
});

type ActiveConformerRoot = () => MolecularProfileNode | undefined;
const registeredVisualPolicies = new WeakMap<
  PluginContext['representation']['structure']['registry'],
  { getRoot?: ActiveConformerRoot }
>();

export function registerMolecularRenderProfileVisuals(
  plugin: Pick<PluginContext, 'representation'>,
  getPrimaryConformerRoot?: ActiveConformerRoot
): void {
  const registry = plugin.representation.structure.registry;
  const registered = registeredVisualPolicies.get(registry);
  if (registered) {
    if (getPrimaryConformerRoot) registered.getRoot = getPrimaryConformerRoot;
    return;
  }
  const policy = { getRoot: getPrimaryConformerRoot };
  const chosen = (structure: Structure) => {
    const root = policy.getRoot?.();
    return root ? primaryMolecularConformer(structure, root).structure : structure;
  };
  const atomic = StructureRepresentationProvider({
    ...NucleotideBallAndStickRepresentationProvider,
    getData: (structure, props) =>
      chosen(NucleotideBallAndStickRepresentationProvider.getData!(structure, props)),
  });
  const interactions = StructureRepresentationProvider({
    ...InteractionsRepresentationProvider,
    getData: (structure, props) =>
      chosen(InteractionsRepresentationProvider.getData!(structure, props)),
  });
  const providers = registry.list.map(({ provider }) => provider);
  for (const provider of providers) registry.remove(provider);
  for (const provider of providers)
    registry.add(
      provider.name === 'cartoon'
        ? NucleotideCartoonRepresentationProvider
        : provider.name === 'ball-and-stick'
          ? atomic
          : provider.name === 'line'
            ? CoordinationLineRepresentationProvider
            : provider.name === 'interactions'
              ? interactions
              : provider
    );
  registeredVisualPolicies.set(registry, policy);
}
