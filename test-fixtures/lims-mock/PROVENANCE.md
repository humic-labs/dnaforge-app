# LIMS demo primer dataset — provenance

These fixtures are **primers designed against PUBLIC reference genomes only**
(`apps/desktop/scripts/generate-mock-primer-dataset.mjs`). No proprietary data is
read, derived, or anonymized — the designer has no path to the old lab's export.

- Sources: pUC19 (L09137), E. coli K-12 MG1655, S. cerevisiae S288C chromosomes
  + chr IV (NC_001136.10) — all committed public fixtures.
- Rows: 1089. Deterministic — re-running reproduces these files byte-for-byte.
- Each annealing region is an exact genome sub-sequence (or reverse-complement), so
  the primers genuinely bind. Categories: PCR / qPCR / sequencing / Gibson-HiFi /
  QuikChange mutagenesis / Golden Gate / ultramer + universal M13/T7/T3/SP6/pUC primers.
- Hero oligos (`mock-demo-hero-manifest.json`) are public pUC19 + chr IV sub-sequences;
  the main-process seed computes their binding coords via `searchNucleotide`.
- Leak safety = PROVENANCE (no proprietary read) + `mock-primers-leak.test.ts`
  (forbidden-token gate + public-source name gate + k-mer overlap backstop).

Regenerate (dev only): `npm run gen:mock-primers`

# Practice registry plasmids — provenance

The practice registry (LIMS **Load test database → Practice registry**) reads no
fixture. `apps/desktop/src/main/lims-practice-plasmids.ts` builds 500 synthetic
plasmids at load time from a fixed seed, so every load produces the same set.

- Each plasmid is one of 14 NCBI plasmid records from the standard sample
  workspace (public domain; accessions and sources are listed in that workspace's
  `PROVENANCE.json`) with a random 300–3,000 bp insert spliced between two
  annotated features. Only the NCBI sequence is used, not its feature notes.
- The inserts are random bases, so the set contains no third-party content beyond
  those NCBI sequences. Markers come from each backbone's own annotations, which
  `lims-practice-plasmids.test.ts` checks.
- This replaces a 500-plasmid set exported from an Addgene database .
  Addgene's terms of use prohibit copying its content for commercial use without
  written consent.
