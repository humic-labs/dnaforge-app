import { searchUniProt } from '../uniprot-search';
import { alphaFoldStructureRefForHit, validateAfdbExists } from '../afdb-validate';
import type { ResolverStep } from '../../types/structure-drawer';

export function classifyProteinId(proteinId: string): 'refseq' | 'embl' | null {
  const trimmed = proteinId.trim();
  if (/^[NWXY]P_\d+(\.\d+)?$/.test(trimmed)) return 'refseq';
  if (/^[A-Z]{3}\d+(\.\d+)?$/.test(trimmed)) return 'embl';
  return null;
}

export const proteinIdStep: ResolverStep = {
  name: 'protein_id',
  hintsRequired: ['proteinId'],
  priority: 30,
  async resolve(_translation, hints, signal) {
    const proteinId = hints.proteinId;
    if (!proteinId) return null;
    const namespace = classifyProteinId(proteinId);
    if (!namespace) return null;
    const query = `xref:${namespace}-${proteinId}`;
    const uniprotHit = await searchUniProt(query, signal);
    if (!uniprotHit) return null;
    const afdb = await validateAfdbExists(uniprotHit.accession, signal);
    if (!afdb) return null;
    return {
      source: 'protein_id',
      identity: 1,
      structure: alphaFoldStructureRefForHit(afdb),
      confidenceNote:
        afdb.meanPlddt !== undefined ? `Mean pLDDT ${afdb.meanPlddt.toFixed(1)}` : undefined,
    };
  },
};
