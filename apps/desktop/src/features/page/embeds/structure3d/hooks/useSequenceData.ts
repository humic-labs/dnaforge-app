'use client';

import { useState, useEffect } from 'react';
import type {
  ChainPolymerType,
  ChainSequence,
  StructureColoration,
  Structure3dColorMode,
  LigandInfo,
  StructureSequenceData,
} from '../types';
import { Model } from 'molstar/lib/mol-model/structure';
import type { Structure } from 'molstar/lib/mol-model/structure';
import { componentPropsFromSelector } from 'molstar/lib/extensions/mvs/load-helpers';
import { substructureFromSelector } from 'molstar/lib/extensions/mvs/components/selector';
import { extractEffectiveChainInfo, WATER_RESIDUES } from '../utils/molstarChainUtils';
import {
  POLYMER_COMPONENT_CODES as THREE_TO_ONE,
  encodedResidueIdentity,
  encodedPolymerKind,
  type EncodedResidueCategory,
} from '../utils/encodedPolymer';
import {
  resolveStructureColorProjection,
  resolveStructureColorLegends,
  observeStructureColorChanges,
} from '../molstar/structureColors';
import {
  mergeStructureColorations,
  structureResidueColorKey,
  UNREPRESENTED_COLORATION,
} from '../utils/structureColoration';
import { nativeStructureSources, chainInstanceIdForIdentity } from '../utils/structureIds';

function sequenceChainKey(chain: Parameters<typeof chainInstanceIdForIdentity>[0]): string {
  return `${chainInstanceIdForIdentity(chain)}:${JSON.stringify([chain.chainId, chain.authAsymId, chain.labelAsymId])}`;
}

type StoryInventoryNode = {
  kind: string;
  ref?: string;
  params?: Record<string, unknown>;
  custom?: Record<string, unknown>;
  children?: StoryInventoryNode[];
};

function storyMoleculeInventory(
  sources: ReturnType<typeof nativeStructureSources>,
  scene: string | undefined
): { chains: Set<string>; ligands: Set<string> } | null {
  if (!scene) return null;
  let roots: StoryInventoryNode[];
  try {
    const document = JSON.parse(scene);
    roots =
      document.kind === 'multiple'
        ? document.snapshots.map((snapshot: { root: StoryInventoryNode }) => snapshot.root)
        : [document.root];
    if (!roots.length || roots.some((root) => root?.kind !== 'root')) return null;
  } catch {
    return null;
  }
  const inventory = { chains: new Set<string>(), ligands: new Set<string>() };
  let resolvedSource = false;
  const visit = (
    node: StoryInventoryNode,
    source?: (typeof sources)[number],
    selection?: Structure,
    ancestorsVisible = true
  ) => {
    const visible = ancestorsVisible && node.custom?.is_hidden !== true;
    if (node.kind === 'structure') {
      source =
        sources.find((candidate) => candidate.structureRef === node.ref) ??
        (sources.length === 1 ? sources[0] : undefined);
      selection = source?.structure;
      if (source) resolvedSource = true;
    }
    if (visible && source && node.kind === 'component') {
      selection = substructureFromSelector(
        source.structure,
        componentPropsFromSelector(
          (node.params?.selector ?? 'all') as Parameters<typeof componentPropsFromSelector>[0]
        )
      );
    }
    if (visible && source && selection && node.kind === 'representation') {
      const opacities = node.children?.filter((child) => child.kind === 'opacity') ?? [];
      const opacity = opacities[opacities.length - 1];
      const native = node.custom?.molstar_representation_params as { alpha?: number } | undefined;
      if ((opacity?.params?.opacity ?? native?.alpha ?? 1) !== 0) {
        const polymerOnly = ['cartoon', 'backbone'].includes(String(node.params?.type));
        for (const unit of selection.units) {
          if (!('chainIndex' in unit) || !('residueIndex' in unit)) continue;
          const h = unit.model.atomicHierarchy;
          for (let atomOffset = 0; atomOffset < unit.elements.length; atomOffset++) {
            const atom = unit.elements[atomOffset];
            const residueIndex = unit.residueIndex[atom];
            const compId = h.atoms.label_comp_id.value(atom).toUpperCase();
            if (WATER_RESIDUES.has(compId)) continue;
            const chain = extractEffectiveChainInfo(unit, h.chains, unit.chainIndex[atom]);
            if (!chain) continue;
            const key = sequenceChainKey({
              chainId: chain.effectiveChainId,
              authAsymId: chain.authAsymId,
              labelAsymId: chain.labelAsymId,
              entityId: chain.entityId,
              operator: chain.operator,
              instanceId: chain.instanceId,
              structureRef: source.structureRef,
              isPrimarySource: source.isPrimarySource,
            });
            const encoded = encodedResidueIdentity(
              unit.model,
              chain.labelAsymId ?? chain.effectiveChainId,
              h.residues.label_seq_id.value(residueIndex),
              compId
            );
            if (encoded) inventory.chains.add(key);
            else if (!polymerOnly)
              inventory.ligands.add(
                `${key}:${h.residues.auth_seq_id.value(residueIndex)}:${compId}`
              );
          }
        }
      }
    }
    for (const child of node.children ?? []) visit(child, source, selection, visible);
  };
  for (const root of roots) visit(root);
  return resolvedSource ? inventory : null;
}

type SequencePlugin = {
  managers?: {
    structure?: {
      hierarchy?: {
        current?: {
          structures?: ReadonlyArray<{
            cell?: { obj?: { data?: SequenceStructureData } };
          }>;
        };
      };
    };
  };
};

type SequenceStructureData = {
  units?: SequenceStructureUnit[];
};

type SequenceStructureUnit = {
  id: string | number;
  conformation?: { operator?: { name?: string; instanceId?: string } };
  model?: {
    id?: string;
    sourceData?: Model['sourceData'];
    atomicHierarchy?: {
      residues: {
        auth_seq_id: { value: (index: number) => number };
        label_seq_id?: { value: (index: number) => number };
      };
      chains: Parameters<typeof extractEffectiveChainInfo>[1];
      atoms?: {
        label_comp_id?: { value: (index: number) => unknown };
        B_iso_or_equiv?: { value: (index: number) => number };
      };
    };
  };
  elements: ArrayLike<number>;
  residueIndex: ArrayLike<number>;
  chainIndex: ArrayLike<number>;
};

const RESIDUE_DISPLAY_LABEL: Record<string, string> = {
  DA: 'dA',
  DC: 'dC',
  DG: 'dG',
  DT: 'dT',
};

type ResidueCategory = EncodedResidueCategory;

export function polymerTypeFromCategories(
  categories: ReadonlySet<ResidueCategory>
): ChainPolymerType {
  return encodedPolymerKind(categories);
}

const STANDARD_POLYMER_CODES = new Set([
  'ALA',
  'ARG',
  'ASN',
  'ASP',
  'CYS',
  'GLU',
  'GLN',
  'GLY',
  'HIS',
  'ILE',
  'LEU',
  'LYS',
  'MET',
  'PHE',
  'PRO',
  'SER',
  'THR',
  'TRP',
  'TYR',
  'VAL',
  'DA',
  'DC',
  'DG',
  'DT',
  'A',
  'C',
  'G',
  'U',
]);

export function isModifiedResidue(name3: string, parentCompId?: string): boolean {
  const upper = name3.toUpperCase();
  return !!parentCompId || (upper in THREE_TO_ONE && !STANDARD_POLYMER_CODES.has(upper));
}

const PTM_FULL_NAMES: Record<string, string> = {
  TPO: 'Phosphothreonine',
  SEP: 'Phosphoserine',
  PTR: 'Phosphotyrosine',
  MLY: 'N,N-dimethyllysine',
  MLZ: 'N-methyllysine',
  M3L: 'N,N,N-trimethyllysine',
  ALY: 'N-acetyllysine',
  CSO: 'S-hydroxycysteine',
  CSD: '3-sulfinoalanine',
  OCS: 'Cysteinesulfonic acid',
  MSE: 'Selenomethionine',
  HYP: 'Hydroxyproline',
  NEP: 'N1-phosphonohistidine',
  HIC: '3-methylhistidine',
  CGU: 'Gamma-carboxyglutamic acid',
  SEC: 'Selenocysteine',
  PYL: 'Pyrrolysine',
};

export function getModifiedResidueName(name3: string): string {
  const upper = name3.toUpperCase();
  return PTM_FULL_NAMES[upper] || name3;
}

export function extractSequenceDataFromPlugin(
  plugin: unknown,
  colorMode: Structure3dColorMode,
  scene?: string | boolean
): StructureSequenceData | null {
  const sequencePlugin = plugin as SequencePlugin | null | undefined;
  const structHierarchy = sequencePlugin?.managers?.structure?.hierarchy;
  if (!structHierarchy?.current?.structures?.length) {
    return null;
  }

  const chainMap = new Map<string, ChainSequence>();
  const chainNativeColorations = new Map<string, StructureColoration[]>();
  const ligandMap = new Map<string, LigandInfo>();
  const chainCategories = new Map<string, Set<ResidueCategory>>();
  const nativeColors = resolveStructureColorProjection(plugin);

  const allSources = nativeStructureSources(plugin);
  const sources = scene === false ? allSources.slice(0, 1) : allSources;
  const storyInventory = storyMoleculeInventory(
    sources,
    typeof scene === 'string' ? scene : undefined
  );
  for (const [sourceIndex, source] of sources.entries()) {
    const sourceScope = {
      ...(source.structureRef ? { structureRef: source.structureRef } : {}),
      ...(sources.length > 1
        ? { sourceLabel: source.sourceLabel ?? `Structure ${sourceIndex + 1}` }
        : {}),
      ...(source.isPrimarySource !== undefined ? { isPrimarySource: source.isPrimarySource } : {}),
    };
    for (const unit of source.structure.units ?? []) {
      if (!('chainIndex' in unit) || !('residueIndex' in unit)) continue;
      if (!unit.model?.atomicHierarchy) continue;

      const atomicHierarchy = unit.model.atomicHierarchy;
      const residueTable = atomicHierarchy.residues;
      const chainTable = atomicHierarchy.chains;
      const atomTable = atomicHierarchy.atoms as typeof atomicHierarchy.atoms & {
        B_iso_or_equiv?: { value: (index: number) => number };
      };
      const seenResidues = new Set<string>();
      const seenPolymerResidueIndices = new Set<number>();
      const chainInfoByIndex = new Map<
        number,
        | (NonNullable<ReturnType<typeof extractEffectiveChainInfo>> & {
            molstarChainSerial?: number;
          })
        | null
      >();
      const getChainInfoForAtom = (atomIndex: number) => {
        const chainIdx = unit.chainIndex[atomIndex];
        if (!chainInfoByIndex.has(chainIdx)) {
          const chainInfo = extractEffectiveChainInfo(unit, chainTable, chainIdx);
          chainInfoByIndex.set(
            chainIdx,
            chainInfo
              ? {
                  ...chainInfo,
                  molstarChainSerial: getMolstarAuthAsymSerial(unit.model, chainInfo.authAsymId),
                }
              : null
          );
        }
        return chainInfoByIndex.get(chainIdx) ?? null;
      };

      for (let i = 0; i < unit.elements.length; i++) {
        const atomIndex = unit.elements[i];
        const resIdx = unit.residueIndex[atomIndex];
        if (seenPolymerResidueIndices.has(resIdx)) continue;
        let name3 = 'UNK';
        if (atomTable?.label_comp_id) {
          const val = atomTable.label_comp_id.value(atomIndex);
          if (val !== undefined && val !== null && typeof val === 'string' && val.length <= 10) {
            name3 = val;
          }
        }

        const name3Upper = name3.toUpperCase();
        if (WATER_RESIDUES.has(name3Upper)) continue;
        const chainInfo = getChainInfoForAtom(atomIndex);
        const chainId = chainInfo?.effectiveChainId ?? 'X';
        const labelSeqId = numericTableValue(residueTable.label_seq_id, resIdx);
        const identity = encodedResidueIdentity(
          unit.model,
          chainInfo?.labelAsymId ?? chainInfo?.baseChain ?? chainId,
          labelSeqId,
          name3Upper
        );
        const isStandardResidue = identity !== null;
        if (isStandardResidue) {
          if (seenPolymerResidueIndices.has(resIdx)) continue;
          seenPolymerResidueIndices.add(resIdx);
        }

        const colorKey = structureResidueColorKey(unit, resIdx, source.structureRef);
        const visibleColoration = nativeColors.all.get(colorKey);
        const coloration = isStandardResidue
          ? (nativeColors.backbone.get(colorKey) ??
            (visibleColoration ? { kind: 'unavailable' as const } : UNREPRESENTED_COLORATION))
          : (visibleColoration ?? UNREPRESENTED_COLORATION);
        const chainKey = sequenceChainKey({
          chainId,
          authAsymId: chainInfo?.authAsymId,
          labelAsymId: chainInfo?.labelAsymId,
          entityId: chainInfo?.entityId,
          operator: chainInfo?.operator,
          instanceId: chainInfo?.instanceId,
          ...sourceScope,
        });
        const position = residueTable.auth_seq_id.value(resIdx);
        const residueKey = isStandardResidue
          ? `${chainId}:${labelSeqId ?? position}`
          : `${chainId}:${position}:${name3Upper}`;

        if (isStandardResidue) {
          if (seenResidues.has(residueKey)) continue;
          seenResidues.add(residueKey);

          if (!chainMap.has(chainKey)) {
            chainMap.set(chainKey, {
              chainId,
              ...sourceScope,
              chainLabel: `Chain ${chainId}`,
              sequence: '',
              baseChain: chainInfo?.baseChain,
              labelAsymId: chainInfo?.labelAsymId,
              authAsymId: chainInfo?.authAsymId,
              entityId: chainInfo?.entityId,
              operator: chainInfo?.operator,
              instanceId: chainInfo?.instanceId,
              molstarChainSerial: chainInfo?.molstarChainSerial,
              residues: [],
            });
          }
          const chainSeq = chainMap.get(chainKey)!;
          const representativeColorations = [
            nativeColors.backbone.get(colorKey),
            nativeColors.alphaCarbon.get(colorKey),
          ].filter((value): value is StructureColoration => value !== undefined);
          const chainColorations = chainNativeColorations.get(chainKey) ?? [];
          chainColorations.push(
            representativeColorations.length
              ? mergeStructureColorations(representativeColorations)
              : coloration
          );
          chainNativeColorations.set(chainKey, chainColorations);
          const name = identity!.code;
          const displayLabel = RESIDUE_DISPLAY_LABEL[name3Upper];

          const categories = chainCategories.get(chainKey) ?? new Set<ResidueCategory>();
          categories.add(identity!.category);
          chainCategories.set(chainKey, categories);

          let value: number | undefined;
          if (colorMode === 'plddt' || colorMode === 'bfactor') {
            if (atomTable?.B_iso_or_equiv) {
              value = atomTable.B_iso_or_equiv.value(atomIndex);
            }
          }

          chainSeq.residues.push({
            position,
            ...(labelSeqId !== undefined ? { labelSeqId, sequenceIndex: labelSeqId - 1 } : {}),
            name,
            ...(displayLabel ? { displayLabel } : {}),
            name3,
            ...(identity!.parentCompId ? { parentCompId: identity!.parentCompId } : {}),
            value,
            coloration,
            ...(nativeColors.atomicDetail.get(colorKey)
              ? {
                  atomicDetail: nativeColors.atomicDetail.get(colorKey),
                  alphaCarbonColoration:
                    nativeColors.alphaCarbon.get(colorKey) ?? UNREPRESENTED_COLORATION,
                }
              : {}),
          });
        } else {
          const ligandKey = `${chainKey}:${position}:${name3Upper}`;
          if (ligandMap.has(ligandKey)) {
            ligandMap.get(ligandKey)!.atomCount++;
          } else {
            ligandMap.set(ligandKey, {
              name: name3Upper,
              chainId,
              ...sourceScope,
              position,
              atomCount: 1,
              coloration,
              baseChain: chainInfo?.baseChain,
              labelAsymId: chainInfo?.labelAsymId,
              authAsymId: chainInfo?.authAsymId,
              entityId: chainInfo?.entityId,
              operator: chainInfo?.operator,
              instanceId: chainInfo?.instanceId,
            });
          }
        }
      }
    }
  }

  const chains: ChainSequence[] = [];
  for (const [chainKey, chain] of chainMap) {
    if (storyInventory && !storyInventory.chains.has(chainKey)) continue;
    chain.residues.sort(
      (a, b) =>
        (a.sequenceIndex ?? Number.MAX_SAFE_INTEGER) -
          (b.sequenceIndex ?? Number.MAX_SAFE_INTEGER) || a.position - b.position
    );
    chain.residues = chain.residues.map((residue, index) => ({
      ...residue,
      sequenceIndex: residue.sequenceIndex ?? index,
    }));
    chain.sequence = chain.residues.map((r) => r.name).join('');
    chain.polymerType = polymerTypeFromCategories(
      chainCategories.get(chainKey) ?? new Set<ResidueCategory>()
    );
    chain.coloration = mergeStructureColorations(chainNativeColorations.get(chainKey) ?? []);
    chains.push(chain);
  }
  chains.sort(
    (a, b) =>
      (a.molstarChainSerial ?? Number.MAX_SAFE_INTEGER) -
        (b.molstarChainSerial ?? Number.MAX_SAFE_INTEGER) || a.chainId.localeCompare(b.chainId)
  );

  const ligands = Array.from(ligandMap)
    .filter(([key]) => !storyInventory || storyInventory.ligands.has(key))
    .map(([, ligand]) => ligand);
  ligands.sort((a, b) => a.chainId.localeCompare(b.chainId) || a.position - b.position);

  return chains.length > 0 || ligands.length > 0
    ? { chains, ligands, colorLegends: resolveStructureColorLegends(plugin) }
    : null;
}

function numericTableValue(
  tableColumn: { value: (row: number) => unknown } | undefined,
  row: number
): number | undefined {
  const value = tableColumn?.value(row);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getMolstarAuthAsymSerial(
  model: unknown,
  authAsymId: string | undefined
): number | undefined {
  if (!authAsymId) return undefined;
  const maybeModel = model as {
    properties?: {
      structAsymMap?: {
        forEach: (callback: (value: { auth_id?: string }, labelId: string) => void) => void;
      };
    };
  };
  const structAsymMap = maybeModel.properties?.structAsymMap;
  if (!structAsymMap) return undefined;

  let offset = 0;
  try {
    offset = Model.AsymIdOffset.get(model as never).value?.auth ?? 0;
  } catch {
    offset = 0;
  }

  let serial: number | undefined;
  let count = 0;
  structAsymMap.forEach(({ auth_id }) => {
    if (serial === undefined && auth_id === authAsymId) {
      serial = count + offset;
    }
    count += 1;
  });
  return serial;
}

export function useSequenceData(
  plugin: unknown,
  colorMode: Structure3dColorMode,
  ready: boolean,
  sceneRevision?: string,
  comparisonModels = false
): StructureSequenceData | null {
  const [data, setData] = useState<StructureSequenceData | null>(null);

  useEffect(() => {
    if (!plugin || !ready) {
      setData(null);
      return;
    }

    const refresh = () => {
      try {
        setData(
          extractSequenceDataFromPlugin(plugin, colorMode, sceneRevision || comparisonModels)
        );
      } catch (error) {
        console.error('[useSequenceData] Failed to extract sequence:', error);
        setData(null);
      }
    };
    refresh();
    return observeStructureColorChanges(plugin, refresh);
  }, [plugin, colorMode, ready, sceneRevision, comparisonModels]);

  return data;
}

export function getColorModeDomain(colorMode: Structure3dColorMode): [number, number] {
  switch (colorMode) {
    case 'plddt':
      return [0, 100];
    case 'bfactor':
      return [0, 100];
    case 'alphamissense':
      return [0, 1];
    default:
      return [0, 1];
  }
}
