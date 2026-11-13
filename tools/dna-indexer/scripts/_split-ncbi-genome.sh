#!/usr/bin/env bash

set -euo pipefail

if [ -z "${MAPPING_FILE:-}" ] || [ ! -f "$MAPPING_FILE" ]; then
  echo "MAPPING_FILE not set or not a file: ${MAPPING_FILE:-<unset>}" >&2
  exit 2
fi


split_gff3() {
  echo "  [gff3] single pass over $(du -h "$GFF3_FULL" | awk '{print $1}')..."
  gunzip -c "$GFF3_FULL" | awk \
    -v mapping="$MAPPING_FILE" \
    -v out_dir="$OUTPUT_DIR" \
    '
    BEGIN {
      while ((getline line < mapping) > 0) {
        n = split(line, parts, "|")
        if (n != 2) continue
        chr = parts[1]; acc = parts[2]
        cmd[acc] = "gzip -c > " out_dir "/" chr ".gff3.gz"
      }
      close(mapping)
    }
    /^#/ {
      for (acc in cmd) print | cmd[acc]
      next
    }
    $1 in cmd { print | cmd[$1] }
    '
  echo "  [gff3] done."
}

split_fasta() {
  echo "  [fasta] single pass over $(du -h "$FASTA_FULL" | awk '{print $1}')..."
  gunzip -c "$FASTA_FULL" | awk \
    -v mapping="$MAPPING_FILE" \
    -v out_dir="$OUTPUT_DIR" \
    '
    BEGIN {
      while ((getline line < mapping) > 0) {
        n = split(line, parts, "|")
        if (n != 2) continue
        chr = parts[1]; acc = parts[2]
        out_path[acc] = out_dir "/" chr ".fa"
        printf "" > out_path[acc]
      }
      close(mapping)
      active = ""
    }
    /^>/ {
      active = ""
      for (acc in out_path) {
        if (index($0, acc) > 0) { active = out_path[acc]; break }
      }
    }
    active != "" { print >> active }
    '
  echo "  [fasta] done."
}

split_gff3 &
gff3_pid=$!
split_fasta &
fasta_pid=$!

echo "  running GFF3 (pid=$gff3_pid) and FASTA (pid=$fasta_pid) splits in parallel..."
wait $gff3_pid
wait $fasta_pid

echo ""
echo "Per-chromosome outputs in $OUTPUT_DIR:"
for entry in $(cut -d'|' -f1 "$MAPPING_FILE"); do
  fa="$OUTPUT_DIR/$entry.fa"
  gff="$OUTPUT_DIR/$entry.gff3.gz"
  if [ -f "$fa" ] && [ -f "$gff" ]; then
    bp=$(grep -v "^>" "$fa" | tr -d '\n' | wc -c | tr -d ' ')
    rows=$(gunzip -c "$gff" | grep -vc "^#" || true)
    fa_size=$(du -h "$fa" | awk '{print $1}')
    gff_size=$(du -h "$gff" | awk '{print $1}')
    printf "  %-6s  fa=%-6s (%s bp)  gff3=%-6s (%s rows)\n" \
      "$entry" "$fa_size" "$bp" "$gff_size" "$rows"
  fi
done
