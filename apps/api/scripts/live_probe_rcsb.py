#!/usr/bin/env python3
""" RCSB live probe.

Runs the RCSB metadata provider against a temporary SQLite store and prints a
JSON summary. This is a live smoke probe for local evidence, not a hermetic unit
test; the unit test injects an httpx.MockTransport client.

Usage:
    cd apps/api
    uv run python scripts/live_probe_rcsb.py | jq
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sqlite3
import sys
import tempfile
from pathlib import Path
from typing import Any

import httpx

from src.control_plane.store import ControlPlaneStore
from src.external.contract import Capability, FetchOptions
from src.external.providers import RCSBProvider
from src.external.service import ExternalResourcesService, FetchRequest


async def run_probe(
    db_path: Path,
    *,
    client: httpx.AsyncClient | None = None,
    raw_id: str = "1RBL",
) -> dict[str, Any]:
    """Fetch one RCSB metadata row and verify  invariants."""
    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient()

    store = ControlPlaneStore(db_path)
    store.initialize()
    service = ExternalResourcesService(store, client=client)
    service.register(RCSBProvider(client=client))

    try:
        response = await service.fetch(
            FetchRequest(
                provider="rcsb",
                raw_id=raw_id,
                workspace_id="fixture-live-probe",
                granted_capabilities=[Capability.EXTERNAL_FETCH_ANNOTATION.value],
            ),
            opts=FetchOptions(max_retries=1),
        )

        resource = store.get_external_resource(response.external_resource_id)
        if resource is None:
            raise RuntimeError(
                f"RCSB probe persisted no resource for {response.external_resource_id}"
            )

        with sqlite3.connect(db_path) as raw:
            data_file_count = raw.execute("SELECT COUNT(*) FROM data_file").fetchone()[
                0
            ]

        metadata = response.metadata
        chain_ids = metadata.get("chain_ids") or []
        polymer_entity_ids = metadata.get("polymer_entity_ids") or []
        data_file_id = resource["data_file_id"]

        if data_file_count != 0 or data_file_id is not None:
            raise RuntimeError(
                "RCSB metadata probe unexpectedly created structure bytes"
            )
        if not chain_ids:
            raise RuntimeError("RCSB metadata probe returned no chain metadata")
        if not polymer_entity_ids:
            raise RuntimeError(
                "RCSB metadata probe returned no polymer entity metadata"
            )

        fetch_logs = store.list_external_fetch_log(provider="rcsb")
        summary: dict[str, Any] = {
            "ok": True,
            "provider": "rcsb",
            "requested_id": raw_id,
            "external_resource_id": response.external_resource_id,
            "canonical_pdb_id": metadata.get("pdb_id"),
            "cache_hit": response.cache_hit,
            "license": response.license,
            "attribution": response.attribution,
            "provider_url": metadata.get("provider_url"),
            "structure_file_urls": metadata.get("structure_file_urls"),
            "chain_ids": chain_ids,
            "chain_count": len(chain_ids),
            "polymer_entity_ids": polymer_entity_ids,
            "resource_exists": True,
            "data_file_count": data_file_count,
            "data_file_id": data_file_id,
            "fetch_log_count": len(fetch_logs),
        }
        return summary
    finally:
        await service.aclose()
        store.close()
        if owns_client:
            await client.aclose()


async def _main_async(raw_id: str) -> int:
    with tempfile.TemporaryDirectory(prefix="fixture-rcsb-live-probe-") as tmp:
        summary = await run_probe(Path(tmp) / "control-plane.sqlite3", raw_id=raw_id)
        print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw-id", default="1RBL", help="RCSB PDB ID to probe")
    args = parser.parse_args(argv)
    return asyncio.run(_main_async(args.raw_id))


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"[live_probe_rcsb] FAIL: {exc}", file=sys.stderr)
        raise SystemExit(1) from None
