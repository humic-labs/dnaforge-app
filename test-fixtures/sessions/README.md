# Browser session fixtures

Session files other genome browsers save, used to prove DNAForge reads them
through the ordinary Add data intake.

- `igv-yeast-chrIV.xml`: an IGV 2.x session for `sacCer3` whose resources are
  the deterministic chromosome IV CRAM (`../alignments/yeast-chriv-cram/reads.cram`,
  relative to this file, with its index) and the deterministic remote VCF that
  the sidecar replay serves at `https://variants.example.org/s288c/calls.vcf.gz`.
  Its locus is `chrIV:3,501-4,000`, the window the CRAM reads fall in. Panel
  and track display elements are present to mirror what IGV writes; only the
  resources and the session attributes are read.
- `ucsc-yeast-chrIV.txt`: UCSC custom-track lines naming the same two sources
  by `bigDataUrl`, plus an inline BED track that no address can attach.
