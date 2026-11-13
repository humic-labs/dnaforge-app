# Deterministic chromosome IV CRAM

`reads.cram` contains 12 deterministic 100-base aligned reads on `chrIV`, at
zero-based starts 3700 through 3733. It is encoded against the checked-in
S. cerevisiae S288C reference at `test-fixtures/indexed/yeast-chrIV/chrIV.fa`.
`reads.cram.crai` is its required CRAM index.

The fixture is intentionally tiny so the normal Electron CI suite can prove
the complete CRAM journey without optional external data: native file choice,
reference choice, header/reference validation, indexed sidecar reads, WebGL
read-row rendering, persistence, and restoration after reload.

It was generated with the repository's `pysam` dependency. The header declares
one `chrIV` reference of length 1,531,933 and the records use fixed names,
positions, bases, qualities, and mapping quality, so regeneration is
deterministic.
