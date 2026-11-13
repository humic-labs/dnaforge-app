#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(dirname "$SCRIPT_DIR")"
DESKTOP_BINARIES="$API_DIR/../desktop/resources/binaries"
AGENT_TOOLS_DIR="$(cd "$API_DIR/../.." && pwd)/packages/core/agent-tools"
REPO_ROOT="$(cd "$API_DIR/../.." && pwd)"
RUNTIME_SECURITY="$REPO_ROOT/scripts/python-runtime-security.cjs"

cd "$API_DIR"

if [[ ! -f "$AGENT_TOOLS_DIR/renderer-tool-manifest.json" || ! -f "$AGENT_TOOLS_DIR/workflow-manifest.json" ]]; then
    echo "ERROR: agent tool manifests not found in $AGENT_TOOLS_DIR" >&2
    exit 1
fi

CLEAN=false
if [[ "$1" == "--clean" ]]; then
    CLEAN=true
fi

SIDECAR_NUITKA_JOBS="${SIDECAR_NUITKA_JOBS-1}"
if [[ ! "$SIDECAR_NUITKA_JOBS" =~ ^([1-9]|1[0-6])$ ]]; then
    echo "ERROR: SIDECAR_NUITKA_JOBS must be an integer from 1 to 16" >&2
    exit 1
fi

detect_target_triple() {
    local os=$(uname -s | tr '[:upper:]' '[:lower:]')
    local arch=$(uname -m)

    if [[ -n "${ARCH_OVERRIDE:-}" ]]; then
        arch="$ARCH_OVERRIDE"
    else
        if [[ "$os" == "darwin" ]]; then
            local hw_arm64=$(sysctl -n hw.optional.arm64 2>/dev/null || echo "0")
            if [[ "$hw_arm64" == "1" ]]; then
                arch="arm64"
            fi
        fi
    fi

    case "$os" in
        darwin)
            case "$arch" in
                arm64) echo "aarch64-apple-darwin" ;;
                x86_64) echo "x86_64-apple-darwin" ;;
                *) echo "unknown-apple-darwin" ;;
            esac
            ;;
        linux)
            case "$arch" in
                x86_64) echo "x86_64-unknown-linux-gnu" ;;
                aarch64) echo "aarch64-unknown-linux-gnu" ;;
                *) echo "unknown-unknown-linux-gnu" ;;
            esac
            ;;
        mingw*|msys*|cygwin*|windows*)
            echo "x86_64-pc-windows-msvc"
            ;;
        *)
            echo "unknown-unknown-unknown"
            ;;
    esac
}

TARGET_TRIPLE=$(detect_target_triple)
echo "Building for target: $TARGET_TRIPLE"

NUITKA_COMPILER_ARGS=()
if [[ "$TARGET_TRIPLE" == "x86_64-unknown-linux-gnu" ]]; then
    NUITKA_COMPILER_ARGS+=(--clang --nofollow-import-to=jsonschema.tests)
fi

if ! command -v uv >/dev/null 2>&1; then
    echo "ERROR: uv is required to build the sidecar from apps/api/uv.lock" >&2
    exit 1
fi

SIDECAR_PYTHON_VERSION="${SIDECAR_PYTHON_VERSION:-3.12}"
SIDECAR_PYTHON_VERSION="$(node "$RUNTIME_SECURITY" minimum "$SIDECAR_PYTHON_VERSION")"
node "$RUNTIME_SECURITY" check-uv "$(uv --version)" >/dev/null
PYTHON_TARGET="$(node "$REPO_ROOT/scripts/ci-setup-secure-python.mjs" --version "$SIDECAR_PYTHON_VERSION" --arch "${TARGET_TRIPLE%%-*}" --target-only)"
if ! PYTHON_BIN="$(uv python find --managed-python --no-python-downloads "$PYTHON_TARGET")"; then
    export UV_PYTHON_INSTALL_DIR="${UV_PYTHON_INSTALL_DIR:-$API_DIR/.cache/sidecar-python}"
    PYTHON_DOWNLOADS_URL="$(node "$RUNTIME_SECURITY" downloads-url)"
    uv python install --no-bin --python-downloads-json-url "$PYTHON_DOWNLOADS_URL" "$PYTHON_TARGET"
    PYTHON_BIN="$(uv python find --managed-python "$PYTHON_TARGET")"
fi
node "$RUNTIME_SECURITY" check "$("$PYTHON_BIN" -c 'import platform; print(platform.python_version())')" "$SIDECAR_PYTHON_VERSION" >/dev/null
echo "Using pinned sidecar Python $SIDECAR_PYTHON_VERSION: $PYTHON_BIN"

if [[ "$TARGET_TRIPLE" == *"windows"* ]]; then
    BINARY_NAME="waypoint-api.exe"
else
    BINARY_NAME="waypoint-api"
fi

echo "Installing dependencies..."
GENOME_EXTRA_ENABLED=$("$PYTHON_BIN" -B -c \
    'import sys; from src.runtime_capabilities import genome_extra_enabled_for_target; print(str(genome_extra_enabled_for_target(sys.argv[1])).lower())' \
    "$TARGET_TRIPLE")
UV_SYNC_ARGS=(--python "$PYTHON_BIN" --locked --inexact --extra sidecar)
if [[ "$GENOME_EXTRA_ENABLED" == "true" ]]; then
    UV_SYNC_ARGS+=(--extra genome)
else
    echo "Windows sidecar build: omitting optional pysam/genome extra (unsupported on Windows)."
fi

"$PYTHON_BIN" scripts/verify_sidecar_architecture.py \
    --target "$TARGET_TRIPLE" \
    --runtime
bash scripts/sync-python-dependencies.sh "$PYTHON_BIN" "$(command -v uv)" "${UV_SYNC_ARGS[@]}"

if [[ -f ".venv/bin/activate" ]]; then
    source .venv/bin/activate
elif [[ -f ".venv/Scripts/activate" ]]; then
    source .venv/Scripts/activate
else
    echo "ERROR: uv did not create a venv activation script under .venv/bin or .venv/Scripts" >&2
    exit 1
fi

ACTIVE_PYTHON_VERSION="$(python -c 'import platform; print(platform.python_version())')"
if ! node "$RUNTIME_SECURITY" check "$ACTIVE_PYTHON_VERSION" "$SIDECAR_PYTHON_VERSION" >/dev/null; then
    echo "ERROR: sidecar venv uses Python $ACTIVE_PYTHON_VERSION, expected $SIDECAR_PYTHON_VERSION" >&2
    exit 1
fi

python scripts/verify_sidecar_architecture.py \
    --target "$TARGET_TRIPLE" \
    --runtime

if [[ "$CLEAN" == true ]]; then
    echo "Cleaning previous builds..."
    rm -rf build dist run_server.build run_server.dist run_server.onefile-build
fi

echo "Running Nuitka with $SIDECAR_NUITKA_JOBS compiler worker(s)..."
FROZEN_IDENTITY_MODULE="$API_DIR/src/_frozen_build_identity.py"
if [[ -e "$FROZEN_IDENTITY_MODULE" ]]; then
    echo "ERROR: generated sidecar identity module already exists: $FROZEN_IDENTITY_MODULE" >&2
    exit 1
fi
SIDECAR_SOURCE_FINGERPRINT=$(node "$API_DIR/../../scripts/sidecar-build-receipt.cjs" source-hash \
    --repo-root "$API_DIR/../..")
cleanup_frozen_identity() {
    rm -f "$FROZEN_IDENTITY_MODULE"
}
trap cleanup_frozen_identity EXIT
printf '# Generated by build-sidecar.sh; never commit.\nSOURCE_FINGERPRINT = "%s"\n' \
    "$SIDECAR_SOURCE_FINGERPRINT" > "$FROZEN_IDENTITY_MODULE"
python -m nuitka \
    "${NUITKA_COMPILER_ARGS[@]}" \
    --jobs="$SIDECAR_NUITKA_JOBS" \
    --standalone \
    --user-package-configuration="$API_DIR/scripts/pysam.nuitka-package.config.yml" \
    --assume-yes-for-downloads \
    --output-dir=dist \
    --output-filename="$BINARY_NAME" \
    --include-package=src \
    --include-package=dnaforge_annotation \
    --include-package-data=dnaforge_annotation \
    --include-package=uvicorn \
    --include-package=fastapi \
    --include-package=pydantic \
    --include-package=mcp \
    --include-package=mcp_types \
    --include-package=jsonschema \
    --include-package=jsonschema_specifications \
    --include-package-data=jsonschema_specifications \
    --include-package=ijson \
    --include-package=primer3 \
    --include-package-data=primer3:src/libprimer3/primer3_config/* \
    --include-package-data=primer3:src/libprimer3/humrep_and_simple.txt \
    --include-package-data=primer3:src/libprimer3/ABOUT.txt \
    --include-package-data=primer3:src/libprimer3/LICENSE.txt \
    --include-package-data=primer3:src/libprimer3/gpl-2.0.txt \
    --include-data-dir="$AGENT_TOOLS_DIR=packages/core/agent-tools" \
    --nofollow-import-to=matplotlib \
    --nofollow-import-to=tkinter \
    --nofollow-import-to=pytest \
    --nofollow-import-to=sentry_sdk \
    --nofollow-import-to=test \
    run_server.py

cleanup_frozen_identity
trap - EXIT

DIST_DIR="dist/run_server.dist"
if [[ ! -x "$DIST_DIR/$BINARY_NAME" ]]; then
    echo "ERROR: Build failed - $DIST_DIR/$BINARY_NAME not found"
    exit 1
fi

if [[ "$TARGET_TRIPLE" == *-apple-darwin ]]; then
    echo "Removing non-runtime local symbols from macOS sidecar binaries..."
    SIDECAR_BEFORE_KIB=$(du -sk "$DIST_DIR" | awk '{print $1}')
    MACH_O_COUNT=0
    while IFS= read -r -d '' CANDIDATE; do
        if file -b "$CANDIDATE" | grep -q '^Mach-O'; then
            strip -x -no_code_signature_warning "$CANDIDATE"
            if ! codesign --force --sign - "$CANDIDATE" >/dev/null 2>&1; then
                echo "ERROR: could not restore ad-hoc signature after stripping: $CANDIDATE" >&2
                exit 1
            fi
            MACH_O_COUNT=$((MACH_O_COUNT + 1))
        fi
    done < <(find "$DIST_DIR" -type f -print0)
    if [[ "$MACH_O_COUNT" -eq 0 ]]; then
        echo "ERROR: macOS sidecar contains no Mach-O binaries to optimize" >&2
        exit 1
    fi
    SIDECAR_AFTER_KIB=$(du -sk "$DIST_DIR" | awk '{print $1}')
    echo "Stripped $MACH_O_COUNT Mach-O files; saved $((SIDECAR_BEFORE_KIB - SIDECAR_AFTER_KIB)) KiB"
fi

python scripts/verify_sidecar_architecture.py \
    --target "$TARGET_TRIPLE" \
    --binary "$DIST_DIR/$BINARY_NAME"

mkdir -p "$DESKTOP_BINARIES"

DEST_NAME="waypoint-api-$TARGET_TRIPLE"

rm -rf "$DESKTOP_BINARIES/$DEST_NAME"
cp -R "$DIST_DIR" "$DESKTOP_BINARIES/$DEST_NAME"
echo "Copied standalone dir to: $DESKTOP_BINARIES/$DEST_NAME (exec: $DEST_NAME/$BINARY_NAME)"

LICENSE_INVENTORY_ARGS=(--output "$DESKTOP_BINARIES/$DEST_NAME/python-licenses.json" --target "$TARGET_TRIPLE")
if [[ "$GENOME_EXTRA_ENABLED" == "true" ]]; then
    LICENSE_INVENTORY_ARGS+=(--extra genome)
fi
python -m src.license_inventory "${LICENSE_INVENTORY_ARGS[@]}"

node "$API_DIR/../../scripts/sidecar-build-receipt.cjs" write \
    --repo-root "$API_DIR/../.." \
    --sidecar-dir "$DESKTOP_BINARIES/$DEST_NAME" \
    --target "$TARGET_TRIPLE" \
    --python-version "$(python --version 2>&1)"

SIZE=$(du -sh "$DESKTOP_BINARIES/$DEST_NAME" | cut -f1)
echo "Sidecar bundle size: $SIZE"

echo "Testing binary..."
if command -v timeout >/dev/null 2>&1; then
    TIMEOUT_CMD="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
    TIMEOUT_CMD="gtimeout"
else
    TIMEOUT_CMD=""
fi

set +e
if [ -n "$TIMEOUT_CMD" ]; then
    "$TIMEOUT_CMD" 5 "$DESKTOP_BINARIES/$DEST_NAME/$BINARY_NAME" --help >/dev/null 2>&1
    BINARY_TEST_EXIT=$?
else
    echo "  (no 'timeout' / 'gtimeout' available — using fallback)"
    "$DESKTOP_BINARIES/$DEST_NAME/$BINARY_NAME" --help >/dev/null 2>&1 &
    BIN_PID=$!
    sleep 5
    if kill -0 "$BIN_PID" 2>/dev/null; then
        kill -TERM "$BIN_PID" 2>/dev/null
        wait "$BIN_PID" 2>/dev/null
        BINARY_TEST_EXIT=124
    else
        wait "$BIN_PID"
        BINARY_TEST_EXIT=$?
    fi
fi
set -e

if [ "$BINARY_TEST_EXIT" -eq 0 ] || [ "$BINARY_TEST_EXIT" -eq 124 ]; then
    echo "Binary smoke test passed (exit $BINARY_TEST_EXIT)"
else
    echo "ERROR: Binary smoke test failed with exit code $BINARY_TEST_EXIT" >&2
    echo "       The compiled sidecar cannot launch. Common causes:" >&2
    echo "         • Missing dynamic library (check with: otool -L or ldd)" >&2
    echo "         • Arch mismatch (wrong TARGET_TRIPLE for this host)" >&2
    echo "         • Nuitka bundled a broken extension" >&2
    echo "       Rebuild with CLEAN=1 and inspect the Nuitka output." >&2
    exit 1
fi

echo "Testing frozen BAM/CRAM runtime policy..."
if ! "$DESKTOP_BINARIES/$DEST_NAME/$BINARY_NAME" --verify-genome-runtime; then
    echo "ERROR: frozen sidecar has no valid pysam/htslib runtime status." >&2
    echo "       This build cannot be packaged or released." >&2
    exit 1
fi
echo "Frozen BAM/CRAM runtime policy passed"

echo "Testing frozen Jobs command without an application or runtime..."
python scripts/verify_packaged_jobs.py "$DESKTOP_BINARIES/$DEST_NAME/$BINARY_NAME"

echo "Testing server startup (/health)..."
HEALTH_PORT=8779
"$DESKTOP_BINARIES/$DEST_NAME/$BINARY_NAME" --port "$HEALTH_PORT" \
    >/tmp/sidecar-health-smoke.log 2>&1 &
HEALTH_PID=$!
HEALTH_OK=0
for _ in $(seq 1 40); do
    if ! kill -0 "$HEALTH_PID" 2>/dev/null; then
        break
    fi
    if curl -sf -m 2 -o /dev/null "http://127.0.0.1:$HEALTH_PORT/health" 2>/dev/null; then
        HEALTH_OK=1
        break
    fi
    sleep 1
done
kill "$HEALTH_PID" 2>/dev/null || true
wait "$HEALTH_PID" 2>/dev/null || true
if [ "$HEALTH_OK" -ne 1 ]; then
    echo "ERROR: sidecar did not serve /health — the server crashed or hung on" >&2
    echo "       startup (e.g. a Nuitka lifespan segfault). Build output:" >&2
    sed 's/^/         /' /tmp/sidecar-health-smoke.log >&2 2>/dev/null || true
    exit 1
fi
echo "Server /health smoke passed"

echo ""
echo "Build complete!"
echo "Binary: $DESKTOP_BINARIES/$DEST_NAME"
