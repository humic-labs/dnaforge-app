#!/usr/bin/env bash
set -euo pipefail

: "${ARCH:?ARCH must be set (arm64|x64)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ASSET_LOCK="$REPO_ROOT/.ci/release-assets.lock.json"
if [ ! -f "$ASSET_LOCK" ]; then
  echo "::error::missing release asset lock: $ASSET_LOCK"
  exit 1
fi
PLATFORM=$([ "$ARCH" = "arm64" ] && echo aarch64-apple-darwin || echo x86_64-apple-darwin)

BINDIR="$(cd "$SCRIPT_DIR/.." && pwd)/resources/binaries"
mkdir -p "$BINDIR"

BIO_CACHE_DIR="${BIO_CACHE_DIR:-$HOME/.cache/waypoint-bio-tools/$ARCH}"

CURL="curl -fsSL --retry 3 --retry-all-errors --retry-delay 2 --connect-timeout 20 --max-time 600"

download_asset() {
  local tool="$1" destination="$2" asset_info url expected actual
  asset_info=$(node -e '
    const fs = require("fs");
    const lock = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (lock.contract !== "dnaforge-release-assets.v1") {
      throw new Error(`unsupported asset lock: ${lock.contract}`);
    }
    const asset = lock.tools[process.argv[2]].platforms[process.argv[3]];
    const base = lock.publicBaseUrl.replace(/\/$/, "");
    process.stdout.write(`${base}/${asset.key}\t${asset.sha256}`);
  ' "$ASSET_LOCK" "$tool" "$PLATFORM")
  IFS=$'\t' read -r url expected <<<"$asset_info"

  echo "  [bio-tools] mirror download: $tool/$PLATFORM"
  $CURL "$url" -o "$destination"
  actual=$(shasum -a 256 "$destination" | awk '{print $1}')
  if [ "$actual" != "$expected" ]; then
    rm -f "$destination"
    echo "::error::$tool archive checksum mismatch: expected $expected, got $actual"
    return 1
  fi
}

thin_if_fat() {
  local bin="$1" want archs
  want=$([ "$ARCH" = "arm64" ] && echo arm64 || echo x86_64)
  lipo -archs "$bin" >/dev/null 2>&1 || return 0
  archs=$(lipo -archs "$bin" 2>/dev/null)
  case " $archs " in *" $want "*) ;; *) return 0 ;; esac
  [ "$(echo "$archs" | wc -w)" -gt 1 ] || return 0
  lipo -thin "$want" "$bin" -output "$bin.__thin" && mv "$bin.__thin" "$bin"
  echo "  [bio-tools] thinned $(basename "$bin") → $want"
}

download_tools() {
  local OUT="$1"
  rm -rf "$OUT"
  mkdir -p "$OUT"

  download_asset blast /tmp/blast.tar.gz
  tar xzf /tmp/blast.tar.gz -C /tmp
  cp /tmp/ncbi-blast-2.16.0+/bin/blastn "$OUT/blastn"
  cp /tmp/ncbi-blast-2.16.0+/bin/makeblastdb "$OUT/makeblastdb"

  download_asset diamond /tmp/diamond.tar.gz
  tar xzf /tmp/diamond.tar.gz -C /tmp
  cp /tmp/diamond "$OUT/diamond"

  download_asset infernal /tmp/infernal.tar.gz
  rm -rf /tmp/infernal-dnaforge && mkdir -p /tmp/infernal-dnaforge
  tar xzf /tmp/infernal.tar.gz -C /tmp/infernal-dnaforge
  if [ "$ARCH" = "arm64" ]; then
    cp /tmp/infernal-dnaforge/infernal-1.1.5-macosx-silicon/binaries/cmscan "$OUT/cmscan"
  else
    cp /tmp/infernal-dnaforge/infernal-1.1.5-macosx-intel/binaries/cmscan "$OUT/cmscan"
  fi

  download_asset mafft /tmp/mafft.zip
  unzip -o /tmp/mafft.zip -d "$OUT/" > /dev/null
  printf '#!/bin/sh\nDIR="$(dirname "$0")/mafft-mac/mafftdir"\nMAFFT_BINARIES="$DIR/libexec"; export MAFFT_BINARIES\nexec "$DIR/bin/mafft" "$@"\n' > "$OUT/mafft"

  while IFS= read -r f; do thin_if_fat "$f"; done < <(find "$OUT" -type f)

  touch "$OUT/.bundle-complete"
}

if [ "${BIO_CACHE_HIT:-}" = "true" ] && [ -f "$BIO_CACHE_DIR/.bundle-complete" ]; then
  echo "[bio-tools] cache HIT for $ARCH ($BIO_CACHE_DIR) — skipping download"
else
  if [ "${BIO_CACHE_HIT:-}" = "true" ]; then
    echo "[bio-tools] cache restored but INCOMPLETE (no .bundle-complete) — re-downloading"
  else
    echo "[bio-tools] cache MISS for $ARCH — downloading tools into $BIO_CACHE_DIR"
  fi
  download_tools "$BIO_CACHE_DIR"
fi

if ls -d "$BIO_CACHE_DIR"/waypoint-api-* >/dev/null 2>&1; then
  echo "::error::bio-tools cache unexpectedly contains a waypoint-api-* sidecar — refusing to bundle (possible cache poisoning)"
  exit 1
fi
for tool in blastn makeblastdb diamond cmscan mafft; do
  cp "$BIO_CACHE_DIR/$tool" "$BINDIR/$tool"
done
rm -rf "$BINDIR/mafft-mac"
cp -R "$BIO_CACHE_DIR/mafft-mac" "$BINDIR/mafft-mac"
chmod -R +x "$BINDIR"
node "$SCRIPT_DIR/build-fastp.mjs" --arch "$ARCH" --cache-dir "$BIO_CACHE_DIR/fastp-runtime" --output "$SCRIPT_DIR/../resources/helpers/fastp-$PLATFORM"
node "$SCRIPT_DIR/build-ngs-tools.mjs" --arch "$ARCH" --cache-dir "$BIO_CACHE_DIR/ngs-runtime" --output-dir "$SCRIPT_DIR/../resources/helpers"

echo "Bundled bio tools (sha256):"
for BIN in blastn makeblastdb diamond cmscan mafft; do
  if [ -f "$BINDIR/$BIN" ]; then
    SIZE=$(du -h "$BINDIR/$BIN" | cut -f1)
    SHA=$(shasum -a 256 "$BINDIR/$BIN" | awk '{print $1}')
    echo "  $BIN: ${SIZE} sha256:${SHA:0:16}..."
  else
    echo "::error::expected bio tool missing after bundle: $BIN"
    rm -rf "$BIO_CACHE_DIR"
    exit 1
  fi
done
ls -lh "$BINDIR/"
