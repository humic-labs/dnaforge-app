""" — generic MCP binding against an in-process Tamarind-shaped fake.

Exercises the real `mcp` client stack (streamable HTTP over an ASGI transport):
discovery, schema, validate, estimate, submit → status → result, cancel, the
auth header on the wire, bad-key → BadCredentialError, 429/500 classification,
catalog drift → MappedToolMissingError, and that our own bugs are never
disguised as provider failures.
"""

from __future__ import annotations

import logging
from pathlib import Path

import pytest

from src.compute.contract import (
    BadCredentialError,
    ComputeOperation,
    ComputeProviderError,
    ComputeRateLimitError,
    CredentialScheme,
    InvalidJobSettingsError,
    JobState,
    MappedToolMissingError,
    OutputKind,
    ProviderBinding,
    ProviderCredential,
    ProviderJobRef,
    ProviderUnavailableError,
    SubmitRequest,
    UnknownJobError,
)
from src.compute.manifests import load_manifests
from src.compute.mcp_binding import (
    McpProviderBinding,
    _default_http_client,
    _walk,
    classify_tool_error,
)

from .compute_fakes import (
    BAD_KEY,
    GOOD_KEY,
    RESULT_SIGNATURE,
    TAMARIND_LANE_AT_CAPACITY,
    FakeState,
    download_client_factory_for,
    fake_tamarind_transport,
    http_client_factory_for,
    live_metrics_bundle_zip,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
MANIFESTS = REPO_ROOT / "packages" / "core" / "compute-endpoints" / "manifests"


def _tamarind_manifest():
    return load_manifests(MANIFESTS)["tamarind"]


def _cred(secret: str = GOOD_KEY) -> ProviderCredential:
    return ProviderCredential(
        "tamarind", CredentialScheme.HEADER, secret, header_name="x-api-key"
    )


async def test_binding_satisfies_protocol():
    assert isinstance(McpProviderBinding(_tamarind_manifest()), ProviderBinding)


async def test_credentialed_mcp_client_never_follows_redirects():
    client = _default_http_client({"x-api-key": GOOD_KEY})
    try:
        assert client.follow_redirects is False
    finally:
        await client.aclose()


async def test_discovery_schema_validate_estimate_round_trip():
    state = FakeState()
    async with fake_tamarind_transport(state) as (transport, gate):
        binding = McpProviderBinding(
            _tamarind_manifest(), http_client_factory=http_client_factory_for(transport)
        )
        tools = await binding.list_tools(_cred(), search="fold")
        assert {t.id for t in tools} == {"alphafold", "esmfold"}
        assert tools[0].tags and "structure-prediction" in tools[0].tags

        designers = await binding.list_tools(_cred(), tags=("Sequence-Design",))
        assert [t.id for t in designers] == ["proteinmpnn"]

        schema = await binding.get_schema(_cred(), "alphafold")

        assert [p["name"] for p in schema["parameters"]] == ["sequence", "numModels"]
        assert schema["parameters"][0]["required"] is True
        assert schema["exampleJob"]["type"] == "alphafold"

        bad = await binding.validate(_cred(), "alphafold", {})
        assert bad.ok is False and bad.problems == ("sequence: required",)
        good = await binding.validate(_cred(), "alphafold", {"sequence": "M" * 120})
        assert good.ok is True

        est = await binding.estimate(_cred(), "alphafold", {"sequence": "M" * 120})
        assert (
            est.is_known()
            and est.unit == "weighted_hours"
            and est.estimated_seconds == 120.0
        )

        assert gate.seen_headers and all(
            h.get("x-api-key") == GOOD_KEY for h in gate.seen_headers
        )
        assert all("authorization" not in h for h in gate.seen_headers)


async def test_submit_status_result_cancel_lifecycle():
    state = FakeState()
    async with fake_tamarind_transport(state) as (transport, _gate):
        downloads: list = []
        binding = McpProviderBinding(
            _tamarind_manifest(),
            http_client_factory=http_client_factory_for(transport),
            download_client_factory=download_client_factory_for(downloads),
        )
        ref = await binding.submit(
            _cred(),
            SubmitRequest(
                "alphafold", {"sequence": "MKTAYIAKQR"}, label="dnaforge-test-1"
            ),
        )
        assert ref == ProviderJobRef("tamarind", "dnaforge-test-1", "alphafold")
        state.status_script["dnaforge-test-1"] = ["In Queue", "Running", "Complete"]

        s1 = await binding.status(_cred(), ref)
        assert (s1.state, s1.provider_state) == (JobState.QUEUED, "In Queue")
        s2 = await binding.status(_cred(), ref)
        assert s2.state is JobState.RUNNING
        s3 = await binding.status(_cred(), ref)
        assert s3.state is JobState.COMPLETED and s3.is_terminal()
        assert s3.cost is not None and s3.cost.unit == "weighted_hours"

        bundle = await binding.fetch_result(_cred(), ref)
        assert bundle.output_kind is OutputKind.STRUCTURE
        assert [f.name for f in bundle.files] == [
            "ranked_0.pdb",
            "model.pdb",
            "seed_2_model.pdb",
            "scores.json",
        ]
        assert all(f.content and f.url is None for f in bundle.files)
        assert bundle.files[0].content.startswith(b"ATOM")
        assert RESULT_SIGNATURE not in repr(bundle)
        assert len(downloads) == 1 and "x-api-key" not in downloads[0].headers
        assert bundle.provenance["remote_id"] == "dnaforge-test-1"

        assert bundle.metrics["plddt"] == 88.5 and bundle.metrics["ptm"] == 0.81

        canceled = await binding.cancel(_cred(), ref)
        assert canceled.state is JobState.CANCELED
        assert state.jobs["dnaforge-test-1"]["JobStatus"] == "Stopped"


async def test_validate_names_the_job_and_rejects_silent_rewrites():
    state = FakeState()
    async with fake_tamarind_transport(state) as (transport, _gate):
        binding = McpProviderBinding(
            _tamarind_manifest(), http_client_factory=http_client_factory_for(transport)
        )
        rewritten = await binding.validate(
            _cred(), "alphafold", {"sequence": "MKT AYI"}
        )
        assert rewritten.ok is False
        assert "changed these settings" in rewritten.problems[-1]
        name = next(
            args["jobName"] for tool, args in state.calls if tool == "validateJob"
        )
        assert name.startswith("dnaforge-validate-alphafold-")


async def test_expired_result_link_is_reported_without_the_link():
    state = FakeState()
    async with fake_tamarind_transport(state) as (transport, _gate):
        downloads: list = []
        binding = McpProviderBinding(
            _tamarind_manifest(),
            http_client_factory=http_client_factory_for(transport),
            download_client_factory=download_client_factory_for(downloads, status=403),
        )
        ref = await binding.submit(
            _cred(),
            SubmitRequest("alphafold", {"sequence": "MKT"}, label="job-expired"),
        )
        with pytest.raises(ProviderUnavailableError, match="expired") as info:
            await binding.fetch_result(_cred(), ref)
        assert RESULT_SIGNATURE not in str(info.value)


async def test_submit_without_label_gets_a_deterministic_prefix():
    state = FakeState()
    async with fake_tamarind_transport(state) as (transport, _gate):
        binding = McpProviderBinding(
            _tamarind_manifest(), http_client_factory=http_client_factory_for(transport)
        )
        ref = await binding.submit(
            _cred(), SubmitRequest("esmfold", {"sequence": "MKT"})
        )
        assert ref.remote_id.startswith("dnaforge-esmfold-")
        assert ref.remote_id in state.jobs


async def test_bad_key_is_bad_credential_not_provider_down():
    state = FakeState()
    async with fake_tamarind_transport(state) as (transport, _gate):
        binding = McpProviderBinding(
            _tamarind_manifest(), http_client_factory=http_client_factory_for(transport)
        )
        with pytest.raises(BadCredentialError) as info:
            await binding.list_tools(_cred(BAD_KEY))
        assert info.value.status_code == 401
        assert BAD_KEY not in str(info.value)


async def test_live_shaped_wrong_key_is_bad_credential_on_verify_and_discovery():
    """Live Tamarind (probed 2026-09-10) never answers a wrong key with HTTP 401:
    initialize succeeds and the refusal rides inside the JSON-RPC reply. Before
    this was modelled, a mistyped key told the user Tamarind was down."""
    state = FakeState(bad_key_style="jsonrpc")
    async with fake_tamarind_transport(state) as (transport, _gate):
        binding = McpProviderBinding(
            _tamarind_manifest(), http_client_factory=http_client_factory_for(transport)
        )
        with pytest.raises(BadCredentialError) as verify_info:
            await binding.verify_credential(_cred(BAD_KEY))
        assert BAD_KEY not in str(verify_info.value)
        with pytest.raises(BadCredentialError):
            await binding.list_tools(_cred(BAD_KEY))
        await binding.verify_credential(_cred())
        assert ("listModalities", {}) in state.calls


async def test_429_and_500_classify_distinctly():
    state = FakeState()
    async with fake_tamarind_transport(state) as (transport, _gate):
        binding = McpProviderBinding(
            _tamarind_manifest(), http_client_factory=http_client_factory_for(transport)
        )
        state.force_status = 429
        with pytest.raises(ComputeRateLimitError):
            await binding.list_tools(_cred())
        state.force_status = 503
        with pytest.raises(ProviderUnavailableError):
            await binding.list_tools(_cred())

        assert [t.id for t in await binding.list_tools(_cred(), search="esm")] == [
            "esmfold"
        ]


async def test_catalog_drift_is_loud():
    state = FakeState(hidden_tools={"estimateTime"})
    async with fake_tamarind_transport(state) as (transport, _gate):
        binding = McpProviderBinding(
            _tamarind_manifest(), http_client_factory=http_client_factory_for(transport)
        )
        with pytest.raises(MappedToolMissingError) as info:
            await binding.estimate(_cred(), "alphafold", {"sequence": "MKT"})
        assert info.value.operation is ComputeOperation.ESTIMATE
        assert info.value.remote_tool == "estimateTime"


async def test_tool_errors_map_to_typed_errors():
    state = FakeState()
    async with fake_tamarind_transport(state) as (transport, _gate):
        binding = McpProviderBinding(
            _tamarind_manifest(), http_client_factory=http_client_factory_for(transport)
        )
        with pytest.raises(InvalidJobSettingsError):
            await binding.submit(
                _cred(), SubmitRequest("alphafold", {}, label="no-seq")
            )
        with pytest.raises(UnknownJobError):
            await binding.status(
                _cred(), ProviderJobRef("tamarind", "never-submitted", "alphafold")
            )


async def test_unexpected_remote_tool_errors_withhold_internal_details():
    detail = "Invalid settings: internal-fixture-detail"
    state = FakeState(unexpected_tool_failure=detail)
    async with fake_tamarind_transport(state) as (transport, _gate):
        binding = McpProviderBinding(
            _tamarind_manifest(), http_client_factory=http_client_factory_for(transport)
        )
        with pytest.raises(ComputeProviderError) as info:
            await binding.submit(
                _cred(),
                SubmitRequest("alphafold", {"sequence": "MKT"}, label="masked-error"),
            )
        assert not isinstance(info.value, InvalidJobSettingsError)
        assert detail not in str(info.value)
        assert "Error executing tool submitJob" in str(info.value)


async def test_our_own_bugs_are_not_disguised_as_provider_failures(monkeypatch):
    state = FakeState()
    async with fake_tamarind_transport(state) as (transport, _gate):
        binding = McpProviderBinding(
            _tamarind_manifest(), http_client_factory=http_client_factory_for(transport)
        )

        def boom(*_a, **_k):
            raise ZeroDivisionError("bug in coercion")

        monkeypatch.setattr("src.compute.mcp_binding._coerce_tools", boom)
        with pytest.raises(ZeroDivisionError):
            await binding.list_tools(_cred())


async def test_secret_never_appears_in_logs(caplog):
    state = FakeState()
    caplog.set_level(logging.DEBUG)
    async with fake_tamarind_transport(state) as (transport, _gate):
        binding = McpProviderBinding(
            _tamarind_manifest(), http_client_factory=http_client_factory_for(transport)
        )
        await binding.list_tools(_cred())
        with pytest.raises(BadCredentialError):
            await binding.list_tools(_cred(BAD_KEY))
        state.force_status = 500
        with pytest.raises(ProviderUnavailableError):
            await binding.list_tools(_cred())
    text = caplog.text
    assert "GOODSECRET" not in text and BAD_KEY not in text


def test_walk_dotted_paths_and_indexes():
    doc = {
        "jobs": [{"JobStatus": "Running"}, {"JobStatus": "Complete"}],
        "a": {"b": {"c": 1}},
    }
    assert _walk(doc, "jobs[1].JobStatus") == "Complete"
    assert _walk(doc, "a.b.c") == 1
    assert _walk(doc, "a.x") is None
    assert _walk(doc, "jobs[5]") is None
    assert _walk(doc, "") is doc


@pytest.mark.parametrize(
    ("text", "kind"),
    [
        ("401 Unauthorized", "bad_credential"),
        ("Invalid API key", "bad_credential"),
        ("Organization budget exceeded", "budget_exhausted"),
        ("monthly_limit_exceeded: remaining 0", "budget_exhausted"),
        ("Monthly job limit exceeded", "budget_exhausted"),
        ("429 Too Many Requests", "rate_limited"),
        ("Job not found: x", "unknown_job"),
        ("Invalid settings: sequence is required", "invalid_settings"),
        ("something odd", "provider_error"),
    ],
)
def test_classify_tool_error(text: str, kind: str):
    assert classify_tool_error(text).failure_kind == kind


async def test_text_wrapped_payloads_and_server_side_tag_filter():
    """Live Tamarind serializes every reply into TEXT, omits descriptions and tags
    from the full listing, and matches its tag vocabulary exactly. Each of those
    silently produced an EMPTY catalog or an empty filter behind a verified key."""
    state = FakeState()
    async with fake_tamarind_transport(state) as (transport, _gate):
        binding = McpProviderBinding(
            _tamarind_manifest(), http_client_factory=http_client_factory_for(transport)
        )
        full = await binding.list_tools(_cred())
        assert {t.id for t in full} == {"alphafold", "esmfold", "proteinmpnn"}
        by_id = {t.id: t for t in full}

        assert all(not t.description for t in full)
        assert by_id["esmfold"].tags == ("protein", "peptide")
        assert "structure-prediction" not in by_id["esmfold"].tags
        assert by_id["esmfold"].display_name == "ESMFold"

        assert by_id["esmfold"].output_kind is not None
        assert by_id["esmfold"].output_kind.value == "structure"
        assert by_id["proteinmpnn"].output_kind.value == "sequence-set"

        designers = await binding.list_tools(_cred(), tags=("Sequence-Design",))
        assert [t.id for t in designers] == ["proteinmpnn"]
        sent = [args for name, args in state.calls if name == "getAvailableTools"]
        assert sent[0]["tag"] is None

        assert sent[1]["tag"] == "sequence-design"


def test_parsed_document_only_unwraps_json_documents():
    from src.compute.mcp_binding import _parsed_document

    assert _parsed_document('{"tools": []}') == {"tools": []}
    assert _parsed_document(" [1, 2] ") == [1, 2]
    assert _parsed_document("dnaforge-1 submitted to queue.") == (
        "dnaforge-1 submitted to queue."
    )

    assert _parsed_document("12345") == "12345"
    assert _parsed_document("{not json") == "{not json"
    assert _parsed_document({"tools": []}) == {"tools": []}


async def test_a_long_human_label_is_shortened_into_a_provider_safe_job_name():
    """Live Tamarind refused the agent's own label at 102 characters ("is too long")
    and only `submitJob` checks it, so validation cannot warn first. The provider
    must get a short, path-safe name that status and result still resolve."""
    from src.compute.mcp_binding import _remote_job_name

    state = FakeState()
    async with fake_tamarind_transport(state) as (transport, _gate):
        binding = McpProviderBinding(
            _tamarind_manifest(), http_client_factory=http_client_factory_for(transport)
        )
        human = f"3D structure prediction of {'M' * 90}"
        assert len(human) > 100
        ref = await binding.submit(
            _cred(), SubmitRequest("alphafold", {"sequence": "MKT"}, label=human)
        )
        assert len(ref.remote_id) <= 100 and " " not in ref.remote_id
        sent = [a for n, a in state.calls if n == "submitJob"]
        assert sent[0]["jobName"] == ref.remote_id

        state.status_script[ref.remote_id] = ["Complete"]
        status = await binding.status(_cred(), ref)
        assert status.state is JobState.COMPLETED

    req = SubmitRequest("alphafold", {"sequence": "MKT"})
    a = _remote_job_name("x" * 150, req)
    b = _remote_job_name("x" * 151, req)
    assert a != b and len(a) <= 100 and len(b) <= 100
    assert _remote_job_name("  ···  ", req).startswith("dnaforge-alphafold-")
    assert _remote_job_name("keep-this-short", req) == "keep-this-short"


async def test_a_fault_returned_as_a_successful_result_is_not_read_as_a_queued_job():
    """Tamarind answers an overloaded jobs list with HTTP 200 and an `error` body.
    Read as data it carries no status, so the job reported QUEUED and a poller
    waited forever. It must surface as the retryable provider fault it is."""
    from src.compute.mcp_binding import ProviderUnavailableError

    state = FakeState()
    state.getjobs_fault = TAMARIND_LANE_AT_CAPACITY
    async with fake_tamarind_transport(state) as (transport, _gate):
        binding = McpProviderBinding(
            _tamarind_manifest(), http_client_factory=http_client_factory_for(transport)
        )
        with pytest.raises(ProviderUnavailableError) as caught:
            await binding.status(
                _cred(), ProviderJobRef("tamarind", "dnaforge-1", "alphafold")
            )
        assert caught.value.status_code == 503
        assert "queue is full" in str(caught.value).lower()


async def test_result_numbers_come_from_the_bundle_when_the_reply_has_none():
    """Live Tamarind's getResult is a signed link and nothing else, so the pTM and
    pLDDT it had already computed sat unread inside metrics.csv while the job record
    reported no metrics at all."""
    state = FakeState()
    async with fake_tamarind_transport(state) as (transport, _gate):
        downloads: list = []
        binding = McpProviderBinding(
            _tamarind_manifest(),
            http_client_factory=http_client_factory_for(transport),
            download_client_factory=download_client_factory_for(
                downloads, body=live_metrics_bundle_zip()
            ),
        )
        ref = await binding.submit(
            _cred(),
            SubmitRequest("esmfold", {"sequence": "MKT"}, label="dnaforge-metrics-1"),
        )
        state.status_script["dnaforge-metrics-1"] = ["Complete"]
        await binding.status(_cred(), ref)
        bundle = await binding.fetch_result(_cred(), ref)

    assert bundle.metrics["ptm"] == 0.829
    assert bundle.metrics["plddt"] == 90.477

    assert "sequence" not in bundle.metrics
    assert bundle.metrics["pae_file"] == "ptm0.829_r3_default.pae.txt"
    assert bundle.metrics["num_recycles"] == 3
