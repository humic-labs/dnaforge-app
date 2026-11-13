# S. cerevisiae S288C nuclear chromosomes (15 of 16)

GenBank sequence files for the S288C reference genome's nuclear chromosomes,
used by the LIMS starter registry (`seedLimsStarterRegistryInDb`) so every
chromosome entity is a real, openable DNA sequence (a chromosome must carry a
resolved sequence — see the `requireResolved` field flag in `shared/lims.ts`).

- **chr I, II, III, V–XVI** — committed here as `S288C_chromosome_<ROMAN>.gb`
  (15 files, ~14 MB). Source: `wp-assets/benchling-crawl/genbank/`.
- **chr IV** — reuses the existing RefSeq fixture
  `test-fixtures/genomes/yeast-chrIV/chrIV.gbff` (NC_001136.10), which the mock
  primer demo's open-at-binding flow also targets. Not duplicated here.

Together these back all 16 `starter-chr-scerevisiae-*` chromosome entities, each
composed into the `starter-genome-scerevisiae-s288c` assembly via `has_part`.
Assembly: GCF_000146045.2 (taxid 559292).

`NC_001137.3-annotated.gb` is the complete annotated chromosome V record retained from the mounted DNAForge Samples source for . Unlike the older label-only export, it preserves the RAD51 gene symbol and YER095W locus tag beyond the initial 256 KiB. Its RAD51 CDS is 349980–351182 in one-based inclusive coordinates (1,203 bases). Tests use this unchanged source snapshot for metadata discovery and exact coordinate transfer.
