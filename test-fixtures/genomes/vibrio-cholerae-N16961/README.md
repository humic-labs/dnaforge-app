# Vibrio cholerae O1 biovar El Tor str. N16961 — reference genome fixtures

Public-domain reference genome from NCBI RefSeq, assembly **GCF_000006745.1**
(ASM674v1, TIGR, the foundational 2000 genome — Heidelberg et al., _Nature_ 406:477).
Used to seed the LIMS practice registry with a **real, two-chromosome** bacterial
genome assembly (strain → has_genome → genome → has_part → chromosome).

| File             | RefSeq        | Molecule                | Length (bp) | Topology |
| ---------------- | ------------- | ----------------------- | ----------- | -------- |
| `NC_002505.1.gb` | NC_002505.1   | Chromosome I (large)    | 2,961,149   | circular |
| `NC_002506.1.gb` | NC_002506.1   | Chromosome II (small)   | 1,072,315   | circular |

- **Strain tax-ID:** 243277 → rolls up to species **Vibrio cholerae** (tax-ID 666).
- **NO megaplasmid.** This reference is exactly two chromosomes, zero plasmids.
  Chromosome II is _ancestrally_ a domesticated megaplasmid (it retains a
  plasmid-type replication origin), but in every current NCBI record it is
  annotated and replicates as a bona fide chromosome — it is not a separate
  molecule. The practice seed records that lore as a note on chromosome II.

Fetched (full annotated GenBank) via NCBI E-utilities:

```
curl 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nuccore&rettype=gbwithparts&retmode=text&id=NC_002505.1'
curl 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nuccore&rettype=gbwithparts&retmode=text&id=NC_002506.1'
```
