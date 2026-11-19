# Mixed-molecule data journey

`1URN.cif` contains deposited coordinates for a U1A mutant protein bound to an
RNA hairpin, including glycerol. Source: https://www.rcsb.org/structure/1URN.
Downloaded from https://files.rcsb.org/download/1URN.cif on 2026-10-07.
SHA-256: `1a67298472bcfec6ff13f571251531f4c5ef133c68b5ccb725c1b5f41d683227`.

File-label chains A, D and H are used for RNA, protein and glycerol respectively.
Only real deposited data may be used in this workflow. The independent Python
verifier calculates occupancy-weighted atomic B-factor means and relative
log2 values from the unchanged coordinate file. These are derived atomic
displacement parameters, not mutation enrichment or direct measurements of
motion. Missing encoded residues remain missing: A14 and D97 in model 1.
No absent chain or replacement observation is invented. The coordinates are
not a new prediction.

The live agent receives only `1URN.cif`. It must write and execute its own
analysis and generate its own results during the turn. The fixture verifier
and a results table are never supplied to it. Earlier runs using invented
calibration signals are disqualified as scientific workflow evidence; their
historical reports are retained without relabeling them as real-data proof.

`1D3Z.cif` is the original deposited ubiquitin NMR ensemble, used to prove that
choosing a source model retains that exact model during agent coloring and save/reopen.
Source: https://www.rcsb.org/structure/1D3Z. Downloaded from
https://files.rcsb.org/download/1D3Z.cif on 2026-10-08.
SHA-256: `7242859f3508ff1711e5b38a78b14c960f137c096f36302406223c93b909c407`.

## Overview contour

The `overview-contour.mvs.json` example uses `1URN.cif`. It draws the
complete RNA entity as a Gaussian surface and keeps the protein entity as a
cartoon. Use the coordinate URI, structure identity, and canvas settings from
`mol_get_scene` when applying the example to an open view.
