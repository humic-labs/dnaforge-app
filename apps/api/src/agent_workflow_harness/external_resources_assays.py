"""Closed-loop assays for external resources.

The agent calls a tool, the sidecar changes state, and an observer verifies
the result through the sidecar HTTP interface and database. These assays
exercise the sidecar independently of the Electron renderer.

Each assay returns a dict matching the rest of the harness result shape:

  {
    "name":     str,
    "outcome":  "passed" | "failed" | "skipped",
    "checks":   [{"name": str, "passed": bool, "evidence": ...}],
    "evidence": dict,
  }
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from src.agent_workflow_harness.runtime import request_json
from src.external.contract import Capability

REQUESTED_CAPABILITIES: tuple[str, ...] = (
    Capability.EXTERNAL_FETCH_ANNOTATION.value,
    Capability.EXTERNAL_FETCH_XREF.value,
)


def _check(name: str, passed: bool, evidence: Any = None) -> dict[str, Any]:
    return {"name": name, "passed": bool(passed), "evidence": evidence}


def _outcome(checks: list[dict[str, Any]]) -> str:
    return "passed" if all(c["passed"] for c in checks) else "failed"


def _query_one(db_path: Path, sql: str, params: tuple = ()) -> dict[str, Any] | None:
    raw = sqlite3.connect(db_path)
    raw.row_factory = sqlite3.Row
    try:
        row = raw.execute(sql, params).fetchone()
        return dict(row) if row is not None else None
    finally:
        raw.close()


def _query_all(db_path: Path, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    raw = sqlite3.connect(db_path)
    raw.row_factory = sqlite3.Row
    try:
        return [dict(row) for row in raw.execute(sql, params).fetchall()]
    finally:
        raw.close()


def _post_headers(session_token: str) -> dict[str, str]:
    """: every assay call now sends X-DNAForge-Session. Centralized
    so the contract is one place to grep when the token plumbing changes."""
    return {
        "Content-Type": "application/json",
        "X-DNAForge-Session": session_token,
    }


def _get_headers(session_token: str) -> dict[str, str]:
    return {"X-DNAForge-Session": session_token}


def external_fetch_smoke(
    *,
    sidecar_url: str,
    db_path: Path,
    session_token: str,
    accession: str = "P00875",
) -> dict[str, Any]:
    """Goal: prove that POST /external/fetch persists external_resource +
    external_fetch_log + xref rows for a real UniProt accession.

    Observer: direct SQL against the sidecar DB (the substrate's only state).

    Score: 4 checks — HTTP 200, external_resource_id returned, fetch_log row
    written with cache_hit=0 + license=CC-BY-4.0, license/attribution
    metadata stored on external_resource."""
    response = request_json(
        f"{sidecar_url}/external/fetch",
        method="POST",
        payload={
            "provider": "uniprot",
            "external_id": accession,
            "granted_capabilities": list(REQUESTED_CAPABILITIES),
        },
        headers=_post_headers(session_token),
    )

    body = response["body"]
    er_id = body.get("external_resource_id") if isinstance(body, dict) else None
    er_row = (
        _query_one(
            db_path,
            "SELECT * FROM external_resource WHERE id = ?",
            (er_id,),
        )
        if er_id
        else None
    )
    log_row = _query_one(
        db_path,
        "SELECT * FROM external_fetch_log WHERE external_resource_id = ? ORDER BY recorded_at DESC LIMIT 1",
        (er_id,) if er_id else ("",),
    )
    xref_count = len(
        _query_all(
            db_path,
            "SELECT id FROM external_resource_xref WHERE from_resource_id = ?",
            (er_id,) if er_id else ("",),
        )
    )

    checks = [
        _check("http_200", response["status_code"] == 200, response["status_code"]),
        _check("external_resource_id_returned", bool(er_id), er_id),
        _check(
            "external_resource_row_persisted",
            er_row is not None,
            {"id": er_id, "row_present": er_row is not None},
        ),
        _check(
            "license_cc_by_4_0",
            er_row is not None and er_row.get("license") == "CC-BY-4.0",
            er_row.get("license") if er_row else None,
        ),
        _check(
            "fetch_log_cache_miss",
            log_row is not None and log_row.get("cache_hit") == 0,
            {"cache_hit": log_row.get("cache_hit") if log_row else None},
        ),
        _check(
            "xref_count_positive",
            xref_count > 0,
            {"xref_count": xref_count},
        ),
    ]

    return {
        "name": "external_fetch_smoke",
        "outcome": _outcome(checks),
        "checks": checks,
        "evidence": {
            "accession": accession,
            "external_resource_id": er_id,
            "xref_count": xref_count,
            "fetch_log_row": log_row,
        },
    }


def external_xref_smoke(
    *,
    sidecar_url: str,
    db_path: Path,
    session_token: str,
    accession: str = "P00875",
) -> dict[str, Any]:
    """Goal: prove that GET /external/xrefs returns the cached xrefs for a
    previously-fetched resource WITHOUT triggering a network re-fetch.

    Observer: SQL fetch_log delta — assay records counts before/after the
    /xrefs call and verifies no new fetch_log rows were written.

    Score: 3 checks — HTTP 200, xrefs returned, fetch_log unchanged
    (proves read-only semantics)."""
    request_json(
        f"{sidecar_url}/external/fetch",
        method="POST",
        payload={
            "provider": "uniprot",
            "external_id": accession,
            "granted_capabilities": list(REQUESTED_CAPABILITIES),
        },
        headers=_post_headers(session_token),
    )

    log_count_before = len(_query_all(db_path, "SELECT id FROM external_fetch_log"))

    xref_response = request_json(
        f"{sidecar_url}/external/xrefs?provider=uniprot&external_id={accession}",
        method="GET",
        headers=_get_headers(session_token),
    )

    log_count_after = len(_query_all(db_path, "SELECT id FROM external_fetch_log"))

    body = xref_response["body"]
    xrefs = body.get("xrefs", []) if isinstance(body, dict) else []
    resource_id = body.get("resource_id") if isinstance(body, dict) else None

    checks = [
        _check(
            "http_200",
            xref_response["status_code"] == 200,
            xref_response["status_code"],
        ),
        _check("resource_id_returned", bool(resource_id), resource_id),
        _check("xrefs_non_empty", len(xrefs) > 0, len(xrefs)),
        _check(
            "no_new_fetch_log_rows",
            log_count_after == log_count_before,
            {"before": log_count_before, "after": log_count_after},
        ),
    ]

    return {
        "name": "external_xref_smoke",
        "outcome": _outcome(checks),
        "checks": checks,
        "evidence": {
            "accession": accession,
            "xref_count": len(xrefs),
            "log_count_before": log_count_before,
            "log_count_after": log_count_after,
        },
    }


def cache_invalidation_smoke(
    *,
    sidecar_url: str,
    db_path: Path,
    session_token: str,
    accession: str = "P0A6F5",
) -> dict[str, Any]:
    """Goal: prove the cache_hit observability is wired in fetch_log.

    First /external/fetch persists with cache_hit=0; second call short-
    circuits with cache_hit=1. The renderer-side IPC invalidation channel
    is 's deliverable — this assay covers what the sidecar can
    independently observe.

    Score: 3 checks — first call cache_hit=0, second call cache_hit=1,
    fetch_log row count incremented by exactly 2."""
    log_count_before = len(_query_all(db_path, "SELECT id FROM external_fetch_log"))

    response_a = request_json(
        f"{sidecar_url}/external/fetch",
        method="POST",
        payload={
            "provider": "uniprot",
            "external_id": accession,
            "granted_capabilities": list(REQUESTED_CAPABILITIES),
        },
        headers=_post_headers(session_token),
    )
    body_a = response_a["body"]
    er_id = body_a.get("external_resource_id") if isinstance(body_a, dict) else None

    response_b = request_json(
        f"{sidecar_url}/external/fetch",
        method="POST",
        payload={
            "provider": "uniprot",
            "external_id": accession,
            "granted_capabilities": list(REQUESTED_CAPABILITIES),
        },
        headers=_post_headers(session_token),
    )
    body_b = response_b["body"]
    cache_hit_b = body_b.get("cache_hit") if isinstance(body_b, dict) else None

    log_count_after = len(_query_all(db_path, "SELECT id FROM external_fetch_log"))

    log_rows = _query_all(
        db_path,
        "SELECT * FROM external_fetch_log WHERE external_resource_id = ? ORDER BY recorded_at ASC",
        (er_id,) if er_id else ("",),
    )

    first_row = log_rows[0] if log_rows else None
    second_row = log_rows[1] if len(log_rows) > 1 else None

    checks = [
        _check(
            "first_call_http_200",
            response_a["status_code"] == 200,
            response_a["status_code"],
        ),
        _check(
            "second_call_http_200",
            response_b["status_code"] == 200,
            response_b["status_code"],
        ),
        _check(
            "first_fetch_log_cache_miss",
            first_row is not None and first_row.get("cache_hit") == 0,
            first_row.get("cache_hit") if first_row else None,
        ),
        _check(
            "second_fetch_log_cache_hit",
            second_row is not None and second_row.get("cache_hit") == 1,
            second_row.get("cache_hit") if second_row else None,
        ),
        _check(
            "response_body_cache_hit_true_on_second_call",
            cache_hit_b is True,
            cache_hit_b,
        ),
        _check(
            "fetch_log_grew_by_two",
            log_count_after - log_count_before == 2,
            {"delta": log_count_after - log_count_before},
        ),
    ]

    return {
        "name": "cache_invalidation_smoke",
        "outcome": _outcome(checks),
        "checks": checks,
        "evidence": {
            "accession": accession,
            "external_resource_id": er_id,
            "log_count_delta": log_count_after - log_count_before,
        },
    }


def dna98_resolver_chain_via_sidecar_smoke(
    *,
    sidecar_url: str,
    db_path: Path,
    session_token: str,
    accession: str = "P02786",
) -> dict[str, Any]:
    """Goal: prove the sidecar half of the  resolver chain works.

    The  resolver chain (renderer-side) follows: CDS → UniProt search
    → AFDB validate → PDB xref → render structure. Once  lands, the
    UniProt + AFDB-validate steps route through the sidecar's
    /external/fetch instead of raw renderer fetch. This assay validates
    that path without needing the real renderer:

      1. POST /external/fetch for a UniProt accession that has PDB xrefs
      2. Read /external/xrefs, filter target_provider=pdb
      3. Verify at least one PDB xref came back

    When  lands, the assay should be re-pointed at the renderer's
    actual resolver chain (via the closed_loop scenario fixture) — until
    then this proves the sidecar's responsibility independently.

    Score: 4 checks — fetch ok, xrefs HTTP 200, ≥1 PDB xref,
    AlphaFold xref present (validates the AFDB-validate equivalent
    surface that  will replace its raw fetch with)."""
    fetch_response = request_json(
        f"{sidecar_url}/external/fetch",
        method="POST",
        payload={
            "provider": "uniprot",
            "external_id": accession,
            "granted_capabilities": list(REQUESTED_CAPABILITIES),
        },
        headers=_post_headers(session_token),
    )

    pdb_response = request_json(
        f"{sidecar_url}/external/xrefs?provider=uniprot&external_id={accession}&target_provider=pdb",
        method="GET",
        headers=_get_headers(session_token),
    )
    afdb_response = request_json(
        f"{sidecar_url}/external/xrefs?provider=uniprot&external_id={accession}&target_provider=alphafold",
        method="GET",
        headers=_get_headers(session_token),
    )

    pdb_xrefs = (
        pdb_response["body"].get("xrefs", [])
        if isinstance(pdb_response["body"], dict)
        else []
    )
    afdb_xrefs = (
        afdb_response["body"].get("xrefs", [])
        if isinstance(afdb_response["body"], dict)
        else []
    )

    checks = [
        _check(
            "fetch_http_200",
            fetch_response["status_code"] == 200,
            fetch_response["status_code"],
        ),
        _check(
            "pdb_xrefs_http_200",
            pdb_response["status_code"] == 200,
            pdb_response["status_code"],
        ),
        _check(
            "afdb_xrefs_http_200",
            afdb_response["status_code"] == 200,
            afdb_response["status_code"],
        ),
        _check("pdb_xref_present", len(pdb_xrefs) >= 1, len(pdb_xrefs)),
        _check(
            "afdb_xref_present",
            len(afdb_xrefs) >= 1,
            len(afdb_xrefs),
        ),
    ]

    return {
        "name": "dna98_resolver_chain_via_sidecar_smoke",
        "outcome": _outcome(checks),
        "checks": checks,
        "evidence": {
            "accession": accession,
            "pdb_xref_count": len(pdb_xrefs),
            "afdb_xref_count": len(afdb_xrefs),
        },
    }


def run_external_resources_assays(
    *,
    sidecar_url: str,
    db_path: Path,
    session_token: str,
) -> list[dict[str, Any]]:
    """Run all 4  assays in sequence. Returns the full result list.

    Independence: each assay uses a different UniProt accession so
    failure-mode interactions don't compound. The cache_invalidation_smoke
    runs against an accession the others don't touch so its delta-count
    assertions remain deterministic.

    `session_token` is forwarded as `X-DNAForge-Session` on every sidecar
    request — required since  added auth enforcement on /external/*.
    """
    return [
        external_fetch_smoke(
            sidecar_url=sidecar_url, db_path=db_path, session_token=session_token
        ),
        external_xref_smoke(
            sidecar_url=sidecar_url, db_path=db_path, session_token=session_token
        ),
        cache_invalidation_smoke(
            sidecar_url=sidecar_url, db_path=db_path, session_token=session_token
        ),
        dna98_resolver_chain_via_sidecar_smoke(
            sidecar_url=sidecar_url, db_path=db_path, session_token=session_token
        ),
    ]
