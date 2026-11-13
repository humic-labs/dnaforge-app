import type {
  ResidueProjectionContract,
  ResidueProjectionMolecule,
  ResidueProjectionMoleculeAlias,
  ResidueProjectionRule,
  ResidueSelection,
  ResidueSelectionCodingDnaMapping,
  ResidueSelectionMapping,
  ResidueSelectionSource,
  ResidueSelectionStructureMapping,
} from '@waypoint/workspace-editor';
import {
  projectionLocationsForResidueIndex,
  residueIndexForProjectionLocation,
  residueIndicesForProjectionSelection,
  residueSelectionProjectsIntoContract,
  selectionMappingsForProjectionResidueIndex,
  translatedCdsMoleculeIdFromParts,
} from '@waypoint/workspace-editor';
import {
  hasStructureCodingBounds,
  type StructureCodingBounds,
  type StructureLinkEntry,
} from '../../../../structure-drawer/public/state/use-structure-link-registry';
import {
  bpToCodonIndex,
  codonToBpRange,
} from '../../../../structure-drawer/public/utils/codon-residue-mapping';
import {
  linkedResidueIndexForStructureResidue,
  structureResiduesForLinkedResidueIndex,
} from '../../../../structure-drawer/public/utils/residue-target-mapping';
import type { ResidueLocation } from '../types';

export type ResidueSelectionLink = Pick<
  StructureLinkEntry,
  | 'sequenceDocumentId'
  | 'cdsStart'
  | 'cdsEnd'
  | 'strand'
  | 'cdsLabel'
  | 'cdsFeatureId'
  | 'residueTarget'
  | 'residueTargets'
  | 'residueMolecule'
>;

export interface BuildResidueSelectionsForStructureLinkArgs {
  structureId: string;
  link: ResidueSelectionLink;
  selectedResidues: ReadonlyArray<ResidueLocation>;
}

export interface ApplyStructureSelectionIntentArgs {
  structureId: string;
  link: ResidueSelectionLink;
  currentSelections: ReadonlyArray<ResidueSelection>;
  selectedResidues: ReadonlyArray<ResidueLocation>;
}

export function buildResidueSelectionsForStructureLink({
  structureId,
  link,
  selectedResidues,
}: BuildResidueSelectionsForStructureLinkArgs): ResidueSelection[] {
  const contract = residueProjectionContractForStructureLink(structureId, link);
  const source: ResidueSelectionSource = {
    kind: 'structure',
    id: structureId,
    surface: 'molstar',
  };
  const residuesByIndex = new Map<number, ResidueLocation[]>();

  for (const res of selectedResidues) {
    if (res.isPrimarySource === false) continue;
    if (res.compId) continue;
    const residueIndex = residueIndexForProjectionLocation(contract, res);
    if (residueIndex === null) continue;
    const group = residuesByIndex.get(residueIndex);
    if (group) {
      if (!hasResidueLocation(group, res)) group.push(res);
    } else {
      residuesByIndex.set(residueIndex, [res]);
    }
  }

  const selections: ResidueSelection[] = [];
  for (const [residueIndex, residues] of residuesByIndex) {
    const projectedMappings = selectionMappingsForProjectionResidueIndex(contract, residueIndex);
    if (
      structureLinkHasCodingDnaProjection(link) &&
      !projectedMappings.some((mapping) => mapping.kind === 'coding-dna')
    ) {
      continue;
    }
    const structureMappings = residues.map((res) => structureResidueToMapping(structureId, res));
    const mappings: ResidueSelection['mappings'] = [...projectedMappings, ...structureMappings];

    selections.push({
      selectionId: `${source.kind}:${source.id ?? structureId}:residue:${residueIndex}`,
      source,
      target: {
        moleculeId: contract.molecule.moleculeId,
        moleculeKind: contract.molecule.moleculeKind,
        coordinateSystem: 'residue',
        intervals: [{ start: residueIndex, end: residueIndex }],
        label: contract.molecule.label,
      },
      mappings,
    });
  }

  return selections;
}

export function residueSelectionMapsToStructureLink(
  selection: ResidueSelection,
  link: ResidueSelectionLink
): boolean {
  return residueSelectionProjectsIntoContract(
    residueProjectionContractForStructureLink(undefined, link),
    selection
  );
}

export interface ResidueSelectionsToStructureResiduesArgs {
  structureId: string;
  link: ResidueSelectionLink;
  selections: ReadonlyArray<ResidueSelection>;
  residueInventory?: ReadonlyArray<ResidueLocation>;
}

export function residueSelectionsToStructureResidues({
  structureId,
  link,
  selections,
  residueInventory,
}: ResidueSelectionsToStructureResiduesArgs): ResidueLocation[] {
  const contract = residueProjectionContractForStructureLink(structureId, link);
  const inventoryByCoordinate = new Map<string, ResidueLocation[]>();
  for (const residue of residueInventory ?? []) {
    if (residue.isPrimarySource === false || residue.compId) continue;
    const key = [residue.chain, residue.position].join('\u0000');
    const matches = inventoryByCoordinate.get(key);
    if (matches) matches.push(residue);
    else inventoryByCoordinate.set(key, [residue]);
  }
  const residues: ResidueLocation[] = [];
  const seen = new Set<string>();

  const push = (residue: ResidueLocation) => {
    const key = residueLocationKey(residue);
    if (seen.has(key)) return;
    seen.add(key);
    residues.push(residue);
  };

  for (const selection of selections) {
    for (const residueIndex of residueIndicesForProjectionSelection(contract, selection)) {
      for (const residue of projectionLocationsForResidueIndex(contract, residueIndex)) {
        const matches = inventoryByCoordinate
          .get([residue.chain, residue.position].join('\u0000'))
          ?.filter((native) => residueLocationMatchesPartial(native, residue));
        if (matches?.length) {
          for (const native of matches) {
            push({
              ...(native.baseChain !== undefined ? { baseChain: native.baseChain } : {}),
              ...(native.labelAsymId !== undefined ? { labelAsymId: native.labelAsymId } : {}),
              ...(native.authAsymId !== undefined ? { authAsymId: native.authAsymId } : {}),
              ...(native.entityId !== undefined ? { entityId: native.entityId } : {}),
              ...(native.labelSeqId !== undefined ? { labelSeqId: native.labelSeqId } : {}),
              ...(native.operator !== undefined ? { operator: native.operator } : {}),
              ...(native.structureRef !== undefined ? { structureRef: native.structureRef } : {}),
              ...(native.instanceId !== undefined ? { instanceId: native.instanceId } : {}),
              ...residue,
            });
          }
        } else {
          push(residue);
        }
      }
    }
  }

  return residues;
}

export function applyStructureSelectionIntentToResidueSelections({
  structureId,
  link,
  currentSelections,
  selectedResidues,
}: ApplyStructureSelectionIntentArgs): ResidueSelection[] {
  const outsideLink: ResidueSelection[] = [];
  const insideLink: ResidueSelection[] = [];
  for (const selection of currentSelections) {
    if (residueSelectionMapsToStructureLink(selection, link)) {
      insideLink.push(selection);
    } else {
      outsideLink.push(selection);
    }
  }

  const selectableResidues = selectedResidues.filter(
    (residue) => !residue.compId && residue.isPrimarySource !== false
  );
  if (selectableResidues.length === 0) {
    return outsideLink;
  }

  const selectableResidueIndices = residueIndicesForStructureResidues(link, selectableResidues);
  const suppressedResidueIndices = new Set<number>();
  const preservedSelections: ResidueSelection[] = [];
  const preservedResidueIndices = new Set<number>();
  for (const selection of insideLink) {
    const selectionResidueIndices = residueIndicesForSelection(selection, link);
    if (selectionResidueIndices.length === 0) continue;

    const everyResidueStillFullySelected = selectionResidueIndices.every((residueIndex) =>
      everyMappedStructureResidueIsSelected(link, residueIndex, selectableResidues)
    );
    if (residueSelectionOwnedByStructurePanel(selection, structureId, link)) {
      if (!everyResidueStillFullySelected) {
        for (const residueIndex of selectionResidueIndices) {
          const selectedCount = selectableResidueIndices.get(residueIndex)?.length ?? 0;
          if (selectedCount > 0) {
            suppressedResidueIndices.add(residueIndex);
          }
        }
      }
      continue;
    }

    if (everyResidueStillFullySelected) {
      preservedSelections.push(selection);
      for (const residueIndex of selectionResidueIndices) preservedResidueIndices.add(residueIndex);
      continue;
    }

    for (const residueIndex of selectionResidueIndices) {
      const selectedCount = selectableResidueIndices.get(residueIndex)?.length ?? 0;
      if (selectedCount > 0) {
        suppressedResidueIndices.add(residueIndex);
      }
    }
  }

  const residuesForStructureWrite = selectableResidues.filter((residue) => {
    const residueIndex = residueIndexForStructureResidue(link, residue);
    if (residueIndex === null) return false;
    return (
      !preservedResidueIndices.has(residueIndex) && !suppressedResidueIndices.has(residueIndex)
    );
  });
  const structureSelections = buildResidueSelectionsForStructureLink({
    structureId,
    link,
    selectedResidues: residuesForStructureWrite,
  });

  return [...outsideLink, ...preservedSelections, ...structureSelections];
}

export function canonicalResidueLocationForStructureLink(
  link: ResidueSelectionLink,
  residue: ResidueLocation
): ResidueLocation | null {
  if (residue.isPrimarySource === false) return null;
  const contract = residueProjectionContractForStructureLink(undefined, link);
  const residueIndex = residueIndexForProjectionLocation(contract, residue);
  if (residueIndex === null) return null;
  const mappedResidues = projectionLocationsForResidueIndex(contract, residueIndex).map(
    (mapped) => ({ ...residue, ...mapped })
  );
  return (
    mappedResidues.find((mapped) => residueLocationMatchesPartial(mapped, residue)) ??
    mappedResidues[0] ??
    null
  );
}

export function codingDnaRangeForStructureResidue(
  link: ResidueSelectionLink,
  residue: ResidueLocation
): { start: number; end: number; strand: 1 | -1; residueIndex: number } | null {
  if (residue.isPrimarySource === false) return null;
  if (!structureLinkHasCodingDnaProjection(link)) return null;
  const residueIndex = residueIndexForProjectionLocation(
    residueProjectionContractForStructureLink(undefined, link),
    residue
  );
  if (residueIndex === null) return null;
  const bpRange = codonToBpRange(residueIndex, link);
  if (!bpRange) return null;
  return {
    start: bpRange.start,
    end: bpRange.end,
    strand: link.strand,
    residueIndex,
  };
}

export function residueSelectionOwnedByStructurePanel(
  selection: ResidueSelection,
  structureId: string,
  link: ResidueSelectionLink
): boolean {
  return (
    selection.source?.kind === 'structure' &&
    selection.source.id === structureId &&
    residueSelectionMapsToStructureLink(selection, link)
  );
}

function translatedCdsMoleculeId(link: ResidueSelectionLink & StructureCodingBounds): string {
  return translatedCdsMoleculeIdForFeatureKey(link, preferredCodingDnaFeatureId(link));
}

function translatedCdsMoleculeIdForFeatureKey(
  link: ResidueSelectionLink & StructureCodingBounds,
  featureKey: string
): string {
  return translatedCdsMoleculeIdFromParts({
    referenceId: link.sequenceDocumentId,
    featureKey,
    start0: link.cdsStart,
    end0: link.cdsEnd,
    strand: link.strand,
  });
}

export function residueProjectionContractForStructureLink(
  structureId: string | undefined,
  link: ResidueSelectionLink
): ResidueProjectionContract<ResidueLocation> {
  const rules: ResidueProjectionRule<ResidueLocation>[] = [];
  if (structureLinkHasCodingDnaProjection(link)) {
    rules.push(codingDnaProjectionRuleForStructureLink(link));
  }
  rules.push(structureResidueProjectionRuleForStructureLink(structureId, link));

  const molecule = residueProjectionMoleculeForStructureLink(link);
  return {
    contractId: `structure-link:${structureId ?? 'any'}:${molecule.moleculeId}`,
    molecule,
    rules,
    ignoreForeignTargetForSourceKinds: ['selected-codon-compat'],
  };
}

function residueProjectionMoleculeForStructureLink(
  link: ResidueSelectionLink
): ResidueProjectionMolecule {
  const molecule = residueMoleculeForStructureLink(link);
  const aliases = structureLinkHasCodingDnaProjection(link)
    ? translatedCdsMoleculeAliasesForStructureLink(link, molecule.moleculeId)
    : [];
  return aliases.length ? { ...molecule, aliases } : molecule;
}

function residueMoleculeForStructureLink(link: ResidueSelectionLink): ResidueProjectionMolecule {
  if (link.residueMolecule) return link.residueMolecule;
  if (!hasStructureCodingBounds(link))
    throw new Error('The structure link has no protein identity or coding-DNA bounds.');
  return {
    moleculeId: translatedCdsMoleculeId(link),
    moleculeKind: 'translated-cds',
    label: link.cdsLabel,
  };
}

function translatedCdsMoleculeAliasesForStructureLink(
  link: ResidueSelectionLink & StructureCodingBounds,
  primaryMoleculeId: string
): ResidueProjectionMoleculeAlias[] {
  const aliases: ResidueProjectionMoleculeAlias[] = [];
  const seen = new Set<string>([primaryMoleculeId]);
  for (const featureKey of codingDnaFeatureIdsForStructureLink(link)) {
    const moleculeId = translatedCdsMoleculeIdForFeatureKey(link, featureKey);
    if (seen.has(moleculeId)) continue;
    seen.add(moleculeId);
    aliases.push({
      moleculeId,
      moleculeKind: 'translated-cds',
      label: featureKey,
    });
  }
  return aliases;
}

function codingDnaProjectionRuleForStructureLink(
  link: ResidueSelectionLink & StructureCodingBounds
): ResidueProjectionRule<ResidueLocation> {
  return {
    kind: 'coding-dna',
    selectionToResidueIndices(selection) {
      const indices: number[] = [];
      for (const mapping of selection.mappings ?? []) {
        if (!codingDnaMappingMatchesStructureLink(mapping, link)) continue;
        for (const interval of mapping.intervals) {
          const startIndex = bpToCodonIndex(interval.start, link);
          const endIndex = bpToCodonIndex(interval.end, link);
          if (startIndex === null || endIndex === null) continue;
          const min = Math.min(startIndex, endIndex);
          const max = Math.max(startIndex, endIndex);
          for (let residueIndex = min; residueIndex <= max; residueIndex += 1) {
            indices.push(residueIndex);
          }
        }
      }
      return indices;
    },
    residueIndexToMappings(residueIndex) {
      const bpRange = codonToBpRange(residueIndex, link);
      if (!bpRange) return [];
      return [
        {
          kind: 'coding-dna',
          referenceId: link.sequenceDocumentId,
          featureId: preferredCodingDnaFeatureId(link),
          strand: link.strand,
          intervals: [{ start: bpRange.start, end: bpRange.end }],
        },
      ];
    },
  };
}

function structureResidueProjectionRuleForStructureLink(
  structureId: string | undefined,
  link: ResidueSelectionLink
): ResidueProjectionRule<ResidueLocation> {
  return {
    kind: 'structure',
    selectionToResidueIndices(selection) {
      if (!structureId) return [];
      const indices: number[] = [];
      for (const mapping of selection.mappings ?? []) {
        if (mapping.kind !== 'structure' || mapping.structureId !== structureId) continue;
        const residueIndex = residueIndexForStructureResidue(
          link,
          structureMappingToResidueLocation(mapping)
        );
        if (residueIndex !== null) indices.push(residueIndex);
      }
      return indices;
    },
    residueIndexToLocations(residueIndex) {
      return structureResiduesForResidueIndex(link, residueIndex);
    },
    locationToResidueIndex(location) {
      return residueIndexForStructureResidue(link, location);
    },
  };
}

function structureLinkHasCodingDnaProjection(
  link: ResidueSelectionLink
): link is ResidueSelectionLink & StructureCodingBounds {
  return hasStructureCodingBounds(link);
}

function codingDnaMappingMatchesStructureLink(
  mapping: ResidueSelectionMapping,
  link: ResidueSelectionLink
): mapping is ResidueSelectionCodingDnaMapping {
  return (
    mapping.kind === 'coding-dna' &&
    mapping.referenceId === link.sequenceDocumentId &&
    mapping.strand === link.strand &&
    (!mapping.featureId || codingDnaFeatureIdMatchesStructureLink(mapping.featureId, link))
  );
}

function codingDnaFeatureIdMatchesStructureLink(
  featureId: string,
  link: ResidueSelectionLink
): boolean {
  return codingDnaFeatureIdsForStructureLink(link).has(featureId);
}

function codingDnaFeatureIdsForStructureLink(link: ResidueSelectionLink): Set<string> {
  return new Set(
    [link.cdsFeatureId, link.cdsLabel]
      .map((featureId) => featureId?.trim())
      .filter((featureId): featureId is string => !!featureId)
  );
}

function preferredCodingDnaFeatureId(link: ResidueSelectionLink): string {
  return link.cdsFeatureId?.trim() || link.cdsLabel;
}

function residueIndicesForSelection(
  selection: ResidueSelection,
  link: ResidueSelectionLink
): number[] {
  return residueIndicesForProjectionSelection(
    residueProjectionContractForStructureLink(undefined, link),
    selection
  );
}

function residueIndicesForStructureResidues(
  link: ResidueSelectionLink,
  residues: ReadonlyArray<ResidueLocation>
): Map<number, ResidueLocation[]> {
  const byIndex = new Map<number, ResidueLocation[]>();
  for (const residue of residues) {
    const residueIndex = residueIndexForStructureResidue(link, residue);
    if (residueIndex === null) continue;
    const group = byIndex.get(residueIndex);
    if (group) group.push(residue);
    else byIndex.set(residueIndex, [residue]);
  }
  return byIndex;
}

function everyMappedStructureResidueIsSelected(
  link: ResidueSelectionLink,
  residueIndex: number,
  selectedResidues: ReadonlyArray<ResidueLocation>
): boolean {
  const mappedResidues = structureResiduesForResidueIndex(link, residueIndex);
  return (
    mappedResidues.length > 0 &&
    mappedResidues.every((residue) =>
      selectedResidues.some((selected) => residueLocationMatchesPartial(selected, residue))
    )
  );
}

function structureResiduesForResidueIndex(
  link: ResidueSelectionLink,
  residueIndex: number
): ResidueLocation[] {
  return structureResiduesForLinkedResidueIndex(link, residueIndex);
}

function residueIndexForStructureResidue(
  link: ResidueSelectionLink,
  residue: ResidueLocation
): number | null {
  return linkedResidueIndexForStructureResidue(link, residue);
}

function structureResidueToMapping(
  structureId: string,
  residue: ResidueLocation
): ResidueSelectionStructureMapping {
  return {
    kind: 'structure',
    structureId,
    chain: residue.chain,
    position: residue.position,
    residueStart: residue.position,
    residueEnd: residue.position,
    ...(residue.baseChain ? { baseChain: residue.baseChain } : {}),
    ...(residue.labelAsymId ? { labelAsymId: residue.labelAsymId } : {}),
    ...(residue.authAsymId ? { authAsymId: residue.authAsymId } : {}),
    ...(residue.entityId ? { entityId: residue.entityId } : {}),
    ...(residue.labelSeqId !== undefined ? { labelSeqId: residue.labelSeqId } : {}),
    ...(residue.operator ? { operator: residue.operator } : {}),
  };
}

function structureMappingToResidueLocation(
  mapping: ResidueSelectionStructureMapping
): ResidueLocation {
  return {
    chain: mapping.chain,
    position: mapping.position,
    ...(mapping.baseChain ? { baseChain: mapping.baseChain } : {}),
    ...(mapping.labelAsymId ? { labelAsymId: mapping.labelAsymId } : {}),
    ...(mapping.authAsymId ? { authAsymId: mapping.authAsymId } : {}),
    ...(mapping.entityId ? { entityId: mapping.entityId } : {}),
    ...(mapping.labelSeqId !== undefined ? { labelSeqId: mapping.labelSeqId } : {}),
    ...(mapping.operator ? { operator: mapping.operator } : {}),
  };
}

export function sameResidueLocations(
  left: ReadonlyArray<ResidueLocation>,
  right: ReadonlyArray<ResidueLocation>
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every(
    (residue, index) => residueLocationKey(residue) === residueLocationKey(right[index])
  );
}

export function hasResidueLocation(
  residues: ReadonlyArray<ResidueLocation>,
  target: ResidueLocation
): boolean {
  const targetKey = residueLocationKey(target);
  return residues.some((residue) => residueLocationKey(residue) === targetKey);
}

export function residueLocationsKey(residues: ReadonlyArray<ResidueLocation>): string {
  return residues.map(residueLocationKey).join('\u0001');
}

function residueLocationKey(residue: ResidueLocation): string {
  return [
    residue.chain,
    residue.position,
    residue.compId ?? '',
    residue.baseChain ?? '',
    residue.labelAsymId ?? '',
    residue.authAsymId ?? '',
    residue.entityId ?? '',
    residue.labelSeqId ?? '',
    residue.operator ?? '',
    residue.structureRef ?? '',
    residue.instanceId ?? '',
  ].join('\u0000');
}

function residueLocationMatchesPartial(full: ResidueLocation, partial: ResidueLocation): boolean {
  return (
    full.chain === partial.chain &&
    full.position === partial.position &&
    optionalScopeMatches(partial.compId, full.compId) &&
    optionalScopeMatches(partial.baseChain, full.baseChain) &&
    optionalScopeMatches(partial.labelAsymId, full.labelAsymId) &&
    optionalScopeMatches(partial.authAsymId, full.authAsymId) &&
    optionalScopeMatches(partial.entityId, full.entityId) &&
    optionalNumberScopeMatches(partial.labelSeqId, full.labelSeqId) &&
    optionalScopeMatches(partial.operator, full.operator) &&
    optionalScopeMatches(partial.structureRef, full.structureRef) &&
    optionalScopeMatches(partial.instanceId, full.instanceId)
  );
}

function optionalScopeMatches(expected: string | undefined, actual: string | undefined): boolean {
  return expected === undefined || expected === actual;
}

function optionalNumberScopeMatches(
  expected: number | undefined,
  actual: number | undefined
): boolean {
  return expected === undefined || expected === actual;
}
