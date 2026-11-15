export interface GeneDatabaseReference {
  database: 'ncbi' | 'ensembl' | 'uniprot';
  identifier: string;
  label: string;
  url: string;
}

const UNIPROT_ACCESSION =
  /^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})$/;

/** Resolve only explicit database identifiers; gene symbols are not globally unique. */
export function getGeneDatabaseReferences(
  attributes: Record<string, string[]>
): GeneDatabaseReference[] {
  const references = new Map<string, GeneDatabaseReference>();
  const add = (database: GeneDatabaseReference['database'], rawIdentifier: string) => {
    const identifier =
      database === 'ensembl'
        ? rawIdentifier.trim().replace(/\.\d+$/, '')
        : rawIdentifier.trim();
    let label: string;
    let url: string;
    if (database === 'ncbi') {
      if (!/^[1-9]\d{0,11}$/.test(identifier)) return;
      label = 'NCBI Gene';
      url = `https://www.ncbi.nlm.nih.gov/gene/${identifier}`;
    } else if (database === 'ensembl') {
      if (!/^ENS[A-Z]*G\d{11}$/.test(identifier)) return;
      label = 'Ensembl';
      url = `https://www.ensembl.org/id/${identifier}`;
    } else {
      if (!UNIPROT_ACCESSION.test(identifier)) return;
      label = 'UniProt';
      url = `https://www.uniprot.org/uniprotkb/${identifier}/entry`;
    }
    references.set(`${database}:${identifier}`, { database, identifier, label, url });
  };

  for (const [key, values] of Object.entries(attributes)) {
    const normalizedKey = key.toLowerCase().replace(/_/g, '');
    if (normalizedKey === 'dbxref') {
      for (const value of values) {
        for (const entry of value.split(',')) {
          const match = /^([^:]+):(.+)$/.exec(entry.trim());
          if (!match) continue;
          const [, source, identifier] = match;
          switch (source.toLowerCase()) {
            case 'geneid':
            case 'ncbi_gene':
              add('ncbi', identifier);
              break;
            case 'ensembl':
              add('ensembl', identifier);
              break;
            case 'uniprot':
            case 'uniprotkb':
            case 'uniprotkb/swiss-prot':
            case 'uniprotkb/trembl':
            case 'swiss-prot':
              add('uniprot', identifier);
              break;
          }
        }
      }
    } else if (normalizedKey === 'geneid' || normalizedKey === 'id') {
      // GTF gene_id and Ensembl GFF3 ID=gene:ENSG... identify a gene exactly.
      // A numeric gene_id alone does not establish which database supplied it.
      for (const value of values) add('ensembl', value.replace(/^gene:/, ''));
    }
  }
  return [...references.values()];
}
