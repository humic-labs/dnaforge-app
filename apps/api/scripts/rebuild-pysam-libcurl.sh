#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PIP="${PIP:-.venv/bin/pip}"
echo "rebuilding pysam from source with libcurl/S3/GCS (htslib) ..."
HTSLIB_CONFIGURE_OPTIONS="--enable-libcurl --enable-gcs --enable-s3" \
  "$PIP" install --no-binary pysam --force-reinstall --no-cache-dir "pysam==0.24.0"

echo "verifying HTTP support ..."
.venv/bin/python - <<'PY'
import pysam
url = "https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/data_collections/1000_genomes_project/data/CEU/NA12878/alignment/NA12878.alt_bwamem_GRCh38DH.20150718.CEU.low_coverage.cram"
ref = "https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/technical/reference/GRCh38_reference_genome/GRCh38_full_analysis_set_plus_decoy_hla.fa"
b = pysam.AlignmentFile(url, "rc", reference_filename=ref)
n = sum(1 for _ in b.fetch("chr20", 1_000_000, 1_001_000))
b.close()
print(f"OK pysam {pysam.__version__} streamed {n} reads from a remote GRCh38 CRAM region")
PY
