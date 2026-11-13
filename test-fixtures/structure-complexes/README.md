# Structure Complex Fixtures

Permanent real-reference fixtures for structure workflows that need more than a
single monomer hit.

## MG1655 thrA keyboard focus

`rcsb/6MX1.cif` is the full PDBx/mmCIF entry downloaded from
`https://files.rcsb.org/download/6MX1.cif` on October 14th, 2026.
SHA-256: `0d8d6fd3217f5a037925dbc840d545842fe80c39b82dd069db76842cc87846ad`.
 uses its two chains and 311 modeled residues with the complete public
MG1655 genome and thrA at 337–2799 for keyboard-focus and native clipboard
acceptance. The resolver is a test fixture; this does not qualify scientific
model matching or residue mapping.

## MG1655 atpG ATP synthase

`mg1655-atpg-complexes.json` anchors the query to the full, provenanced _E.
coli_ K-12 MG1655 genome fixture:

- Source sequence: `test-fixtures/sequences/circular/ecoli-mg1655-complete.gb`
- Local structure bytes: `test-fixtures/structure-complexes/rcsb/1FS0.pdb`
  (`sha256 d665fd3b5cab41e4b773349bffe78cb882d39e9425f0ece283de5c50d5b4e1f9`)
- Equivalent PDBx/mmCIF bytes:
  `test-fixtures/structure-complexes/rcsb/1FS0.cif`
  (`sha256 575ecb1cd4740171231340fb6f986477f26790478bea2eb48c7b24808b14002e`)
- Equivalent BinaryCIF bytes, downloaded from the RCSB model server at
  `https://models.rcsb.org/1fs0.bcif` on 2026-07-15:
  `test-fixtures/structure-complexes/rcsb/1FS0.bcif`
  (`sha256 71204349778c261763bac7a761f01900f754efb9965b91592cc846561e982e00`)
- Local multimer bytes: `test-fixtures/structure-complexes/rcsb/3OAA.pdb`
  (`sha256 d5abcf7cb8960a177578dc8812af08fd4be4e9695514c964c95c0938a8e76fb1`)
- Query anchor: `atpG` / UniProt `P0ABA6` / ATP synthase gamma chain
- Primary UX surface: right-click the MG1655 `atpG` CDS, resolve structures,
  then browse complex candidates without losing the sequence anchor.

## Nucleic-acid coordinates

`rcsb/1BNA.pdb` (`sha256 df42f1506792f191b957227b061360652adcf6f813eb69d9ec553067ea584670`)
is the Drew-Dickerson B-DNA dodecamer — two 12-residue DNA strands,
`CGCGAATTCGCG`, plus ordered waters. It exists for : it is the smallest
committed structure whose residues are named `DA`/`DC`/`DG`/`DT`, which is what
makes the structure sequence list draw two-character monomer labels.

**Do not substitute another complex for it without checking the residue names.**
Of the other entries here, only `6ZU1.cif` contains DNA at all (and it is
21 MB); `7ZP8`, `7NBU` and `9Q87` are RNA, whose `A`/`C`/`G`/`U` are single
characters and never reproduced the defect. A DNA-label test pointed at one of
those passes without ever exercising the bug.

The catalog intentionally covers several complex shapes:

- `1FS0`: gamma/epsilon co-complex.
- `3OAA`: F1 sector complex.
- `5T4O`, `5T4P`, `5T4Q`, `6OQR`, `6PQV`, `6WNQ`, `6WNR`, `8DBP`, `8DBT`: full
  F1Fo ATP synthase states with all expected subunits present in the MG1655
  source sequence.
- `7JGA`: homologous mycobacterial F1Fo ATP synthase. This is an external-only
  contrast case: the structure is useful biological context, but its members
  must not be presented as subunits resident in the MG1655 workspace sequence.

Permanent live viewer coverage must exercise ATP synthase from multiple
biological protomer perspectives, not only the original `atpG` query:

- `1FS0` / `atpG`: small gamma/epsilon co-complex control.
- `3OAA` / `atpA`: repeated alpha protomer class in a heteromultimer.
- `3OAA` / `atpG`: unique gamma protomer class in the same heteromultimer
  family.

Those cases are expected to drive real Electron/WebGL tests through the actual
view picker: Surface Context, Hybrid, Illustrative, and back to Surface Context.
The MolStar diagnostics must prove the gray context surface, selected protomer
cartoons, chain table color matching, and absence of stale overlays after each
round trip.

Keep synthetic or monomer-only examples out of this catalog. If a future
structure workflow needs a new fixture, prefer adding another real PDB/EMDB case
here and tying every member back to either `workspaceMembers` or
`externalMembers`.

## MG1655 Structure Result Listings

`mg1655-structure-result-listings.json` is a broader resolver/listing fixture
set. It covers 10 real MG1655 CDS queries:

- Five co-complex listings: `atpG`, `rpoB`, `groL`, `rplL`, and `tufA`.
- Five non-co-complex listings: `arsC`, `hdfR`, `mioC`, `arcA`, and `lacZ`.

This catalog intentionally includes proteins with many PDB co-complex hits,
proteins with only monomeric or homomeric PDB hits, and proteins with no PDB
cross-references that still have AlphaFold predictions. Resolver tests should
use these cases to avoid treating "no PDB hit" as "no structure found" and to
avoid sending monomer/homomer hits through the complex-member browser.

## MG1655 RNA Structure Searches

`mg1655-rna-structure-searches.json` covers real MG1655 non-CDS annotations
that use RCSB polymer-entity sequence search instead of the protein resolver:

- RNA-only query: `ffs` signal recognition particle 4.5S RNA.
  - Local positive-hit bytes: `test-fixtures/structure-complexes/rcsb/5GAD.pdb`
    (`sha256 fe8470377019f3a4fd9c0bb9bb4773171d5a94e780e20898ddacabebe5886d27`).
- tRNA query: `gltU` tRNA-Glu.
- rRNA query: `rrfC` 5S ribosomal RNA.
- Homologous/partial provider match: `rrsC` 16S ribosomal RNA, whose top RCSB
  sequence hits are high-identity but not exact.
- No-hit RNA controls: `chiX` and `oxyS` small regulatory RNAs. These must show
  RNA-specific no-match UX and must not fall through to AlphaFold.
- Protein-RNA co-complex controls: `rplL` and `tufA`, cross-linked to the protein
  result-listing catalog so protein queries with RNA members cannot be confused
  with RNA sequence search.
- Live mixed-complex rendering control: MG1655 `ffh` protein can use the same
  `5GAD` local bytes to render Ffh in an RNP context without taking the RNA
  sequence-search resolver path.

Keep this catalog separate from protein AlphaFold fixtures. AlphaFold is a
protein-only fallback and must not mask a failing RNA/nucleic-acid search path.

## MG1655 Ribosome Pressure Benchmark

`mg1655-ribosome-pressure.json` promotes MG1655 `rrlC` and `rrsC` ribosome hits
into the hard-case visualization benchmark for the structure drawer. It is
intentionally larger and more expensive than the regular ATPG acceptance
fixtures:

- Query anchor: `rrlC rRNA (23S ribosomal RNA)`.
- Local structure bytes: `test-fixtures/structure-complexes/rcsb/7ZP8.cif`
  (`sha256 567072776b6f53c36c0b25b096a0012d6dcc6f8e6d9cb06091360ffba9b31a81`).
- Local switch-target bytes: `test-fixtures/structure-complexes/rcsb/7NBU.cif`
  (`sha256 eea059162391ff022b762376671c34aa672fcf54f41083ff0fab6c1dd9eac403`).
- Loaded hover pressure bytes: `test-fixtures/structure-complexes/rcsb/9Q87.cif`
  (`sha256 5f6eaf624dc1b6495c3e0deea5444ae3fc12803042787b1ffdb6436a0dff0206`).
- Loaded visual-integrity regression bytes: `test-fixtures/structure-complexes/rcsb/6ZU1.cif`
  (`sha256 6af651a19b93d063af0d8a99119064b75ceae53dbbd2b678bee4301a48978022`).
- Primary UX surface: right-click the MG1655 `rrlC` RNA annotation, resolve
  structures, then hover between large ribosome candidates without exposing a
  blank viewer; right-click `rrsC`, load `6ZU1` or `9Q87`, then confirm the
  loaded viewer contains visible polymer context, and sweep both the sequence
  rows and MolStar canvas without delayed hover feedback.

Use this catalog for performance and cache/handoff regressions. Do not use it
for fast unit tests; the mmCIF files are deliberately large enough to exercise
the expensive MolStar parse/draw path.
