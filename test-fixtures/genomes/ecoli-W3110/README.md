# Escherichia coli str. K-12 substr. W3110 — reference genome fixture

Public-domain reference genome from NCBI RefSeq. W3110 is, alongside MG1655, one
of the two canonical wild-type _E. coli_ K-12 laboratory reference strains. Used
to seed the LIMS practice registry as the **second** E. coli genome assembly
(the first, MG1655, reuses `test-fixtures/sequences/circular/ecoli-mg1655-complete.gb`).

| File             | RefSeq      | Molecule                   | Length (bp) | Topology |
| ---------------- | ----------- | -------------------------- | ----------- | -------- |
| `NC_007779.1.gb` | NC_007779.1 | Chromosome (complete)      | 4,646,332   | circular |

- **Strain tax-ID:** 316407 → rolls up to species **Escherichia coli** (tax-ID 562).
- MG1655 (strain tax-ID 511145) and W3110 (316407) are distinct K-12 strain nodes
  that roll up to the **same** species (562) — the strain-vs-species relationship
  the organism filter showcases. Single circular chromosome, no plasmid.

Fetched (full annotated GenBank) via NCBI E-utilities:

```
curl 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nuccore&rettype=gbwithparts&retmode=text&id=NC_007779.1'
```
