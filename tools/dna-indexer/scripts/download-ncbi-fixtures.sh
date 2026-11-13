#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

OUTPUT_DIR="test-fixtures/sources/ncbi-gff3"
mkdir -p "$OUTPUT_DIR"

NCBI_BASE="https://ftp.ncbi.nlm.nih.gov/genomes/all/GCF/000/001/405/GCF_000001405.40_GRCh38.p14"
GFF3_URL="$NCBI_BASE/GCF_000001405.40_GRCh38.p14_genomic.gff.gz"
FASTA_URL="$NCBI_BASE/GCF_000001405.40_GRCh38.p14_genomic.fna.gz"

CHROMS=(
  "chr1|NC_000001.11"
  "chr2|NC_000002.12"
  "chr3|NC_000003.12"
  "chr4|NC_000004.12"
  "chr5|NC_000005.10"
  "chr6|NC_000006.12"
  "chr7|NC_000007.14"
  "chr8|NC_000008.11"
  "chr9|NC_000009.12"
  "chr10|NC_000010.11"
  "chr11|NC_000011.10"
  "chr12|NC_000012.12"
  "chr13|NC_000013.11"
  "chr14|NC_000014.9"
  "chr15|NC_000015.10"
  "chr16|NC_000016.10"
  "chr17|NC_000017.11"
  "chr18|NC_000018.10"
  "chr19|NC_000019.10"
  "chr20|NC_000020.11"
  "chr21|NC_000021.9"
  "chr22|NC_000022.11"
  "chrX|NC_000023.11"
  "chrY|NC_000024.10"
)

FILTER=""
CHECK_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=true ;;
    --help|-h)
      grep "^# " "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) FILTER="$arg" ;;
  esac
done

CACHE_DIR="$OUTPUT_DIR/_ncbi-full"
mkdir -p "$CACHE_DIR"
GFF3_FULL="$CACHE_DIR/GCF_000001405.40_GRCh38.p14_genomic.gff.gz"
FASTA_FULL="$CACHE_DIR/GCF_000001405.40_GRCh38.p14_genomic.fna.gz"

if [ "$CHECK_ONLY" = "true" ]; then
  echo "Would download (if not cached):"
  echo "  GFF3:  $GFF3_URL"
  echo "  FASTA: $FASTA_URL"
  echo "Would filter to:"
  for entry in "${CHROMS[@]}"; do
    IFS='|' read -r name acc <<<"$entry"
    if [ -n "$FILTER" ] && [ "$FILTER" != "$name" ]; then
      continue
    fi
    echo "  $name (accession $acc) -> $OUTPUT_DIR/$name.gff3.gz + $name.fa"
  done
  exit 0
fi

download_if_missing() {
  local url="$1"
  local dest="$2"
  if [ -f "$dest" ] && [ "$(stat -f%z "$dest" 2>/dev/null || stat -c%s "$dest")" -gt 1000000 ]; then
    echo "  $dest already cached ($(du -h "$dest" | awk '{print $1}'))"
    return
  fi
  echo "  fetching $url"
  curl -fL --progress-bar -o "$dest.partial" "$url"
  mv "$dest.partial" "$dest"
  echo "  saved $dest ($(du -h "$dest" | awk '{print $1}'))"
}

echo "Step 1/2: ensure full-genome NCBI files are cached..."
download_if_missing "$GFF3_URL" "$GFF3_FULL"
download_if_missing "$FASTA_URL" "$FASTA_FULL"

echo ""
echo "Step 2/2: filter to per-chromosome fixtures..."

MAPPING_TMP=$(mktemp -t ncbi-split-mapping-XXXXXX)
trap 'rm -f "$MAPPING_TMP"' EXIT
for entry in "${CHROMS[@]}"; do
  IFS='|' read -r name acc <<<"$entry"
  if [ -n "$FILTER" ] && [ "$FILTER" != "$name" ]; then
    continue
  fi
  echo "$name|$acc" >> "$MAPPING_TMP"
done

if [ ! -s "$MAPPING_TMP" ]; then
  echo "  no chromosomes matched filter '$FILTER' — exiting"
  exit 0
fi

export CACHE_DIR GFF3_FULL FASTA_FULL OUTPUT_DIR
export MAPPING_FILE="$MAPPING_TMP"
"$(dirname "$0")/_split-ncbi-genome.sh"

echo ""
echo "Done. Next:"
echo "  Open GRCh38 in the app to prepare it."
