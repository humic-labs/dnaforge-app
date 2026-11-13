import { searchUniProt } from '../uniprot-search';
import { alphaFoldStructureRefForHit, validateAfdbExists } from '../afdb-validate';
import type { ResolverStep } from '../../types/structure-drawer';

export const locusTagStep: ResolverStep = {
  name: 'locus_tag',
  hintsRequired: ['locusTag', 'taxonId'],
  priority: 60,
  async resolve(_translation, hints, signal) {
    const { locusTag, taxonId } = hints;
    if (!locusTag || taxonId === undefined) return null;
    const query = `gene_oln:${locusTag} AND organism_id:${taxonId}`;
    const uniprotHit = await searchUniProt(query, signal);
    if (!uniprotHit) return null;
    const afdb = await validateAfdbExists(uniprotHit.accession, signal);
    if (!afdb) return null;
    return {
      source: 'locus_tag',
      identity: 1,
      structure: alphaFoldStructureRefForHit(afdb),
      confidenceNote:
        afdb.meanPlddt !== undefined ? `Mean pLDDT ${afdb.meanPlddt.toFixed(1)}` : undefined,
    };
  },
};
