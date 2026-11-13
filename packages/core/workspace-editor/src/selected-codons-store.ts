import { useMemo } from 'react';
import {
  ResidueSelectionsProvider,
  createResidueSelectionsStore,
  residueSelectionsToCodingDnaRanges,
  useCreateResidueSelectionsStore,
  useResidueSelections,
  useResidueSelectionsStore,
  type CodingDnaSelectionRange,
  type ResidueSelection,
  type ResidueSelectionsStore,
} from './residue-selection-store';

export type SelectedCodonKey = CodingDnaSelectionRange;
export type SelectedCodonsStore = ResidueSelectionsStore;

export const SelectedCodonsProvider = ResidueSelectionsProvider;

export function createSelectedCodonsStore(): SelectedCodonsStore {
  return createResidueSelectionsStore();
}

export function useSelectedCodons(): ReadonlyArray<SelectedCodonKey> {
  const selections = useResidueSelections();
  return useMemo(() => residueSelectionsToCodingDnaRanges(selections), [selections]);
}

export function useSelectedCodonsStore(): SelectedCodonsStore | null {
  return useResidueSelectionsStore();
}

export function useCreateSelectedCodonsStore(): SelectedCodonsStore {
  return useCreateResidueSelectionsStore();
}

export function selectedCodonsToResidueSelections(
  referenceId: string,
  codons: ReadonlyArray<SelectedCodonKey>
): ReadonlyArray<ResidueSelection> {
  if (codons.length === 0) return [];
  return codons.map((codon, index) => ({
    selectionId: `selected-codon:${referenceId}:${codon.start}:${codon.end}:${codon.strand}`,
    source: {
      kind: 'selected-codon-compat',
      id: referenceId,
      surface: 'legacy-test-bridge',
    },
    target: {
      moleculeId: `translated-cds:${referenceId}:legacy-selected-codon:${index}`,
      moleculeKind: 'translated-cds',
      coordinateSystem: 'residue',
      intervals: [{ start: index, end: index }],
    },
    mappings: [
      {
        kind: 'coding-dna',
        referenceId,
        strand: codon.strand,
        intervals: [{ start: codon.start, end: codon.end }],
      },
    ],
  }));
}
