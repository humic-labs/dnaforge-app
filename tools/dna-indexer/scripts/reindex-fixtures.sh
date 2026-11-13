#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

BIN="$REPO_ROOT/target/release/dna-indexer"

FIXTURES=(
  "pUC19|test-fixtures/sequences/circular/pUC19.gb|test-fixtures/indexed/pUC19|puc19"
  "yeast-chrIV|test-fixtures/genomes/yeast-chrIV/chrIV.gbff|test-fixtures/indexed/yeast-chrIV|chrIV"
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

echo "Building release binary..."
cargo build --release --manifest-path tools/dna-indexer/Cargo.toml >/dev/null
EXPECTED_SCHEMA=$("$BIN" --version | awk '{print $NF}')
echo "Indexer binary schema: $EXPECTED_SCHEMA"

if [ "$CHECK_ONLY" = "true" ]; then
  echo "--check: dry run. Would re-index:"
fi

failed=0
for entry in "${FIXTURES[@]}"; do
  IFS='|' read -r name source out_dir index_name <<<"$entry"
  if [ -n "$FILTER" ] && [ "$FILTER" != "$name" ]; then
    continue
  fi

  if [ ! -f "$source" ]; then
    echo "  $name  SKIP  (source missing: $source)"
    continue
  fi

  if [ "$CHECK_ONLY" = "true" ]; then
    echo "  $name  →  $out_dir/$index_name.{fa,fa.fai,gff3.gz,gff3.gz.tbi}"
    continue
  fi

  echo ""
  echo "→ $name  ($source → $out_dir)"
  mkdir -p "$out_dir"
  START=$SECONDS
  if ! "$BIN" index --in "$source" --out-dir "$out_dir" --name "$index_name" 2>&1 | sed 's/^/    /'; then
    echo "  $name  FAILED"
    failed=$((failed + 1))
    continue
  fi
  ELAPSED=$((SECONDS - START))

  ACTUAL_SCHEMA=$(gunzip -c "$out_dir/$index_name.gff3.gz" 2>/dev/null \
    | grep '^##dna-indexer-schema' \
    | head -1 \
    | awk '{print $NF}')
  if [ "$ACTUAL_SCHEMA" != "$EXPECTED_SCHEMA" ]; then
    echo "  $name  SCHEMA MISMATCH  (binary=$EXPECTED_SCHEMA, file=$ACTUAL_SCHEMA)"
    failed=$((failed + 1))
    continue
  fi
  SIZE=$(du -h "$out_dir/$index_name.gff3.gz" | awk '{print $1}')
  PARENTS=$(gunzip -c "$out_dir/$index_name.gff3.gz" | grep -c 'Parent=' || true)
  echo "  ✓ $name done in ${ELAPSED}s — gff3=$SIZE, Parent= edges=$PARENTS, schema=$ACTUAL_SCHEMA"
done

if [ "$failed" -gt 0 ]; then
  echo ""
  echo "$failed fixture(s) failed."
  exit 1
fi

echo ""
echo "Done. Review the diff with: git status test-fixtures/indexed/"
