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

## Gene-property transfers

The `gene-properties` folders retain the original source identifiers and measured
values, alongside a row-by-row crosswalk to exact MG1655 GFF gene identifiers.
They transfer properties between named genes; they do not assert that source
strains have MG1655 coordinates or physiology. The native mapping excludes every
unresolved source row and retains its reason in the metadata.

Goodall insertion indices describe gene-level summaries, with 4,040 uniquely
mapped rows and 273 excluded rows. Of those exclusions, 53 have repeated source
names that cannot identify individual copies. Nichols mutant growth scores map
48 ECK identifiers through exact source annotation aliases, preserving 21
conditions and nine missing scores. Schmidt protein abundance retains 22
conditions for 48 proteins, using exact protein-to-parent-gene identities and one
explicitly documented gene-name fallback. The Touchon table is enriched for
pseudogenes; only 17 of its 81 source genes map uniquely, with states retained
for all 21 named strains. It is not a whole-genome conservation survey.

## Exact historical reference

The indexed RNA and chromosome-topology examples use NC_000913.2, with its
4,639,675 bases and annotation source retained separately under
`native-references/NC_000913.2`. No coordinates are borrowed from NC_000913.3.

Ribosome profiles retain 400 bins for two conditions. A nonempty bin's density
is its reported weighted-read contribution divided by genomic width. Empty bins
are missing, including 195 values represented as zeros in the original derived
snapshot. The original values remain in audit columns. The one-based origin is
derived from the publisher's WIG format declaration; the headerless files do not
provide direct sequence anchors.

The transcription-start example separates 300 strand-coverage bins from 134
published TSS assignments. All 134 supplied sequence anchors match the exact
reference and declared strand. Coverage means use only reported positions;
blank bins remain missing. TSS point heights are the published expression step
heights, with their own units.

Psoralen data retains 464 intervals for two conditions, containing all 928
source means. Every source probe matches the exact reference. The final interval
ends at the actual reference length; its original bin bound and probe count are
retained. These values describe crosslinked/non-crosslinked signal ratios.
