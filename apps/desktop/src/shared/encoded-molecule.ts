export type EncodedMoleculeKind = 'protein' | 'rna' | 'dna';
export interface EncodedMolecule {
  kind: EncodedMoleculeKind;
  sequence: string;
}

export const ENCODED_SEQUENCE_MAX_LENGTH = 1_000_000;
const alphabets: Record<EncodedMoleculeKind, RegExp> = {
  protein: /^[ACDEFGHIKLMNPQRSTVWYOU]+$/,
  rna: /^[ACGU]+$/,
  dna: /^[ACGT]+$/,
};

export function canonicalEncodedMolecule(input: EncodedMolecule): EncodedMolecule {
  if (
    !Object.prototype.hasOwnProperty.call(alphabets, input.kind) ||
    typeof input.sequence !== 'string'
  )
    throw new Error('An encoded molecule needs an explicit protein, RNA, or DNA type.');
  let sequence = input.sequence.replace(/\s/g, '').toUpperCase();
  if (input.kind === 'protein') sequence = sequence.replace(/\*$/, '');
  if (sequence.length > ENCODED_SEQUENCE_MAX_LENGTH || !alphabets[input.kind].test(sequence))
    throw new Error(`Reuse requires a complete, unambiguous ${input.kind} sequence.`);
  return { kind: input.kind, sequence };
}

export function encodedMoleculeIdentityPayload(input: EncodedMolecule): string {
  const molecule = canonicalEncodedMolecule(input);
  return JSON.stringify(['encoded-molecule-v1', molecule.kind, molecule.sequence]);
}

export interface SubmittedEncodedMolecule extends EncodedMolecule {
  chainIds: string[] | null;
}

export function submittedEncodedMolecules(
  settings: Record<string, unknown>
): SubmittedEncodedMolecule[] {
  if (Array.isArray(settings.entities) && settings.entities.length) {
    const used = new Set<string>();
    const molecules: SubmittedEncodedMolecule[] = [];
    for (const entity of settings.entities) {
      if (!entity || typeof entity !== 'object' || Array.isArray(entity))
        throw new Error('The run contains an invalid molecule entity.');
      const item = entity as Record<string, unknown>;
      const ids = item.chain_ids;
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.some((id) => typeof id !== 'string' || !id || id.length > 256 || used.has(id)) ||
        new Set(ids).size !== ids.length
      )
        throw new Error('Every submitted molecule copy needs a unique declared chain ID.');
      for (const id of ids) used.add(id as string);
      if (item.type === 'ligand_smiles' || item.type === 'ligand_ccd') continue;
      if (!['protein', 'rna', 'dna'].includes(String(item.type)) || typeof item.value !== 'string')
        throw new Error('The run contains an unsupported encoded molecule input.');
      molecules.push({
        ...canonicalEncodedMolecule({
          kind: item.type as EncodedMoleculeKind,
          sequence: item.value,
        }),
        chainIds: ids as string[],
      });
    }
    if (!molecules.length) throw new Error('This run has no encoded polymer input.');
    return molecules;
  }
  const direct = settings.sequence ?? settings.protein_sequence;
  if (typeof direct === 'string') {
    const chain = settings.chain_id;
    if (chain !== undefined && (typeof chain !== 'string' || !chain || chain.length > 256))
      throw new Error('The run has an invalid protein chain ID.');
    return [
      {
        ...canonicalEncodedMolecule({ kind: 'protein', sequence: direct }),
        chainIds: typeof chain === 'string' ? [chain] : null,
      },
    ];
  }
  if (Array.isArray(settings.polymers)) {
    const molecules = settings.polymers.map((polymer: unknown) => {
      if (!polymer || typeof polymer !== 'object' || Array.isArray(polymer))
        throw new Error('The run contains an invalid polymer input.');
      const item = polymer as Record<string, unknown>;
      if (
        !['protein', 'rna', 'dna'].includes(String(item.molecule_type)) ||
        typeof item.sequence !== 'string'
      )
        throw new Error('The run contains an unsupported polymer input.');
      return {
        ...canonicalEncodedMolecule({
          kind: item.molecule_type as EncodedMoleculeKind,
          sequence: item.sequence,
        }),
        chainIds: null,
      };
    });
    if (molecules.length) return molecules;
  }
  throw new Error('This run has no supported encoded sequence input to verify for reuse.');
}
