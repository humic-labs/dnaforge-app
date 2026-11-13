#!/usr/bin/env bash
set -euo pipefail

PYTHON_BIN="$1"
UV_BIN="$2"
shift 2
RUNTIME="$("$PYTHON_BIN" -c 'import platform; print(f"{platform.system()}:{platform.machine()}")')"

case "$RUNTIME" in
  Darwin:arm64|Darwin:aarch64)
    ARCHFLAGS='-arch arm64' "$UV_BIN" sync "$@"
    ;;
  Darwin:x86_64)
    OPENSSL_STATIC=1 ARCHFLAGS='-arch x86_64' "$UV_BIN" sync "$@"
    ;;
  Darwin:*)
    echo "Unsupported macOS Python architecture: $RUNTIME" >&2
    exit 1
    ;;
  *:*)
    "$UV_BIN" sync "$@"
    ;;
  *)
    echo 'Could not determine the selected Python runtime architecture.' >&2
    exit 1
    ;;
esac
