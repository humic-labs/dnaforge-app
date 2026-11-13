import { submittedEncodedMolecules } from './encoded-molecule';
export function canonicalPredictionProtein(sequence: string): string {
  const canonical = sequence.replace(/\s/g, '').toUpperCase().replace(/\*$/, '');
  if (!/^[ACDEFGHIKLMNPQRSTVWY]{1,24000}$/.test(canonical))
    throw new Error('Prediction reuse requires a complete, unambiguous protein sequence.');
  return canonical;
}

export function submittedProteins(settings: Record<string, unknown>): string[] {
  const proteins = submittedEncodedMolecules(settings)
    .filter((molecule) => molecule.kind === 'protein')
    .flatMap((molecule) =>
      Array.from({ length: molecule.chainIds?.length ?? 1 }, () =>
        canonicalPredictionProtein(molecule.sequence)
      )
    );
  if (!proteins.length)
    throw new Error('This run has no supported protein sequence input to verify for reuse.');
  return proteins;
}
