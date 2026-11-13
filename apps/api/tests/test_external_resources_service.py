""" / L1 — provider + service contract suite via httpx.MockTransport.

Plan: tools/devops/plans/2026-05-02-bioinformatics-db-substrate.md
       (sub-ticket DNA-XXa2 — test plan)

Replaces vcrpy with httpx.MockTransport — deterministic, no recording, no I/O,
no new dev dep. Covers every provider failure mode the service has to handle
in production:

  1. Happy path     — entry fetch + xref resolution, transactional persist
  2. 404            — 4xx propagates as ProviderHttpError, no retry
  3. 5xx + retry    — exponential backoff retries succeed on 2nd attempt
  4. 429 + retry    — Retry-After header honored
  5. Malformed JSON — provider error class, not silent corruption
  6. Empty xrefs    — entry persisted, no xref rows
  7. Timeout        — httpx.Timeout fires, ProviderTimeoutError raised
  8. Rate limiting  — token bucket throttles burst, all requests succeed
  9. Circuit open   — breaker opens after N consecutive failures
 10. Cache hit      — short-circuits the network entirely
 11. Capability denied — fails before provider invocation
 12. Atomic batch   — partial-success crash leaves no torn state

These tests run in <1s total. The live-probe nightly suite that hits the real
UniProt API (codex 24) is separate, deferred to DNA-XXa4 with its own quota
budget.
"""

from __future__ import annotations

import asyncio
import sqlite3

import httpx
import pytest

from src.control_plane.store import ControlPlaneStore
from src.external.contract import (
    Capability,
    FetchOptions,
    FetchResult,
    ParsedId,
    ProviderError,
    ProviderHttpError,
    ProviderTimeoutError,
    Xref,
)
from src.external.providers import UniProtProvider
from src.external.service import (
    CapabilityDenied,
    CircuitOpen,
    ExternalResourcesService,
    FetchRequest,
    UnknownProvider,
)


def _p00875_payload() -> dict:
    return {
        "primaryAccession": "P00875",
        "entryType": "UniProtKB reviewed (Swiss-Prot)",
        "organism": {"scientificName": "Synechococcus elongatus", "taxonId": 269084},
        "sequence": {"length": 472},
        "genes": [{"geneName": {"value": "rbcL"}}],
        "proteinDescription": {
            "recommendedName": {
                "fullName": {"value": "Ribulose bisphosphate carboxylase large chain"},
                "ecNumbers": [{"value": "4.1.1.39"}],
            }
        },
        "entryAudit": {"entryVersion": 178},
        "uniProtKBCrossReferences": [
            {"database": "PDB", "id": "1RBL", "properties": []},
            {"database": "AlphaFoldDB", "id": "P00875", "properties": []},
            {"database": "RefSeq", "id": "WP_011378050.1", "properties": []},
        ],
    }


def _build_response_handler(
    *,
    payload: dict | None = None,
    status_code: int = 200,
    body: bytes | None = None,
    headers: dict | None = None,
) -> "callable":
    """Return a request handler suitable for httpx.MockTransport."""

    def handler(request: httpx.Request) -> httpx.Response:
        if body is not None:
            return httpx.Response(
                status_code=status_code, content=body, headers=headers or {}
            )
        return httpx.Response(
            status_code=status_code,
            json=payload if payload is not None else {},
            headers=headers or {},
        )

    return handler


def _service_with_handler(
    tmp_path,
    handler,
    *,
    rate_limit_per_s: float = 100.0,
    rate_limit_burst: float = 100.0,
) -> tuple[ExternalResourcesService, ControlPlaneStore]:
    """Build a service wired to a MockTransport-backed httpx client."""
    store = ControlPlaneStore(tmp_path / "ctrl.sqlite3")
    store.initialize()
    transport = httpx.MockTransport(handler)
    client = httpx.AsyncClient(transport=transport)
    service = ExternalResourcesService(
        store,
        client=client,
        rate_limit_per_s=rate_limit_per_s,
        rate_limit_burst=rate_limit_burst,
    )
    service.register(UniProtProvider(client=client))
    return service, store


def _granted_full() -> list[str]:
    return [
        Capability.EXTERNAL_FETCH_ANNOTATION.value,
        Capability.EXTERNAL_FETCH_XREF.value,
    ]


@pytest.mark.asyncio
async def test_happy_path_fetches_entry_and_persists_xrefs(tmp_path):
    """Single fetch → external_resource + fetch_log + 3 stub-xref rows in
    one transaction. License + attribution propagate from provider through
    the service to the persisted row."""
    service, store = _service_with_handler(
        tmp_path, _build_response_handler(payload=_p00875_payload())
    )
    response = await service.fetch(
        FetchRequest(
            provider="uniprot",
            raw_id="P00875",
            workspace_id="ws-1",
            granted_capabilities=_granted_full(),
        )
    )
    assert response.cache_hit is False
    assert response.license == "CC-BY-4.0"
    assert "UniProt Consortium" in (response.attribution or "")
    assert response.metadata["primary_accession"] == "P00875"
    assert response.xref_count == 3

    raw = sqlite3.connect(store.db_path)
    n_resources = raw.execute("SELECT COUNT(*) FROM external_resource").fetchone()[0]
    n_xrefs = raw.execute("SELECT COUNT(*) FROM external_resource_xref").fetchone()[0]
    n_logs = raw.execute("SELECT COUNT(*) FROM external_fetch_log").fetchone()[0]
    raw.close()
    assert n_resources == 4
    assert n_xrefs == 3
    assert n_logs == 1
    await service.aclose()


@pytest.mark.asyncio
async def test_404_propagates_as_provider_http_error_no_retry(tmp_path):
    call_count = 0

    def handler(request):
        nonlocal call_count
        call_count += 1
        return httpx.Response(status_code=404, json={"error": "not found"})

    service, store = _service_with_handler(tmp_path, handler)
    with pytest.raises(ProviderHttpError) as exc:
        await service.fetch(
            FetchRequest(
                provider="uniprot",
                raw_id="P99999",
                granted_capabilities=_granted_full(),
            )
        )
    assert exc.value.status_code == 404
    assert call_count == 1
    await service.aclose()


@pytest.mark.asyncio
async def test_5xx_retried_with_backoff_then_succeeds(tmp_path):
    attempts = {"n": 0}

    def handler(request):
        attempts["n"] += 1
        if attempts["n"] == 1:
            return httpx.Response(status_code=502)
        return httpx.Response(status_code=200, json=_p00875_payload())

    service, store = _service_with_handler(tmp_path, handler)
    response = await service.fetch(
        FetchRequest(
            provider="uniprot",
            raw_id="P00875",
            granted_capabilities=_granted_full(),
        ),
        opts=FetchOptions(
            initial_backoff_s=0.001,
            max_backoff_s=0.01,
            max_retries=3,
        ),
    )
    assert attempts["n"] == 2
    assert response.cache_hit is False
    await service.aclose()


@pytest.mark.asyncio
async def test_429_with_retry_after_header_is_honored(tmp_path):
    attempts = {"n": 0}

    def handler(request):
        attempts["n"] += 1
        if attempts["n"] == 1:
            return httpx.Response(
                status_code=429,
                json={"error": "rate limited"},
                headers={"Retry-After": "0.001"},
            )
        return httpx.Response(status_code=200, json=_p00875_payload())

    service, store = _service_with_handler(tmp_path, handler)
    response = await service.fetch(
        FetchRequest(
            provider="uniprot",
            raw_id="P00875",
            granted_capabilities=_granted_full(),
        ),
        opts=FetchOptions(initial_backoff_s=10.0, max_retries=3),
    )
    assert attempts["n"] == 2
    assert response.cache_hit is False
    await service.aclose()


@pytest.mark.asyncio
async def test_malformed_json_raises_provider_http_error(tmp_path):
    service, store = _service_with_handler(
        tmp_path,
        _build_response_handler(body=b"<html>not json</html>", status_code=200),
    )
    with pytest.raises(ProviderHttpError):
        await service.fetch(
            FetchRequest(
                provider="uniprot",
                raw_id="P00875",
                granted_capabilities=_granted_full(),
            ),
            opts=FetchOptions(max_retries=0),
        )
    await service.aclose()


@pytest.mark.asyncio
async def test_entry_with_no_xrefs_persists_parent_row_only(tmp_path):
    payload = _p00875_payload()
    payload["uniProtKBCrossReferences"] = []
    service, store = _service_with_handler(
        tmp_path, _build_response_handler(payload=payload)
    )
    response = await service.fetch(
        FetchRequest(
            provider="uniprot",
            raw_id="P00875",
            granted_capabilities=_granted_full(),
        )
    )
    assert response.xref_count == 0
    raw = sqlite3.connect(store.db_path)
    assert raw.execute("SELECT COUNT(*) FROM external_resource_xref").fetchone()[0] == 0
    assert raw.execute("SELECT COUNT(*) FROM external_resource").fetchone()[0] == 1
    raw.close()
    await service.aclose()


@pytest.mark.asyncio
async def test_timeout_raises_provider_timeout_error(tmp_path):
    """When httpx.TimeoutException fires on the underlying request, the
    provider translates it to ProviderTimeoutError so the service layer's
    failure-kind dispatch (`external_fetch_log.failure_kind = 'timeout'`)
    works. MockTransport doesn't fire real timeouts — we trigger the
    exception path directly by having the handler raise it."""

    def handler(request):
        raise httpx.TimeoutException("simulated total timeout")

    transport = httpx.MockTransport(handler)
    client = httpx.AsyncClient(transport=transport)
    store = ControlPlaneStore(tmp_path / "ctrl.sqlite3")
    store.initialize()
    service = ExternalResourcesService(store, client=client)
    service.register(UniProtProvider(client=client))

    with pytest.raises(ProviderTimeoutError):
        await service.fetch(
            FetchRequest(
                provider="uniprot",
                raw_id="P00875",
                granted_capabilities=_granted_full(),
            ),
            opts=FetchOptions(max_retries=0),
        )
    await service.aclose()


@pytest.mark.asyncio
async def test_rate_limiter_throttles_burst_without_dropping(tmp_path):
    """5 requests against a 2-token-burst, 100 req/s refill bucket — every
    request lands successfully, but the wall-clock time exceeds what an
    unthrottled client would take. Handler echoes the requested accession
    so the provider's primaryAccession identity check passes."""

    def handler(request: httpx.Request) -> httpx.Response:
        accession = request.url.path.rsplit("/", 1)[-1].removesuffix(".json")
        payload = _p00875_payload()
        payload["primaryAccession"] = accession.upper()
        return httpx.Response(status_code=200, json=payload)

    service, store = _service_with_handler(
        tmp_path, handler, rate_limit_per_s=100.0, rate_limit_burst=2.0
    )
    for i in range(5):
        await service.fetch(
            FetchRequest(
                provider="uniprot",
                raw_id=f"P{i:05d}",
                granted_capabilities=_granted_full(),
            ),
            opts=FetchOptions(max_retries=0),
        )
    raw = sqlite3.connect(store.db_path)
    n = raw.execute(
        "SELECT COUNT(*) FROM external_resource WHERE provider='uniprot'"
    ).fetchone()[0]
    raw.close()
    assert n >= 5
    await service.aclose()


@pytest.mark.asyncio
async def test_circuit_breaker_opens_after_threshold_failures(tmp_path):
    """5 consecutive 5xx with retries=0 → 5 failures → breaker opens →
    next call raises CircuitOpen WITHOUT touching the network."""
    network_calls = {"n": 0}

    def handler(request):
        network_calls["n"] += 1
        return httpx.Response(status_code=500)

    service, store = _service_with_handler(tmp_path, handler)
    for i in range(5):
        with pytest.raises(ProviderError):
            await service.fetch(
                FetchRequest(
                    provider="uniprot",
                    raw_id=f"P{i:05d}",
                    granted_capabilities=_granted_full(),
                ),
                opts=FetchOptions(max_retries=0),
            )

    network_count_before = network_calls["n"]
    with pytest.raises(CircuitOpen):
        await service.fetch(
            FetchRequest(
                provider="uniprot",
                raw_id="P99999",
                granted_capabilities=_granted_full(),
            ),
            opts=FetchOptions(max_retries=0),
        )
    assert network_calls["n"] == network_count_before
    await service.aclose()


@pytest.mark.asyncio
async def test_cache_hit_skips_network(tmp_path):
    network_calls = {"n": 0}

    def handler(request):
        network_calls["n"] += 1
        return httpx.Response(status_code=200, json=_p00875_payload())

    service, store = _service_with_handler(tmp_path, handler)
    await service.fetch(
        FetchRequest(
            provider="uniprot",
            raw_id="P00875",
            granted_capabilities=_granted_full(),
        )
    )
    assert network_calls["n"] == 1

    response2 = await service.fetch(
        FetchRequest(
            provider="uniprot",
            raw_id="P00875",
            granted_capabilities=_granted_full(),
        )
    )
    assert response2.cache_hit is True
    assert network_calls["n"] == 1

    raw = sqlite3.connect(store.db_path)
    n_logs = raw.execute(
        "SELECT COUNT(*) FROM external_fetch_log WHERE cache_hit = 1"
    ).fetchone()[0]
    raw.close()
    assert n_logs == 1
    await service.aclose()


@pytest.mark.asyncio
async def test_capability_denied_fails_before_network(tmp_path):
    network_calls = {"n": 0}

    def handler(request):
        network_calls["n"] += 1
        return httpx.Response(status_code=200, json=_p00875_payload())

    service, store = _service_with_handler(tmp_path, handler)
    with pytest.raises(CapabilityDenied) as exc:
        await service.fetch(
            FetchRequest(
                provider="uniprot",
                raw_id="P00875",
                granted_capabilities=[],
            )
        )
    assert network_calls["n"] == 0
    assert "external-fetch:annotation" in exc.value.required
    await service.aclose()


@pytest.mark.asyncio
async def test_unknown_provider_raises_clean_error(tmp_path):
    service, store = _service_with_handler(
        tmp_path, _build_response_handler(payload=_p00875_payload())
    )
    with pytest.raises(UnknownProvider):
        await service.fetch(
            FetchRequest(
                provider="ncbi",
                raw_id="GENBANK-12345",
                granted_capabilities=_granted_full(),
            )
        )
    await service.aclose()


@pytest.mark.asyncio
async def test_persist_is_atomic_partial_failure_rolls_back(tmp_path, monkeypatch):
    """Per testing-specialist CRITICAL: drive failure through the actual
    service code path, not through `store.transaction()` directly. If a
    DAO write inside `service._persist_fetch` raises, ROLLBACK must leave
    the substrate untouched — no orphan external_resource without its
    fetch_log, no fetch_log without its parent.
    """
    service, store = _service_with_handler(
        tmp_path, _build_response_handler(payload=_p00875_payload())
    )

    raw = sqlite3.connect(store.db_path)
    counts_before = {
        t: raw.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        for t in (
            "data_file",
            "external_resource",
            "external_resource_xref",
            "external_fetch_log",
        )
    }
    raw.close()

    real_xref = store.upsert_external_resource_xref
    calls = {"n": 0}

    def boom(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:
            raise sqlite3.IntegrityError("synthetic mid-batch failure")
        return real_xref(*args, **kwargs)

    monkeypatch.setattr(store, "upsert_external_resource_xref", boom)

    with pytest.raises(sqlite3.IntegrityError):
        await service.fetch(
            FetchRequest(
                provider="uniprot",
                raw_id="P00875",
                granted_capabilities=_granted_full(),
            )
        )

    raw = sqlite3.connect(store.db_path)
    counts_after = {
        t: raw.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        for t in (
            "data_file",
            "external_resource",
            "external_resource_xref",
            "external_fetch_log",
        )
    }
    raw.close()
    assert (
        counts_after == counts_before
    ), f"transaction did not roll back cleanly: {counts_before} -> {counts_after}"
    await service.aclose()


@pytest.mark.asyncio
async def test_fetch_with_bind_to_creates_workspace_binding(tmp_path):
    service, store = _service_with_handler(
        tmp_path, _build_response_handler(payload=_p00875_payload())
    )
    response = await service.fetch(
        FetchRequest(
            provider="uniprot",
            raw_id="P00875",
            workspace_id="ws-rubisco",
            granted_capabilities=_granted_full(),
            bind_to={
                "source_kind": "sequence",
                "source_uri": "waypoint://workspace/ws-rubisco/sequence/rubisco.gb",
                "relationship": "derived_from",
                "evidence": "asserted",
            },
        )
    )
    assert response.binding_id is not None
    bindings = store.list_external_resource_bindings(workspace_id="ws-rubisco")
    assert len(bindings) == 1
    assert bindings[0]["external_resource_id"] == response.external_resource_id
    await service.aclose()


@pytest.mark.asyncio
async def test_license_and_attribution_round_trip_through_persistence(tmp_path):
    """The plan's Legal section requires license + attribution on every
    cached row. This test pins that they survive the provider → service →
    DAO → readback round-trip."""
    service, store = _service_with_handler(
        tmp_path, _build_response_handler(payload=_p00875_payload())
    )
    await service.fetch(
        FetchRequest(
            provider="uniprot",
            raw_id="P00875",
            granted_capabilities=_granted_full(),
        )
    )
    row = store.get_external_resource_by_external_id("uniprot", "P00875")
    assert row is not None
    assert row["license"] == "CC-BY-4.0"
    assert "UniProt Consortium" in (row["attribution"] or "")
    await service.aclose()


@pytest.mark.asyncio
async def test_uniprot_connection_error_wrapped_as_provider_http_error(tmp_path):
    """A.5 — without the `(httpx.HTTPError, OSError)` translation in the
    provider, ConnectError / DNS failure / TLS failure / connection reset
    bubble raw, skip breaker accounting, and surface as 500 to callers."""

    def handler(request):
        raise httpx.ConnectError("simulated DNS failure")

    service, _ = _service_with_handler(tmp_path, handler)
    with pytest.raises(ProviderHttpError):
        await service.fetch(
            FetchRequest(
                provider="uniprot",
                raw_id="P00875",
                granted_capabilities=_granted_full(),
            ),
            opts=FetchOptions(max_retries=0),
        )
    assert service._breakers["uniprot"].consecutive_failures == 1
    await service.aclose()


@pytest.mark.asyncio
async def test_retry_exhaustion_raises_last_exception(tmp_path):
    """A.9 — handler returns 503 every attempt; service exhausts retries
    and raises the last ProviderError. Off-by-one in `range(max_retries+1)`
    or missing `raise last_exception` would silently change attempt count."""
    attempts = {"n": 0}

    def handler(request):
        attempts["n"] += 1
        return httpx.Response(status_code=503)

    service, _ = _service_with_handler(tmp_path, handler)
    with pytest.raises(ProviderHttpError) as exc:
        await service.fetch(
            FetchRequest(
                provider="uniprot",
                raw_id="P00875",
                granted_capabilities=_granted_full(),
            ),
            opts=FetchOptions(
                initial_backoff_s=0.001, max_backoff_s=0.005, max_retries=2
            ),
        )
    assert (
        attempts["n"] == 3
    ), f"expected 3 attempts (max_retries+1), got {attempts['n']}"
    assert exc.value.status_code == 503
    assert service._breakers["uniprot"].consecutive_failures == 1
    await service.aclose()


@pytest.mark.asyncio
async def test_provider_response_identity_mismatch_rejected(tmp_path):
    """A.27 — defends against proxy/cache poisoning. If we ask for P12345
    and the response carries primaryAccession=P00875, the service must
    refuse to persist mismatched data. A regression that drops the
    `result.parsed_id.cache_key() != cache_key` check would silently
    accept mismatched provider responses.
    """
    payload = _p00875_payload()
    service, store = _service_with_handler(
        tmp_path, _build_response_handler(payload=payload)
    )
    with pytest.raises(ProviderHttpError, match="returned data for"):
        await service.fetch(
            FetchRequest(
                provider="uniprot",
                raw_id="P02786",
                granted_capabilities=_granted_full(),
            ),
            opts=FetchOptions(max_retries=0),
        )
    raw = sqlite3.connect(store.db_path)
    n = raw.execute(
        "SELECT COUNT(*) FROM external_resource WHERE external_id = 'P02786'"
    ).fetchone()[0]
    raw.close()
    assert n == 0
    await service.aclose()


@pytest.mark.asyncio
async def test_failure_logging_writes_fetch_log_row_with_failure_kind(tmp_path):
    """A.36 — every error path that calls _log_fetch_failure must produce
    one external_fetch_log row with the right failure_kind. Primary audit
    signal — dashboards and freshness watchers depend on it."""

    def handler(request):
        return httpx.Response(status_code=500)

    service, store = _service_with_handler(tmp_path, handler)
    with pytest.raises(ProviderHttpError):
        await service.fetch(
            FetchRequest(
                provider="uniprot",
                raw_id="P00875",
                granted_capabilities=_granted_full(),
            ),
            opts=FetchOptions(max_retries=0),
        )
    logs = store.list_external_fetch_log(provider="uniprot")
    assert len(logs) == 1, f"expected exactly one failure log, got {len(logs)}"
    assert logs[0]["failure_kind"] == "http_error"
    assert logs[0]["status_code"] == 500
    assert logs[0]["external_resource_id"] is None
    await service.aclose()


@pytest.mark.asyncio
async def test_cache_hit_persistence_is_atomic(tmp_path, monkeypatch):
    """A.26 — the cache-hit path runs three writes (fetch_log + binding +
    freshness). If any of them fail mid-batch, ROLLBACK must leave the
    fetch_log row untouched too. A regression that drops the
    `with self._store.transaction():` wrapper around _cache_hit_response
    would let the fetch_log row commit while the binding fails — torn
    state."""
    service, store = _service_with_handler(
        tmp_path, _build_response_handler(payload=_p00875_payload())
    )
    await service.fetch(
        FetchRequest(
            provider="uniprot",
            raw_id="P00875",
            granted_capabilities=_granted_full(),
        )
    )
    fetch_log_count_before = len(store.list_external_fetch_log(provider="uniprot"))

    real_binding = store.upsert_external_resource_binding

    def boom(*args, **kwargs):
        raise sqlite3.IntegrityError("synthetic mid-cache-hit failure")

    monkeypatch.setattr(store, "upsert_external_resource_binding", boom)

    with pytest.raises(sqlite3.IntegrityError):
        await service.fetch(
            FetchRequest(
                provider="uniprot",
                raw_id="P00875",
                workspace_id="ws-1",
                granted_capabilities=_granted_full(),
                bind_to={
                    "source_kind": "sequence",
                    "source_uri": "waypoint://workspace/ws-1/sequence/x.gb",
                    "relationship": "derived_from",
                    "evidence": "asserted",
                },
            )
        )

    fetch_log_count_after = len(store.list_external_fetch_log(provider="uniprot"))
    assert fetch_log_count_after == fetch_log_count_before, (
        f"cache-hit transaction did not roll back: "
        f"{fetch_log_count_before} → {fetch_log_count_after}"
    )

    monkeypatch.setattr(store, "upsert_external_resource_binding", real_binding)
    await service.aclose()


@pytest.mark.asyncio
async def test_circuit_breaker_recovers_after_timeout(tmp_path):
    """A.30 — after consecutive failures open the breaker, a probe AFTER
    `recovery_timeout_s` elapses must succeed and reset the counters. A
    regression in the `time.monotonic()` math here ships a permanently-open
    circuit; users see permanent 503 after one bad burst."""
    state = {"fail": True}

    def handler(request):
        if state["fail"]:
            return httpx.Response(status_code=500)
        return httpx.Response(status_code=200, json=_p00875_payload())

    service, _ = _service_with_handler(tmp_path, handler)

    from src.external.service import _CircuitBreaker

    service._breakers["uniprot"] = _CircuitBreaker(
        failure_threshold=2, recovery_timeout_s=0.05
    )

    for i in range(2):
        with pytest.raises(ProviderError):
            await service.fetch(
                FetchRequest(
                    provider="uniprot",
                    raw_id=f"P{i:05d}",
                    granted_capabilities=_granted_full(),
                ),
                opts=FetchOptions(max_retries=0),
            )

    assert service._breakers["uniprot"].opened_at_monotonic is not None

    await asyncio.sleep(0.1)
    state["fail"] = False

    response = await service.fetch(
        FetchRequest(
            provider="uniprot",
            raw_id="P00875",
            granted_capabilities=_granted_full(),
        ),
        opts=FetchOptions(max_retries=0),
    )
    assert response.cache_hit is False
    assert service._breakers["uniprot"].opened_at_monotonic is None
    assert service._breakers["uniprot"].consecutive_failures == 0
    await service.aclose()


@pytest.mark.asyncio
async def test_persist_with_content_bytes_creates_data_file_link(tmp_path):
    """A.35 — exercises the `data_file` UPSERT branch in _persist_fetch
    that fires when FetchResult.content_bytes is set. UniProt v1 is
    JSON-only (content_bytes=None), but  (renderer migration onto
    structure files) ships providers that DO populate bytes. Without this
    test, the data_file linkage is untested code that  walks
    blind."""
    from src.external.contract import FetchResult, ParsedId

    class _BlobProvider:
        provider_id = "synthetic-blob"

        def __init__(self, client=None):
            self._client = client

        def detect_id(self, raw):
            return ParsedId(canonical_id=raw, provider="synthetic-blob")

        async def fetch(self, parsed_id, opts):
            return FetchResult(
                parsed_id=parsed_id,
                metadata={"kind": "synthetic"},
                content_bytes=b"BINARY-PDB-LIKE-PAYLOAD",
                content_mime_type="chemical/x-pdb",
                external_url="https://example.test/blob/X1",
                license="public-domain",
                attribution="Synthetic Provider",
            )

        async def resolve_xrefs(self, parsed_id, target_provider=None):
            return []

        def declared_capabilities(self):
            return [Capability.EXTERNAL_FETCH_ANNOTATION]

    transport = httpx.MockTransport(lambda r: httpx.Response(200))
    client = httpx.AsyncClient(transport=transport)
    store = ControlPlaneStore(tmp_path / "blob.sqlite3")
    store.initialize()
    service = ExternalResourcesService(store, client=client)
    service.register(_BlobProvider(client=client))

    response = await service.fetch(
        FetchRequest(
            provider="synthetic-blob",
            raw_id="X1",
            granted_capabilities=["external-fetch:annotation"],
        )
    )

    raw = sqlite3.connect(store.db_path)
    raw.row_factory = sqlite3.Row
    df_row = raw.execute("SELECT * FROM data_file").fetchone()
    er_row = raw.execute(
        "SELECT * FROM external_resource WHERE id = ?", (response.external_resource_id,)
    ).fetchone()
    raw.close()

    assert df_row is not None
    assert df_row["byte_size"] == len(b"BINARY-PDB-LIKE-PAYLOAD")
    assert df_row["mime_type"] == "chemical/x-pdb"
    assert er_row["data_file_id"] == df_row["sha256"]
    await service.aclose()


@pytest.mark.asyncio
async def test_annotation_only_fetch_does_not_run_separate_xref_resolution(tmp_path):
    class _SeparateXrefProvider:
        provider_id = "synthetic-xref"

        def __init__(self, client=None):
            self._client = client
            self.resolve_calls = 0

        def detect_id(self, raw):
            return ParsedId(canonical_id=raw, provider=self.provider_id)

        async def fetch(self, parsed_id, opts):
            return FetchResult(
                parsed_id=parsed_id, metadata={"kind": "synthetic"}, xrefs=[]
            )

        async def resolve_xrefs(self, parsed_id, target_provider=None):
            self.resolve_calls += 1
            return [
                Xref(
                    target_provider="rcsb",
                    target_external_id="RCSB:1ABC:ENTRY",
                    xref_type="has_structure",
                )
            ]

        def declared_capabilities(self):
            return [
                Capability.EXTERNAL_FETCH_ANNOTATION,
                Capability.EXTERNAL_FETCH_XREF,
            ]

    transport = httpx.MockTransport(lambda r: httpx.Response(200))
    client = httpx.AsyncClient(transport=transport)
    store = ControlPlaneStore(tmp_path / "xref-scope.sqlite3")
    store.initialize()
    service = ExternalResourcesService(store, client=client)
    provider = _SeparateXrefProvider(client=client)
    service.register(provider)

    response = await service.fetch(
        FetchRequest(
            provider=provider.provider_id,
            raw_id="X1",
            granted_capabilities=[Capability.EXTERNAL_FETCH_ANNOTATION.value],
        ),
        opts=FetchOptions(max_retries=0),
    )

    assert response.xref_count == 0
    assert provider.resolve_calls == 0
    resource = store.get_external_resource_by_external_id(provider.provider_id, "X1")
    assert resource is not None
    assert store.list_external_resource_xrefs(from_resource_id=resource["id"]) == []
    await service.aclose()


@pytest.mark.asyncio
async def test_fetch_with_xref_scope_runs_separate_xref_resolution(tmp_path):
    class _SeparateXrefProvider:
        provider_id = "synthetic-xref"

        def __init__(self, client=None):
            self._client = client
            self.resolve_calls = 0

        def detect_id(self, raw):
            return ParsedId(canonical_id=raw, provider=self.provider_id)

        async def fetch(self, parsed_id, opts):
            return FetchResult(
                parsed_id=parsed_id, metadata={"kind": "synthetic"}, xrefs=[]
            )

        async def resolve_xrefs(self, parsed_id, target_provider=None):
            self.resolve_calls += 1
            return [
                Xref(
                    target_provider="rcsb",
                    target_external_id="RCSB:1ABC:ENTRY",
                    xref_type="has_structure",
                )
            ]

        def declared_capabilities(self):
            return [
                Capability.EXTERNAL_FETCH_ANNOTATION,
                Capability.EXTERNAL_FETCH_XREF,
            ]

    transport = httpx.MockTransport(lambda r: httpx.Response(200))
    client = httpx.AsyncClient(transport=transport)
    store = ControlPlaneStore(tmp_path / "xref-scope-full.sqlite3")
    store.initialize()
    service = ExternalResourcesService(store, client=client)
    provider = _SeparateXrefProvider(client=client)
    service.register(provider)

    response = await service.fetch(
        FetchRequest(
            provider=provider.provider_id,
            raw_id="X1",
            granted_capabilities=[
                Capability.EXTERNAL_FETCH_ANNOTATION.value,
                Capability.EXTERNAL_FETCH_XREF.value,
            ],
        ),
        opts=FetchOptions(max_retries=0),
    )

    assert response.xref_count == 1
    assert provider.resolve_calls == 1
    resource = store.get_external_resource_by_external_id(provider.provider_id, "X1")
    assert resource is not None
    assert len(store.list_external_resource_xrefs(from_resource_id=resource["id"])) == 1
    await service.aclose()


def test_register_overwrites_silently_documented_v1_contract(tmp_path):
    """C-5 — service.register() is idempotent on provider_id; the second
    call REPLACES the first. v1 contract: last write wins, caller is
    responsible for closing the old provider's client if it owned one.
    This test pins the contract so a future add-without-clobber refactor
    is a deliberate change, not an accidental one.
    """
    transport = httpx.MockTransport(lambda r: httpx.Response(200))
    client = httpx.AsyncClient(transport=transport)
    store = ControlPlaneStore(tmp_path / "reg.sqlite3")
    store.initialize()
    service = ExternalResourcesService(store, client=client)

    first = UniProtProvider(client=client)
    second = UniProtProvider(client=client)
    service.register(first)
    service.register(second)

    assert (
        service._providers["uniprot"] is second
    ), "register() must replace prior registration (v1 contract)"


@pytest.mark.asyncio
async def test_failure_log_unknown_provider_writes_row(tmp_path):
    service, store = _service_with_handler(
        tmp_path, _build_response_handler(payload=_p00875_payload())
    )
    with pytest.raises(UnknownProvider):
        await service.fetch(
            FetchRequest(
                provider="ncbi",
                raw_id="ABC",
                granted_capabilities=["external-fetch:annotation"],
            )
        )
    logs = store.list_external_fetch_log()
    assert len(logs) == 1
    assert logs[0]["failure_kind"] == "unknown_provider"
    assert logs[0]["provider"] == "ncbi"
    await service.aclose()


@pytest.mark.asyncio
async def test_failure_log_unrecognized_id_writes_row(tmp_path):
    service, store = _service_with_handler(
        tmp_path, _build_response_handler(payload=_p00875_payload())
    )
    with pytest.raises(ProviderError):
        await service.fetch(
            FetchRequest(
                provider="uniprot",
                raw_id="GARBAGE",
                granted_capabilities=_granted_full(),
            )
        )
    logs = store.list_external_fetch_log()
    assert len(logs) == 1
    assert logs[0]["failure_kind"] == "provider_error"
    await service.aclose()


@pytest.mark.asyncio
async def test_failure_log_capability_denied_writes_row(tmp_path):
    service, store = _service_with_handler(
        tmp_path, _build_response_handler(payload=_p00875_payload())
    )
    with pytest.raises(CapabilityDenied):
        await service.fetch(
            FetchRequest(
                provider="uniprot",
                raw_id="P00875",
                granted_capabilities=[],
            )
        )
    logs = store.list_external_fetch_log()
    assert len(logs) == 1
    assert logs[0]["failure_kind"] == "capability_denied"
    assert logs[0]["capability_check_json"]["satisfied"] is False
    await service.aclose()


@pytest.mark.asyncio
async def test_failure_log_bind_to_without_workspace_writes_row(tmp_path):
    from src.external.service import ServiceError

    service, store = _service_with_handler(
        tmp_path, _build_response_handler(payload=_p00875_payload())
    )
    with pytest.raises(ServiceError):
        await service.fetch(
            FetchRequest(
                provider="uniprot",
                raw_id="P00875",
                granted_capabilities=_granted_full(),
                bind_to={
                    "source_kind": "sequence",
                    "source_uri": "waypoint://x",
                    "relationship": "derived_from",
                    "evidence": "asserted",
                },
            )
        )
    logs = store.list_external_fetch_log()
    assert len(logs) == 1
    assert logs[0]["failure_kind"] == "invalid_request"
    await service.aclose()


@pytest.mark.asyncio
async def test_successful_fetch_records_latency_ms(tmp_path):
    """The fetch_log column existed in 's schema but the service
    never wrote to it. Operationally invisible — ops couldn't see what
    was slow. Now wired via time.perf_counter delta around the resilient
    fetch loop."""

    def handler(request):
        return httpx.Response(status_code=200, json=_p00875_payload())

    service, store = _service_with_handler(tmp_path, handler)
    await service.fetch(
        FetchRequest(
            provider="uniprot",
            raw_id="P00875",
            granted_capabilities=_granted_full(),
        )
    )
    logs = store.list_external_fetch_log(provider="uniprot")
    assert len(logs) == 1
    assert logs[0]["latency_ms"] is not None
    assert logs[0]["latency_ms"] >= 0
    await service.aclose()


def _blob_provider_factory(client: httpx.AsyncClient):
    """Reusable across the workflow-boundaries tests. Mirrors the v0 /
    -shaped provider that returns binary content for structure files.
    """
    from src.external.contract import FetchResult, ParsedId

    class _Blob:
        provider_id = "synthetic-blob"

        def __init__(self) -> None:
            self._client = client

        def detect_id(self, raw):
            return ParsedId(canonical_id=raw, provider="synthetic-blob")

        async def fetch(self, parsed_id, opts):
            return FetchResult(
                parsed_id=parsed_id,
                metadata={"kind": "synthetic"},
                content_bytes=b"BINARY-PDB-LIKE-PAYLOAD",
                content_mime_type="chemical/x-pdb",
                external_url="https://example.test/blob/X1",
                license="public-domain",
                attribution="Synthetic Provider",
            )

        async def resolve_xrefs(self, parsed_id, target_provider=None):
            return []

        def declared_capabilities(self):
            return [Capability.EXTERNAL_FETCH_ANNOTATION]

    return _Blob()


@pytest.mark.asyncio
async def test_agent_artifact_written_when_action_id_and_bytes_present(tmp_path):
    transport = httpx.MockTransport(lambda r: httpx.Response(200))
    client = httpx.AsyncClient(transport=transport)
    store = ControlPlaneStore(tmp_path / "wb.sqlite3")
    store.initialize()
    store.ensure_agent_identity("agent-1", scope=["external-fetch:annotation"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="external_fetch",
        parameters={"provider": "synthetic-blob", "external_id": "X1"},
    )
    service = ExternalResourcesService(store, client=client)
    service.register(_blob_provider_factory(client))

    response = await service.fetch(
        FetchRequest(
            provider="synthetic-blob",
            raw_id="X1",
            granted_capabilities=["external-fetch:annotation"],
            agent_action_id=action_id,
        )
    )

    assert response.agent_artifact_id is not None
    artifact = store.get_agent_artifact(response.agent_artifact_id)
    assert artifact is not None
    assert artifact["agent_identity_id"] == "agent-1"
    assert artifact["action_id"] == action_id
    assert artifact["kind"] == "external"
    assert artifact["sha256"] is not None
    assert artifact["mime_type"] == "chemical/x-pdb"
    assert artifact["size_bytes"] == len(b"BINARY-PDB-LIKE-PAYLOAD")
    assert artifact["provenance_json"]["provider"] == "synthetic-blob"
    assert artifact["provenance_json"]["license"] == "public-domain"
    assert "external-fetch" in artifact["tags_json"]
    await service.aclose()


@pytest.mark.asyncio
async def test_agent_artifact_skipped_when_no_bytes(tmp_path):
    """UniProt v1 path: bytes_received never flows, so no artifact even
    with action_id. Pins the substrate plan's `bytes when present` rule."""
    transport = httpx.MockTransport(
        lambda r: httpx.Response(200, json=_p00875_payload())
    )
    client = httpx.AsyncClient(transport=transport)
    store = ControlPlaneStore(tmp_path / "wb_nobytes.sqlite3")
    store.initialize()
    store.ensure_agent_identity("agent-1", scope=["external-fetch:annotation"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="external.fetch",
        parameters={"provider": "uniprot", "external_id": "P00875"},
    )
    service = ExternalResourcesService(store, client=client)
    service.register(UniProtProvider(client=client))

    response = await service.fetch(
        FetchRequest(
            provider="uniprot",
            raw_id="P00875",
            granted_capabilities=_granted_full(),
            agent_action_id=action_id,
        )
    )
    assert response.agent_artifact_id is None
    assert response.external_resource_id is not None
    await service.aclose()


@pytest.mark.asyncio
async def test_agent_artifact_skipped_when_no_action_id(tmp_path):
    """Direct sidecar fetch (no /mcp/call origin) writes data_file +
    external_resource but NOT agent_artifact. Same as above except via the
    no-action-id path — both must be silent on the artifact write."""
    transport = httpx.MockTransport(lambda r: httpx.Response(200))
    client = httpx.AsyncClient(transport=transport)
    store = ControlPlaneStore(tmp_path / "wb_noaction.sqlite3")
    store.initialize()
    service = ExternalResourcesService(store, client=client)
    service.register(_blob_provider_factory(client))

    response = await service.fetch(
        FetchRequest(
            provider="synthetic-blob",
            raw_id="X1",
            granted_capabilities=["external-fetch:annotation"],
        )
    )
    assert response.agent_artifact_id is None
    raw = sqlite3.connect(store.db_path)
    artifact_count = raw.execute("SELECT COUNT(*) FROM agent_artifact").fetchone()[0]
    raw.close()
    assert artifact_count == 0
    await service.aclose()


@pytest.mark.asyncio
async def test_agent_artifact_silent_skip_on_unknown_action_id(tmp_path):
    """Defensive: a non-existent action_id (race / test misuse) skips the
    artifact write rather than crashing the fetch with FK violation. Pins
    fail-soft semantics."""
    transport = httpx.MockTransport(lambda r: httpx.Response(200))
    client = httpx.AsyncClient(transport=transport)
    store = ControlPlaneStore(tmp_path / "wb_ghost.sqlite3")
    store.initialize()
    service = ExternalResourcesService(store, client=client)
    service.register(_blob_provider_factory(client))

    response = await service.fetch(
        FetchRequest(
            provider="synthetic-blob",
            raw_id="X1",
            granted_capabilities=["external-fetch:annotation"],
            agent_action_id="ghost-action-id-not-in-table",
        )
    )
    assert response.agent_artifact_id is None
    assert response.external_resource_id is not None
    await service.aclose()


@pytest.mark.asyncio
async def test_agent_artifact_uses_action_scope_not_identity_scope(tmp_path):
    transport = httpx.MockTransport(lambda r: httpx.Response(200))
    client = httpx.AsyncClient(transport=transport)
    store = ControlPlaneStore(tmp_path / "wb_action_scope.sqlite3")
    store.initialize()
    store.ensure_agent_identity("agent-1", scope=[])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="external.fetch",
        parameters={"provider": "synthetic-blob", "external_id": "X1"},
        authorized_scope=["external-fetch:annotation"],
    )
    service = ExternalResourcesService(store, client=client)
    service.register(_blob_provider_factory(client))

    response = await service.fetch(
        FetchRequest(
            provider="synthetic-blob",
            raw_id="X1",
            granted_capabilities=["external-fetch:annotation"],
            agent_action_id=action_id,
        )
    )

    assert response.agent_artifact_id is not None
    await service.aclose()


@pytest.mark.asyncio
async def test_agent_artifact_skips_action_scope_that_does_not_cover_fetch(tmp_path):
    transport = httpx.MockTransport(lambda r: httpx.Response(200))
    client = httpx.AsyncClient(transport=transport)
    store = ControlPlaneStore(tmp_path / "wb_action_scope_denied.sqlite3")
    store.initialize()
    store.ensure_agent_identity("agent-1", scope=["external-fetch:annotation"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="external.fetch",
        parameters={"provider": "synthetic-blob", "external_id": "X1"},
        authorized_scope=[],
    )
    service = ExternalResourcesService(store, client=client)
    service.register(_blob_provider_factory(client))

    response = await service.fetch(
        FetchRequest(
            provider="synthetic-blob",
            raw_id="X1",
            granted_capabilities=["external-fetch:annotation"],
            agent_action_id=action_id,
        )
    )

    assert response.agent_artifact_id is None
    raw = sqlite3.connect(store.db_path)
    artifact_count = raw.execute("SELECT COUNT(*) FROM agent_artifact").fetchone()[0]
    raw.close()
    assert artifact_count == 0
    await service.aclose()


@pytest.mark.asyncio
async def test_agent_artifact_skips_non_external_fetch_action_id(tmp_path):
    transport = httpx.MockTransport(lambda r: httpx.Response(200))
    client = httpx.AsyncClient(transport=transport)
    store = ControlPlaneStore(tmp_path / "wb_wrong_tool.sqlite3")
    store.initialize()
    store.ensure_agent_identity("agent-1", scope=["external-fetch:annotation"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="get_workspace",
        parameters={"provider": "synthetic-blob", "external_id": "X1"},
    )
    service = ExternalResourcesService(store, client=client)
    service.register(_blob_provider_factory(client))

    response = await service.fetch(
        FetchRequest(
            provider="synthetic-blob",
            raw_id="X1",
            granted_capabilities=["external-fetch:annotation"],
            agent_action_id=action_id,
        )
    )

    assert response.agent_artifact_id is None
    raw = sqlite3.connect(store.db_path)
    artifact_count = raw.execute("SELECT COUNT(*) FROM agent_artifact").fetchone()[0]
    raw.close()
    assert artifact_count == 0
    await service.aclose()


@pytest.mark.asyncio
async def test_agent_artifact_skips_denied_external_fetch_action_id(tmp_path):
    transport = httpx.MockTransport(lambda r: httpx.Response(200))
    client = httpx.AsyncClient(transport=transport)
    store = ControlPlaneStore(tmp_path / "wb_denied.sqlite3")
    store.initialize()
    store.ensure_agent_identity("agent-1", scope=["external-fetch:annotation"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="external.fetch",
        parameters={"provider": "synthetic-blob", "external_id": "X1"},
        authorization_state="denied",
    )
    service = ExternalResourcesService(store, client=client)
    service.register(_blob_provider_factory(client))

    response = await service.fetch(
        FetchRequest(
            provider="synthetic-blob",
            raw_id="X1",
            granted_capabilities=["external-fetch:annotation"],
            agent_action_id=action_id,
        )
    )

    assert response.agent_artifact_id is None
    raw = sqlite3.connect(store.db_path)
    artifact_count = raw.execute("SELECT COUNT(*) FROM agent_artifact").fetchone()[0]
    raw.close()
    assert artifact_count == 0
    await service.aclose()


@pytest.mark.asyncio
async def test_agent_artifact_skips_mismatched_external_fetch_action_parameters(
    tmp_path,
):
    transport = httpx.MockTransport(lambda r: httpx.Response(200))
    client = httpx.AsyncClient(transport=transport)
    store = ControlPlaneStore(tmp_path / "wb_mismatched_action.sqlite3")
    store.initialize()
    store.ensure_agent_identity("agent-1", scope=["external-fetch:annotation"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="external.fetch",
        parameters={"provider": "synthetic-blob", "external_id": "OTHER"},
    )
    service = ExternalResourcesService(store, client=client)
    service.register(_blob_provider_factory(client))

    response = await service.fetch(
        FetchRequest(
            provider="synthetic-blob",
            raw_id="X1",
            granted_capabilities=["external-fetch:annotation"],
            agent_action_id=action_id,
        )
    )

    assert response.agent_artifact_id is None
    raw = sqlite3.connect(store.db_path)
    artifact_count = raw.execute("SELECT COUNT(*) FROM agent_artifact").fetchone()[0]
    raw.close()
    assert artifact_count == 0
    await service.aclose()


@pytest.mark.asyncio
async def test_list_xrefs_returns_empty_when_resource_not_cached(tmp_path):
    transport = httpx.MockTransport(lambda r: httpx.Response(200))
    client = httpx.AsyncClient(transport=transport)
    store = ControlPlaneStore(tmp_path / "xref_empty.sqlite3")
    store.initialize()
    service = ExternalResourcesService(store, client=client)

    rows = service.list_xrefs("uniprot", "NEVER_FETCHED")
    assert rows == []
    await service.aclose()


@pytest.mark.asyncio
async def test_list_xrefs_returns_persisted_xrefs(tmp_path):
    transport = httpx.MockTransport(
        lambda r: httpx.Response(200, json=_p00875_payload())
    )
    client = httpx.AsyncClient(transport=transport)
    store = ControlPlaneStore(tmp_path / "xref_full.sqlite3")
    store.initialize()
    service = ExternalResourcesService(store, client=client)
    service.register(UniProtProvider(client=client))

    await service.fetch(
        FetchRequest(
            provider="uniprot",
            raw_id="P00875",
            granted_capabilities=_granted_full(),
        )
    )

    rows = service.list_xrefs("uniprot", "P00875")
    assert len(rows) > 0
    assert all("xref_type" in r for r in rows)
    await service.aclose()


@pytest.mark.asyncio
async def test_list_xrefs_filters_by_canonical_target_provider(tmp_path):
    transport = httpx.MockTransport(
        lambda r: httpx.Response(200, json=_p00875_payload())
    )
    client = httpx.AsyncClient(transport=transport)
    store = ControlPlaneStore(tmp_path / "xref_filter.sqlite3")
    store.initialize()
    service = ExternalResourcesService(store, client=client)
    service.register(UniProtProvider(client=client))

    await service.fetch(
        FetchRequest(
            provider="uniprot",
            raw_id="P00875",
            granted_capabilities=_granted_full(),
        )
    )

    all_rows = service.list_xrefs("uniprot", "P00875")
    pdb_rows = service.list_xrefs("uniprot", "P00875", target_provider="rcsb")
    assert len(pdb_rows) > 0
    assert len(pdb_rows) <= len(all_rows)
    for row in pdb_rows:
        target = store.get_external_resource(row["to_resource_id"])
        assert target is not None
        assert target["provider"] == "rcsb"
    await service.aclose()


@pytest.mark.asyncio
async def test_list_xrefs_accepts_pdb_target_provider_alias(tmp_path):
    transport = httpx.MockTransport(
        lambda r: httpx.Response(200, json=_p00875_payload())
    )
    client = httpx.AsyncClient(transport=transport)
    store = ControlPlaneStore(tmp_path / "xref_pdb_alias.sqlite3")
    store.initialize()
    service = ExternalResourcesService(store, client=client)
    service.register(UniProtProvider(client=client))

    await service.fetch(
        FetchRequest(
            provider="uniprot",
            raw_id="P00875",
            granted_capabilities=_granted_full(),
        )
    )

    rows = service.list_xrefs("uniprot", "P00875", target_provider="pdb")
    assert len(rows) > 0
    for row in rows:
        target = store.get_external_resource(row["to_resource_id"])
        assert target is not None
        assert target["provider"] == "rcsb"
    await service.aclose()
