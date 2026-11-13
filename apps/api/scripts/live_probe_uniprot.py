#!/usr/bin/env python3
""" (Phase 1a4) — UniProt live probe.

Scheduled-job entry point that exercises the external_resources assays
against REAL UniProt. Boots a hermetic sidecar (its own SQLite DB in a
temp dir), runs the four  assays, and emits a JSON result on
stdout. Returns 0 when every assay passes; non-zero with details
otherwise.

Why this is separate from agent_mcp_harness.py: the full harness boots
fake renderer + MCP companion + closed-loop scenario fixtures. The live
probe only needs the sidecar — running the rest just adds CI noise and
flake surface unrelated to UniProt schema drift.

Usage (CI, scheduled):
    python apps/api/scripts/live_probe_uniprot.py

Usage (local sanity):
    cd apps/api
    uv run python scripts/live_probe_uniprot.py | jq

Exits:
    0  — all four assays passed
    1  — any assay failed (schema drift, network, etc.)
    2  — sidecar failed to boot
"""

from __future__ import annotations

import http.client
import json
import os
import secrets
import subprocess
import sys
import tempfile
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any


def _find_free_port() -> int:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for_health(url: str, timeout_s: float = 30.0) -> bool:
    """Poll /health until it returns ok or the deadline expires."""
    from urllib.parse import urlsplit

    parts = urlsplit(url)
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            conn = http.client.HTTPConnection(parts.hostname, parts.port, timeout=2.0)
            conn.request("GET", parts.path or "/health")
            resp = conn.getresponse()
            resp.read()
            conn.close()
            if resp.status == 200:
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def _start_sidecar(
    api_port: int,
    db_path: Path,
    log_path: Path,
    *,
    session_token: str,
    grant_capabilities: Sequence[str],
) -> subprocess.Popen:
    env = {
        **os.environ,
        "PYTHONUNBUFFERED": "1",
        "DNAFORGE_SIDECAR_DB_PATH": str(db_path),
        "DNAFORGE_MCP_SESSION_TOKEN": session_token,
        "DNAFORGE_MCP_GRANT_CAPABILITIES": ",".join(grant_capabilities),
    }
    return subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "src.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(api_port),
            "--log-level",
            "warning",
        ],
        env=env,
        stdout=log_path.open("w"),
        stderr=subprocess.STDOUT,
    )


def main() -> int:
    api_dir = Path(__file__).resolve().parents[1]
    if not (api_dir / "src" / "main.py").exists():
        print("FATAL: cannot locate apps/api/src/main.py", file=sys.stderr)
        return 2

    sys.path.insert(0, str(api_dir))

    port = _find_free_port()
    sidecar_url = f"http://127.0.0.1:{port}"
    session_token = os.environ.get(
        "DNAFORGE_MCP_SESSION_TOKEN"
    ) or secrets.token_urlsafe(32)

    from src.agent_workflow_harness.external_resources_assays import (  # noqa: E402
        REQUESTED_CAPABILITIES,
    )

    with tempfile.TemporaryDirectory(prefix="fixture-live-probe-") as tmp:
        tmp_dir = Path(tmp)
        db_path = tmp_dir / "control-plane.sqlite3"
        log_path = tmp_dir / "sidecar.log"

        proc = _start_sidecar(
            port,
            db_path,
            log_path,
            session_token=session_token,
            grant_capabilities=REQUESTED_CAPABILITIES,
        )
        try:
            if not _wait_for_health(f"{sidecar_url}/health"):
                print("FATAL: sidecar did not become healthy", file=sys.stderr)
                if log_path.exists():
                    print("--- sidecar log ---", file=sys.stderr)
                    print(log_path.read_text(errors="replace"), file=sys.stderr)
                return 2

            from src.agent_workflow_harness.external_resources_assays import (  # noqa: E402
                run_external_resources_assays,
            )

            results = run_external_resources_assays(
                sidecar_url=sidecar_url,
                db_path=db_path,
                session_token=session_token,
            )
            failures = [r for r in results if r["outcome"] != "passed"]

            summary: dict[str, Any] = {
                "ok": len(failures) == 0,
                "sidecar_url": sidecar_url,
                "assay_count": len(results),
                "failure_count": len(failures),
                "assays": results,
            }
            print(json.dumps(summary, indent=2, sort_keys=True))
            return 0 if not failures else 1
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
