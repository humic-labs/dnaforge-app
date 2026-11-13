# Golden Gate Fidelity Dataset

`pryor2020-four-base-ligation-counts.json` is a generated compact copy of the
four-base Type IIS ligation count matrices from:

Pryor JM, Potapov V, Bilotti K, Pokhrel N, Lohman GJS. Enabling one-pot Golden
Gate assemblies of unprecedented complexity using data-optimized assembly
design. PLOS ONE. 2020;15(9):e0238592.
https://doi.org/10.1371/journal.pone.0238592

The source PLOS article and supporting information are distributed under CC BY
4.0. Keep the source-file SHA-256 and workbook cell digests in the JSON in sync
with `GoldenGateFidelityDataset.test.ts` whenever regenerating this file.

Included supporting tables:

- S1: BsaI-HFv2, 4-base overhang count matrix.
- S2: BsmBI-v2, 4-base overhang count matrix.
- S3: Esp3I, 4-base overhang count matrix.
- S4: BbsI-HF, 4-base overhang count matrix.

SapI S5 is intentionally excluded here because it is a 3-base overhang dataset,
while the current workbench Golden Gate optimizer is explicitly four-base.
