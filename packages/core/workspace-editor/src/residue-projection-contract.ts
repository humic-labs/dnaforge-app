import type {
  ResidueSelection,
  ResidueSelectionMapping,
  ResidueSelectionTarget,
} from './residue-selection-store';

export interface ResidueProjectionMoleculeAlias {
  moleculeId: string;
  moleculeKind?: string;
  label?: string;
}

export interface ResidueProjectionMolecule {
  moleculeId: string;
  moleculeKind: string;
  label?: string;
  aliases?: ReadonlyArray<ResidueProjectionMoleculeAlias>;
}

export interface ResidueProjectionRuleContext<TLocation = unknown> {
  contract: ResidueProjectionContract<TLocation>;
  selectionTargetsMolecule: boolean;
  selectionHasForeignMolecule: boolean;
}

export interface ResidueProjectionRule<TLocation = unknown> {
  kind: string;
  selectionToResidueIndices?: (
    selection: ResidueSelection,
    context: ResidueProjectionRuleContext<TLocation>
  ) => Iterable<number> | null | undefined;
  residueIndexToMappings?: (
    residueIndex: number,
    context: ResidueProjectionRuleContext<TLocation>
  ) => ReadonlyArray<ResidueSelectionMapping>;
  residueIndexToLocations?: (
    residueIndex: number,
    context: ResidueProjectionRuleContext<TLocation>
  ) => ReadonlyArray<TLocation>;
  locationToResidueIndex?: (
    location: TLocation,
    context: ResidueProjectionRuleContext<TLocation>
  ) => number | null | undefined;
}

export interface ResidueProjectionContract<TLocation = unknown> {
  contractId: string;
  molecule: ResidueProjectionMolecule;
  rules: ReadonlyArray<ResidueProjectionRule<TLocation>>;
  ignoreForeignTargetForSourceKinds?: ReadonlyArray<string>;
}

export function residueMoleculeKindsCompatible(
  left: string | undefined,
  right: string | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return normalizeResidueMoleculeKind(left) === normalizeResidueMoleculeKind(right);
}

export function residueSelectionTargetsProjectionMolecule<TLocation>(
  selection: ResidueSelection,
  contract: ResidueProjectionContract<TLocation>
): boolean {
  const target = selection.target;
  return (
    target.coordinateSystem === 'residue' &&
    (targetMatchesProjectionMolecule(target, contract.molecule) ||
      (contract.molecule.aliases ?? []).some((alias) =>
        targetMatchesProjectionAlias(target, alias)
      ))
  );
}

export function residueSelectionHasForeignProjectionMolecule<TLocation>(
  selection: ResidueSelection,
  contract: ResidueProjectionContract<TLocation>
): boolean {
  if (contract.ignoreForeignTargetForSourceKinds?.includes(selection.source?.kind ?? '')) {
    return false;
  }
  if (selection.target.coordinateSystem !== 'residue') return false;
  return !residueSelectionTargetsProjectionMolecule(selection, contract);
}

export function residueSelectionProjectsIntoContract<TLocation>(
  contract: ResidueProjectionContract<TLocation>,
  selection: ResidueSelection
): boolean {
  return residueIndicesForProjectionSelection(contract, selection).length > 0;
}

export function residueIndicesForProjectionSelection<TLocation>(
  contract: ResidueProjectionContract<TLocation>,
  selection: ResidueSelection
): number[] {
  const selectionTargetsMolecule = residueSelectionTargetsProjectionMolecule(selection, contract);
  const selectionHasForeignMolecule = residueSelectionHasForeignProjectionMolecule(
    selection,
    contract
  );

  if (selectionTargetsMolecule) {
    return dedupeResidueIndices(intervalsToResidueIndices(selection.target.intervals));
  }
  if (selectionHasForeignMolecule) {
    return [];
  }

  const context: ResidueProjectionRuleContext<TLocation> = {
    contract,
    selectionTargetsMolecule,
    selectionHasForeignMolecule,
  };
  const indices: number[] = [];
  for (const rule of contract.rules) {
    const projected = rule.selectionToResidueIndices?.(selection, context);
    if (!projected) continue;
    for (const residueIndex of projected) indices.push(residueIndex);
  }
  return dedupeResidueIndices(indices);
}

export function selectionMappingsForProjectionResidueIndex<TLocation>(
  contract: ResidueProjectionContract<TLocation>,
  residueIndex: number
): ResidueSelectionMapping[] {
  if (!isUsableResidueIndex(residueIndex)) return [];

  const context: ResidueProjectionRuleContext<TLocation> = {
    contract,
    selectionTargetsMolecule: true,
    selectionHasForeignMolecule: false,
  };
  const mappings: ResidueSelectionMapping[] = [];
  for (const rule of contract.rules) {
    const projected = rule.residueIndexToMappings?.(residueIndex, context);
    if (!projected) continue;
    mappings.push(...projected);
  }
  return mappings;
}

export function projectionLocationsForResidueIndex<TLocation>(
  contract: ResidueProjectionContract<TLocation>,
  residueIndex: number
): TLocation[] {
  if (!isUsableResidueIndex(residueIndex)) return [];

  const context: ResidueProjectionRuleContext<TLocation> = {
    contract,
    selectionTargetsMolecule: true,
    selectionHasForeignMolecule: false,
  };
  const locations: TLocation[] = [];
  for (const rule of contract.rules) {
    const projected = rule.residueIndexToLocations?.(residueIndex, context);
    if (!projected) continue;
    locations.push(...projected);
  }
  return locations;
}

export function residueIndexForProjectionLocation<TLocation>(
  contract: ResidueProjectionContract<TLocation>,
  location: TLocation
): number | null {
  const context: ResidueProjectionRuleContext<TLocation> = {
    contract,
    selectionTargetsMolecule: true,
    selectionHasForeignMolecule: false,
  };
  for (const rule of contract.rules) {
    const residueIndex = rule.locationToResidueIndex?.(location, context);
    if (residueIndex === null || residueIndex === undefined) continue;
    if (!isUsableResidueIndex(residueIndex)) continue;
    return residueIndex;
  }
  return null;
}

function targetMatchesProjectionMolecule(
  target: ResidueSelectionTarget,
  molecule: ResidueProjectionMolecule
): boolean {
  return (
    target.moleculeId === molecule.moleculeId &&
    residueMoleculeKindsCompatible(target.moleculeKind, molecule.moleculeKind)
  );
}

function targetMatchesProjectionAlias(
  target: ResidueSelectionTarget,
  alias: ResidueProjectionMoleculeAlias
): boolean {
  return (
    target.moleculeId === alias.moleculeId &&
    (!alias.moleculeKind || residueMoleculeKindsCompatible(target.moleculeKind, alias.moleculeKind))
  );
}

function normalizeResidueMoleculeKind(kind: string): string {
  if (kind === 'protein-sequence') return 'protein';
  return kind;
}

function intervalsToResidueIndices(
  intervals: ResidueSelectionTarget['intervals']
): Iterable<number> {
  return (function* () {
    for (const interval of intervals) {
      const min = Math.min(interval.start, interval.end);
      const max = Math.max(interval.start, interval.end);
      for (let residueIndex = min; residueIndex <= max; residueIndex += 1) {
        yield residueIndex;
      }
    }
  })();
}

function dedupeResidueIndices(indices: Iterable<number>): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const residueIndex of indices) {
    if (!isUsableResidueIndex(residueIndex)) continue;
    if (seen.has(residueIndex)) continue;
    seen.add(residueIndex);
    result.push(residueIndex);
  }
  return result;
}

function isUsableResidueIndex(residueIndex: number): boolean {
  return Number.isInteger(residueIndex) && residueIndex >= 0;
}
