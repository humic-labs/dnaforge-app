# yeast-chrIV (DNA-G1)

_Saccharomyces cerevisiae_ S288C chromosome IV. The smallest "real eukaryote
chromosome" fixture — exercises a bigger, denser GenBank record than
mg1655-complete (4.6 Mb prokaryote with ~10k features) at 1.5 Mb with eukaryotic
feature shapes (introns, joined CDS, chromosome-coordinate gene models).

## Provenance

| Field    | Value                                                |
| -------- | ---------------------------------------------------- |
| Source   | NCBI nuccore                                         |
| RefSeq   | `NC_001136.10`                                       |
| Assembly | `GCF_000146045.2`                                    |
| Length   | 1,531,933 bp (linear)                                |
| License  | Public domain (US-government-produced sequence data) |
| Fetched  | 2026-05-04 via NCBI eutils `efetch`                  |

## Re-fetch

```bash
curl -sf \
  "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nuccore&id=NC_001136.10&rettype=gbwithparts&retmode=text" \
  -o chrIV.gbff
```
