#!/bin/bash

set -e

BLAST_VERSION="2.16.0"
DIAMOND_VERSION="2.1.19"
INFERNAL_VERSION="1.1.5"
DNA_INDEXER_VERSION="0.1.0"
DNA_COVERAGE_VERSION="0.1.0"

DNA_INDEXER_SOURCE="${DNA_INDEXER_SOURCE:-lfs}"
DNA_COVERAGE_SOURCE="${DNA_COVERAGE_SOURCE:-lfs}"

TEMP_DIR="$(mktemp -d)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ASSET_LOCK="$REPO_ROOT/.ci/release-assets.lock.json"
PLATFORM=""

if [[ ! -f "$ASSET_LOCK" ]]; then
    echo "Missing release asset lock: $ASSET_LOCK" >&2
    exit 1
fi

download_locked_asset() {
    local tool="$1"
    local destination="$2"
    local asset_info url expected actual

    asset_info=$(node -e '
      const fs = require("fs");
      const lock = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const asset = lock.tools[process.argv[2]].platforms[process.argv[3]];
      if (!asset) throw new Error(`no locked ${process.argv[2]} asset for ${process.argv[3]}`);
      const base = lock.publicBaseUrl.replace(/\/$/, "");
      process.stdout.write(`${base}/${asset.key}\t${asset.sha256}`);
    ' "$ASSET_LOCK" "$tool" "$PLATFORM")
    IFS=$'\t' read -r url expected <<<"$asset_info"

    curl -fsSL \
        --retry 3 \
        --retry-all-errors \
        --retry-delay 2 \
        --connect-timeout 20 \
        --max-time 600 \
        "$url" \
        -o "$destination"
    actual=$(shasum -a 256 "$destination" | awk '{print $1}')
    if [[ "$actual" != "$expected" ]]; then
        echo "Checksum mismatch for $tool: expected $expected, got $actual" >&2
        return 1
    fi
}

detect_platform() {
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

get_tools_dir() {
    local platform="$1"

    if [[ -n "$WAYPOINT_DATA_DIR" ]]; then
        echo "${WAYPOINT_DATA_DIR}/tools/${platform}"
    elif [[ "$(uname -s)" == "Darwin" ]]; then
        echo "$HOME/Library/Application Support/Waypoint/tools/${platform}"
    else
        echo "${XDG_DATA_HOME:-$HOME/.local/share}/waypoint/tools/${platform}"
    fi
}

download_blast() {
    echo "Downloading BLAST+ ${BLAST_VERSION}..."

    download_locked_asset blast "$TEMP_DIR/blast.tar.gz"
    tar -xzf "$TEMP_DIR/blast.tar.gz" -C "$TEMP_DIR"

    local blast_dir="$TEMP_DIR/ncbi-blast-${BLAST_VERSION}+/bin"
    cp "$blast_dir/blastn" "$BINARIES_DIR/blastn"
    cp "$blast_dir/makeblastdb" "$BINARIES_DIR/makeblastdb"

    chmod +x "$BINARIES_DIR/blastn"
    chmod +x "$BINARIES_DIR/makeblastdb"

    echo "  -> blastn"
    echo "  -> makeblastdb"
}

download_diamond() {
    echo "Downloading Diamond ${DIAMOND_VERSION}..."

    download_locked_asset diamond "$TEMP_DIR/diamond.tar.gz"
    tar -xzf "$TEMP_DIR/diamond.tar.gz" -C "$TEMP_DIR"

    cp "$TEMP_DIR/diamond" "$BINARIES_DIR/diamond"
    chmod +x "$BINARIES_DIR/diamond"

    echo "  -> diamond"
}

download_infernal() {
    local arch
    arch="$(uname -m)"

    if [[ "$(uname -s)" == "Darwin" ]]; then
        local cpu_brand
        cpu_brand="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "")"
        if [[ "$cpu_brand" == *"Apple"* ]]; then
            arch="arm64"
        fi
    fi

    echo "Downloading Infernal ${INFERNAL_VERSION}..."

    download_locked_asset infernal "$TEMP_DIR/infernal.tar.gz"
    tar -xzf "$TEMP_DIR/infernal.tar.gz" -C "$TEMP_DIR"

    local infernal_dir="$TEMP_DIR/infernal-${INFERNAL_VERSION}-"*
    infernal_dir=$(ls -d $infernal_dir 2>/dev/null | head -1)

    if [[ -d "$infernal_dir/binaries" ]]; then
        cp "$infernal_dir/binaries/cmscan" "$BINARIES_DIR/cmscan"
    elif [[ -f "$infernal_dir/src/cmscan" ]]; then
        cp "$infernal_dir/src/cmscan" "$BINARIES_DIR/cmscan"
    else
        local cmscan_path=$(find "$TEMP_DIR" -name "cmscan" -type f | head -1)
        if [[ -n "$cmscan_path" ]]; then
            cp "$cmscan_path" "$BINARIES_DIR/cmscan"
        else
            echo "Warning: Could not find cmscan binary in Infernal package" >&2
            return 1
        fi
    fi

    chmod +x "$BINARIES_DIR/cmscan"

    echo "  -> cmscan"
}

helper_source_path() {
    local helper="$1"
    local platform="$2"
    local repo_root
    repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
    local helpers_src="$repo_root/apps/desktop/resources/helpers/${helper}-${platform}"
    if [[ -s "$helpers_src" ]]; then
        echo "$helpers_src"
        return 0
    fi
    if [[ "$platform" == *"-unknown-linux-gnu" ]]; then
        local musl_platform="${platform/-unknown-linux-gnu/-unknown-linux-musl}"
        helpers_src="$repo_root/apps/desktop/resources/helpers/${helper}-${musl_platform}"
        if [[ -s "$helpers_src" ]]; then
            echo "$helpers_src"
            return 0
        fi
    fi
    echo "$repo_root/apps/desktop/resources/helpers/${helper}-${platform}"
}

download_dnaforge_helper() {
    local helper="$1"
    local version="$2"
    local source="$3"
    local platform="$4"
    local dest="$BINARIES_DIR/${helper}"
    local source_env
    source_env="$(echo "${helper//-/_}_SOURCE" | tr '[:lower:]' '[:upper:]')"

    echo "Installing ${helper} ${version} (source: ${source})..."

    case "$source" in
        lfs)
            local helpers_src
            helpers_src="$(helper_source_path "$helper" "$platform")"
            if [[ ! -s "$helpers_src" ]]; then
                echo "ERROR: ${helper} binary not found at $helpers_src" >&2
                echo "       Run \`npm run helpers:build\` from apps/desktop/ to build it locally," >&2
                echo "       or set ${source_env}=release to download from GH Releases." >&2
                return 1
            fi
            cp "$helpers_src" "$dest"
            chmod +x "$dest"
            echo "  -> ${helper} (from LFS / local build)"
            ;;
        release)
            local url="https://github.com/humic-labs/dnaforge-app/releases/download/${helper}-v${version}/${helper}-${platform}"
            local filename="${helper}-${platform}"
            echo "  Fetching from $url..."
            if ! curl -fL --silent --show-error -o "$TEMP_DIR/$filename" "$url"; then
                echo "" >&2
                echo "ERROR: Could not fetch ${helper}-${platform} from $url" >&2
                echo "       The release tag ${helper}-v${version} may not exist yet." >&2
                echo "       Build the helper locally if this repository has not published the requested release artifact." >&2
                echo "       Fall back to ${source_env}=lfs (the default) for local dev." >&2
                return 1
            fi
            cp "$TEMP_DIR/$filename" "$dest"
            chmod +x "$dest"
            echo "  -> ${helper} (from GH Release ${helper}-v${version})"
            ;;
        *)
            echo "ERROR: unknown helper source=$source (expected: lfs | release)" >&2
            return 1
            ;;
    esac
}

download_dna_indexer() {
    download_dnaforge_helper "dna-indexer" "$DNA_INDEXER_VERSION" "$DNA_INDEXER_SOURCE" "$1"
}

download_dna_coverage() {
    download_dnaforge_helper "dna-coverage" "$DNA_COVERAGE_VERSION" "$DNA_COVERAGE_SOURCE" "$1"
}

validate_binaries() {
    local failed=0
    for bin in blastn makeblastdb diamond cmscan; do
        local path="$BINARIES_DIR/${bin}"
        if [[ ! -s "$path" ]]; then
            echo "ERROR: ${bin} is missing or empty" >&2
            failed=1
        fi
    done
    for helper in dna-indexer dna-coverage; do
        if [[ ! -s "$BINARIES_DIR/$helper" ]]; then
            echo "WARNING: $helper is missing or empty (indexed-genome features may fail)" >&2
            echo "         Run \`npm run helpers:build\` from apps/desktop/ to build helper binaries." >&2
        fi
    done
    if [[ $failed -eq 1 ]]; then
        echo "Binary validation failed. Run with --force to re-download." >&2
        exit 1
    fi
    echo "All required binaries validated."
}

main() {
    echo "=== Downloading Bioinformatics Tools ==="
    echo ""

    local platform
    platform=$(detect_platform)
    PLATFORM="$platform"
    echo "Detected platform: $platform"

    BINARIES_DIR="$(get_tools_dir "$platform")"
    echo "Tools directory: $BINARIES_DIR"
    echo ""

    mkdir -p "$BINARIES_DIR"
    mkdir -p "$TEMP_DIR"

    local existing=0
    for bin in blastn makeblastdb diamond cmscan dna-indexer dna-coverage; do
        if [[ -s "$BINARIES_DIR/${bin}" ]]; then
            echo "Found existing: ${bin}"
            existing=$((existing + 1))
        fi
    done

    if [[ $existing -eq 6 ]]; then
        echo ""
        echo "All binaries already present. Use --force to re-download."
        if [[ "$1" != "--force" ]]; then
            rm -rf "$TEMP_DIR"
            exit 0
        fi
        echo "Force flag set, re-downloading..."
        echo ""
    fi

    download_blast
    echo ""

    download_diamond
    echo ""

    download_infernal
    echo ""

    download_dna_indexer "$platform" || true
    echo ""

    download_dna_coverage "$platform" || true
    echo ""

    validate_binaries
    echo ""

    rm -rf "$TEMP_DIR"

    echo "=== Download Complete ==="
    echo ""
    echo "Binaries installed to: $BINARIES_DIR"
    ls -la "$BINARIES_DIR"
}

main "$@"
