""" — compute endpoints contract .

Pins the operation vocabulary to the TS manifest schema, the capability split
between discovery and submit, credential redaction, the job FSM vocabulary, and
the typed error kinds. No binding exists yet (slice 2); a minimal in-test fake
proves the Protocol is implementable and runtime-checkable.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from src.compute.contract import (
    MANAGE_OPERATIONS,
    READ_ONLY_OPERATIONS,
    TERMINAL_STATES,
    BadCredentialError,
    BudgetExhaustedError,
    ComputeOperation,
    ComputeProviderError,
    ComputeRateLimitError,
    CostEstimate,
    CredentialScheme,
    InvalidJobSettingsError,
    JobState,
    JobStatus,
    MappedToolMissingError,
    OutputKind,
    ProviderBinding,
    ProviderCredential,
    ProviderJobRef,
    ProviderUnavailableError,
    ResultBundle,
    ResultFile,
    SubmitRequest,
    ToolDescriptor,
    UnknownJobError,
    ValidationResult,
    capability_for,
)
from src.concurrency.schema import ToolEffect
from src.external.contract import Capability

REPO_ROOT = Path(__file__).resolve().parents[3]
MANIFEST_TS = (
    REPO_ROOT / "packages" / "core" / "compute-endpoints" / "src" / "manifest.ts"
)
MANIFEST_DIR = REPO_ROOT / "packages" / "core" / "compute-endpoints" / "manifests"


def _ts_operations() -> list[str]:
    text = MANIFEST_TS.read_text()
    block = re.search(r"COMPUTE_OPERATIONS = \[(.*?)\] as const", text, re.S)
    assert block, "COMPUTE_OPERATIONS not found in manifest.ts"
    return re.findall(r"'([a-z_]+)'", block.group(1))


def test_operation_vocabulary_matches_ts_manifest_schema():
    assert [op.value for op in ComputeOperation] == _ts_operations()


def test_operation_vocabulary_is_exactly_eight():
    assert len(ComputeOperation) == 8


def test_every_operation_is_scoped_by_what_it_does_not_what_it_costs():
    """Three classes, no overlap and nothing left over: read, manage, spend.

    Cancel spends nothing, so it is not submit; it destroys work in flight, so it
    is not discovery. Same shape later for deleting a remote job or stopping a
    batch, which is why this is a class and not a special case.
    """
    assert READ_ONLY_OPERATIONS | MANAGE_OPERATIONS | {
        ComputeOperation.SUBMIT
    } == frozenset(ComputeOperation)
    assert not READ_ONLY_OPERATIONS & MANAGE_OPERATIONS
    assert ComputeOperation.SUBMIT not in READ_ONLY_OPERATIONS | MANAGE_OPERATIONS

    assert (
        capability_for(ComputeOperation.SUBMIT)
        == Capability.EXTERNAL_COMPUTE_SUBMIT.value
    )
    for op in MANAGE_OPERATIONS:
        assert capability_for(op) == Capability.EXTERNAL_COMPUTE_MANAGE.value
    for op in READ_ONLY_OPERATIONS:
        assert capability_for(op) == Capability.EXTERNAL_COMPUTE_DISCOVER.value


def test_new_capabilities_exist_in_the_closed_enum():
    assert (
        Capability("external-compute:discover") is Capability.EXTERNAL_COMPUTE_DISCOVER
    )
    assert Capability("external-compute:submit") is Capability.EXTERNAL_COMPUTE_SUBMIT
    assert Capability("external-compute:manage") is Capability.EXTERNAL_COMPUTE_MANAGE


def test_external_submit_effect_exists_in_tool_effect_enum():
    assert ToolEffect("external-submit") is ToolEffect.EXTERNAL_SUBMIT


def test_bundled_manifest_toolmaps_use_the_operation_vocabulary():
    ops = {op.value for op in ComputeOperation}
    seen_mcp = False
    for path in sorted(MANIFEST_DIR.glob("*.json")):
        manifest = json.loads(path.read_text())
        if manifest["transport"] != "mcp":
            continue
        seen_mcp = True
        assert set(manifest["toolMap"]) <= ops, path.name
        for required in (
            "list_tools",
            "get_schema",
            "submit",
            "status",
            "fetch_result",
        ):
            assert (
                required in manifest["toolMap"]
            ), f"{path.name} lacks toolMap.{required}"
    assert seen_mcp, "expected at least one MCP manifest (tamarind)"


def test_bundled_manifest_ids_are_distinct_and_well_formed():
    ids = [json.loads(p.read_text())["id"] for p in MANIFEST_DIR.glob("*.json")]
    assert len(ids) == len(set(ids))
    assert set(ids) == {"boltz", "nvidia-nim", "replicate", "subseq", "tamarind"}
    for provider_id in ids:
        assert re.fullmatch(r"[a-z][a-z0-9_-]{1,63}", provider_id), provider_id


def test_credential_repr_and_str_redact_the_secret():
    cred = ProviderCredential(
        provider_id="tamarind",
        scheme=CredentialScheme.HEADER,
        secret="tmr_live_SUPERSECRET",
        header_name="x-api-key",
    )
    assert "SUPERSECRET" not in repr(cred)
    assert "SUPERSECRET" not in str(cred)
    assert "SUPERSECRET" not in f"{cred}"
    assert "<redacted>" in repr(cred)


def test_credential_as_headers_is_the_only_secret_egress():
    header = ProviderCredential(
        "tamarind", CredentialScheme.HEADER, "k1", header_name="x-api-key"
    )
    assert header.as_headers() == {"x-api-key": "k1"}
    bearer = ProviderCredential("subseq", CredentialScheme.BEARER, "k2")
    assert bearer.as_headers() == {"Authorization": "Bearer k2"}
    oauth = ProviderCredential("future", CredentialScheme.OAUTH, "tok")
    assert oauth.as_headers() == {"Authorization": "Bearer tok"}


@pytest.mark.parametrize("secret", ["", "   "])
def test_credential_rejects_empty_secret(secret: str):
    with pytest.raises(ValueError, match="non-empty"):
        ProviderCredential("tamarind", CredentialScheme.BEARER, secret)


def test_header_scheme_requires_header_name():
    with pytest.raises(ValueError, match="header_name"):
        ProviderCredential("tamarind", CredentialScheme.HEADER, "k")


def test_credential_is_frozen():
    cred = ProviderCredential("subseq", CredentialScheme.BEARER, "k")
    with pytest.raises((AttributeError, TypeError)):
        cred.secret = "other"  # type: ignore[misc]


def test_terminal_states_are_exactly_completed_failed_canceled():
    assert TERMINAL_STATES == {JobState.COMPLETED, JobState.FAILED, JobState.CANCELED}
    ref = ProviderJobRef("tamarind", "job-1", "alphafold")
    assert JobStatus(ref, JobState.RUNNING).is_terminal() is False
    assert JobStatus(ref, JobState.COMPLETED).is_terminal() is True


def test_result_file_needs_content_or_url():
    ResultFile("model.pdb", content=b"ATOM")
    ResultFile("model.pdb", url="https://example.com/x")
    with pytest.raises(ValueError, match="neither content nor url"):
        ResultFile("model.pdb")


def test_cost_estimate_unknown_is_explicit():
    assert CostEstimate(amount=None, unit="credits").is_known() is False
    assert CostEstimate(amount=0.4, unit="weighted_hours").is_known() is True


def test_output_kinds_match_manifest_vocabulary():
    text = MANIFEST_TS.read_text()
    block = re.search(r"outputKind: z\.enum\(\[(.*?)\]\)", text, re.S)
    assert block
    ts_kinds = set(re.findall(r"'([a-z-]+)'", block.group(1)))
    assert {k.value for k in OutputKind} == ts_kinds


@pytest.mark.parametrize(
    ("error", "kind"),
    [
        (BadCredentialError("x"), "bad_credential"),
        (BudgetExhaustedError("x"), "budget_exhausted"),
        (ComputeRateLimitError("x", retry_after_s=3.0), "rate_limited"),
        (ProviderUnavailableError("x"), "provider_unavailable"),
        (
            MappedToolMissingError(ComputeOperation.ESTIMATE, "estimateTime"),
            "mapped_tool_missing",
        ),
        (
            InvalidJobSettingsError("x", problems=("sequence: required",)),
            "invalid_settings",
        ),
        (UnknownJobError("x"), "unknown_job"),
    ],
)
def test_error_subclasses_carry_distinct_failure_kinds(
    error: ComputeProviderError, kind: str
):
    assert isinstance(error, ComputeProviderError)
    assert error.failure_kind == kind


def test_failure_kinds_are_unique_across_error_classes():
    kinds = [
        cls.failure_kind
        for cls in (
            ComputeProviderError,
            BadCredentialError,
            BudgetExhaustedError,
            ComputeRateLimitError,
            ProviderUnavailableError,
            MappedToolMissingError,
            InvalidJobSettingsError,
            UnknownJobError,
        )
    ]
    assert len(kinds) == len(set(kinds))


def test_mapped_tool_missing_names_operation_and_tool():
    err = MappedToolMissingError(ComputeOperation.ESTIMATE, "estimateTime")
    assert "estimateTime" in str(err) and "estimate" in str(err)
    assert err.operation is ComputeOperation.ESTIMATE


class _FakeBinding:
    provider_id = "fake"

    async def list_tools(self, credential, *, search=None, tags=()):
        return [ToolDescriptor("esmfold", "ESMFold", output_kind=OutputKind.STRUCTURE)]

    async def get_schema(self, credential, tool_id):
        return {"type": "object", "properties": {"sequence": {"type": "string"}}}

    async def validate(self, credential, tool_id, settings):
        return ValidationResult(
            ok="sequence" in settings,
            problems=() if "sequence" in settings else ("sequence: required",),
        )

    async def estimate(self, credential, tool_id, settings):
        return CostEstimate(amount=None, unit="credits")

    async def submit(self, credential, request: SubmitRequest):
        return ProviderJobRef(self.provider_id, "job-1", request.tool_id)

    async def status(self, credential, ref):
        return JobStatus(ref, JobState.COMPLETED, provider_state="Complete")

    async def fetch_result(self, credential, ref):
        return ResultBundle(
            ref, OutputKind.STRUCTURE, (ResultFile("m.pdb", content=b"ATOM"),)
        )

    async def cancel(self, credential, ref):
        return JobStatus(ref, JobState.CANCELED)


class _NotABinding:
    provider_id = "nope"

    async def list_tools(self, credential):
        return []


def test_fake_binding_satisfies_protocol_and_partial_does_not():
    assert isinstance(_FakeBinding(), ProviderBinding)
    assert not isinstance(_NotABinding(), ProviderBinding)


@pytest.mark.asyncio
async def test_fake_binding_round_trip():
    cred = ProviderCredential("fake", CredentialScheme.BEARER, "k")
    binding: ProviderBinding = _FakeBinding()
    tools = await binding.list_tools(cred)
    assert tools[0].id == "esmfold"
    bad = await binding.validate(cred, "esmfold", {})
    assert bad.ok is False and bad.problems == ("sequence: required",)
    ref = await binding.submit(cred, SubmitRequest("esmfold", {"sequence": "MKT"}))
    assert (await binding.status(cred, ref)).is_terminal()
    bundle = await binding.fetch_result(cred, ref)
    assert bundle.output_kind is OutputKind.STRUCTURE
    assert bundle.files[0].content == b"ATOM"
