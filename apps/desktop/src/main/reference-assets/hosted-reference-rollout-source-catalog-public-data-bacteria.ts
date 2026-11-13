export const HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_V1 = Object.freeze([
  {
    id: 'ecoliK12Mg1655',
    name: 'E. coli K-12 MG1655',
    organism: 'Escherichia coli str. K-12 substr. MG1655',
    taxId: 511145,
    assembly: 'ASM584v2',
    description:
      'E. coli K-12 MG1655 complete genome — primary chromosome with searchable NCBI RefSeq annotations.',
    sources: {
      fasta: {
        relativePath: 'ecoliK12Mg1655/GCF_000005845.2/53bb6a51b6e92139/GCF_000005845.2_primary.fna',
        sha256: '53bb6a51b6e92139ced1e38f74b7938781027c52200922ff03718c2237d23bb4',
        byteLength: 4699745,
      },
      annotations: {
        relativePath:
          'ecoliK12Mg1655/GCF_000005845.2/fd4ba59c3e6232c2/GCF_000005845.2_primary.gff3',
        sha256: 'fd4ba59c3e6232c2c8410c120fea9c1ffce14ebf502a632f8746e8ac0b423db5',
        byteLength: 2467433,
      },
    },
    provenance: {
      provider: 'NCBI RefSeq',
      datasetId: 'GCF_000005845.2',
      datasetVersion: 'ASM584v2',
      sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000005845.2/',
      license: 'NCBI public-domain data',
      attribution: 'National Center for Biotechnology Information (NCBI)',
    },
    contigs: [
      {
        chrom: 'NC_000913.3',
        sourceSeqId: 'NC_000913.3',
        displayName: 'chromosome',
        lengthBp: 4641652,
        role: 'assembled-molecule',
        circular: true,
        aliases: {
          refseq: 'NC_000913.3',
          genbank: 'U00096.3',
        },
      },
    ],
  },
  {
    id: 'ecoliBl21De3',
    name: 'E. coli BL21(DE3)',
    organism: 'Escherichia coli BL21(DE3)',
    assembly: 'ASM2266v1',
    description:
      'Review-only primary snapshot for ecoliBl21De3 (GCF_000022665.1). Not picker-activated.',
    sources: {
      fasta: {
        relativePath: 'ecoliBl21De3/GCF_000022665.1/9225e577e41a5456/GCF_000022665.1_primary.fna',
        sha256: '9225e577e41a54569496d542561181d963e4c16ad5a115da1b3600ab4558226f',
        byteLength: 4615999,
      },
      annotations: {
        relativePath: 'ecoliBl21De3/GCF_000022665.1/bad5e62d5349aeb3/GCF_000022665.1_primary.gff3',
        sha256: 'bad5e62d5349aeb3a0bffaab5a9b66c9a1cd50eee05564c130644beea2b7420b',
        byteLength: 2711632,
      },
    },
    provenance: {
      provider: 'NCBI RefSeq',
      datasetId: 'GCF_000022665.1',
      datasetVersion: 'ASM2266v1',
      sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000022665.1/',
      license: 'NCBI public-domain data',
      attribution: 'National Center for Biotechnology Information (NCBI)',
    },
    contigs: [
      {
        chrom: 'NC_012971.2',
        sourceSeqId: 'NC_012971.2',
        displayName: 'chromosome',
        lengthBp: 4558953,
        role: 'assembled-molecule',
        circular: true,
        aliases: {
          refseq: 'NC_012971.2',
          genbank: 'CP001509.3',
        },
      },
    ],
  },
  {
    id: 'bacillus168',
    name: 'B. subtilis 168',
    organism: 'Bacillus subtilis subsp. subtilis str. 168',
    assembly: 'ASM904v1',
    description:
      'Review-only primary snapshot for bacillus168 (GCF_000009045.1). Not picker-activated.',
    sources: {
      fasta: {
        relativePath: 'bacillus168/GCF_000009045.1/59c09816fb55fb1a/GCF_000009045.1_primary.fna',
        sha256: '59c09816fb55fb1a0b42d0715f627bb42018a19c6bf933c9cb37f6058ee4737e',
        byteLength: 4268374,
      },
      annotations: {
        relativePath: 'bacillus168/GCF_000009045.1/583ade1198a862d3/GCF_000009045.1_primary.gff3',
        sha256: '583ade1198a862d3fd57c8e6a412deb86a6d50dbd25757e421990f5d9f495dea',
        byteLength: 3808860,
      },
    },
    provenance: {
      provider: 'NCBI RefSeq',
      datasetId: 'GCF_000009045.1',
      datasetVersion: 'ASM904v1',
      sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000009045.1/',
      license: 'NCBI public-domain data',
      attribution: 'National Center for Biotechnology Information (NCBI)',
    },
    contigs: [
      {
        chrom: 'NC_000964.3',
        sourceSeqId: 'NC_000964.3',
        displayName: 'chromosome',
        lengthBp: 4215606,
        role: 'assembled-molecule',
        circular: true,
        aliases: {
          refseq: 'NC_000964.3',
        },
      },
    ],
  },
  {
    id: 'pputidaKt2440',
    name: 'P. putida KT2440',
    organism: 'Pseudomonas putida KT2440',
    assembly: 'ASM756v2',
    description:
      'Review-only primary snapshot for pputidaKt2440 (GCF_000007565.2). Not picker-activated.',
    sources: {
      fasta: {
        relativePath: 'pputidaKt2440/GCF_000007565.2/f3b9661ab008a185/GCF_000007565.2_primary.fna',
        sha256: 'f3b9661ab008a18564e6f4e303e8c631ea77a98bb396925d49907d65f5f93e05',
        byteLength: 6259205,
      },
      annotations: {
        relativePath: 'pputidaKt2440/GCF_000007565.2/f665c81809ada088/GCF_000007565.2_primary.gff3',
        sha256: 'f665c81809ada0888ed60315d30175a0a848a13d99222879f5a84b5e56efce0e',
        byteLength: 3424703,
      },
    },
    provenance: {
      provider: 'NCBI RefSeq',
      datasetId: 'GCF_000007565.2',
      datasetVersion: 'ASM756v2',
      sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000007565.2/',
      license: 'NCBI public-domain data',
      attribution: 'National Center for Biotechnology Information (NCBI)',
    },
    contigs: [
      {
        chrom: 'NC_002947.4',
        sourceSeqId: 'NC_002947.4',
        displayName: 'chromosome',
        lengthBp: 6181873,
        role: 'assembled-molecule',
        circular: true,
        aliases: {
          refseq: 'NC_002947.4',
          genbank: 'AE015451.2',
        },
      },
    ],
  },
  {
    id: 'cglutamicumAtcc13032',
    name: 'C. glutamicum ATCC 13032',
    organism: 'Corynebacterium glutamicum ATCC 13032',
    assembly: 'ASM1132v1',
    description:
      'Review-only primary snapshot for cglutamicumAtcc13032 (GCF_000011325.1). Not picker-activated.',
    sources: {
      fasta: {
        relativePath:
          'cglutamicumAtcc13032/GCF_000011325.1/77a96e75167d6e75/GCF_000011325.1_primary.fna',
        sha256: '77a96e75167d6e750d09f40616bb14a682e30b625e0f8f51fafe7c634deff636',
        byteLength: 3350839,
      },
      annotations: {
        relativePath:
          'cglutamicumAtcc13032/GCF_000011325.1/a794b57f8240d07d/GCF_000011325.1_primary.gff3',
        sha256: 'a794b57f8240d07d774efc9159e41c50c964ac4c0bc350ad13ce3f9c1536c485',
        byteLength: 1903826,
      },
    },
    provenance: {
      provider: 'NCBI RefSeq',
      datasetId: 'GCF_000011325.1',
      datasetVersion: 'ASM1132v1',
      sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000011325.1/',
      license: 'NCBI public-domain data',
      attribution: 'National Center for Biotechnology Information (NCBI)',
    },
    contigs: [
      {
        chrom: 'NC_003450.3',
        sourceSeqId: 'NC_003450.3',
        displayName: 'chromosome',
        lengthBp: 3309401,
        role: 'assembled-molecule',
        circular: true,
        aliases: {
          refseq: 'NC_003450.3',
          genbank: 'BA000036.3',
        },
      },
    ],
  },
  {
    id: 'scoelicolorA32',
    name: 'S. coelicolor A3(2)',
    organism: 'Streptomyces coelicolor A3(2)',
    assembly: 'ASM20383v1',
    description:
      'Review-only primary snapshot for scoelicolorA32 (GCF_000203835.1). Not picker-activated.',
    sources: {
      fasta: {
        relativePath: 'scoelicolorA32/GCF_000203835.1/0fd098e241ad998c/GCF_000203835.1_primary.fna',
        sha256: '0fd098e241ad998c8aa090ab9f1592d6cee7d142be8a17032093bf57be123112',
        byteLength: 9168246,
      },
      annotations: {
        relativePath:
          'scoelicolorA32/GCF_000203835.1/0f6ac54bea13874a/GCF_000203835.1_primary.gff3',
        sha256: '0f6ac54bea13874adbe6cc44af8bf7648ff0c1d7ccd28f2cc97d99a94a9a3831',
        byteLength: 4902400,
      },
    },
    provenance: {
      provider: 'NCBI RefSeq',
      datasetId: 'GCF_000203835.1',
      datasetVersion: 'ASM20383v1',
      sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000203835.1/',
      license: 'NCBI public-domain data',
      attribution: 'National Center for Biotechnology Information (NCBI)',
    },
    contigs: [
      {
        chrom: 'NC_003888.3',
        sourceSeqId: 'NC_003888.3',
        displayName: 'chromosome',
        lengthBp: 8667507,
        role: 'assembled-molecule',
        circular: false,
        aliases: {
          refseq: 'NC_003888.3',
          genbank: 'AL645882.2',
        },
      },
      {
        chrom: 'chrSCP1',
        sourceSeqId: 'NC_003903.1',
        displayName: 'SCP1',
        lengthBp: 356023,
        role: 'assembled-molecule',
        circular: false,
        aliases: {
          refseq: 'NC_003903.1',
          genbank: 'AL589148.1',
          ucsc: 'chrSCP1',
        },
      },
      {
        chrom: 'chrSCP2',
        sourceSeqId: 'NC_003904.1',
        displayName: 'SCP2',
        lengthBp: 31317,
        role: 'assembled-molecule',
        circular: true,
        aliases: {
          refseq: 'NC_003904.1',
          genbank: 'AL645771.1',
          ucsc: 'chrSCP2',
        },
      },
    ],
  },
  {
    id: 'mtbH37Rv',
    name: 'M. tuberculosis H37Rv',
    organism: 'Mycobacterium tuberculosis H37Rv',
    assembly: 'ASM19595v2',
    description:
      'Review-only primary snapshot for mtbH37Rv (GCF_000195955.2). Not picker-activated.',
    sources: {
      fasta: {
        relativePath: 'mtbH37Rv/GCF_000195955.2/427dc8cea7ffbbac/GCF_000195955.2_primary.fna',
        sha256: '427dc8cea7ffbbac1b0baa31362bb7a30cac0a3ca9052d73634adf9122a63b28',
        byteLength: 4466740,
      },
      annotations: {
        relativePath: 'mtbH37Rv/GCF_000195955.2/56fd1dae1af5098e/GCF_000195955.2_primary.gff3',
        sha256: '56fd1dae1af5098e757f5e1134f7a272327d3d97161f9516e07da480ff8608f3',
        byteLength: 2171352,
      },
    },
    provenance: {
      provider: 'NCBI RefSeq',
      datasetId: 'GCF_000195955.2',
      datasetVersion: 'ASM19595v2',
      sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000195955.2/',
      license: 'NCBI public-domain data',
      attribution: 'National Center for Biotechnology Information (NCBI)',
    },
    contigs: [
      {
        chrom: 'NC_000962.3',
        sourceSeqId: 'NC_000962.3',
        displayName: 'chromosome',
        lengthBp: 4411532,
        role: 'assembled-molecule',
        circular: false,
        aliases: {
          refseq: 'NC_000962.3',
          genbank: 'AL123456.3',
        },
      },
    ],
  },
  {
    id: 'paeruginosaPao1',
    name: 'P. aeruginosa PAO1',
    organism: 'Pseudomonas aeruginosa PAO1',
    assembly: 'ASM676v1',
    description:
      'Review-only primary snapshot for paeruginosaPao1 (GCF_000006765.1). Not picker-activated.',
    sources: {
      fasta: {
        relativePath:
          'paeruginosaPao1/GCF_000006765.1/3e9335fb76772d32/GCF_000006765.1_primary.fna',
        sha256: '3e9335fb76772d324537b0c4c8cc7935e8b467b2acb0fae0c6e6dbeb2f227117',
        byteLength: 6342768,
      },
      annotations: {
        relativePath:
          'paeruginosaPao1/GCF_000006765.1/e9708fe0b89e8fa8/GCF_000006765.1_primary.gff3',
        sha256: 'e9708fe0b89e8fa898a86ea8ed38ed0d697e460878578917545b733fb271b170',
        byteLength: 3243171,
      },
    },
    provenance: {
      provider: 'NCBI RefSeq',
      datasetId: 'GCF_000006765.1',
      datasetVersion: 'ASM676v1',
      sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000006765.1/',
      license: 'NCBI public-domain data',
      attribution: 'National Center for Biotechnology Information (NCBI)',
    },
    contigs: [
      {
        chrom: 'NC_002516.2',
        sourceSeqId: 'NC_002516.2',
        displayName: 'chromosome',
        lengthBp: 6264404,
        role: 'assembled-molecule',
        circular: true,
        aliases: {
          refseq: 'NC_002516.2',
          genbank: 'AE004091.2',
        },
      },
    ],
  },
  {
    id: 'saureusNctc8325',
    name: 'S. aureus NCTC 8325',
    organism: 'Staphylococcus aureus subsp. aureus NCTC 8325',
    assembly: 'ASM1342v1',
    description:
      'Review-only primary snapshot for saureusNctc8325 (GCF_000013425.1). Not picker-activated.',
    sources: {
      fasta: {
        relativePath:
          'saureusNctc8325/GCF_000013425.1/05df047f78234de4/GCF_000013425.1_primary.fna',
        sha256: '05df047f78234de456a72df5f938b7fdef98fc3af3bf8634a11d70fbd3dcd21d',
        byteLength: 2856716,
      },
      annotations: {
        relativePath:
          'saureusNctc8325/GCF_000013425.1/87aa7bfbf590a400/GCF_000013425.1_primary.gff3',
        sha256: '87aa7bfbf590a400c5e0cccd034051ecf46531e0efb772d1c8101505b6f61705',
        byteLength: 1406958,
      },
    },
    provenance: {
      provider: 'NCBI RefSeq',
      datasetId: 'GCF_000013425.1',
      datasetVersion: 'ASM1342v1',
      sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000013425.1/',
      license: 'NCBI public-domain data',
      attribution: 'National Center for Biotechnology Information (NCBI)',
    },
    contigs: [
      {
        chrom: 'NC_007795.1',
        sourceSeqId: 'NC_007795.1',
        displayName: 'chromosome',
        lengthBp: 2821361,
        role: 'assembled-molecule',
        circular: true,
        aliases: {
          refseq: 'NC_007795.1',
          genbank: 'CP000253.1',
        },
      },
    ],
  },
  {
    id: 'salmonellaLt2',
    name: 'S. Typhimurium LT2',
    organism: 'Salmonella enterica serovar Typhimurium LT2',
    assembly: 'ASM694v2',
    description:
      'Review-only primary snapshot for salmonellaLt2 (GCF_000006945.2). Not picker-activated.',
    sources: {
      fasta: {
        relativePath: 'salmonellaLt2/GCF_000006945.2/196a3eff4e6e6ed5/GCF_000006945.2_primary.fna',
        sha256: '196a3eff4e6e6ed597173cc15d9dbde4cd55d76ad4d1b046da34cd75629c65cd',
        byteLength: 5013482,
      },
      annotations: {
        relativePath: 'salmonellaLt2/GCF_000006945.2/54e7d835ac9f83ec/GCF_000006945.2_primary.gff3',
        sha256: '54e7d835ac9f83ecf7d3f8023b13aef0cfefc20721c0c5dee1eaabc991dae11e',
        byteLength: 3694565,
      },
    },
    provenance: {
      provider: 'NCBI RefSeq',
      datasetId: 'GCF_000006945.2',
      datasetVersion: 'ASM694v2',
      sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000006945.2/',
      license: 'NCBI public-domain data',
      attribution: 'National Center for Biotechnology Information (NCBI)',
    },
    contigs: [
      {
        chrom: 'NC_003197.2',
        sourceSeqId: 'NC_003197.2',
        displayName: 'chromosome',
        lengthBp: 4857450,
        role: 'assembled-molecule',
        circular: true,
        aliases: {
          refseq: 'NC_003197.2',
          genbank: 'AE006468.2',
        },
      },
      {
        chrom: 'chrpSLT',
        sourceSeqId: 'NC_003277.2',
        displayName: 'pSLT',
        lengthBp: 93933,
        role: 'assembled-molecule',
        circular: true,
        aliases: {
          refseq: 'NC_003277.2',
          genbank: 'AE006471.2',
          ucsc: 'chrpSLT',
        },
      },
    ],
  },
  {
    id: 'saureusUsa300Fpr3757',
    name: 'S. aureus USA300 FPR3757',
    organism: 'Staphylococcus aureus subsp. aureus USA300_FPR3757',
    taxId: 451515,
    assembly: 'ASM1346v1',
    description:
      'Exact ASM1346v1 Staphylococcus aureus subsp. aureus USA300_FPR3757 reference, NCBI RefSeq assembled molecules with searchable annotations.',
    sources: {
      fasta: {
        relativePath:
          'saureusUsa300Fpr3757/GCA_000013465.1/a3dc8a88d0502a32/GCA_000013465.1_primary.fna',
        sha256: 'a3dc8a88d0502a32293e680827eb6a74b790d4c419491c1613782a06fc93a63b',
        byteLength: 2908759,
      },
      annotations: {
        relativePath:
          'saureusUsa300Fpr3757/GCA_000013465.1/82aaf72461577447/GCA_000013465.1_primary.gff3',
        sha256: '82aaf72461577447a5eaf6ddd1d5236bff59135d7933351b7d0c8b060332ec2a',
        byteLength: 1234469,
      },
    },
    provenance: {
      provider: 'NCBI RefSeq',
      datasetId: 'GCA_000013465.1',
      datasetVersion: 'ASM1346v1',
      sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCA_000013465.1/',
      license: 'NCBI public-domain data',
      attribution: 'National Center for Biotechnology Information (NCBI)',
    },
    contigs: [
      {
        chrom: 'chromosome',
        sourceSeqId: 'CP000255.1',
        displayName: 'chromosome',
        lengthBp: 2872769,
        role: 'assembled-molecule',
        circular: true,
        aliases: {
          refseq: 'NC_007793.1',
          genbank: 'CP000255.1',
          ucsc: 'chromosome',
        },
      },
    ],
  },
] as const);
