import { searchUniProt } from '../uniprot-search';
import { alphaFoldStructureRefForHit, validateAfdbExists } from '../afdb-validate';
import type { ResolverStep } from '../../types/structure-drawer';

const GENEID_XREF_PREFIX = 'GeneID:';

export function extractGeneIdXref(dbXrefs: readonly string[] | undefined): string | null {
  if (!dbXrefs) return null;
  for (const xref of dbXrefs) {
    if (xref.startsWith(GENEID_XREF_PREFIX)) {
      const id = xref.slice(GENEID_XREF_PREFIX.length).trim();
      if (id.length > 0) return id;
    }
  }
  return null;
}

export const geneIdStep: ResolverStep = {
  name: 'geneid_xref',
  hintsRequired: ['dbXrefs'],
  priority: 50,
  async resolve(_translation, hints, signal) {
    const geneId = extractGeneIdXref(hints.dbXrefs);
    if (!geneId) return null;
    const uniprotHit = await searchUniProt(`xref:geneid-${geneId}`, signal);
    if (!uniprotHit) return null;
    const afdb = await validateAfdbExists(uniprotHit.accession, signal);
    if (!afdb) return null;
    return {
      source: 'geneid_xref',
      identity: 1,
      structure: alphaFoldStructureRefForHit(afdb),
      confidenceNote:
        afdb.meanPlddt !== undefined ? `Mean pLDDT ${afdb.meanPlddt.toFixed(1)}` : undefined,
    };
  },
};
