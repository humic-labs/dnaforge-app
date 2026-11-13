# Tabular Fixtures

Deterministic synthetic CSV/TSV files for manually testing the file-backed table
viewer/editor.

- `sample-metadata.csv` — simple CSV with headers and plain cells.
- `quoted-notes.csv` — CSV with quoted commas, escaped quotes, and multiline
  cells.
- `read-counts.tsv` — TSV with comma-containing cells that should not split.
- `plate-layout.tsv` — wider TSV shaped like a small plate map.
- `ncbi-gene/` — real public NCBI Gene TSV pressure fixtures ranging from 52 KB
  to 34 MB.

Edge-case fixtures live under `edge-cases/` so the top-level manual-test path
starts with valid files:

- `edge-cases/malformed-unclosed-quote.csv` — intentionally invalid CSV for the
  raw-text fallback path.

No file in this directory is lab-derived.
