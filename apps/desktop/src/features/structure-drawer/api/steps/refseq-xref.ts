import { searchUniProt } from '../uniprot-search';
import { alphaFoldStructureRefForHit, validateAfdbExists } from '../afdb-validate';
import type { ResolverStep } from '../../types/structure-drawer';

const REFSEQ_XREF_PREFIX = 'RefSeq:';

export function extractRefSeqXref(dbXrefs: readonly string[] | undefined): string | null {
  if (!dbXrefs) return null;
  for (const xref of dbXrefs) {
    if (xref.startsWith(REFSEQ_XREF_PREFIX)) {
      const id = xref.slice(REFSEQ_XREF_PREFIX.length).trim();
      if (id.length > 0) return id;
    }
  }
  return null;
}

export const refSeqStep: ResolverStep = {
  name: 'refseq_xref',
  hintsRequired: ['dbXrefs'],
  priority: 40,
  async resolve(_translation, hints, signal) {
    const refseqId = extractRefSeqXref(hints.dbXrefs);
    if (!refseqId) return null;
    const uniprotHit = await searchUniProt(`xref:refseq-${refseqId}`, signal);
    if (!uniprotHit) return null;
    const afdb = await validateAfdbExists(uniprotHit.accession, signal);
    if (!afdb) return null;
    return {
      source: 'refseq_xref',
      identity: 1,
      structure: alphaFoldStructureRefForHit(afdb),
      confidenceNote:
        afdb.meanPlddt !== undefined ? `Mean pLDDT ${afdb.meanPlddt.toFixed(1)}` : undefined,
    };
  },
};
