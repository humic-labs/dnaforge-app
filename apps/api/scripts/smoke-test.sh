#!/bin/bash




set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(dirname "$SCRIPT_DIR")"
URL="${1:-http://localhost:8000}"


PORT=$(echo "$URL" | grep -oE ':[0-9]+' | tail -1 | tr -d ':')
PORT="${PORT:-8000}"

echo "Smoke testing selected sidecar..."
cd "$API_DIR"
uv run python -m tests.live_sidecar_preflight "$URL" --protected-path /toolbox/status


SIDECAR_PID=$(lsof -ti :"$PORT" 2>/dev/null | head -1)
if [[ -n "$SIDECAR_PID" ]]; then

    if [[ "$(uname)" == "Darwin" ]]; then
        PROC_START_EPOCH=$(ps -p "$SIDECAR_PID" -o lstart= 2>/dev/null | xargs -I{} date -jf "%c" "{}" +%s 2>/dev/null || echo "")
        if [[ -n "$PROC_START_EPOCH" ]]; then

            STALE_FILE=$(find "$API_DIR/src" -name "*.py" -newer /dev/stdin <<< "" 2>/dev/null | while read -r f; do
                FILE_EPOCH=$(stat -f %m "$f" 2>/dev/null || echo 0)
                if [[ "$FILE_EPOCH" -gt "$PROC_START_EPOCH" ]]; then
                    echo "$f"
                    break
                fi
            done)
            if [[ -n "$STALE_FILE" ]]; then
                echo ""
                echo "WARNING: Sidecar (PID $SIDECAR_PID) may be stale."
                echo "  Source file modified after process start: $STALE_FILE"
                echo "  Restart sidecar before trusting results."
                echo ""
            fi
        fi
    fi
fi


echo ""
echo "Running integration tests against live sidecar..."
cd "$API_DIR"
if [[ -z "${DNAFORGE_MCP_SESSION_TOKEN:-}" ]]; then
    echo "ERROR: DNAFORGE_MCP_SESSION_TOKEN is required for protected smoke routes" >&2
    exit 2
fi
SIDECAR_URL="$URL" uv run pytest tests/test_sidecar_integration.py -v -m slow
