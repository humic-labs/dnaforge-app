"""Live contract suite: exercise the REAL provider API without dispatching a job.

Tamarind has no sandbox and no dry-run flag (`submitJob` takes only jobName,
projectTag, settings and type; the only "sandbox" language in its tool catalogue
is about an MCP client's own network egress). What it does have is three genuinely
free, authenticated paths, and that is enough to cover seven of the eight
operations against the live API:

* `validateJob` and `estimateTime` are free by design,
* every read (`getAvailableTools`, `getJobSchema`, `getJobs`, `getResult`) is free,
* and `submitJob` with deliberately invalid settings exercises the real submit
  path — auth, routing, job-name rules, settings validation — and is REFUSED, so
  no job is created and no compute is spent.

Only the submit happy path is out of scope here; that is what the gated live
journey in `e2e/electron/compute-endpoints.e2e.ts` covers, deliberately and rarely.

Run it:

    COMPUTE_LIVE_CONTRACT=1 PYTHONPATH=$PWD python -m pytest tests/test_compute_live_contract.py -q -s
"""

from __future__ import annotations

import os

import pytest

from src.compute.contract import (
    BadCredentialError,
    BudgetExhaustedError,
    CredentialScheme,
    InvalidJobSettingsError,
    ProviderCredential,
    ProviderJobRef,
    SubmitRequest,
    UnknownJobError,
)
from src.compute.manifests import load_manifests
from src.compute.mcp_binding import McpProviderBinding, _result_payload

pytestmark = [
    pytest.mark.skipif(
        os.environ.get("COMPUTE_LIVE_CONTRACT") != "1",
        reason="live contract suite: set COMPUTE_LIVE_CONTRACT=1 and a provider key",
    ),
    pytest.mark.skipif(
        not os.environ.get("TAMARIND_API_KEY"),
        reason="needs TAMARIND_API_KEY (no job is created)",
    ),
]

UBIQUITIN = (
    "MQIFVKTLTGKTITLEVEPSDTIENVKAKIQDKEGIPPDQQRLIFAGKQLEDGRTLSDYNIQKESTLHLVLRLRGG"
)


def _binding() -> McpProviderBinding:
    return McpProviderBinding(load_manifests()["tamarind"])


def _cred() -> ProviderCredential:
    return ProviderCredential(
        "tamarind",
        CredentialScheme.HEADER,
        os.environ["TAMARIND_API_KEY"],
        header_name="x-api-key",
    )


async def test_verify_proves_the_key_and_a_wrong_key_is_refused_as_a_wrong_key():
    binding = _binding()
    await binding.verify_credential(_cred())

    key = os.environ["TAMARIND_API_KEY"]
    wrong = ProviderCredential(
        "tamarind",
        CredentialScheme.HEADER,
        f"{key[:-4]}{'YYYY' if key.endswith('XXXX') else 'XXXX'}",
        header_name="x-api-key",
    )
    with pytest.raises(BadCredentialError):
        await binding.verify_credential(wrong)


async def test_discovery_returns_a_real_catalog_a_schema_and_a_filtered_view():
    """D9/D10 live: the catalog must not be empty behind a key that verifies, and
    a capability filter must be answered by the provider, not by us."""
    binding = _binding()
    everything = await binding.list_tools(_cred())
    assert len(everything) > 100, len(everything)

    folders = await binding.list_tools(_cred(), search="esmfold")
    assert "esmfold" in {t.id for t in folders}

    tagged = await binding.list_tools(_cred(), tags=("structure-prediction",))
    assert tagged, "a known-good provider tag returned nothing"
    assert all(
        t.description for t in tagged
    ), "a filtered listing must carry descriptions"

    schema = await binding.get_schema(_cred(), "esmfold")
    assert [p["name"] for p in schema["parameters"]] == ["sequence"]


async def test_validate_and_estimate_are_free_and_answer_for_real():
    binding = _binding()
    bad = await binding.validate(_cred(), "esmfold", {})
    assert bad.ok is False and bad.problems

    good = await binding.validate(_cred(), "esmfold", {"sequence": UBIQUITIN})
    if not good.ok and _is_monthly_limit(good.problems):
        pytest.skip(good.problems[0])
    assert good.ok is True

    estimate = await binding.estimate(_cred(), "esmfold", {"sequence": UBIQUITIN})
    assert (
        estimate.unit
    ), "an estimate must name its unit even when the amount is unknown"


async def test_the_real_submit_path_is_exercised_and_refused_without_creating_a_job():
    """The closest thing Tamarind has to a dry run. Invalid settings reach the real
    POST /api/submit-job, which refuses them, so auth, routing and validation are
    all proven and nothing is queued or billed."""
    binding = _binding()
    before = _names(await _raw_jobs(binding))
    try:
        with pytest.raises(InvalidJobSettingsError):
            await binding.submit(
                _cred(), SubmitRequest("esmfold", {}, label="dnaforge-contract-probe")
            )
    except BudgetExhaustedError as exc:
        after = _names(await _raw_jobs(binding))
        assert after == before, "a quota-refused submit must not create a job"
        pytest.skip(str(exc))
    after = _names(await _raw_jobs(binding))
    assert after == before, "a refused submit must not create a job"


async def test_status_and_result_parse_against_a_job_that_already_finished():
    """Reading a finished job is free. This is the only way to prove the status map
    and the signed-zip result path against live bytes without spending anything."""
    binding = _binding()
    jobs = await _raw_jobs(binding)
    done = [
        j
        for j in jobs
        if isinstance(j, dict) and str(j.get("JobStatus", "")).lower() == "complete"
    ]
    if not done:
        pytest.skip("no finished job on this account to read")
    folds = [j for j in done if str(j.get("Type") or "").lower().startswith("esmfold")]
    chosen = folds[0] if folds else done[0]
    name = str(chosen["JobName"])
    tool = str(chosen.get("Type") or "esmfold")
    ref = ProviderJobRef("tamarind", name, tool)

    status = await binding.status(_cred(), ref)
    assert status.is_terminal() and status.state.value == "completed"

    bundle = await binding.fetch_result(_cred(), ref)
    assert bundle.files, "a finished job returned no files"
    assert all(
        f.content is not None for f in bundle.files
    ), "a signed link must be resolved inside the sidecar, never handed out"
    assert bundle.provenance.get("provider") == "tamarind"

    if folds:
        assert bundle.metrics, "a finished fold reported no metrics"
        ptm = bundle.metrics.get("ptm")
        assert (
            isinstance(ptm, (int, float)) and 0.0 <= float(ptm) <= 1.0
        ), bundle.metrics
        plddt = bundle.metrics.get("plddt")
        assert plddt is None or 0.0 <= float(plddt) <= 100.0, bundle.metrics
        assert "sequence" not in bundle.metrics


async def test_cancelling_a_job_that_does_not_exist_is_reported_as_unknown():
    binding = _binding()
    with pytest.raises(UnknownJobError):
        await binding.cancel(
            _cred(), ProviderJobRef("tamarind", "dnaforge-no-such-job-000", "esmfold")
        )


async def _raw_jobs(binding: McpProviderBinding) -> list:
    async with binding._session(_cred()) as session:
        payload = _result_payload(await session.call_tool("getJobs", {"limit": 25}))
    if isinstance(payload, dict) and isinstance(payload.get("jobs"), list):
        return payload["jobs"]
    return []


def _names(jobs: list) -> set[str]:
    return {str(j.get("JobName")) for j in jobs if isinstance(j, dict)}


def _is_monthly_limit(problems: tuple[str, ...]) -> bool:
    text = " ".join(problems).lower()
    return "monthly job limit exceeded" in text or "monthly_limit_exceeded" in text
