import { alphaFoldStructureRefForHit, validateAfdbExists } from '../afdb-validate';
import { alphaFoldCandidateFromHit } from '../alphafold-candidate';
import type { ResolverStep } from '../../types/structure-drawer';

const UNIPROT_XREF_PREFIXES = [
  'UniProtKB/Swiss-Prot:',
  'UniProtKB/TrEMBL:',
  'UniProtKB:',
  'UniProt:',
] as const;

export function extractUniProtAccessions(dbXrefs: readonly string[] | undefined): string[] {
  if (!dbXrefs) return [];
  const out: string[] = [];
  for (const xref of dbXrefs) {
    for (const prefix of UNIPROT_XREF_PREFIXES) {
      if (xref.startsWith(prefix)) {
        const id = xref.slice(prefix.length).trim();
        if (id.length > 0) {
          out.push(id.toUpperCase());
          break;
        }
      }
    }
  }
  return out;
}

export const uniprotXrefStep: ResolverStep = {
  name: 'uniprot_xref',
  hintsRequired: ['dbXrefs'],
  priority: 20,
  async resolve(_translation, hints, signal) {
    const accessions = extractUniProtAccessions(hints.dbXrefs);
    if (accessions.length === 0) return null;
    for (const accession of accessions) {
      const hit = await validateAfdbExists(accession, signal);
      if (hit) {
        const candidate = alphaFoldCandidateFromHit(hit, 'uniprot_xref');
        return {
          source: 'uniprot_xref',
          identity: 1,
          structure: alphaFoldStructureRefForHit(hit),
          recommendedCandidateId: candidate.id,
          candidates: [candidate],
          confidenceNote:
            hit.meanPlddt !== undefined ? `Mean pLDDT ${hit.meanPlddt.toFixed(1)}` : undefined,
        };
      }
    }
    return null;
  },
};
