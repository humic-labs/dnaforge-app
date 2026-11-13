#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUNDLE_DIR="$DESKTOP_DIR/resources/binaries"

get_runtime_tools_dir() {
  local platform="$1"
  if [[ -n "${WAYPOINT_DATA_DIR:-}" ]]; then
    echo "${WAYPOINT_DATA_DIR}/tools/${platform}"
  elif [[ "$(uname -s)" == "Darwin" ]]; then
    echo "$HOME/Library/Application Support/Waypoint/tools/${platform}"
  else
    echo "${XDG_DATA_HOME:-$HOME/.local/share}/waypoint/tools/${platform}"
  fi
}

resolve_platform() {
  local os arch suffix
  os="$(uname -s)"
  arch="$(uname -m)"
  if [[ "$os" == "Darwin" ]]; then
    local cpu_brand
    cpu_brand="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "")"
    if [[ "$cpu_brand" == *"Apple"* ]]; then
      arch="arm64"
    fi
  fi
  case "$os" in
    Darwin)
      case "$arch" in
        arm64) suffix="aarch64-apple-darwin" ;;
        x86_64) suffix="x86_64-apple-darwin" ;;
        *) echo "Unsupported macOS architecture: $arch" >&2; exit 1 ;;
      esac
      ;;
    Linux)
      case "$arch" in
        x86_64) suffix="x86_64-unknown-linux-gnu" ;;
        aarch64) suffix="aarch64-unknown-linux-gnu" ;;
        *) echo "Unsupported Linux architecture: $arch" >&2; exit 1 ;;
      esac
      ;;
    *)
      echo "Unsupported OS: $os" >&2
      exit 1
      ;;
  esac
  echo "$suffix"
}

PLATFORM="$(resolve_platform)"
RUNTIME_DIR="$(get_runtime_tools_dir "$PLATFORM")"

echo "Bundle path:  $BUNDLE_DIR"
echo "Runtime path: $RUNTIME_DIR"
echo

EXPECTED=(blastn makeblastdb diamond cmscan)
SIDECAR_GLOB="waypoint-api-*"

if [[ ! -d "$RUNTIME_DIR" ]]; then
  echo "ERROR: runtime tools directory does not exist:" >&2
  echo "  $RUNTIME_DIR" >&2
  echo >&2
  echo "Run download-binaries.sh first:" >&2
  echo "  ./apps/desktop/scripts/download-binaries.sh" >&2
  exit 1
fi

missing=()
for bin in "${EXPECTED[@]}"; do
  if [[ ! -f "$RUNTIME_DIR/$bin" ]]; then
    missing+=("$bin")
  fi
done
if (( ${#missing[@]} > 0 )); then
  echo "ERROR: runtime tools dir is missing: ${missing[*]}" >&2
  echo >&2
  echo "Re-run download-binaries.sh — it may have failed mid-download:" >&2
  echo "  ./apps/desktop/scripts/download-binaries.sh" >&2
  exit 1
fi

mkdir -p "$BUNDLE_DIR"

for bin in "${EXPECTED[@]}"; do
  cp -p "$RUNTIME_DIR/$bin" "$BUNDLE_DIR/$bin"
  chmod +x "$BUNDLE_DIR/$bin"
done

if [[ -d "$RUNTIME_DIR/mafft-mac" ]]; then
  rm -rf "$BUNDLE_DIR/mafft-mac"
  cp -R "$RUNTIME_DIR/mafft-mac" "$BUNDLE_DIR/mafft-mac"
fi
if [[ -f "$RUNTIME_DIR/mafft" ]]; then
  cp -p "$RUNTIME_DIR/mafft" "$BUNDLE_DIR/mafft"
  chmod +x "$BUNDLE_DIR/mafft"
fi

for sidecar in "$RUNTIME_DIR"/$SIDECAR_GLOB; do
  [[ -e "$sidecar" ]] || continue
  destination="$BUNDLE_DIR/$(basename "$sidecar")"
  if [[ -d "$sidecar" ]]; then
    rm -rf "$destination"
    cp -pR "$sidecar" "$destination"
  else
    cp -p "$sidecar" "$destination"
    chmod +x "$destination"
  fi
done

echo "Copied/present in $BUNDLE_DIR:"
ls -lh "$BUNDLE_DIR" | awk 'NR>1 {printf "  %s  %s\n", $5, $NF}'

bundle_sidecar_found=false
for sidecar in "$BUNDLE_DIR"/$SIDECAR_GLOB; do
  if [[ -e "$sidecar" ]]; then
    bundle_sidecar_found=true
    break
  fi
done
if [[ "$bundle_sidecar_found" == false ]]; then
  echo
  echo "NOTE: no waypoint-api-* sidecar binary in the bundle path."
  echo "      Build it via:  cd apps/api && ./scripts/build-sidecar.sh"
  echo "      Then re-run this script (or copy from build-sidecar.sh's output)."
fi

echo
echo "Done. You can now run: pnpm run package:dir"
