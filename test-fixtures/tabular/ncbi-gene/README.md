# NCBI Gene TSV Pressure Fixtures

Real public NCBI Gene `gene_info` TSV files for pressure-testing the file-backed
table viewer at biological metadata sizes.

These files are intentionally large enough to exercise normal previews,
row-limited previews, and bounded prefix previews for oversized tables:

| File                                        |    Rows |      Bytes | Expected viewer path              |
| ------------------------------------------- | ------: | ---------: | --------------------------------- |
| `retroviridae.gene_info.tsv`                |     465 |     53,564 | editable grid                     |
| `pseudomonas_pao1.gene_info.tsv`            |   5,699 |    681,904 | preview grid                      |
| `ecoli_mg1655.gene_info.tsv`                |   4,653 |    954,116 | preview grid                      |
| `homo_sapiens.gene_info.tsv`                | 193,876 | 35,131,800 | bounded 5 MB table prefix preview |

Sources:

- `retroviridae.gene_info.tsv`:
  <https://ftp.ncbi.nlm.nih.gov/gene/DATA/GENE_INFO/Viruses/Retroviridae.gene_info.gz>
- `pseudomonas_pao1.gene_info.tsv`:
  <https://ftp.ncbi.nlm.nih.gov/gene/DATA/GENE_INFO/Archaea_Bacteria/Pseudomonas_aeruginosa_PAO1.gene_info.gz>
- `ecoli_mg1655.gene_info.tsv`:
  <https://ftp.ncbi.nlm.nih.gov/gene/DATA/GENE_INFO/Archaea_Bacteria/Escherichia_coli_str._K-12_substr._MG1655.gene_info.gz>
- `homo_sapiens.gene_info.tsv`:
  <https://ftp.ncbi.nlm.nih.gov/gene/DATA/GENE_INFO/Mammalia/Homo_sapiens.gene_info.gz>
