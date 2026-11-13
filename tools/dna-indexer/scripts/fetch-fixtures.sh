#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_DIR="${SCRIPT_DIR}/../test-fixtures/genbank"
mkdir -p "${FIXTURE_DIR}"

EFETCH="https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"

FIXTURES=(
  "NG_059281.1|hbb_human.gb|Human HBB locus — 3 exons, classic textbook gene"
  "NG_008679.2|pax6_human.gb|Human PAX6 — multi-isoform, alternative splicing"
  "NC_012920.1|mt_genome_human.gb|Human mitochondrial genome — many complement-strand features"
  "J01749.1|pbr322.gb|pBR322 — small bacterial cloning vector, multi-record possible"
)


for entry in "${FIXTURES[@]}"; do
  IFS='|' read -r accession outname comment <<< "$entry"
  outpath="${FIXTURE_DIR}/${outname}"
  if [[ -s "$outpath" ]]; then
    echo "skip (already present): ${outname}"
    continue
  fi
  echo "fetching ${accession} → ${outname} (${comment})"
  curl -fsSL \
    --retry 3 --retry-delay 2 \
    "${EFETCH}?db=nuccore&id=${accession}&rettype=gb&retmode=text" \
    -o "${outpath}.tmp"
  if [[ ! -s "${outpath}.tmp" ]]; then
    echo "  warn: zero-byte response for ${accession}; removing tmp" >&2
    rm -f "${outpath}.tmp"
    continue
  fi
  mv "${outpath}.tmp" "$outpath"
  sleep 1
done

echo
echo "Done. ${FIXTURE_DIR} contents:"
ls -lh "${FIXTURE_DIR}"
echo
echo "Next: cargo test --release --manifest-path tools/dna-indexer/Cargo.toml \\"
echo "      --test refseq_e2e -- --ignored"
