# Genomic dataset fixtures

These four scientific datasets retain measured values, original source metadata,
source URLs and citations. `manifest.json` identifies dataset contracts, coordinate conventions, numeric
columns and SHA256 hashes. Original download
names in `sources` identify upstream inputs; they do not imply those raw files
are bundled here.

## CRISPRi guides

[Rousset et al. (2018)](https://doi.org/10.1371/journal.pgen.1007749)
provides the growth-screen measurements. `crispri-guides.csv` retains 820 guide
sequences and their growth log2 fold changes. Each guide has one exact 20-base
match across both strands of NC_000913.3. `start0` and `end0` are the resulting
zero-based, half-open intervals. `sourcePosition` preserves the original
reported position; the two coordinate systems are not interchangeable.

The reference is `../MG1655-NC_000913.3.fasta`. The placement metadata retains
original records and reference hashes. Sequence matching does not establish PAM
compatibility, new off-target evidence or a phenotype in a different strain.

## Regulatory binding intervals

The [RegulonDB source](https://github.com/regulondbunam/download-data-files)
and its [publication](https://doi.org/10.1099/mgen.0.000833) identify the 176
retained regulatory interactions. `regulondb-bindings.bed` uses BED4 with
zero-based, half-open NC_000913.3 bounds. Each uppercase binding-site sequence
matches that reference at the converted interval.

Names retain regulator, target, effect, confidence and source identity.
`regulondb-binding-metadata.json` retains source strand, evidence, original
one-based bounds and the complete source record for every BED row. Shared sites
remain separate interaction records. No binding-strength score is supplied.

## Synthesized promoter fragments

[Ireland et al. (2020)](https://doi.org/10.7554/eLife.55308) and the
[RegSeq data repository](https://github.com/RPGroup-PBoC/RegSeq) provide four
160-base synthesized fragments: araAB, arcA, groSL and aphA. Each FASTA retains
the supplied fragment sequence. Its CSV has 160 zero-based positions and the
original signed information values for LB and Anaero conditions, in bits.
These are fragment coordinates; no chromosome offset or gene interval is added.

## RNA reactivity and supplied structure

[Mustoe et al. (2018)](https://doi.org/10.1016/j.cell.2018.02.034) is the
original study. The exact redistributed source files are pinned from the
[ShaKer repository](https://github.com/BackofenLab/ShaKer/tree/6f29547d70a2b72ceccf28218c790c45406946e8/data/weeks194_orig).
`shape-rpsT_5.gb` retains the supplied 432-base RNA sequence, including uracil,
with RNA molecule typing and no added gene annotations. Its LOCUS date records
fixture preparation.

`shape-rpsT_5.csv` contains all 432 one-based transcript positions: 341 measured
reactivities, 91 blank measurements and three measured zeros. Blank values must
remain missing. `shape-rpsT_5-pairs.json` preserves the supplied dot-bracket model
and its 103 base pairs. Those pairs describe the supplied structure model;
they are not measured pairwise contacts. No chromosome mapping is asserted.

`shape-rpsT_5-pairs.csv` contains the same 103 supplied pairs as endpoint
spans. `start0` is the first one-based position minus one; `end0` is the second
one-based position. The actual zero-based endpoints are therefore `start0` and
`end0 - 1`. `paired = 1`, with unit `supplied model pair`, denotes presence in
the supplied model. It is neither confidence nor coverage of the intervening
bases. No pairs are inferred from the reactivity values.

## Provenance

The `source-data` files retain scientific values, processing, limitations and
upstream attribution. Presentation suggestions and plot-axis labels are omitted.
`sourceSnapshots` distinguishes each bundled file hash from its original
processed snapshot hash. The source files' original URLs, citations and hashes
remain in `sources`; this directory does not assert a new license for those
upstream data.
