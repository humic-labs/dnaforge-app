import { searchUniProt } from '../uniprot-search';
import { alphaFoldStructureRefForHit, validateAfdbExists } from '../afdb-validate';
import type { ResolverStep } from '../../types/structure-drawer';

const GENE_ORGANISM_IDENTITY = 0.95;

export const geneOrganismStep: ResolverStep = {
  name: 'gene_organism',
  hintsRequired: ['geneName', 'taxonId'],
  priority: 70,
  async resolve(translation, hints, signal) {
    if (translation.trim().length > 0) return null;
    const { geneName, taxonId } = hints;
    if (!geneName || taxonId === undefined) return null;
    const query = `gene:${geneName} AND organism_id:${taxonId}`;
    const uniprotHit = await searchUniProt(query, signal);
    if (!uniprotHit) return null;
    const afdb = await validateAfdbExists(uniprotHit.accession, signal);
    if (!afdb) return null;
    return {
      source: 'gene_organism',
      identity: GENE_ORGANISM_IDENTITY,
      structure: alphaFoldStructureRefForHit(afdb),
      confidenceNote:
        afdb.meanPlddt !== undefined
          ? `Mean pLDDT ${afdb.meanPlddt.toFixed(1)} · gene-name match (≥95% confidence)`
          : 'Gene-name match (≥95% confidence)',
    };
  },
};
