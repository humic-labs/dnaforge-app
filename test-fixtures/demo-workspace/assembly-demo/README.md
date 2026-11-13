# Plasmid workspace

Build an assembly by extracting regions from five complete circular plasmids.
The NCBI source accessions are listed below. `pUC19-DsRed` is a
synthetic software fixture assembled from those records. These are nonviral
cloning and expression vectors. The demo does not establish experimental
performance of a proposed construct.

## How to build an assembly

1. Call `create_design({ name, assemblyMethod: "gibson" })`.
2. Find each imported source by name and use its returned sequence identifier
   (`documentId`). Call `add_design_region({ designId, documentId, start, end })`
   for each part in order, using the 1-based inclusive ranges below.
3. Call `draft_design_assembly({ designId })` to compute overlaps and primers.
4. Call `open_tab({ type: "design", entityId: designId })`.

The drafted design is the deliverable. Creating a separate finalized plasmid is
a subsequent user action. The design opens beside chat automatically.
The File columns identify the original source records; imported sequences use
the identifiers returned by the app.

## Plasmids on the shelf

| Source file | Size | Source | Parts |
| --- | --- | --- | --- |
| `pEGFP-N1.gb` | 4733 bp | [U55762.1](https://www.ncbi.nlm.nih.gov/nuccore/U55762.1) | CMV promoter, EGFP, SV40 polyA |
| `pTRE.gb` | 3146 bp | [U89931.1](https://www.ncbi.nlm.nih.gov/nuccore/U89931.1) | Tet-responsive promoter with seven tetO sites |
| `pUC19-DsRed.gb` | 4265 bp | Synthetic recipe below | DsRed (FP583), CMV promoter, SV40 polyA |
| `pACYC177.gb` | 3941 bp | [X06402.1](https://www.ncbi.nlm.nih.gov/nuccore/X06402.1) | p15A origin and KanR backbone |
| `pUC19.gb` | 2686 bp | [L09137.2](https://www.ncbi.nlm.nih.gov/nuccore/L09137.2) | pUC origin and AmpR backbone |

## Extractable parts

All ranges are 1-based, inclusive and forward. Promoter ranges include the
downstream leader and cloning sites up to the next reporter position. The CMV
range includes the Kozak sequence. The TRE range is the original pTRE leader;
it is not TRE3G and does not include an added Kozak sequence.

| Part | Role | File | start | end |
| --- | --- | --- | --- | --- |
| CMV promoter | constitutive promoter | `plasmids/pEGFP-N1.gb` | 1 | 678 |
| TRE promoter | Tet-responsive promoter | `plasmids/pTRE.gb` | 1 | 438 |
| EGFP | green reporter | `plasmids/pEGFP-N1.gb` | 679 | 1398 |
| DsRed (FP583) | red reporter | `plasmids/pUC19-DsRed.gb` | 3365 | 4042 |
| SV40 polyA | terminator | `plasmids/pEGFP-N1.gb` | 1416 | 1638 |
| SV40 polyA (red vector) | terminator | `plasmids/pUC19-DsRed.gb` | 4043 | 4265 |
| p15A + KanR backbone | bacterial backbone | `plasmids/pACYC177.gb` | 766 | 3025 |
| CMV–EGFP cassette | promoter and reporter | `plasmids/pEGFP-N1.gb` | 1 | 1398 |

Choose a promoter, green or red reporter, terminator and backbone. Put the
backbone last to close the circle. Tet control requires the appropriate
transactivator in the host; pTRE alone does not supply that transactivator.

## Reproduction

Run `node test-fixtures/demo-workspace/assembly-demo/generate.mjs` from the
repository root. It reads the pinned NCBI records in `sources/`, adds demo
annotations to pEGFP-N1 and pTRE, and marks pACYC177 circular as its NCBI COMMENT
states. It normalizes record whitespace and removes the historical vendor support email from two input records. Original download hashes and normalized input hashes are retained. It does not change their nucleotide sequences.

The synthetic red vector concatenates these forward, inclusive source ranges
with no base changes or spacers:

1. L09137.2, bases 1–2686.
2. U55762.1, bases 1–678.
3. [AF168419.2](https://www.ncbi.nlm.nih.gov/nuccore/AF168419.2), bases 54–731,
   the complete FP583 coding sequence including its stop codon.
4. U55762.1, bases 1416–1638.

`sources/manifest.json` records download URLs and exact input hashes.
