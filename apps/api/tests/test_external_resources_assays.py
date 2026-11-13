""" / L1 — closed-loop assay runners for external_resources.

Tests the four assays in `src/agent_workflow_harness/external_resources_assays.py`
without booting a real sidecar. We monkeypatch `request_json` to return
canned responses + seed the DB directly with `ControlPlaneStore` so the
assays' DB-side observers see the same state a real sidecar fetch would
have left.

This pins the assays' scoring logic — it's the part the live-probe
nightly suite (real UniProt) and the local harness run share.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from src.control_plane.store import ControlPlaneStore
from src.agent_workflow_harness import external_resources_assays as assays
from src.external.contract import Capability


def _store_with(tmp_path) -> tuple[ControlPlaneStore, Path]:
    db_path = tmp_path / "harness.sqlite3"
    s = ControlPlaneStore(db_path)
    s.initialize()
    return s, db_path


def _seed_resource(
    store: ControlPlaneStore,
    *,
    provider: str = "uniprot",
    external_id: str = "P00875",
    license: str = "CC-BY-4.0",
) -> str:
    return store.upsert_external_resource(
        provider=provider,
        external_id=external_id,
        metadata={"organism": "Synechococcus elongatus"},
        external_url=f"https://rest.uniprot.org/uniprotkb/{external_id}.json",
        license=license,
        attribution="UniProt Consortium",
    )


def _seed_xref(
    store: ControlPlaneStore,
    *,
    from_id: str,
    target_provider: str,
    target_external_id: str,
    xref_type: str = "has_structure",
) -> str:
    target_id = store.upsert_external_resource_stub(
        provider=target_provider, external_id=target_external_id
    )
    return store.upsert_external_resource_xref(
        from_resource_id=from_id,
        to_resource_id=target_id,
        xref_type=xref_type,
        evidence="asserted",
        source_provider="uniprot",
    )


def _mk_request_stub(responses: dict[tuple[str, str], dict[str, Any]]):
    """Returns a function matching `request_json`'s signature that looks up
    `(method, url-path)` tuples in `responses`. The path is the URL minus
    `http://host:port` so tests don't need to worry about port binding."""

    def stub(url: str, *, method: str, payload: Any = None, headers: Any = None):
        from urllib.parse import urlsplit

        path = urlsplit(url).path
        if urlsplit(url).query:
            path = f"{path}?{urlsplit(url).query}"
        key = (method.upper(), path)
        if key not in responses:
            raise AssertionError(f"unexpected request: {key}; have {list(responses)}")
        return responses[key]

    return stub


def test_external_fetch_smoke_pass_when_state_matches(monkeypatch, tmp_path):
    s, db_path = _store_with(tmp_path)
    er_id = _seed_resource(s, external_id="P00875")
    _seed_xref(s, from_id=er_id, target_provider="pdb", target_external_id="1RBL")
    s.insert_external_fetch_log(
        provider="uniprot",
        endpoint="https://rest.uniprot.org/uniprotkb/P00875.json",
        method="GET",
        capability_check={"granted": ["external-fetch:annotation"]},
        status_code=200,
        latency_ms=120,
        cache_hit=False,
        external_resource_id=er_id,
    )

    monkeypatch.setattr(
        assays,
        "request_json",
        _mk_request_stub(
            {
                ("POST", "/external/fetch"): {
                    "status_code": 200,
                    "body": {
                        "external_resource_id": er_id,
                        "provider": "uniprot",
                        "external_id": "P00875",
                        "cache_hit": False,
                        "license": "CC-BY-4.0",
                        "xref_count": 1,
                    },
                },
            }
        ),
    )

    result = assays.external_fetch_smoke(
        sidecar_url="http://127.0.0.1:65535",
        db_path=db_path,
        session_token="test-session",
    )
    assert result["name"] == "external_fetch_smoke"
    assert result["outcome"] == "passed", result["checks"]
    s.close()


def test_external_fetch_smoke_fails_when_no_xrefs(monkeypatch, tmp_path):
    s, db_path = _store_with(tmp_path)
    er_id = _seed_resource(s, external_id="P00875")
    s.insert_external_fetch_log(
        provider="uniprot",
        endpoint="x",
        method="GET",
        capability_check={},
        cache_hit=False,
        external_resource_id=er_id,
    )

    monkeypatch.setattr(
        assays,
        "request_json",
        _mk_request_stub(
            {
                ("POST", "/external/fetch"): {
                    "status_code": 200,
                    "body": {"external_resource_id": er_id, "license": "CC-BY-4.0"},
                },
            }
        ),
    )

    result = assays.external_fetch_smoke(
        sidecar_url="http://127.0.0.1:65535",
        db_path=db_path,
        session_token="test-session",
    )
    assert result["outcome"] == "failed"
    assert any(
        c["name"] == "xref_count_positive" and not c["passed"] for c in result["checks"]
    )
    s.close()


def test_external_xref_smoke_pass_when_no_new_log_rows(monkeypatch, tmp_path):
    s, db_path = _store_with(tmp_path)
    er_id = _seed_resource(s, external_id="P00875")
    _seed_xref(s, from_id=er_id, target_provider="pdb", target_external_id="1RBL")
    s.insert_external_fetch_log(
        provider="uniprot",
        endpoint="x",
        method="GET",
        capability_check={},
        cache_hit=False,
        external_resource_id=er_id,
    )

    monkeypatch.setattr(
        assays,
        "request_json",
        _mk_request_stub(
            {
                ("POST", "/external/fetch"): {
                    "status_code": 200,
                    "body": {"external_resource_id": er_id, "cache_hit": True},
                },
                ("GET", "/external/xrefs?provider=uniprot&external_id=P00875"): {
                    "status_code": 200,
                    "body": {
                        "resource_id": er_id,
                        "xrefs": [{"xref_type": "has_structure"}],
                        "total": 1,
                    },
                },
            }
        ),
    )

    result = assays.external_xref_smoke(
        sidecar_url="http://127.0.0.1:65535",
        db_path=db_path,
        session_token="test-session",
    )
    assert result["name"] == "external_xref_smoke"
    assert result["outcome"] == "passed", result["checks"]
    s.close()


def test_external_xref_smoke_fails_when_not_cached(monkeypatch, tmp_path):
    """ contract update: /external/xrefs returns 404 when not cached."""
    s, db_path = _store_with(tmp_path)

    monkeypatch.setattr(
        assays,
        "request_json",
        _mk_request_stub(
            {
                ("POST", "/external/fetch"): {
                    "status_code": 200,
                    "body": {"external_resource_id": "x", "cache_hit": False},
                },
                ("GET", "/external/xrefs?provider=uniprot&external_id=P00875"): {
                    "status_code": 404,
                    "body": {
                        "detail": "no resource for provider='uniprot' external_id='P00875'"
                    },
                },
            }
        ),
    )
    result = assays.external_xref_smoke(
        sidecar_url="http://127.0.0.1:65535",
        db_path=db_path,
        session_token="test-session",
    )
    assert result["outcome"] == "failed"
    assert any(c["name"] == "http_200" and not c["passed"] for c in result["checks"])
    s.close()


def test_cache_invalidation_smoke_pass_when_sidecar_writes_log_rows(
    monkeypatch, tmp_path
):
    """The assay's delta-count check (`fetch_log_grew_by_two`) requires the
    sidecar to actually write log rows on each fetch. Drive the mock to
    side-effect the DB the way a real sidecar would so the pass case is
    reachable in unit tests."""
    s, db_path = _store_with(tmp_path)
    er_id = _seed_resource(s, external_id="P0A6F5")

    call_count = {"n": 0}

    def stub(url: str, *, method: str, payload: Any = None, headers: Any = None):
        call_count["n"] += 1
        is_first = call_count["n"] == 1
        s.insert_external_fetch_log(
            provider="uniprot",
            endpoint="https://rest.uniprot.org/uniprotkb/P0A6F5.json",
            method="GET",
            capability_check={"granted": ["external-fetch:annotation"]},
            cache_hit=not is_first,
            external_resource_id=er_id,
        )
        return {
            "status_code": 200,
            "body": {
                "external_resource_id": er_id,
                "cache_hit": not is_first,
                "license": "CC-BY-4.0",
            },
        }

    monkeypatch.setattr(assays, "request_json", stub)
    result = assays.cache_invalidation_smoke(
        sidecar_url="http://127.0.0.1:65535",
        db_path=db_path,
        session_token="test-session",
    )
    assert result["name"] == "cache_invalidation_smoke"
    assert result["outcome"] == "passed", result["checks"]
    s.close()


def test_cache_invalidation_smoke_fails_when_log_count_does_not_grow(
    monkeypatch, tmp_path
):
    """Pin the inverse: when the mock sidecar doesn't write fetch_log rows,
    the assay correctly reports failure on `fetch_log_grew_by_two` rather
    than silently passing."""
    s, db_path = _store_with(tmp_path)

    monkeypatch.setattr(
        assays,
        "request_json",
        _mk_request_stub(
            {
                ("POST", "/external/fetch"): {
                    "status_code": 200,
                    "body": {"external_resource_id": "r1", "cache_hit": True},
                },
            }
        ),
    )
    result = assays.cache_invalidation_smoke(
        sidecar_url="http://127.0.0.1:65535",
        db_path=db_path,
        session_token="test-session",
    )
    assert result["outcome"] == "failed"
    assert any(
        c["name"] == "fetch_log_grew_by_two" and not c["passed"]
        for c in result["checks"]
    )
    s.close()


def test_dna98_resolver_chain_pass_with_pdb_and_afdb(monkeypatch, tmp_path):
    s, db_path = _store_with(tmp_path)

    monkeypatch.setattr(
        assays,
        "request_json",
        _mk_request_stub(
            {
                ("POST", "/external/fetch"): {
                    "status_code": 200,
                    "body": {"external_resource_id": "r1", "cache_hit": False},
                },
                (
                    "GET",
                    "/external/xrefs?provider=uniprot&external_id=P02786&target_provider=pdb",
                ): {
                    "status_code": 200,
                    "body": {
                        "xrefs": [
                            {"xref_type": "has_structure", "to_resource_id": "p1"}
                        ],
                    },
                },
                (
                    "GET",
                    "/external/xrefs?provider=uniprot&external_id=P02786&target_provider=alphafold",
                ): {
                    "status_code": 200,
                    "body": {
                        "xrefs": [
                            {"xref_type": "has_structure", "to_resource_id": "a1"}
                        ],
                    },
                },
            }
        ),
    )
    result = assays.dna98_resolver_chain_via_sidecar_smoke(
        sidecar_url="http://127.0.0.1:65535",
        db_path=db_path,
        session_token="test-session",
    )
    assert result["outcome"] == "passed", result["checks"]
    s.close()


def test_dna98_resolver_chain_fails_when_pdb_missing(monkeypatch, tmp_path):
    s, db_path = _store_with(tmp_path)
    monkeypatch.setattr(
        assays,
        "request_json",
        _mk_request_stub(
            {
                ("POST", "/external/fetch"): {
                    "status_code": 200,
                    "body": {"external_resource_id": "r1"},
                },
                (
                    "GET",
                    "/external/xrefs?provider=uniprot&external_id=P02786&target_provider=pdb",
                ): {
                    "status_code": 200,
                    "body": {"xrefs": []},
                },
                (
                    "GET",
                    "/external/xrefs?provider=uniprot&external_id=P02786&target_provider=alphafold",
                ): {
                    "status_code": 200,
                    "body": {"xrefs": [{"xref_type": "has_structure"}]},
                },
            }
        ),
    )
    result = assays.dna98_resolver_chain_via_sidecar_smoke(
        sidecar_url="http://127.0.0.1:65535",
        db_path=db_path,
        session_token="test-session",
    )
    assert result["outcome"] == "failed"
    assert any(
        c["name"] == "pdb_xref_present" and not c["passed"] for c in result["checks"]
    )
    s.close()


def test_run_external_resources_assays_returns_four(monkeypatch, tmp_path):
    s, db_path = _store_with(tmp_path)

    def stub(url: str, *, method: str, payload: Any = None, headers: Any = None):
        return {
            "status_code": 200,
            "body": {
                "external_resource_id": "r1",
                "cache_hit": True,
                "license": "CC-BY-4.0",
                "resource_id": "r1",
                "xrefs": [{"xref_type": "has_structure"}],
                "total": 1,
            },
        }

    monkeypatch.setattr(assays, "request_json", stub)

    results = assays.run_external_resources_assays(
        sidecar_url="http://127.0.0.1:65535",
        db_path=db_path,
        session_token="test-session",
    )
    assert len(results) == 4
    names = {r["name"] for r in results}
    assert names == {
        "external_fetch_smoke",
        "external_xref_smoke",
        "cache_invalidation_smoke",
        "dna98_resolver_chain_via_sidecar_smoke",
    }
    s.close()


def test_every_fetch_requests_annotation_and_xref_scopes(monkeypatch, tmp_path):
    """The assays observe persisted cross-references, and the sidecar only
    persists them when the request carries `external-fetch:xref-resolution`.
    Requesting annotation alone still answers HTTP 200, so a missing scope
    reads as UniProt drift instead of a harness bug."""
    s, db_path = _store_with(tmp_path)
    requested: list[list[str]] = []

    def stub(url: str, *, method: str, payload: Any = None, headers: Any = None):
        if isinstance(payload, dict) and "granted_capabilities" in payload:
            requested.append(payload["granted_capabilities"])
        return {
            "status_code": 200,
            "body": {
                "external_resource_id": "r1",
                "cache_hit": True,
                "license": "CC-BY-4.0",
                "resource_id": "r1",
                "xrefs": [{"xref_type": "has_structure"}],
                "total": 1,
            },
        }

    monkeypatch.setattr(assays, "request_json", stub)
    assays.run_external_resources_assays(
        sidecar_url="http://127.0.0.1:65535",
        db_path=db_path,
        session_token="test-session",
    )

    assert requested, "no /external/fetch call carried granted_capabilities"
    for granted in requested:
        assert set(granted) == {
            Capability.EXTERNAL_FETCH_ANNOTATION.value,
            Capability.EXTERNAL_FETCH_XREF.value,
        }
    s.close()
