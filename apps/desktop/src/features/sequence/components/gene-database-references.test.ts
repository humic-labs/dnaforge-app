import { describe, expect, it } from 'vitest';
import { getGeneDatabaseReferences } from './gene-database-references';

describe('getGeneDatabaseReferences', () => {
  it('links explicit NCBI, Ensembl and UniProt cross references to their records', () => {
    expect(
      getGeneDatabaseReferences({
        Dbxref: ['GeneID:7157,Ensembl:ENSG00000141510', 'UniProtKB/Swiss-Prot:P04637'],
      })
    ).toEqual([
      { database: 'ncbi', identifier: '7157', label: 'NCBI Gene', url: 'https://www.ncbi.nlm.nih.gov/gene/7157' },
      { database: 'ensembl', identifier: 'ENSG00000141510', label: 'Ensembl', url: 'https://www.ensembl.org/id/ENSG00000141510' },
      { database: 'uniprot', identifier: 'P04637', label: 'UniProt', url: 'https://www.uniprot.org/uniprotkb/P04637/entry' },
    ]);
  });

  it('normalizes versioned Ensembl genes and deduplicates across annotation formats', () => {
    const references = getGeneDatabaseReferences({
      gene_id: ['ENSMUSG00000059552.17'],
      ID: ['gene:ENSMUSG00000059552'],
      db_xref: ['Ensembl:ENSMUSG00000059552.17'],
    });
    expect(references).toHaveLength(1);
    expect(references[0].identifier).toBe('ENSMUSG00000059552');
  });

  it('does not infer database identity from gene symbols, transcript IDs or arbitrary URLs', () => {
    expect(getGeneDatabaseReferences({
      gene: ['TP53'], gene_id: ['7157'], ID: ['transcript:ENST00000269305'],
      Dbxref: ['GeneID:0', 'GeneID:1234567890123', 'GeneID:7157/../../', 'Ensembl:ENST00000269305', 'UniProt:javascript:alert(1)', 'Unknown:P04637'],
    })).toEqual([]);
  });

  it('supports six and ten character UniProt accessions but not unchecked isoforms', () => {
    expect(getGeneDatabaseReferences({ db_xref: ['UniProtKB:Q9Y261', 'UniProtKB/TrEMBL:A0A024RBG1', 'UniProtKB:P04637-2', 'UniProtKB:INVALID'] })
      .map((reference) => reference.identifier)).toEqual(['Q9Y261', 'A0A024RBG1']);
  });

  it('has no references for annotations without database identifiers', () => {
    expect(getGeneDatabaseReferences({})).toEqual([]);
  });
});
