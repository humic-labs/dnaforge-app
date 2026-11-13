#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DESKTOP_DIR/../.." && pwd)"
BUNDLE_DIR="$DESKTOP_DIR/resources/binaries"

os="$(uname -s)"
arch="$(uname -m)"
if [[ -n "${DNA_ASSEMBLY_TARGET:-}" ]]; then
  TRIPLE="$DNA_ASSEMBLY_TARGET"
elif [[ "$os" == "Darwin" ]]; then
  if [[ "$arch" == "arm64" ]] || sysctl -n machdep.cpu.brand_string 2>/dev/null | grep -qi "Apple"; then
    TRIPLE="aarch64-apple-darwin"
  else
    TRIPLE="x86_64-apple-darwin"
  fi
elif [[ "$os" == "Linux" ]]; then
  if [[ "$arch" == "aarch64" || "$arch" == "arm64" ]]; then
    TRIPLE="aarch64-unknown-linux-gnu"
  else
    TRIPLE="x86_64-unknown-linux-gnu"
  fi
elif [[ "$os" == MINGW* || "$os" == MSYS* || "$os" == CYGWIN* ]]; then
  TRIPLE="x86_64-pc-windows-msvc"
else
  echo "build-rust-helpers: unsupported host $os-$arch (set DNA_ASSEMBLY_TARGET)" >&2
  exit 1
fi
EXT=""
case "$TRIPLE" in *windows*) EXT=".exe" ;; esac

if ! command -v cargo >/dev/null 2>&1; then
  echo "build-rust-helpers: cargo not found — install Rust (https://rustup.rs)" >&2
  exit 1
fi

rustup target add "$TRIPLE" >/dev/null 2>&1 || true
echo "build-rust-helpers: cargo build -p dna-assembly --release --target $TRIPLE"
cargo build --manifest-path "$REPO_ROOT/Cargo.toml" -p dna-assembly --release --target "$TRIPLE"

SRC="$REPO_ROOT/target/$TRIPLE/release/dna-assembly$EXT"
if [[ ! -f "$SRC" ]]; then
  echo "build-rust-helpers: expected $SRC after build" >&2
  exit 1
fi

mkdir -p "$BUNDLE_DIR"
DEST="$BUNDLE_DIR/dna-assembly$EXT"
cp "$SRC" "$DEST"
chmod +x "$DEST"
echo "build-rust-helpers: staged $DEST ($(du -h "$DEST" | cut -f1))"
