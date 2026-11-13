import type {
  ChainSequence,
  Structure3dAttrs,
  StructureChainColoring,
  StructureComplexMember,
  StructureScene,
  StructureViewState,
} from '../types';
import {
  createStructureChainColoring,
  getChainColorForSequenceChain,
  getDisplayChainId,
} from '../types';
import {
  createQueryInComplexPreviewRecipe,
  createQueryInComplexRecipe,
  createQueryInComplexSurfaceRecipe,
} from './builtinViewRecipes';
import {
  chainInstanceId,
  chainInstanceIdForSequenceChain,
  stableStructureIdToken,
  structureChainGroupId,
  structureMemberId,
  type ChainInstanceId,
  type StructureChainGroupId,
  type StructureMemberId,
} from './structureIds';
import {
  detailMemberForChain,
  effectiveDetailChainInstanceIds,
  effectiveDetailMemberIds,
  orderChainsForStructureTable,
} from './structureDetailState';
import { structureViewStateFromAttrs } from './viewRecipe';

export const STRUCTURE_CONTEXT_MOLSTAR_COLOR = 0xb8b8b8;
export const STRUCTURE_CONTEXT_COLOR = '#b8b8b8';

export type StructureChainDetailState = 'detail' | 'context';
export type StructureChainGroupEvidence =
  | 'query-anchor'
  | 'gene-name'
  | 'uniprot'
  | 'pdb-entity'
  | 'member-description'
  | 'chain-instance';

export interface StructureChainGroup {
  groupId: StructureChainGroupId;
  groupLabel: string;
  evidence: StructureChainGroupEvidence;
  chainIds: string[];
  memberIds: StructureMemberId[];
  entityIds: string[];
  labelAsymIds: string[];
  authAsymIds: string[];
  chainCount: number;
  detailVisibleCount: number;
}

export interface StructureChainRenderRow {
  chain: ChainSequence;
  chainInstanceId: ChainInstanceId;
  displayChainId: string;
  member?: StructureComplexMember;
  memberId?: StructureMemberId;
  groupId: StructureChainGroupId;
  groupLabel: string;
  groupEvidence: StructureChainGroupEvidence;
  detailState: StructureChainDetailState;
  detailVisible: boolean;
  detailColor: string;
  detailMolstarColor?: number;
  displayColor: string;
  displayMolstarColor?: number;
}

export interface StructureRenderModel {
  scene?: StructureScene;
  view?: StructureViewState;
  chainColoring: StructureChainColoring;
  orderedChains: ChainSequence[];
  chainRows: StructureChainRenderRow[];
  chainGroups: StructureChainGroup[];
  detailMemberIds?: StructureMemberId[];
  detailChainInstanceIds?: ChainInstanceId[];
  molstarPalette: readonly number[];
  contextColor: string;
  contextMolstarColor: number;
}

export interface CreateStructureRenderModelInput {
  chains: readonly ChainSequence[];
  scene?: StructureScene | undefined;
  view?: StructureViewState | undefined;
  chainColoring?: StructureChainColoring | undefined;
}

export function createStructureRenderModel({
  chains,
  scene,
  view,
  chainColoring,
}: CreateStructureRenderModelInput): StructureRenderModel {
  const resolvedChainColoring = chainColoring ?? createStructureChainColoring(chains);
  const orderedChains = orderChainsForStructureTable(chains, scene);
  const detailMemberIds = scene
    ? effectiveDetailMemberIds(scene, view).map(structureMemberId)
    : undefined;
  const detailMemberIdSet = detailMemberIds ? new Set(detailMemberIds) : null;
  const rawDetailChainInstanceIds = scene ? effectiveDetailChainInstanceIds(view) : undefined;
  const detailChainInstanceIds = rawDetailChainInstanceIds?.map(chainInstanceIdFromStoredId);
  const detailChainInstanceIdSet = detailChainInstanceIds ? new Set(detailChainInstanceIds) : null;
  const isComplex = scene?.sceneKind === 'complex';
  const chainRows = orderedChains.map((chain) => {
    const member = detailMemberForChain(chain, scene);
    const chainGroup = biologicalGroupForChain(chain, member, scene);
    const rowChainInstanceId = chainInstanceIdForSequenceChain(chain);
    const rowMemberId = member ? structureMemberId(member.memberId) : undefined;
    const detailVisible = isComplex
      ? detailChainInstanceIdSet
        ? detailChainInstanceIdSet.has(rowChainInstanceId)
        : member
          ? rowMemberId !== undefined && detailMemberIdSet?.has(rowMemberId) === true
          : false
      : true;
    const detailColor =
      resolvedChainColoring.colorByChainId.get(chain.chainId) ??
      getChainColorForSequenceChain(chain);
    const detailMolstarColor = resolvedChainColoring.molstarColorByChainId.get(chain.chainId);
    const displayMolstarColor = detailVisible
      ? detailMolstarColor
      : STRUCTURE_CONTEXT_MOLSTAR_COLOR;
    const detailState: StructureChainDetailState = detailVisible ? 'detail' : 'context';
    return {
      chain,
      chainInstanceId: rowChainInstanceId,
      displayChainId: getDisplayChainId(chain),
      ...(member && rowMemberId ? { member, memberId: rowMemberId } : {}),
      groupId: chainGroup.groupId,
      groupLabel: chainGroup.groupLabel,
      groupEvidence: chainGroup.evidence,
      detailState,
      detailVisible,
      detailColor,
      ...(detailMolstarColor !== undefined ? { detailMolstarColor } : {}),
      displayColor: detailVisible ? detailColor : STRUCTURE_CONTEXT_COLOR,
      ...(displayMolstarColor !== undefined ? { displayMolstarColor } : {}),
    };
  });
  const chainGroups = chainGroupsFromRows(chainRows);

  return {
    ...(scene ? { scene } : {}),
    ...(view ? { view } : {}),
    chainColoring: resolvedChainColoring,
    orderedChains,
    chainRows,
    chainGroups,
    detailMemberIds: isComplex ? (detailMemberIds ?? []) : undefined,
    detailChainInstanceIds: isComplex
      ? (detailChainInstanceIds ??
        chainRows.filter((row) => row.detailVisible).map((row) => row.chainInstanceId))
      : undefined,
    molstarPalette: resolvedChainColoring.molstarPalette,
    contextColor: STRUCTURE_CONTEXT_COLOR,
    contextMolstarColor: STRUCTURE_CONTEXT_MOLSTAR_COLOR,
  };
}

function biologicalGroupForChain(
  chain: ChainSequence,
  member: StructureComplexMember | undefined,
  scene: StructureScene | undefined
): Pick<StructureChainGroup, 'groupId' | 'groupLabel' | 'evidence'> {
  const queryMember = scene?.members.find(
    (candidate) => candidate.memberId === scene.queryAnchor.memberId
  );
  const queryEntityIds = new Set([
    ...(scene?.queryAnchor.targetSelection.entityIds ?? []),
    ...entityIdsForMember(queryMember),
  ]);
  const queryGeneLabel = firstNonEmpty([
    scene?.queryAnchor.proteinIdentity?.feature?.label,
    scene?.queryAnchor.label,
    queryMember?.workspaceFeatureRef?.label,
    queryMember?.identifiers?.geneNames?.[0],
  ]);

  if (queryGeneLabel && chain.entityId && queryEntityIds.has(chain.entityId)) {
    return {
      groupId: structureChainGroupId(`query-gene:${stableStructureIdToken(queryGeneLabel)}`),
      groupLabel: queryGeneLabel,
      evidence: 'query-anchor',
    };
  }

  const geneName = firstNonEmpty(member?.identifiers?.geneNames);
  if (geneName) {
    return {
      groupId: structureChainGroupId(`gene:${stableStructureIdToken(geneName)}`),
      groupLabel: geneName,
      evidence: 'gene-name',
    };
  }

  const uniprotAccession = firstNonEmpty(member?.identifiers?.uniprotAccessions);
  if (uniprotAccession) {
    return {
      groupId: structureChainGroupId(`uniprot:${stableStructureIdToken(uniprotAccession)}`),
      groupLabel: member?.displayName ?? uniprotAccession,
      evidence: 'uniprot',
    };
  }

  const entityId = chain.entityId ?? member?.pdbEntityId ?? member?.selection.entityIds?.[0];
  if (entityId) {
    const pdbId = scene?.queryAnchor.targetSelection.pdbId ?? member?.selection.pdbId ?? 'pdb';
    return {
      groupId: structureChainGroupId(
        `pdb-entity:${stableStructureIdToken(pdbId)}:${stableStructureIdToken(entityId)}`
      ),
      groupLabel:
        member?.identifiers?.pdbEntityDescription ??
        nonGenericMemberLabel(member?.displayName) ??
        `Entity ${entityId}`,
      evidence: 'pdb-entity',
    };
  }

  const description = member?.displayName;
  if (description) {
    return {
      groupId: structureChainGroupId(`member-description:${stableStructureIdToken(description)}`),
      groupLabel: description,
      evidence: 'member-description',
    };
  }

  const displayChainId = getDisplayChainId(chain);
  return {
    groupId: structureChainGroupId(
      `chain-instance:${stableStructureIdToken(chainInstanceIdForSequenceChain(chain))}`
    ),
    groupLabel: `Chain ${displayChainId}`,
    evidence: 'chain-instance',
  };
}

function chainGroupsFromRows(rows: readonly StructureChainRenderRow[]): StructureChainGroup[] {
  const groups = new Map<string, StructureChainGroup>();
  for (const row of rows) {
    const group =
      groups.get(row.groupId) ??
      ({
        groupId: row.groupId,
        groupLabel: row.groupLabel,
        evidence: row.groupEvidence,
        chainIds: [],
        memberIds: [],
        entityIds: [],
        labelAsymIds: [],
        authAsymIds: [],
        chainCount: 0,
        detailVisibleCount: 0,
      } satisfies StructureChainGroup);
    pushUnique(group.chainIds, row.chain.chainId);
    if (row.memberId) pushUnique(group.memberIds, row.memberId);
    if (row.chain.entityId) pushUnique(group.entityIds, row.chain.entityId);
    if (row.chain.labelAsymId) pushUnique(group.labelAsymIds, row.chain.labelAsymId);
    if (row.chain.authAsymId) pushUnique(group.authAsymIds, row.chain.authAsymId);
    group.chainCount += 1;
    if (row.detailVisible) group.detailVisibleCount += 1;
    groups.set(row.groupId, group);
  }
  return [...groups.values()];
}

function entityIdsForMember(member: StructureComplexMember | undefined): string[] {
  return unique([
    ...(member?.selection.entityIds ?? []),
    ...(member?.pdbEntityId ? [member.pdbEntityId] : []),
  ]);
}

function chainInstanceIdFromStoredId(value: string): ChainInstanceId {
  return chainInstanceId(value);
}

function nonGenericMemberLabel(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  return /^chain\s+\S+$/i.test(value.trim()) ? undefined : value.trim();
}

function firstNonEmpty(values: readonly (string | undefined)[] | undefined): string | undefined {
  return values?.find((value): value is string => !!value?.trim())?.trim();
}

function unique(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => !!value?.trim()))];
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

export function normalizeStructureViewForScene(attrs: Structure3dAttrs): Structure3dAttrs {
  const view = structureViewStateForScene(attrs);
  return attrs.view === view ? attrs : { ...attrs, view };
}

export type StructureViewRenderIntent = NonNullable<StructureViewState['renderIntent']>;

export function structureViewStateForScene(
  attrs: Structure3dAttrs,
  options: { renderIntent?: StructureViewRenderIntent } = {}
): StructureViewState {
  const renderIntent = options.renderIntent ?? attrs.view?.renderIntent;
  if (renderIntent === 'preview' && shouldUsePdbPreviewDefault(attrs)) {
    return createQueryInComplexPreviewViewState(attrs);
  }
  if (shouldPromoteQueryInComplexSurfaceView(attrs)) {
    return createQueryInComplexSurfaceViewState(attrs);
  }
  if (shouldUseComplexQueryDefault(attrs)) {
    return renderIntent === 'preview'
      ? createQueryInComplexPreviewViewState(attrs)
      : createQueryInComplexViewState(attrs);
  }
  const view = structureViewStateFromAttrs(attrs);
  return renderIntent === undefined || view.renderIntent === renderIntent
    ? view
    : { ...view, renderIntent };
}

function shouldUsePdbPreviewDefault(attrs: Structure3dAttrs): boolean {
  if (!attrs.scene) return false;
  const source =
    attrs.source ??
    (attrs.pdbId || attrs.providerIdentityKey || attrs.scene.queryAnchor.targetSelection.pdbId
      ? 'pdb'
      : undefined);
  return source === 'pdb';
}

function shouldUseComplexQueryDefault(attrs: Structure3dAttrs): boolean {
  if (attrs.scene?.sceneKind !== 'complex') return false;
  if ((attrs.scene.members?.length ?? 0) <= 1) return false;
  const source =
    attrs.source ??
    (attrs.pdbId || attrs.providerIdentityKey || attrs.scene.queryAnchor.targetSelection.pdbId
      ? 'pdb'
      : undefined);
  if (source !== 'pdb') return false;
  if (!attrs.view) return true;
  if (attrs.view.activeRecipeId === 'query-in-complex') return false;
  if (isComplexAwareView(attrs.view)) return false;
  return attrs.view.activeRecipeId === 'cartoon' || attrs.view.recipe.id === 'cartoon';
}

function isComplexAwareView(view: StructureViewState): boolean {
  return view.recipe.layers.some(
    (layer) =>
      layer.target.kind === 'whole-complex' ||
      layer.target.kind === 'query-anchor' ||
      layer.target.kind === 'active-focus' ||
      layer.target.kind === 'context' ||
      layer.target.kind === 'member' ||
      layer.target.kind === 'member-kind' ||
      layer.target.kind === 'chain'
  );
}

function shouldPromoteQueryInComplexSurfaceView(attrs: Structure3dAttrs): boolean {
  if (attrs.view?.activeRecipeId !== 'query-in-complex') return false;
  return attrs.view.recipe.layers.some(
    (layer) =>
      layer.id === 'context-complex-surface' &&
      layer.target.kind === 'whole-complex' &&
      layer.representation.kind === 'surface'
  );
}

function createQueryInComplexViewState(attrs: Structure3dAttrs): StructureViewState {
  const baseView = structureViewStateFromAttrs(attrs);
  const cameraSnapshot = attrs.view?.cameraSnapshot ?? attrs.cameraSnapshot;
  const backgroundColor = attrs.view?.backgroundColor ?? attrs.backgroundColor;
  return {
    schemaVersion: 1,
    activeRecipeId: 'query-in-complex',
    recipe: createQueryInComplexRecipe(),
    renderIntent: 'loaded',
    ...(attrs.view?.detailMemberIds !== undefined
      ? { detailMemberIds: [...attrs.view.detailMemberIds] }
      : {}),
    ...(attrs.view?.detailChainInstanceIds !== undefined
      ? { detailChainInstanceIds: [...attrs.view.detailChainInstanceIds] }
      : {}),
    ...(cameraSnapshot !== undefined ? { cameraSnapshot } : {}),
    showWater: baseView.showWater,
    spin: baseView.spin,
    ...(backgroundColor !== undefined ? { backgroundColor } : {}),
  };
}

function createQueryInComplexSurfaceViewState(attrs: Structure3dAttrs): StructureViewState {
  const baseView = structureViewStateFromAttrs(attrs);
  const cameraSnapshot = attrs.view?.cameraSnapshot ?? attrs.cameraSnapshot;
  const backgroundColor = attrs.view?.backgroundColor ?? attrs.backgroundColor;
  return {
    schemaVersion: 1,
    activeRecipeId: 'query-in-complex-surface',
    recipe: createQueryInComplexSurfaceRecipe(),
    renderIntent: 'loaded',
    ...(attrs.view?.detailMemberIds !== undefined
      ? { detailMemberIds: [...attrs.view.detailMemberIds] }
      : {}),
    ...(attrs.view?.detailChainInstanceIds !== undefined
      ? { detailChainInstanceIds: [...attrs.view.detailChainInstanceIds] }
      : {}),
    ...(cameraSnapshot !== undefined ? { cameraSnapshot } : {}),
    showWater: baseView.showWater,
    spin: baseView.spin,
    ...(backgroundColor !== undefined ? { backgroundColor } : {}),
  };
}

function createQueryInComplexPreviewViewState(attrs: Structure3dAttrs): StructureViewState {
  const baseView = structureViewStateFromAttrs(attrs);
  const cameraSnapshot = attrs.view?.cameraSnapshot ?? attrs.cameraSnapshot;
  const backgroundColor = attrs.view?.backgroundColor ?? attrs.backgroundColor;
  return {
    schemaVersion: 1,
    activeRecipeId: 'query-in-complex-preview',
    recipe: createQueryInComplexPreviewRecipe(),
    renderIntent: 'preview',
    ...(attrs.view?.detailMemberIds !== undefined
      ? { detailMemberIds: [...attrs.view.detailMemberIds] }
      : {}),
    ...(attrs.view?.detailChainInstanceIds !== undefined
      ? { detailChainInstanceIds: [...attrs.view.detailChainInstanceIds] }
      : {}),
    ...(cameraSnapshot !== undefined ? { cameraSnapshot } : {}),
    showWater: baseView.showWater,
    spin: baseView.spin,
    ...(backgroundColor !== undefined ? { backgroundColor } : {}),
  };
}
