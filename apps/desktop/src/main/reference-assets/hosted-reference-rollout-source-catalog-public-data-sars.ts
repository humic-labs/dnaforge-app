export const HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_V1 = Object.freeze([
  {
    id: 'sarsCov2WuhanHu1',
    name: 'SARS-CoV-2 Wuhan-Hu-1',
    organism: 'Severe acute respiratory syndrome coronavirus 2',
    taxId: 2697049,
    assembly: 'ASM985889v3',
    description:
      'Exact ASM985889v3 Severe acute respiratory syndrome coronavirus 2 reference, NCBI RefSeq assembled molecules with searchable annotations.',
    sources: {
      fasta: {
        relativePath:
          'sarsCov2WuhanHu1/GCF_009858895.2/b0540238e8b48a5c/GCF_009858895.2_primary.fna',
        sha256: 'b0540238e8b48a5ce25dffafb94b1a9be507b161dea2a166d09a9565381f94eb',
        byteLength: 30374,
      },
      annotations: {
        relativePath:
          'sarsCov2WuhanHu1/GCF_009858895.2/c3632fb64c9ffd87/GCF_009858895.2_primary.gff3',
        sha256: 'c3632fb64c9ffd872d21ce1588ae9fd2b629687f7ae82d73c2e4827b689df292',
        byteLength: 14572,
      },
    },
    provenance: {
      provider: 'NCBI RefSeq',
      datasetId: 'GCF_009858895.2',
      datasetVersion: 'ASM985889v3',
      sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_009858895.2/',
      license: 'NCBI public-domain data',
      attribution: 'National Center for Biotechnology Information (NCBI)',
    },
    contigs: [
      {
        chrom: 'chrsegment',
        sourceSeqId: 'NC_045512.2',
        displayName: 'segment',
        lengthBp: 29903,
        role: 'assembled-molecule',
        circular: false,
        aliases: {
          refseq: 'NC_045512.2',
          genbank: 'MN908947.3',
          ucsc: 'chrsegment',
        },
      },
    ],
  },
] as const);
