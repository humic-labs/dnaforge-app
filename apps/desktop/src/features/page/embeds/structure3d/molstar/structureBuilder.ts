import { fetchStructureData, fetchStructureFromUrl } from '../utils/structureData';
import {
  bindMolViewSpecCoordinates,
  resetMolViewSpecRuntime,
  setMolViewSpecCoordinateModel,
} from './molViewSpec';
import type { StructureFetchIdentity } from '../utils/structureData';
import type {
  StructureMemberSelection,
  StructureScene,
  StructureCoordinateModelSelection,
} from '../types';
import { PluginStateObject as SO } from 'molstar/lib/mol-plugin-state/objects';
import { StateObjectSelector } from 'molstar/lib/mol-state';
import type { MolstarPlugin } from './cache';
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder';
import type { Expression } from 'molstar/lib/mol-script/language/expression';
import type { StructureRepresentationBuiltInProps } from 'molstar/lib/mol-plugin-state/helpers/structure-representation-params';
import {
  STRUCTURE_COMPONENT_LABELS,
  detailChainPolymerLabel,
  detailContextChainPolymerLabel,
  detailMemberPolymerLabel,
  isDetailContextChainPolymerComponentLabel,
  isDetailChainPolymerComponentLabel,
  isDetailMemberPolymerComponentLabel,
} from './componentLabels';
import { getInitialPolymerRepresentationPlanForRole } from './renderPlan';
import {
  CachedParseCif,
  CachedTrajectoryFromMmCif,
  CachedTrajectoryFromPDB,
} from './decodedCoordinates';

const focusComponentSignatures = new WeakMap<MolstarPlugin, string>();
const detailComponentCatalogSignatures = new WeakMap<MolstarPlugin, string>();
const DETAIL_COMPONENT_CATALOG_VERSION = 10;

export interface DetailedPolymerChainTarget {
  targetId: string;
  memberId?: string;
  selection: StructureMemberSelection;
  operator?: string;
  visible: boolean;
  color?: number;
}

interface DetailedChainSelectorVariant {
  name: string;
  expression: Expression;
}

type StructureComponentSourceRef = Parameters<
  MolstarPlugin['builders']['structure']['tryCreateComponentFromExpression']
>[0];
type TrajectoryRef = Parameters<MolstarPlugin['builders']['structure']['createModel']>[0];
type CoordinateDataRef = Awaited<ReturnType<MolstarPlugin['builders']['data']['rawData']>>;

async function parseCoordinateTrajectory(
  plugin: MolstarPlugin,
  data: CoordinateDataRef,
  format: 'pdb' | 'mmcif',
  coordinateModel?: StructureCoordinateModelSelection
): Promise<TrajectoryRef> {
  if (
    coordinateModel &&
    (!Number.isInteger(coordinateModel.blockIndex) ||
      coordinateModel.blockIndex < 0 ||
      !Number.isInteger(coordinateModel.modelIndex) ||
      coordinateModel.modelIndex < 0)
  )
    throw new Error('The selected coordinate model is invalid.');
  let trajectory: TrajectoryRef;
  if (format === 'mmcif') {
    const cif = await plugin.state.data
      .build()
      .to(data)
      .apply(CachedParseCif, undefined, { state: { isGhost: true } })
      .commit({ revertOnError: true });
    const blocks = cif.cell?.obj?.data.blocks;
    const block = blocks?.[coordinateModel?.blockIndex ?? 0];
    if (!block) throw new Error('The selected coordinate data block was not found.');
    if (coordinateModel && blocks!.filter((item) => item.header === block.header).length !== 1)
      throw new Error('The coordinate file has ambiguous duplicate data-block names.');
    trajectory = await plugin.state.data
      .build()
      .to(cif)
      .apply(CachedTrajectoryFromMmCif, { blockHeader: block.header })
      .commit({ revertOnError: true });
  } else {
    if (coordinateModel?.blockIndex) throw new Error('PDB coordinates have one data block.');
    if (!SO.Data.String.is(data.obj)) throw new Error('PDB coordinates must be text.');
    const textData = new StateObjectSelector<SO.Data.String>(data.ref, plugin.state.data);
    trajectory = await plugin.state.data
      .build()
      .to(textData)
      .apply(CachedTrajectoryFromPDB, { variant: 'pdb' })
      .commit({ revertOnError: true });
  }
  const frameCount = trajectory.cell?.obj?.data.frameCount;
  if (coordinateModel && (frameCount === undefined || coordinateModel.modelIndex >= frameCount))
    throw new Error('The selected coordinate model was not found.');
  return trajectory;
}
type RepresentationComponentRef = Parameters<
  MolstarPlugin['builders']['structure']['representation']['addRepresentation']
>[0];
type StructureHierarchyComponent = {
  cell?: { obj?: { label?: string }; transform?: { ref?: string } };
  id?: unknown;
  ref?: unknown;
  representations?: unknown[];
};

async function addStructureRepresentation(
  plugin: MolstarPlugin,
  component: RepresentationComponentRef,
  props: StructureRepresentationBuiltInProps,
  options?: { tag?: string }
): Promise<void> {
  await plugin.builders.structure.representation.addRepresentation(
    componentRepresentationRef(component) ?? component,
    {
      ...props,
      typeParams: { ...props.typeParams, ignoreHydrogens: true, ignoreHydrogensVariant: 'all' },
    },
    options
  );
}

export async function buildStructureWithComponents(
  plugin: MolstarPlugin,
  trajectory: TrajectoryRef,
  structureIdentity?: StructureFetchIdentity,
  coordinateModel?: StructureCoordinateModelSelection
): Promise<void> {
  const model = await plugin.builders.structure.createModel(
    trajectory,
    coordinateModel ? { modelIndex: coordinateModel.modelIndex } : undefined
  );

  const structure = await plugin.builders.structure.createStructure(model, {
    name: 'model',
    params: {},
  });

  const scopedChainTest = buildRcsbScopeChainTest(structureIdentity);
  if (scopedChainTest) {
    await buildScopedRcsbComponents(plugin, structure, scopedChainTest);
    plugin.canvas3d?.requestCameraReset();
    return;
  }

  const polymerComponent = await plugin.builders.structure.tryCreateComponentStatic(
    structure,
    'polymer',
    { label: STRUCTURE_COMPONENT_LABELS.polymer }
  );

  if (polymerComponent) {
    for (const representation of getInitialPolymerRepresentationPlanForRole('unscoped')) {
      await addStructureRepresentation(plugin, polymerComponent, representation.props, {
        tag: representation.tag,
      });
    }
  }

  const ligandComponent = await plugin.builders.structure.tryCreateComponentStatic(
    structure,
    'ligand',
    { label: 'Ligand' }
  );

  if (ligandComponent) {
    await addStructureRepresentation(plugin, ligandComponent, {
      type: 'ball-and-stick',
      typeParams: { sizeFactor: 0.2 },
      color: 'element-symbol',
    });
  }

  const ionComponent = await plugin.builders.structure.tryCreateComponentStatic(structure, 'ion', {
    label: 'Ion',
  });

  if (ionComponent) {
    await addStructureRepresentation(plugin, ionComponent, {
      type: 'spacefill',
      typeParams: { sizeFactor: 0.6 },
      color: 'element-symbol',
    });
  }

  const waterComponent = await plugin.builders.structure.tryCreateComponentStatic(
    structure,
    'water',
    { label: 'Water' }
  );

  if (waterComponent) {
    await addStructureRepresentation(plugin, waterComponent, {
      type: 'spacefill',
      typeParams: { sizeFactor: 0.5, alpha: 0 },
      color: 'uniform',
      colorParams: { value: 0x888888 },
    });
  }

  const { structures } = plugin.managers.structure.hierarchy.current;
  if (structures?.length > 0) {
    plugin.canvas3d?.requestCameraReset();
  }
}

export async function loadStructure(
  plugin: MolstarPlugin,
  options: {
    pdbId?: string;
    uniprotId?: string;
    url?: string;
    structureData?: string | Uint8Array;
    structureDataFormat?: 'pdb' | 'mmcif';
    coordinateModel?: StructureCoordinateModelSelection;
    structureIdentity?: StructureFetchIdentity;

    coordinatesOnly?: boolean;
  },
  checkTimeout: () => void
): Promise<void> {
  const {
    pdbId,
    uniprotId,
    url,
    structureData,
    structureDataFormat,
    coordinateModel,
    structureIdentity,
    coordinatesOnly,
  } = options;
  resetMolViewSpecRuntime(plugin);
  setMolViewSpecCoordinateModel(plugin, coordinateModel);

  if (pdbId) {
    const { data: fetchedData, format } = await fetchStructureData(
      structureIdentity ?? pdbId,
      'rcsb'
    );
    checkTimeout();
    const data = await plugin.builders.data.rawData(
      { data: fetchedData, label: pdbId.toUpperCase() },
      { state: { isGhost: true } }
    );
    bindMolViewSpecCoordinates(plugin, fetchedData, format);
    if (coordinatesOnly) return;
    const trajectory = await parseCoordinateTrajectory(plugin, data, format, coordinateModel);
    await buildStructureWithComponents(plugin, trajectory, structureIdentity, coordinateModel);
  } else if (uniprotId) {
    const { data: fetchedData, format } = await fetchStructureData(
      structureIdentity ?? uniprotId,
      'alphafold'
    );
    checkTimeout();
    const data = await plugin.builders.data.rawData(
      { data: fetchedData, label: `AF-${uniprotId.toUpperCase()}` },
      { state: { isGhost: true } }
    );
    bindMolViewSpecCoordinates(plugin, fetchedData, format);
    if (coordinatesOnly) return;
    const trajectory = await parseCoordinateTrajectory(plugin, data, format, coordinateModel);
    await buildStructureWithComponents(plugin, trajectory, structureIdentity, coordinateModel);
  } else if (url) {
    const { data: fetchedData, format } = await fetchStructureFromUrl(url);
    checkTimeout();
    const data = await plugin.builders.data.rawData(
      { data: fetchedData, label: 'URL Structure' },
      { state: { isGhost: true } }
    );
    bindMolViewSpecCoordinates(plugin, fetchedData, format);
    if (coordinatesOnly) return;
    const trajectory = await parseCoordinateTrajectory(plugin, data, format, coordinateModel);
    await buildStructureWithComponents(plugin, trajectory, structureIdentity, coordinateModel);
  } else if (structureData) {
    checkTimeout();
    const data = await plugin.builders.data.rawData(
      { data: structureData, label: 'Uploaded Structure' },
      { state: { isGhost: true } }
    );
    const format =
      structureDataFormat ??
      (typeof structureData !== 'string' ||
      structureData.includes('data_') ||
      structureData.includes('_atom_site')
        ? 'mmcif'
        : 'pdb');
    bindMolViewSpecCoordinates(plugin, structureData, format);
    if (coordinatesOnly) return;
    const trajectory = await parseCoordinateTrajectory(plugin, data, format, coordinateModel);
    await buildStructureWithComponents(plugin, trajectory, structureIdentity, coordinateModel);
  }
}

async function buildScopedRcsbComponents(
  plugin: MolstarPlugin,
  structure: StructureComponentSourceRef,
  scopedChainTest: Expression
): Promise<void> {
  const contextChainTest = MS.core.logic.not([scopedChainTest]);
  const wholeLoadedEntryTest = alwaysTrueTest();
  const contextPolymerComponent = await plugin.builders.structure.tryCreateComponentFromExpression(
    structure,
    scopedAtomGroups(contextChainTest, entityTypeTest('polymer')),
    'context-rcsb-polymer',
    { label: STRUCTURE_COMPONENT_LABELS.rcsbContextPolymer }
  );

  if (contextPolymerComponent) {
    for (const representation of getInitialPolymerRepresentationPlanForRole('context')) {
      await addStructureRepresentation(plugin, contextPolymerComponent, representation.props, {
        tag: representation.tag,
      });
    }
  }

  const polymerComponent = await plugin.builders.structure.tryCreateComponentFromExpression(
    structure,
    scopedAtomGroups(scopedChainTest, entityTypeTest('polymer')),
    'scoped-rcsb-polymer',
    { label: STRUCTURE_COMPONENT_LABELS.rcsbQueryPolymer }
  );

  if (polymerComponent) {
    for (const representation of getInitialPolymerRepresentationPlanForRole('query')) {
      await addStructureRepresentation(plugin, polymerComponent, representation.props, {
        tag: representation.tag,
      });
    }
  }

  const ligandComponent = await plugin.builders.structure.tryCreateComponentFromExpression(
    structure,
    scopedAtomGroups(
      wholeLoadedEntryTest,
      MS.core.set.has([
        MS.set('non-polymer', 'branched'),
        MS.struct.atomProperty.macromolecular.entityType(),
      ]),
      MS.core.logic.not([commonIonAtomTest()])
    ),
    'scoped-rcsb-ligand',
    { label: 'Ligand' }
  );

  if (ligandComponent) {
    await addStructureRepresentation(plugin, ligandComponent, {
      type: 'ball-and-stick',
      typeParams: { sizeFactor: 0.2 },
      color: 'element-symbol',
    });
  }

  const ionComponent = await plugin.builders.structure.tryCreateComponentFromExpression(
    structure,
    scopedAtomGroups(wholeLoadedEntryTest, entityTypeTest('non-polymer'), commonIonAtomTest()),
    'scoped-rcsb-ion',
    { label: 'Ion' }
  );

  if (ionComponent) {
    await addStructureRepresentation(plugin, ionComponent, {
      type: 'spacefill',
      typeParams: { sizeFactor: 0.6 },
      color: 'element-symbol',
    });
  }

  const waterComponent = await plugin.builders.structure.tryCreateComponentFromExpression(
    structure,
    scopedAtomGroups(scopedChainTest, entityTypeTest('water')),
    'scoped-rcsb-water',
    { label: 'Water' }
  );

  if (waterComponent) {
    await addStructureRepresentation(plugin, waterComponent, {
      type: 'spacefill',
      typeParams: { sizeFactor: 0.5, alpha: 0 },
      color: 'uniform',
      colorParams: { value: 0x888888 },
    });
  }
}

export async function syncActiveFocusPolymerComponents(
  plugin: MolstarPlugin,
  scene: StructureScene | undefined,
  isCurrent: () => boolean = () => true,
  detailMemberIds?: readonly string[],
  detailChainTargets?: readonly DetailedPolymerChainTarget[]
): Promise<void> {
  if (!scene || scene.sceneKind !== 'complex') return;
  if (!plugin?.managers?.structure?.hierarchy?.current?.structures?.length) return;
  if (!plugin?.state?.data?.build) return;

  if (detailMemberIds !== undefined) {
    await syncDetailedPolymerComponents(
      plugin,
      scene,
      detailMemberIds,
      isCurrent,
      detailChainTargets
    );
    return;
  }

  const queryMember = scene.members.find(
    (member) => member.memberId === scene.queryAnchor.memberId
  );
  const queryTest = buildSelectionChainTest(
    queryMember?.selection ?? scene.queryAnchor.targetSelection
  );
  if (!queryTest) return;

  const focus = scene.activeFocus;
  const focusIsQuery = !focus || focus.memberId === scene.queryAnchor.memberId;
  const focusTest = focusIsQuery ? null : buildSelectionChainTest(focus.selection);

  const signature = focusComponentSignature(scene);
  if (focusComponentSignatures.get(plugin) === signature) return;

  let structures = plugin.managers.structure.hierarchy.current.structures ?? [];
  for (const structure of structures) {
    if (!isCurrent()) return;
    await deleteComponentsByLabel(plugin, structure.components ?? [], [
      STRUCTURE_COMPONENT_LABELS.polymer,
      STRUCTURE_COMPONENT_LABELS.rcsbContextPolymer,
      STRUCTURE_COMPONENT_LABELS.rcsbFocusPolymer,
      STRUCTURE_COMPONENT_LABELS.rcsbQueryPolymer,
    ]);
  }

  if (!isCurrent()) return;
  structures = plugin.managers.structure.hierarchy.current.structures ?? [];

  for (const structure of structures) {
    if (!isCurrent()) return;
    const structureRef = structure.cell ?? structure;

    const contextExclusionTest =
      focusTest && !focusIsQuery ? MS.core.logic.or([queryTest, focusTest]) : queryTest;
    const contextChainTest = MS.core.logic.not([contextExclusionTest]);
    const contextPolymerComponent =
      await plugin.builders.structure.tryCreateComponentFromExpression(
        structureRef,
        scopedAtomGroups(contextChainTest, entityTypeTest('polymer')),
        'context-rcsb-polymer',
        { label: STRUCTURE_COMPONENT_LABELS.rcsbContextPolymer }
      );

    if (!isCurrent()) return;
    if (contextPolymerComponent) {
      for (const representation of getInitialPolymerRepresentationPlanForRole('context')) {
        await addStructureRepresentation(plugin, contextPolymerComponent, representation.props, {
          tag: representation.tag,
        });
        if (!isCurrent()) return;
      }
    }

    const queryPolymerComponent = await plugin.builders.structure.tryCreateComponentFromExpression(
      structureRef,
      scopedAtomGroups(queryTest, entityTypeTest('polymer')),
      'scoped-rcsb-polymer',
      { label: STRUCTURE_COMPONENT_LABELS.rcsbQueryPolymer }
    );

    if (!isCurrent()) return;
    if (queryPolymerComponent) {
      for (const representation of getInitialPolymerRepresentationPlanForRole('query')) {
        await addStructureRepresentation(plugin, queryPolymerComponent, representation.props, {
          tag: representation.tag,
        });
        if (!isCurrent()) return;
      }
    }

    if (!focusTest || focusIsQuery) continue;
    const focusPolymerComponent = await plugin.builders.structure.tryCreateComponentFromExpression(
      structureRef,
      scopedAtomGroups(focusTest, entityTypeTest('polymer')),
      'active-focus-rcsb-polymer',
      { label: STRUCTURE_COMPONENT_LABELS.rcsbFocusPolymer }
    );

    if (!isCurrent()) return;
    if (focusPolymerComponent) {
      for (const representation of getInitialPolymerRepresentationPlanForRole('focus')) {
        await addStructureRepresentation(plugin, focusPolymerComponent, representation.props, {
          tag: representation.tag,
        });
        if (!isCurrent()) return;
      }
    }
  }

  focusComponentSignatures.set(plugin, signature);
}

function resolveDetailedPolymerTargets(
  scene: StructureScene,
  detailMemberIds: readonly string[],
  detailChainTargets?: readonly DetailedPolymerChainTarget[]
): {
  allDetailTargets: readonly DetailedPolymerChainTarget[];
  visibleDetailTargets: ReturnType<typeof visibleDetailedTargets>;
  catalogSignature: string;
  visibilitySignature: string;
} {
  const allDetailTargets =
    detailChainTargets ??
    scene.members
      .filter((member) => member.kind !== 'water')
      .map((member) => detailTargetFromMember(member));
  const visibleDetailTargets = visibleDetailedTargets(scene, detailMemberIds, detailChainTargets);
  return {
    allDetailTargets,
    visibleDetailTargets,
    catalogSignature: detailedComponentCatalogSignature(
      scene,
      detailChainTargets ? allDetailTargets : undefined
    ),
    visibilitySignature: detailedVisibilitySignature(scene, detailMemberIds, visibleDetailTargets),
  };
}

function broadPolymerComponentLabelsToDelete(
  detailChainTargets: readonly DetailedPolymerChainTarget[] | undefined
): string[] {
  return detailChainTargets !== undefined
    ? [STRUCTURE_COMPONENT_LABELS.rcsbFocusPolymer]
    : [
        STRUCTURE_COMPONENT_LABELS.polymer,
        STRUCTURE_COMPONENT_LABELS.rcsbContextPolymer,
        STRUCTURE_COMPONENT_LABELS.rcsbFocusPolymer,
        STRUCTURE_COMPONENT_LABELS.rcsbQueryPolymer,
      ];
}

function shouldSkipDetailedPolymerSync(
  catalogIsCurrent: boolean,
  visibilityIsCurrent: boolean
): boolean {
  return catalogIsCurrent && visibilityIsCurrent;
}

function currentHierarchyStructures(plugin: MolstarPlugin): Array<{
  components?: unknown[];
  cell?: unknown;
}> {
  return plugin.managers.structure.hierarchy.current.structures ?? [];
}

function restoreCameraSnapshotIfCurrent(
  plugin: MolstarPlugin,
  cameraSnapshot: ReturnType<typeof captureCameraSnapshot>,
  isCurrent: () => boolean
): void {
  if (isCurrent()) {
    restoreCameraSnapshot(plugin, cameraSnapshot);
  }
}

async function deleteBroadPolymerComponentsOnStructures(
  plugin: MolstarPlugin,
  detailChainTargets: readonly DetailedPolymerChainTarget[] | undefined,
  isCurrent: () => boolean
): Promise<boolean> {
  const broadComponentLabelsToDelete = broadPolymerComponentLabelsToDelete(detailChainTargets);
  for (const structure of currentHierarchyStructures(plugin)) {
    if (!isCurrent()) return false;
    const components = structure.components ?? [];
    await deleteComponentsByLabel(plugin, components, broadComponentLabelsToDelete);
    if (!isCurrent()) return false;
  }
  return true;
}

async function deleteStaleDetailCatalogOnStructures(
  plugin: MolstarPlugin,
  allDetailTargets: readonly DetailedPolymerChainTarget[],
  visibleDetailTargets: ReturnType<typeof visibleDetailedTargets>,
  detailChainTargets: readonly DetailedPolymerChainTarget[] | undefined,
  catalogIsCurrent: boolean,
  isCurrent: () => boolean
): Promise<boolean> {
  if (catalogIsCurrent) return true;
  for (const structure of currentHierarchyStructures(plugin)) {
    if (!isCurrent()) return false;
    const components = structure.components ?? [];
    await deleteStaleDetailComponents(
      plugin,
      components,
      desiredDetailComponentLabels(
        allDetailTargets,
        visibleDetailTargets,
        detailChainTargets !== undefined
      )
    );
    if (!isCurrent()) return false;
    if (detailChainTargets === undefined) {
      await deleteComponentsByLabel(plugin, components, [
        STRUCTURE_COMPONENT_LABELS.rcsbDetailContextPolymer,
      ]);
      if (!isCurrent()) return false;
    }
  }
  return true;
}

async function ensureDetailContextPolymerOnStructures(
  plugin: MolstarPlugin,
  visibleDetailTargets: ReturnType<typeof visibleDetailedTargets>,
  detailChainTargets: readonly DetailedPolymerChainTarget[] | undefined,
  catalogIsCurrent: boolean,
  isCurrent: () => boolean
): Promise<boolean> {
  if (detailChainTargets !== undefined) return true;
  for (const structure of currentHierarchyStructures(plugin)) {
    if (!isCurrent()) return false;
    const structureRef = structure.cell ?? structure;
    const components = structure.components ?? [];
    const hasCurrentDetailContext =
      catalogIsCurrent &&
      hasComponentWithLabel(components, STRUCTURE_COMPONENT_LABELS.rcsbDetailContextPolymer);

    if (hasCurrentDetailContext) continue;
    const contextChainTest = buildDetailContextChainTest(visibleDetailTargets);
    const detailContextComponent = await plugin.builders.structure.tryCreateComponentFromExpression(
      structureRef as unknown as StructureComponentSourceRef,
      scopedAtomGroups(contextChainTest, entityTypeTest('polymer')),
      'stable-detail-context-rcsb-polymer',
      { label: STRUCTURE_COMPONENT_LABELS.rcsbDetailContextPolymer }
    );

    if (!isCurrent()) return false;
    if (detailContextComponent) {
      for (const representation of initialRepresentationsForRoleVisibility('context', true)) {
        await addStructureRepresentation(plugin, detailContextComponent, representation.props, {
          tag: representation.tag,
        });
        if (!isCurrent()) return false;
      }
    }
  }
  return true;
}

async function ensureVisibleDetailMemberComponentsOnStructures(
  plugin: MolstarPlugin,
  allDetailTargets: readonly DetailedPolymerChainTarget[],
  visibleDetailTargets: ReturnType<typeof visibleDetailedTargets>,
  detailChainTargets: readonly DetailedPolymerChainTarget[] | undefined,
  isCurrent: () => boolean
): Promise<boolean> {
  for (const structure of currentHierarchyStructures(plugin)) {
    if (!isCurrent()) return false;
    const structureRef = structure.cell ?? structure;
    const components = structure.components ?? [];
    if (detailChainTargets !== undefined) {
      await ensurePerChainDetailComponents(
        plugin,
        structureRef as unknown as StructureComponentSourceRef,
        components,
        allDetailTargets,
        isCurrent
      );
      if (!isCurrent()) return false;
      continue;
    }

    for (const target of visibleDetailTargets) {
      const label =
        detailChainTargets !== undefined
          ? detailChainPolymerLabel(target.targetId)
          : detailMemberPolymerLabel(target.targetId);
      if (hasComponentWithLabel(components, label)) continue;

      const targetTest = buildDetailedChainTargetTest(target);
      if (!targetTest) continue;

      const detailComponent = await plugin.builders.structure.tryCreateComponentFromExpression(
        structureRef as unknown as StructureComponentSourceRef,
        scopedAtomGroups(targetTest, entityTypeTest('polymer')),
        detailChainTargets !== undefined
          ? stableDetailChainComponentId(target.targetId)
          : stableDetailMemberComponentId(target.targetId),
        { label }
      );

      if (!isCurrent()) return false;
      if (detailComponent) {
        for (const representation of initialRepresentationsForRoleVisibility('query', true)) {
          await addStructureRepresentation(plugin, detailComponent, representation.props, {
            tag: representation.tag,
          });
          if (!isCurrent()) return false;
        }
      }
    }
  }
  return true;
}

async function syncDetailedPolymerComponents(
  plugin: MolstarPlugin,
  scene: StructureScene,
  detailMemberIds: readonly string[],
  isCurrent: () => boolean,
  detailChainTargets?: readonly DetailedPolymerChainTarget[]
): Promise<void> {
  const { allDetailTargets, visibleDetailTargets, catalogSignature, visibilitySignature } =
    resolveDetailedPolymerTargets(scene, detailMemberIds, detailChainTargets);
  const catalogIsCurrent = detailComponentCatalogSignatures.get(plugin) === catalogSignature;
  const visibilityIsCurrent = focusComponentSignatures.get(plugin) === visibilitySignature;
  if (shouldSkipDetailedPolymerSync(catalogIsCurrent, visibilityIsCurrent)) {
    return;
  }
  const cameraSnapshot = captureCameraSnapshot(plugin);

  try {
    if (!(await deleteBroadPolymerComponentsOnStructures(plugin, detailChainTargets, isCurrent))) {
      return;
    }
    if (
      !(await deleteStaleDetailCatalogOnStructures(
        plugin,
        allDetailTargets,
        visibleDetailTargets,
        detailChainTargets,
        catalogIsCurrent,
        isCurrent
      ))
    ) {
      return;
    }
    if (
      !(await ensureDetailContextPolymerOnStructures(
        plugin,
        visibleDetailTargets,
        detailChainTargets,
        catalogIsCurrent,
        isCurrent
      ))
    ) {
      return;
    }
    if (
      !(await ensureVisibleDetailMemberComponentsOnStructures(
        plugin,
        allDetailTargets,
        visibleDetailTargets,
        detailChainTargets,
        isCurrent
      ))
    ) {
      return;
    }

    detailComponentCatalogSignatures.set(plugin, catalogSignature);
    focusComponentSignatures.set(plugin, visibilitySignature);
  } finally {
    restoreCameraSnapshotIfCurrent(plugin, cameraSnapshot, isCurrent);
  }
}

function initialRepresentationsForRoleVisibility(
  role: 'query' | 'context',
  visible: boolean
): ReturnType<typeof getInitialPolymerRepresentationPlanForRole> {
  return getInitialPolymerRepresentationPlanForRole(role).map((representation) => ({
    ...representation,
    props:
      representation.slot === 'primary'
        ? representationWithVisibility(representation.props, visible)
        : representationWithVisibility(representation.props, false),
  }));
}

function representationWithVisibility(
  props: StructureRepresentationBuiltInProps,
  visible: boolean
): StructureRepresentationBuiltInProps {
  if (visible) return props;
  return {
    ...props,
    typeParams: {
      ...props.typeParams,
      alpha: 0,
    },
  };
}

async function ensurePerChainDetailComponents(
  plugin: MolstarPlugin,
  structureRef: StructureComponentSourceRef,
  components: unknown[],
  targets: readonly DetailedPolymerChainTarget[],
  isCurrent: () => boolean
): Promise<void> {
  const resolvedComponents: Array<{
    target: DetailedPolymerChainTarget;
    component: unknown;
    role: 'query' | 'context';
    visible: boolean;
  }> = [];
  const missingContextTargets: DetailedPolymerChainTarget[] = [];
  for (const target of targets) {
    const detailComponent = await ensureDetailChainComponent(
      plugin,
      structureRef,
      components,
      target,
      'detail'
    );
    if (!isCurrent()) return;
    if (detailComponent) {
      resolvedComponents.push({
        target,
        component: detailComponent,
        role: 'query',
        visible: target.visible,
      });
    }

    const contextComponent = await ensureDetailChainComponent(
      plugin,
      structureRef,
      components,
      target,
      'context'
    );
    if (!isCurrent()) return;
    if (contextComponent) {
      resolvedComponents.push({
        target,
        component: contextComponent,
        role: 'context',
        visible: !target.visible,
      });
    } else if (!target.visible) {
      missingContextTargets.push(target);
    }
  }

  if (missingContextTargets.length > 0) {
    await ensureScopedDetailContextFallback(plugin, structureRef, components, targets, isCurrent);
    if (!isCurrent()) return;
  } else {
    await deleteComponentsByLabel(plugin, components, [
      STRUCTURE_COMPONENT_LABELS.rcsbDetailContextPolymer,
    ]);
    if (!isCurrent()) return;
  }

  for (const { component, role, visible } of resolvedComponents) {
    await ensureInitialRepresentationsForComponent(plugin, component, role, visible, isCurrent);
    if (!isCurrent()) return;
  }
}

async function ensureScopedDetailContextFallback(
  plugin: MolstarPlugin,
  structureRef: StructureComponentSourceRef,
  components: unknown[],
  targets: readonly DetailedPolymerChainTarget[],
  isCurrent: () => boolean
): Promise<void> {
  await deleteComponentsByLabel(plugin, components, [
    STRUCTURE_COMPONENT_LABELS.rcsbDetailContextPolymer,
  ]);
  if (!isCurrent()) return;

  const contextChainTest = buildDetailContextChainTest(targets.filter((target) => target.visible));
  const detailContextComponent = await plugin.builders.structure.tryCreateComponentFromExpression(
    structureRef,
    scopedAtomGroups(contextChainTest, entityTypeTest('polymer')),
    'stable-detail-context-rcsb-polymer',
    { label: STRUCTURE_COMPONENT_LABELS.rcsbDetailContextPolymer }
  );

  if (!isCurrent() || !detailContextComponent) return;
  for (const representation of initialRepresentationsForRoleVisibility('context', true)) {
    await addStructureRepresentation(plugin, detailContextComponent, representation.props, {
      tag: representation.tag,
    });
    if (!isCurrent()) return;
  }
}

async function ensureDetailChainComponent(
  plugin: MolstarPlugin,
  structureRef: StructureComponentSourceRef,
  components: unknown[],
  target: DetailedPolymerChainTarget,
  role: 'detail' | 'context'
): Promise<unknown | undefined> {
  const selectorVariants = buildDetailedChainTargetSelectorVariants(target);
  if (selectorVariants.length === 0) {
    recordDetailComponentCreationDiagnostic(target, {
      created: false,
      reason: 'no-chain-selector',
    });
    return undefined;
  }

  const detailLabel =
    role === 'detail'
      ? detailChainPolymerLabel(target.targetId)
      : detailContextChainPolymerLabel(target.targetId);
  const existingDetailComponent = findComponentWithLabel(components, detailLabel);
  if (existingDetailComponent) {
    recordDetailComponentCreationDiagnostic(target, {
      created: true,
      label: detailLabel,
      reason: 'existing-component',
    });
    return existingDetailComponent;
  }

  let resolvedDetailComponent: unknown;
  for (const selectorVariant of selectorVariants) {
    const detailComponent = await plugin.builders.structure.tryCreateComponentFromExpression(
      structureRef,
      selectorVariant.expression,
      role === 'detail'
        ? stableDetailChainComponentId(target.targetId)
        : stableDetailContextChainComponentId(target.targetId),
      { label: detailLabel }
    );

    resolvedDetailComponent = detailComponent ?? findCurrentComponentWithLabel(plugin, detailLabel);
    recordDetailComponentCreationDiagnostic(target, {
      created: !!resolvedDetailComponent,
      label: detailLabel,
      expression: selectorVariant.expression,
      variant: selectorVariant.name,
      reason: detailComponent
        ? 'created-component'
        : resolvedDetailComponent
          ? 'found-after-create'
          : 'molstar-returned-null',
    });
    if (resolvedDetailComponent) break;
  }

  return resolvedDetailComponent;
}

function recordDetailComponentCreationDiagnostic(
  target: DetailedPolymerChainTarget,
  result: {
    created: boolean;
    label?: string;
    reason: string;
    expression?: Expression;
    variant?: string;
  }
): void {
  const diagnostic = {
    targetId: target.targetId,
    memberId: target.memberId,
    visible: target.visible,
    selection: target.selection,
    operator: target.operator,
    created: result.created,
    label: result.label,
    reason: result.reason,
    variant: result.variant,
    expression: result.expression ? JSON.stringify(result.expression) : undefined,
  };
  const globalWithDiagnostics = globalThis as {
    __WAYPOINT_MOLSTAR_DETAIL_COMPONENT_CREATION_LOG__?: unknown[];
  };
  const existing = globalWithDiagnostics.__WAYPOINT_MOLSTAR_DETAIL_COMPONENT_CREATION_LOG__;
  const log = Array.isArray(existing) ? existing : [];
  log.push(diagnostic);
  if (log.length > 250) log.splice(0, log.length - 250);
  globalWithDiagnostics.__WAYPOINT_MOLSTAR_DETAIL_COMPONENT_CREATION_LOG__ = log;
}

async function ensureInitialRepresentationsForComponent(
  plugin: MolstarPlugin,
  component: unknown,
  role: 'query' | 'context',
  visible: boolean,
  isCurrent: () => boolean
): Promise<void> {
  if (
    !component ||
    componentHasRepresentations(component) ||
    !componentCanReceiveRepresentation(component)
  ) {
    return;
  }
  for (const representation of initialRepresentationsForRoleVisibility(role, visible)) {
    await addStructureRepresentation(
      plugin,
      component as unknown as RepresentationComponentRef,
      representation.props,
      {
        tag: representation.tag,
      }
    );
    if (!isCurrent()) return;
  }
}

function hasComponentWithLabel(components: unknown[], label: string): boolean {
  return !!findComponentWithLabel(components, label);
}

function findComponentWithLabel(components: unknown[], label: string): unknown | undefined {
  return components.find(
    (component) => (component as StructureHierarchyComponent).cell?.obj?.label === label
  );
}

function findCurrentComponentWithLabel(plugin: MolstarPlugin, label: string): unknown | undefined {
  for (const structure of plugin.managers.structure.hierarchy.current.structures ?? []) {
    const component = findComponentWithLabel(structure.components ?? [], label);
    if (component) return component;
  }
  return undefined;
}

function componentHasRepresentations(component: unknown): boolean {
  const representations = (component as StructureHierarchyComponent).representations;
  return Array.isArray(representations) && representations.length > 0;
}

function componentCanReceiveRepresentation(component: unknown): boolean {
  return componentRepresentationRef(component) !== undefined;
}

function componentRepresentationRef(component: unknown): string | undefined {
  if (typeof component === 'string' && component.length > 0) return component;
  if (!component || typeof component !== 'object') return undefined;
  const candidate = component as StructureHierarchyComponent;
  if (typeof candidate.ref === 'string' && candidate.ref.length > 0) return candidate.ref;
  const cellRef = candidate.cell?.transform?.ref;
  return typeof cellRef === 'string' && cellRef.length > 0 ? cellRef : undefined;
}

async function deleteStaleDetailComponents(
  plugin: MolstarPlugin,
  components: unknown[],
  desiredLabels: ReadonlySet<string>
): Promise<void> {
  const refs = components
    .map((component) => {
      const cell = (
        component as { cell?: { obj?: { label?: string }; transform?: { ref?: string } } }
      ).cell;
      const label = cell?.obj?.label;
      return label &&
        (label === STRUCTURE_COMPONENT_LABELS.rcsbDetailContextPolymer ||
          isDetailContextChainPolymerComponentLabel(label) ||
          isDetailMemberPolymerComponentLabel(label) ||
          isDetailChainPolymerComponentLabel(label)) &&
        !desiredLabels.has(label)
        ? cell.transform?.ref
        : undefined;
    })
    .filter((ref): ref is string => !!ref);

  if (refs.length === 0) return;
  const builder = plugin.state.data.build();
  if (!builder) return;
  for (const ref of refs) {
    builder.delete(ref);
  }
  await builder.commit();
}

function stableDetailMemberComponentId(memberId: string): string {
  return `detail-member-rcsb-polymer-${memberId.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
}

function stableDetailChainComponentId(targetId: string): string {
  return `detail-chain-rcsb-polymer-${targetId.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
}

function stableDetailContextChainComponentId(targetId: string): string {
  return `detail-context-chain-rcsb-polymer-${targetId.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
}

function detailTargetFromMember(
  member: StructureScene['members'][number],
  detailMemberIds: readonly string[] = []
): DetailedPolymerChainTarget {
  return {
    targetId: member.memberId,
    memberId: member.memberId,
    selection: member.selection,
    visible: detailMemberIds.includes(member.memberId),
  };
}

function visibleDetailedTargets(
  scene: StructureScene,
  detailMemberIds: readonly string[],
  detailChainTargets?: readonly DetailedPolymerChainTarget[]
): DetailedPolymerChainTarget[] {
  if (detailChainTargets) {
    return detailChainTargets.filter(
      (target) =>
        target.visible && typeof target.targetId === 'string' && target.targetId.length > 0
    );
  }
  const detailIds = new Set(
    detailMemberIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
  );
  return scene.members
    .filter((member) => member.kind !== 'water' && detailIds.has(member.memberId))
    .map((member) => detailTargetFromMember(member, detailMemberIds));
}

function desiredDetailComponentLabels(
  allTargets: readonly DetailedPolymerChainTarget[],
  visibleTargets: readonly DetailedPolymerChainTarget[],
  useChainLabels: boolean
): ReadonlySet<string> {
  if (useChainLabels) {
    return new Set([
      ...allTargets.map((target) => detailChainPolymerLabel(target.targetId)),
      ...allTargets.map((target) => detailContextChainPolymerLabel(target.targetId)),
    ]);
  }

  return new Set([
    STRUCTURE_COMPONENT_LABELS.rcsbDetailContextPolymer,
    ...visibleTargets.map((target) => detailMemberPolymerLabel(target.targetId)),
  ]);
}

function captureCameraSnapshot(plugin: MolstarPlugin): unknown {
  return plugin.canvas3d?.camera?.getSnapshot?.() ?? null;
}

function restoreCameraSnapshot(plugin: MolstarPlugin, snapshot: unknown): void {
  if (!snapshot) return;
  plugin.canvas3d?.camera?.setState?.(snapshot, 0);
}

function scopedAtomGroups(
  scopedChainTest: Expression,
  entityTest: Expression,
  atomTest?: Expression
): Expression {
  return MS.struct.generator.atomGroups({
    'chain-test': scopedChainTest,
    'entity-test': entityTest,
    ...(atomTest ? { 'atom-test': atomTest } : {}),
  });
}

function entityTypeTest(type: 'polymer' | 'non-polymer' | 'water'): Expression {
  return MS.core.rel.eq([MS.struct.atomProperty.macromolecular.entityType(), type]);
}

function commonIonAtomTest(): Expression {
  return MS.core.set.has([
    MS.set('NA', 'MG', 'K', 'CA', 'MN', 'FE', 'CO', 'NI', 'CU', 'ZN', 'CD', 'HG', 'CL', 'BR', 'I'),
    MS.acp('elementSymbol'),
  ]);
}

function alwaysTrueTest(): Expression {
  return MS.core.rel.eq([1, 1]);
}

export function buildRcsbScopeChainTest(
  structureIdentity: StructureFetchIdentity | undefined
): Expression | null {
  if (!structureIdentity || structureIdentity.provider !== 'rcsb') return null;

  const directTests: Expression[] = [];
  const labelAsymIds = canonicalScopeTokens(structureIdentity.labelAsymIds);
  const authAsymIds = canonicalScopeTokens(structureIdentity.authAsymIds);
  const entityId = structureIdentity.pdbEntityId?.trim();

  if (labelAsymIds.length > 0) {
    directTests.push(
      tokenPropertyTest(labelAsymIds, MS.struct.atomProperty.macromolecular.label_asym_id())
    );
  }
  if (authAsymIds.length > 0) {
    directTests.push(
      tokenPropertyTest(authAsymIds, MS.struct.atomProperty.macromolecular.auth_asym_id())
    );
  }

  if (directTests.length > 0) {
    return directTests.length === 1 ? directTests[0] : MS.core.logic.or(directTests);
  }
  if (!entityId) return null;
  return MS.core.rel.eq([MS.struct.atomProperty.macromolecular.label_entity_id(), entityId]);
}

export function buildSelectionChainTest(
  selection: StructureMemberSelection | undefined,
  options: { narrowDirectChainByEntity?: boolean } = {}
): Expression | null {
  if (!selection) return null;

  const directTest = buildSelectionDirectChainTest(selection);
  const entityTest = buildSelectionEntityIdTest(selection);
  if (directTest) {
    return options.narrowDirectChainByEntity && entityTest
      ? MS.core.logic.and([directTest, entityTest])
      : directTest;
  }

  return entityTest;
}

function buildSelectionDirectChainTest(
  selection: StructureMemberSelection | undefined
): Expression | null {
  if (!selection) return null;

  const directTests: Expression[] = [];
  const labelAsymIds = canonicalScopeTokens(selection.labelAsymIds);
  const authAsymIds = canonicalScopeTokens(selection.authAsymIds);
  const ambiguousChainIds =
    labelAsymIds.length === 0 && authAsymIds.length === 0
      ? canonicalScopeTokens(selection.chainIds)
      : [];

  if (labelAsymIds.length > 0) {
    directTests.push(
      tokenPropertyTest(labelAsymIds, MS.struct.atomProperty.macromolecular.label_asym_id())
    );
  }
  if (authAsymIds.length > 0) {
    directTests.push(
      tokenPropertyTest(authAsymIds, MS.struct.atomProperty.macromolecular.auth_asym_id())
    );
  }
  if (ambiguousChainIds.length > 0) {
    directTests.push(
      tokenPropertyTest(ambiguousChainIds, MS.struct.atomProperty.macromolecular.label_asym_id())
    );
    directTests.push(
      tokenPropertyTest(ambiguousChainIds, MS.struct.atomProperty.macromolecular.auth_asym_id())
    );
  }

  if (directTests.length === 0) return null;
  return directTests.length === 1 ? directTests[0] : MS.core.logic.or(directTests);
}

function buildSelectionEntityIdTest(
  selection: StructureMemberSelection | undefined
): Expression | null {
  const entityIds = canonicalScopeTokens(selection?.entityIds);
  if (entityIds.length === 0) return null;
  return tokenPropertyTest(entityIds, MS.struct.atomProperty.macromolecular.label_entity_id());
}

export function buildDetailedChainTargetTest(
  target: Pick<DetailedPolymerChainTarget, 'selection' | 'operator'>
): Expression | null {
  const chainTest = buildSelectionChainTest(target.selection, {
    narrowDirectChainByEntity: true,
  });
  if (!chainTest) return null;
  const operator = target.operator?.trim();
  if (!operator) return chainTest;
  return MS.core.logic.and([
    chainTest,
    MS.core.rel.eq([MS.struct.atomProperty.core.operatorName(), operator]),
  ]);
}

function buildDetailedChainTargetSelector(
  target: Pick<DetailedPolymerChainTarget, 'selection' | 'operator'>
): { chainTest: Expression; entityTest: Expression } | null {
  const directChainTest = buildSelectionDirectChainTest(target.selection);
  const entityIdTest = directChainTest ? null : buildSelectionEntityIdTest(target.selection);
  if (!directChainTest && !entityIdTest) return null;

  const operator = target.operator?.trim();
  const chainTests = [
    directChainTest ?? null,
    operator ? MS.core.rel.eq([MS.struct.atomProperty.core.operatorName(), operator]) : null,
  ].filter((test): test is Expression => !!test);
  const chainTest =
    chainTests.length === 0
      ? alwaysTrueTest()
      : chainTests.length === 1
        ? chainTests[0]
        : MS.core.logic.and(chainTests);
  const entityTests = [entityTypeTest('polymer'), entityIdTest].filter(
    (test): test is Expression => !!test
  );
  return {
    chainTest,
    entityTest: entityTests.length === 1 ? entityTests[0] : MS.core.logic.and(entityTests),
  };
}

function buildDetailedChainTargetSelectorVariants(
  target: Pick<DetailedPolymerChainTarget, 'selection' | 'operator'>
): DetailedChainSelectorVariant[] {
  const primarySelector = buildDetailedChainTargetSelector(target);
  const directChainTest = buildSelectionDirectChainTest(target.selection);
  const entityIdTest = buildSelectionEntityIdTest(target.selection);
  const operator = target.operator?.trim();
  const operatorTest = operator
    ? MS.core.rel.eq([MS.struct.atomProperty.core.operatorName(), operator])
    : null;
  const variants: DetailedChainSelectorVariant[] = [];

  if (primarySelector) {
    variants.push({
      name: 'direct-chain-polymer',
      expression: scopedAtomGroups(primarySelector.chainTest, primarySelector.entityTest),
    });
  }

  if (directChainTest) {
    variants.push({
      name: 'direct-atom-polymer',
      expression: scopedAtomGroups(
        operatorTest ? operatorTest : alwaysTrueTest(),
        entityTypeTest('polymer'),
        directChainTest
      ),
    });
  }

  if (entityIdTest) {
    variants.push({
      name: 'entity-polymer',
      expression: scopedAtomGroups(
        operatorTest ? operatorTest : alwaysTrueTest(),
        MS.core.logic.and([entityTypeTest('polymer'), entityIdTest])
      ),
    });
  }

  return dedupeSelectorVariants(variants);
}

function dedupeSelectorVariants(
  variants: readonly DetailedChainSelectorVariant[]
): DetailedChainSelectorVariant[] {
  const seen = new Set<string>();
  const deduped: DetailedChainSelectorVariant[] = [];
  for (const variant of variants) {
    const key = JSON.stringify(variant.expression);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(variant);
  }
  return deduped;
}

export function buildDetailMembersChainTest(
  scene: StructureScene,
  detailMemberIds: readonly string[]
): Expression | null {
  const detailIds = new Set(detailMemberIds);
  const tests = scene.members
    .filter((member) => detailIds.has(member.memberId))
    .map((member) => buildSelectionChainTest(member.selection))
    .filter((test): test is Expression => !!test);

  if (tests.length === 0) return null;
  return tests.length === 1 ? tests[0] : MS.core.logic.or(tests);
}

export function buildDetailContextChainTest(
  visibleDetailTargets: readonly Pick<DetailedPolymerChainTarget, 'selection' | 'operator'>[]
): Expression {
  const excludedDetailTests = visibleDetailTargets
    .map((target) => buildDetailedChainTargetTest(target))
    .filter((test): test is Expression => !!test);

  if (excludedDetailTests.length === 0) return alwaysTrueTest();

  const excluded =
    excludedDetailTests.length === 1
      ? excludedDetailTests[0]
      : MS.core.logic.or(excludedDetailTests);
  return MS.core.logic.not([excluded]);
}

function canonicalScopeTokens(values: readonly string[] | undefined): string[] {
  if (!values?.length) return [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function tokenPropertyTest(values: readonly string[], property: Expression): Expression {
  return values.length === 1
    ? MS.core.rel.eq([property, values[0]])
    : MS.core.set.has([MS.set(...values), property]);
}

async function deleteComponentsByLabel(
  plugin: MolstarPlugin,
  components: unknown[],
  labels: readonly string[]
): Promise<void> {
  const refs = components
    .map((component) => {
      const cell = (
        component as { cell?: { obj?: { label?: string }; transform?: { ref?: string } } }
      ).cell;
      return cell?.obj?.label && labels.includes(cell.obj.label) ? cell.transform?.ref : undefined;
    })
    .filter((ref): ref is string => !!ref);

  if (refs.length === 0) return;

  const builder = plugin.state.data.build();
  if (!builder) return;

  for (const ref of refs) {
    builder.delete(ref);
  }
  await builder.commit();
}

function focusComponentSignature(scene: StructureScene): string {
  const focus = scene.activeFocus;
  return [
    scene.sceneId,
    `query:${scene.queryAnchor.memberId}:${selectionSignature(scene.queryAnchor.targetSelection)}`,
    focus
      ? `focus:${focus.memberId}:${selectionSignature(focus.selection)}`
      : `focus:${scene.queryAnchor.memberId}`,
  ].join('|');
}

function detailedVisibilitySignature(
  scene: StructureScene,
  detailMemberIds: readonly string[],
  detailChainTargets?: readonly DetailedPolymerChainTarget[]
): string {
  const chainVisibility =
    detailChainTargets
      ?.map((target) => `${target.targetId}:${target.visible ? '1' : '0'}:${target.color ?? ''}`)
      .sort()
      .join(',') ?? '';
  return [
    scene.sceneId,
    `detail:${[...detailMemberIds].sort().join(',')}`,
    `chains:${chainVisibility}`,
  ].join('|');
}

function detailedComponentCatalogSignature(
  scene: StructureScene,
  detailChainTargets?: readonly DetailedPolymerChainTarget[]
): string {
  if (detailChainTargets !== undefined) {
    return [
      `v:${DETAIL_COMPONENT_CATALOG_VERSION}`,
      scene.sceneId,
      ...detailChainTargets
        .map(
          (target) =>
            `${target.targetId}:${target.memberId ?? ''}:${target.operator ?? ''}:${selectionSignature(target.selection)}`
        )
        .sort(),
    ].join('|');
  }

  return [
    `v:${DETAIL_COMPONENT_CATALOG_VERSION}`,
    scene.sceneId,
    ...scene.members
      .filter((member) => member.kind !== 'water')
      .map((member) => `${member.memberId}:${member.kind}:${selectionSignature(member.selection)}`),
  ].join('|');
}

function selectionSignature(selection: StructureMemberSelection): string {
  return [
    `entity:${canonicalScopeTokens(selection.entityIds).join(',')}`,
    `label:${canonicalScopeTokens(selection.labelAsymIds).join(',')}`,
    `auth:${canonicalScopeTokens(selection.authAsymIds).join(',')}`,
    `chain:${canonicalScopeTokens(selection.chainIds).join(',')}`,
  ].join(';');
}
