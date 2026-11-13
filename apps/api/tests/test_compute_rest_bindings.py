""" — REST binding kind: NVIDIA hosted NIM (static catalog, long-poll
with 202 + nvcf-reqid fallback) and subseq.bio (dynamic catalog, async jobs,
multipart submit, per-file download). Recorded fixtures via httpx.MockTransport;
no network. Proves the same eight-operation protocol holds across transports.
"""

from __future__ import annotations

import io
import json
import re
import zipfile
from pathlib import Path

import httpx
import pytest

from src.compute.contract import (
    BadCredentialError,
    BudgetExhaustedError,
    ComputeProviderError,
    ComputeRateLimitError,
    CredentialScheme,
    InvalidJobSettingsError,
    JobState,
    OutputKind,
    ProviderBinding,
    ProviderCredential,
    ProviderJobRef,
    ProviderUnavailableError,
    SubmitRequest,
    UnknownJobError,
)
from src.compute.manifests import load_manifests
from src.compute.providers.nvidia_nim import (
    POLL_SECONDS_HEADER,
    REQID_HEADER,
    NvidiaNimBinding,
)
from src.compute.providers.subseq import SubseqBinding
from src.compute.service import ComputeService

REPO_ROOT = Path(__file__).resolve().parents[3]
MANIFESTS = REPO_ROOT / "packages" / "core" / "compute-endpoints" / "manifests"
NV_KEY = "nvapi-TESTSECRET-000"
SQ_KEY = "sq-TESTSECRET-000"


def _cred(provider: str, scheme: CredentialScheme, secret: str) -> ProviderCredential:
    return ProviderCredential(provider, scheme, secret)


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


class NvidiaFake:
    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.pending: dict[str, int] = {}
        self.force: list[httpx.Response] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.force:
            return self.force.pop(0)
        if request.headers.get("Authorization") != f"Bearer {NV_KEY}":
            return httpx.Response(
                403,
                json={
                    "status": 403,
                    "title": "Forbidden",
                    "detail": "Authorization failed",
                },
            )
        path = request.url.path
        if path.endswith("/biology/deepmind/alphafold2"):
            body = json.loads(request.content)
            if "sequence" not in body:
                return httpx.Response(422, json={"detail": "sequence required"})
            return httpx.Response(
                200,
                json={
                    "pdbs": [
                        "ATOM      1  N   MET A   1      0.000   0.000   0.000  1.00 88.50           N\nEND\n"
                    ],
                    "plddt": 88.5,
                },
            )
        if path.endswith("/biology/mit/boltz2/predict"):
            body = json.loads(request.content)
            if "polymers" not in body:
                return httpx.Response(
                    422, json={"error": "body -> polymers: Field required"}
                )
            return httpx.Response(
                200,
                headers={REQID_HEADER: "bc7edb16", "nvcf-status": "fulfilled"},
                json={
                    "structures": [
                        {
                            "structure": "data_model\n_entry.id model\n",
                            "format": "mmcif",
                            "name": "prediction",
                            "source": "prediction_model_0.cif",
                        }
                    ],
                    "metrics": {
                        "total_time_seconds": 1.07,
                        "model_inference_time_seconds": 0.65,
                    },
                    "confidence_scores": [0.7466],
                    "affinities": {},
                    "ptm_scores": [0.9231],
                    "iptm_scores": [0.0],
                    "ligand_iptm_scores": [0.0],
                    "protein_iptm_scores": [0.0],
                    "complex_plddt_scores": [0.9332],
                    "complex_iplddt_scores": [0.9332],
                    "complex_pde_scores": [0.318],
                    "complex_ipde_scores": [0.0],
                },
            )
        if path.endswith("/biology/deepmind/alphafold2-multimer"):
            self.pending["req-1"] = 2
            return httpx.Response(202, headers={REQID_HEADER: "req-1"})
        if "/status/" in path:
            reqid = path.rsplit("/", 1)[-1]
            if reqid not in self.pending:
                return httpx.Response(404, json={"detail": "unknown request"})
            if self.pending[reqid] > 0:
                self.pending[reqid] -= 1
                return httpx.Response(202, headers={REQID_HEADER: reqid})
            return httpx.Response(
                200,
                json={"pdbs": ["ATOM\nEND\n", "ATOM\nEND\n"], "iptm": 0.71, "ptm": 0.8},
            )
        return httpx.Response(404, json={"detail": "no such endpoint"})


@pytest.fixture
def nvidia():
    fake = NvidiaFake()
    binding = NvidiaNimBinding(
        load_manifests(MANIFESTS)["nvidia-nim"], client=_client(fake), poll_seconds=5
    )
    return fake, binding


async def test_nvidia_binding_is_a_protocol_binding(nvidia):
    _fake, binding = nvidia
    assert isinstance(binding, ProviderBinding)


async def test_nvidia_cancel_refuses_to_claim_remote_work_stopped(nvidia):
    _fake, binding = nvidia
    cred = _cred("nvidia-nim", CredentialScheme.BEARER, NV_KEY)
    with pytest.raises(ComputeProviderError, match="cannot cancel"):
        await binding.cancel(
            cred,
            ProviderJobRef("nvidia-nim", "nvcf:req-1", "alphafold2"),
        )


async def test_nvidia_static_catalog_schema_validate_estimate(nvidia):
    fake, binding = nvidia
    cred = _cred("nvidia-nim", CredentialScheme.BEARER, NV_KEY)
    tools = await binding.list_tools(cred, search="fold")
    assert {t.id for t in tools} >= {
        "alphafold2",
        "alphafold2-multimer",
        "openfold2",
    }
    assert tools[0].id == "boltz2"
    by_task = await binding.list_tools(cred, search="protein structure prediction")
    assert "boltz2" in {t.id for t in by_task}
    assert fake.requests == []
    schema = await binding.get_schema(cred, "alphafold2")
    assert schema["required"] == ["sequence"]
    bad = await binding.validate(cred, "alphafold2", {"sequence": "MK1T"})
    assert bad.ok is False and "one-letter" in bad.problems[0]
    est = await binding.estimate(cred, "alphafold2", {"sequence": "MKT"})
    assert est.is_known() is False and est.unit == "credits"
    with pytest.raises(InvalidJobSettingsError):
        await binding.get_schema(cred, "nope")


async def test_nvidia_synchronous_submit_completes_inline(nvidia):
    fake, binding = nvidia
    cred = _cred("nvidia-nim", CredentialScheme.BEARER, NV_KEY)
    ref = await binding.submit(
        cred, SubmitRequest("alphafold2", {"sequence": "MKTAYIAKQR"})
    )
    assert ref.remote_id.startswith("inline:")
    req = fake.requests[-1]
    assert req.headers[POLL_SECONDS_HEADER] == "5"
    assert req.headers["Authorization"] == f"Bearer {NV_KEY}"
    assert req.url.path.endswith("/v1/biology/deepmind/alphafold2")
    st = await binding.status(cred, ref)
    assert st.state is JobState.COMPLETED
    bundle = await binding.fetch_result(cred, ref)
    assert bundle.output_kind is OutputKind.STRUCTURE
    assert bundle.files[0].name == "model_1.pdb" and bundle.files[0].content.startswith(
        b"ATOM"
    )
    assert bundle.metrics == {"plddt": 88.5}
    assert bundle.provenance["endpoint"] == "/biology/deepmind/alphafold2"


async def test_nvidia_boltz2_live_shape_becomes_a_cif_with_confidence_metrics(nvidia):
    """Pinned to the response captured from the real endpoint on 2026-09-09."""
    _fake, binding = nvidia
    cred = _cred("nvidia-nim", CredentialScheme.BEARER, NV_KEY)
    with pytest.raises(InvalidJobSettingsError):
        await binding.submit(cred, SubmitRequest("boltz2", {"sequence": "MKT"}))
    ref = await binding.submit(
        cred,
        SubmitRequest(
            "boltz2",
            {
                "polymers": [
                    {"id": "A", "molecule_type": "protein", "sequence": "MQIFVKTLTGK"}
                ],
                "recycling_steps": 1,
            },
        ),
    )
    bundle = await binding.fetch_result(cred, ref)
    assert bundle.output_kind is OutputKind.STRUCTURE
    assert [f.name for f in bundle.files] == ["prediction_model_0.cif"]
    assert bundle.files[0].content.startswith(b"data_model")
    assert bundle.files[0].media_type == "chemical/x-mmcif"
    assert bundle.metrics["confidence_scores"] == [0.7466]
    assert bundle.metrics["ptm_scores"] == [0.9231]
    assert bundle.metrics["complex_plddt_scores"] == [0.9332]
    assert "affinities" not in bundle.metrics
    assert "model_inference_time_seconds" in bundle.provenance["provider_timing"]


async def test_nvidia_202_then_poll_until_200(nvidia):
    fake, binding = nvidia
    cred = _cred("nvidia-nim", CredentialScheme.BEARER, NV_KEY)
    ref = await binding.submit(
        cred, SubmitRequest("alphafold2-multimer", {"sequences": ["MKT", "GGG"]})
    )
    assert ref.remote_id == "nvcf:req-1"
    s1 = await binding.status(cred, ref)
    assert s1.state is JobState.RUNNING and s1.provider_state == "202 pending"
    assert fake.requests[-1].url.path.endswith("/v1/status/req-1")
    s2 = await binding.status(cred, ref)
    assert s2.state is JobState.RUNNING
    s3 = await binding.status(cred, ref)
    assert s3.state is JobState.COMPLETED
    bundle = await binding.fetch_result(cred, ref)
    assert [f.name for f in bundle.files] == ["model_1.pdb", "model_2.pdb"]
    assert bundle.metrics == {"iptm": 0.71, "ptm": 0.8}
    with pytest.raises(UnknownJobError):
        await binding.status(
            cred,
            ProviderJobRef("nvidia-nim", "nvcf:req-missing", "alphafold2-multimer"),
        )


async def test_nvidia_error_mapping(nvidia):
    fake, binding = nvidia
    bad = _cred("nvidia-nim", CredentialScheme.BEARER, "nvapi-wrong")
    with pytest.raises(BadCredentialError):
        await binding.submit(bad, SubmitRequest("alphafold2", {"sequence": "MKT"}))
    cred = _cred("nvidia-nim", CredentialScheme.BEARER, NV_KEY)
    with pytest.raises(InvalidJobSettingsError):
        await binding.submit(cred, SubmitRequest("alphafold2", {}))
    fake.force.append(httpx.Response(429, headers={"Retry-After": "7"}))
    with pytest.raises(ComputeRateLimitError) as info:
        await binding.submit(cred, SubmitRequest("alphafold2", {"sequence": "MKT"}))
    assert info.value.retry_after_s == 7.0
    request_count = len(fake.requests)
    fake.force.append(httpx.Response(503))
    with pytest.raises(ProviderUnavailableError):
        await binding.submit(cred, SubmitRequest("alphafold2", {"sequence": "MKT"}))
    assert len(fake.requests) == request_count + 1
    fake.force.append(httpx.Response(402, text="insufficient credits"))
    with pytest.raises(BudgetExhaustedError):
        await binding.submit(cred, SubmitRequest("alphafold2", {"sequence": "MKT"}))


async def test_nvidia_verify_proves_the_key_without_spending(nvidia):
    """The static catalog answers any string, so verify must reach NVIDIA: an
    empty Boltz-2 body is refused with 403 for a wrong key and 422 for a right
    one (both probed live 2026-09-10), and never starts a job."""
    fake, binding = nvidia
    wrong = _cred("nvidia-nim", CredentialScheme.BEARER, "nvapi-wrong")
    assert await binding.list_tools(wrong)
    with pytest.raises(BadCredentialError):
        await binding.verify_credential(wrong)
    await binding.verify_credential(
        _cred("nvidia-nim", CredentialScheme.BEARER, NV_KEY)
    )
    verify_request = fake.requests[-1]
    assert verify_request.url.path.endswith("/biology/mit/boltz2/predict")
    assert json.loads(verify_request.content) == {}


SUBSEQ_PROGRAMS = [
    {
        "name": "esmfold",
        "display_name": "ESMFold",
        "description": "Fast protein structure prediction.",
        "cost_per_hour": 1.6758,
        "submit_fee": 0,
        "min_run_time": 60,
        "main_output_dir": ".subseq/artifacts/structs",
    },
    {
        "name": "boltz-2",
        "display_name": "Boltz-2",
        "description": "Boltz structure and affinity prediction.",
        "cost_per_hour": 2.4906,
        "submit_fee": 0,
        "min_run_time": 60,
        "main_output_dir": ".subseq/artifacts/structs",
    },
    {
        "name": "rfdiffusion3",
        "display_name": "RFdiffusion3",
        "description": "All-atom RFdiffusion3 design workflows.",
        "cost_per_hour": 2.1882,
        "submit_fee": 0,
        "min_run_time": 120,
        "main_output_dir": ".subseq/",
    },
]
SUBSEQ_ESMFOLD_PARAMS = {
    "program": "esmfold",
    "guided": True,
    "display_name": "ESMFold",
    "main_output_dir": ".subseq/artifacts/structs",
    "modes": [
        {
            "name": "single_sequence",
            "label": "Single Sequence",
            "description": "Predict one typed protein sequence as a single-chain structure.",
            "default": True,
            "input_shape": "none",
        },
        {
            "name": "custom_input",
            "label": "Custom Input",
            "description": "Run one supplied protein FASTA file.",
            "input_shape": "single",
        },
        {
            "name": "batch_input",
            "label": "Batch Input",
            "description": "Predict structures for all FASTA inputs in the selected source.",
            "input_shape": "batch",
        },
    ],
    "params": [
        {
            "name": "protein_sequence",
            "type": "sequence_text",
            "label": "Protein Sequence",
            "pane": "inputs",
            "required": True,
            "modes": ["single_sequence"],
            "help": "Single-chain protein sequence using one-letter codes.",
        },
        {
            "name": "target_fasta",
            "type": "input_file",
            "label": "Protein FASTA",
            "pane": "inputs",
            "required": True,
            "modes": ["custom_input"],
            "help": "Choose one prepared protein FASTA file.",
            "extensions": [".fasta", ".fa", ".faa", ".fas"],
        },
        {
            "name": "prediction_depth",
            "type": "string",
            "label": "Prediction Depth",
            "default": "Standard",
            "extra": True,
            "options": ["Fast", "Standard", "Thorough"],
        },
        {
            "name": "split_fasta_chainbreaks",
            "type": "bool",
            "label": "Split FASTA chain breaks",
            "default": True,
            "modes": ["custom_input", "batch_input"],
        },
    ],
}
SUBSEQ_BOLTZ2_PARAMS = {
    "program": "boltz-2",
    "modes": [
        {"name": "single_sequence", "default": True, "input_shape": "single"},
        {"name": "build_assembly", "input_shape": "none"},
    ],
    "params": [
        {
            "name": "protein_sequence",
            "type": "sequence_text",
            "required": True,
            "modes": ["single_sequence"],
        },
        {
            "name": "msa_source",
            "type": "string",
            "default": "Single Sequence",
            "modes": ["single_sequence"],
            "options": ["Single Sequence", "Precomputed MSA"],
        },
        {
            "name": "msa_file",
            "type": "msa_file",
            "required": True,
            "modes": ["single_sequence"],
            "depends_on": {"param": "msa_source", "value": "Precomputed MSA"},
            "extensions": [".a3m"],
        },
        {
            "name": "entities",
            "type": "repeatable_group",
            "required": True,
            "modes": ["build_assembly"],
            "min_items": 1,
            "max_items": 12,
            "fields": [
                {
                    "name": "entity_type",
                    "type": "string",
                    "default": "Protein",
                    "options": ["Protein", "DNA", "RNA"],
                },
                {"name": "sequence", "type": "sequence_text", "required": True},
            ],
        },
        {
            "name": "output_format",
            "type": "string",
            "default": "mmCIF",
            "options": ["mmCIF", "PDB"],
        },
        {"name": "random_seed", "type": "int", "min": 1, "max": 2147483647},
    ],
}


SUBSEQ_CHAI1_PARAMS = {
    "program": "chai-1",
    "modes": [{"name": "structure_prediction", "default": True}],
    "params": [
        {
            "name": "target_fasta",
            "type": "sequence_file",
            "required": True,
            "modes": ["structure_prediction"],
            "extensions": [".fasta", ".fa"],
        },
        {"name": "num_samples", "type": "int", "default": 5, "min": 1, "max": 25},
    ],
}


def _form_field(body: bytes, name: str) -> bytes | None:
    match = re.search(rb'name="' + name.encode() + rb'"\r\n\r\n(.*?)\r\n--', body, re.S)
    return match.group(1) if match else None


class SubseqFake:
    """subseq.bio as probed live: the catalog and parameter schemas are public;
    account, job, and file routes need the bearer key."""

    PUBLIC = ("/program/list", "/program/params")

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.jobs: dict[str, dict] = {}
        self.submitted_params: list[dict] = []
        self.status_script = ["pending", "running", "completed"]
        self.omit_manifest = False
        self.invalid_download = False
        self.result_ready = True

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        q = dict(request.url.params)
        if (
            not path.endswith(self.PUBLIC)
            and request.headers.get("Authorization") != f"Bearer {SQ_KEY}"
        ):
            return httpx.Response(
                401, json={"success": False, "error": "Invalid api key"}
            )
        if path.endswith("/program/list"):
            return httpx.Response(200, json={"success": True, "data": SUBSEQ_PROGRAMS})
        if path.endswith("/program/params"):
            schema = {
                "esmfold": SUBSEQ_ESMFOLD_PARAMS,
                "boltz-2": SUBSEQ_BOLTZ2_PARAMS,
                "chai-1": SUBSEQ_CHAI1_PARAMS,
            }.get(q.get("program", ""))
            if schema is None:
                return httpx.Response(
                    400, json={"success": False, "error": "Invalid program"}
                )
            return httpx.Response(200, json={"success": True, "data": schema})
        if path.endswith("/account/info"):
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "data": {"email": "lab@example.org", "credits": 12.5},
                },
            )
        if path.endswith("/job/submit"):
            program = _form_field(request.content, "program")
            params = _form_field(request.content, "params")
            if not program or params is None:
                return httpx.Response(
                    400, json={"success": False, "error": "program and params required"}
                )
            self.submitted_params.append(json.loads(params))
            job_id = f"5bf2d83e40a47cf{len(self.jobs) + 1}"
            self.jobs[job_id] = {"status": "pending", "program": program.decode()}
            return httpx.Response(
                200, json={"success": True, "data": {"job_id": job_id}}
            )
        if path.endswith("/job/view"):
            job = self.jobs.get(q.get("jobid", ""))
            if not job:
                return httpx.Response(
                    404, json={"success": False, "error": "job not found"}
                )
            if self.status_script:
                job["status"] = self.status_script.pop(0)
            if job["status"] == "completed":
                job["cost"] = 0.03
                job["dl_ready"] = self.result_ready
                if not self.omit_manifest:
                    job["manifest"] = [
                        {"path": "outputs/scores.json", "sha256": "c4c1", "size": 13},
                        {
                            "path": ".subseq/artifacts/structs/prediction.pdb",
                            "sha256": "b3b0",
                            "size": 2456,
                        },
                        {"path": "outputs/bundle.zip", "sha256": "d5d2", "size": 9000},
                    ]
            return httpx.Response(200, json={"success": True, "data": job})
        if path.endswith("/job/file"):
            name = q["path"].rsplit("/", 1)[-1]
            if name.endswith(".pdb"):
                return httpx.Response(
                    200,
                    content=b"ATOM      1  CA  MET A   1      0.000   0.000   0.000\nEND\n",
                    headers={"content-type": "chemical/x-pdb"},
                )
            return httpx.Response(
                200,
                content=b'{"plddt": 80}',
                headers={"content-type": "application/json"},
            )
        if path.endswith("/job/download"):
            if self.invalid_download:
                return httpx.Response(200, content=b"not a result archive")
            archive = io.BytesIO()
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr(
                    ".subseq/artifacts/structs/prediction.pdb",
                    "ATOM      1  CA  MET A   1      0.000   0.000   0.000\nEND\n",
                )
                bundle.writestr("outputs/scores.json", '{"plddt": 80}')
            return httpx.Response(
                200,
                content=archive.getvalue(),
                headers={"content-type": "application/zip"},
            )
        if path.endswith("/job/cancel"):
            if "jobid" not in q:
                return httpx.Response(
                    400, json={"success": False, "error": "jobid required"}
                )
            return httpx.Response(
                200, json={"success": True, "data": "Job cancelled successfully"}
            )
        return httpx.Response(404, json={"success": False, "error": "no route"})


@pytest.fixture
def subseq():
    fake = SubseqFake()
    binding = SubseqBinding(load_manifests(MANIFESTS)["subseq"], client=_client(fake))
    return fake, binding


async def test_subseq_live_schema_becomes_a_mode_aware_json_schema(subseq):
    _fake, binding = subseq
    cred = _cred("subseq", CredentialScheme.BEARER, SQ_KEY)
    assert [t.id for t in await binding.list_tools(cred, search="fold")] == ["esmfold"]

    schema = await binding.get_schema(cred, "esmfold")
    mode = schema["properties"]["mode"]
    assert mode["enum"] == ["single_sequence", "custom_input", "batch_input"]
    assert mode["default"] == "single_sequence"
    assert schema["required"] == ["protein_sequence"]
    assert schema["properties"]["protein_sequence"]["type"] == "string"
    assert schema["properties"]["prediction_depth"]["enum"] == [
        "Fast",
        "Standard",
        "Thorough",
    ]
    assert "custom_input" in schema["properties"]["target_fasta"]["description"]
    assert schema["properties"]["split_fasta_chainbreaks"]["type"] == "boolean"

    missing = await binding.validate(cred, "esmfold", {})
    assert missing.ok is False and missing.problems == ("protein_sequence: required",)
    assert (await binding.validate(cred, "esmfold", {"protein_sequence": "MKT"})).ok
    wrong_mode = await binding.validate(
        cred, "esmfold", {"mode": "nope", "protein_sequence": "MKT"}
    )
    assert wrong_mode.ok is False and wrong_mode.problems[0].startswith("mode:")

    boltz = await binding.get_schema(cred, "boltz-2")
    assert boltz["required"] == ["protein_sequence"]
    assert boltz["properties"]["entities"]["type"] == "array"
    assert boltz["properties"]["entities"]["items"]["required"] == ["sequence"]
    assert boltz["properties"]["random_seed"]["maximum"] == 2147483647
    assembly = await binding.validate(cred, "boltz-2", {"mode": "build_assembly"})
    assert assembly.problems == ("entities: required",)

    est = await binding.estimate(cred, "esmfold", {"protein_sequence": "MKT"})
    assert est.unit == "credits" and est.estimated_seconds == 60.0
    assert est.amount == round(1.6758 * 60 / 3600, 4)
    with pytest.raises((InvalidJobSettingsError, UnknownJobError)):
        await binding.get_schema(cred, "nope")


async def test_subseq_async_lifecycle_and_file_download(subseq):
    fake, binding = subseq
    cred = _cred("subseq", CredentialScheme.BEARER, SQ_KEY)
    ref = await binding.submit(
        cred,
        SubmitRequest(
            "esmfold",
            {"protein_sequence": "MKT"},
            files={"target.fasta": b">t\nMKT\n"},
            label="my job",
        ),
    )
    assert ref.remote_id == "5bf2d83e40a47cf1"
    submit_req = fake.requests[-1]
    assert submit_req.headers["Content-Type"].startswith("multipart/form-data")
    assert fake.submitted_params[-1] == {
        "protein_sequence": "MKT",
        "mode": "single_sequence",
    }
    assert _form_field(submit_req.content, "memo") == b"my job"
    assert b'filename="target.fasta"' in submit_req.content

    states = [(await binding.status(cred, ref)).state for _ in range(3)]
    assert states == [JobState.QUEUED, JobState.RUNNING, JobState.COMPLETED]
    st = await binding.status(cred, ref)
    assert st.cost is not None and st.cost.amount == 0.03

    bundle = await binding.fetch_result(cred, ref)
    assert bundle.output_kind is OutputKind.STRUCTURE
    assert [f.name for f in bundle.files] == [
        "prediction.pdb",
        "scores.json",
        "bundle.zip",
    ]
    assert (bundle.files[0].content or b"").startswith(b"ATOM")
    assert bundle.files[2].content is None and "bundle.zip" in (
        bundle.files[2].url or ""
    )

    canceled = await binding.cancel(cred, ref)
    assert canceled.state is JobState.CANCELED
    assert fake.requests[-1].url.params["jobid"] == ref.remote_id


async def test_subseq_downloads_the_result_archive_when_live_view_omits_manifest(
    subseq,
):
    fake, binding = subseq
    fake.omit_manifest = True
    fake.status_script = []
    ref = ProviderJobRef("subseq", "5bf2d83e40a47cf1", "esmfold")
    fake.jobs[ref.remote_id] = {"status": "completed", "program": "esmfold"}

    bundle = await binding.fetch_result(
        _cred("subseq", CredentialScheme.BEARER, SQ_KEY), ref
    )

    assert bundle.output_kind is OutputKind.STRUCTURE
    assert [file.name for file in bundle.files] == ["prediction.pdb", "scores.json"]
    assert (bundle.files[0].content or b"").startswith(b"ATOM")
    assert all(file.url is None for file in bundle.files)
    download = next(
        request
        for request in fake.requests
        if request.url.path.endswith("/job/download")
    )
    assert download.headers["Authorization"] == f"Bearer {SQ_KEY}"


async def test_subseq_keeps_completed_job_running_until_results_are_ready(subseq):
    fake, binding = subseq
    fake.result_ready = False
    fake.status_script = []
    ref = ProviderJobRef("subseq", "5bf2d83e40a47cf1", "esmfold")
    fake.jobs[ref.remote_id] = {"status": "completed", "program": "esmfold"}
    credential = _cred("subseq", CredentialScheme.BEARER, SQ_KEY)

    preparing = await binding.status(credential, ref)

    assert preparing.state is JobState.RUNNING
    assert preparing.provider_state == "completed (preparing results)"
    assert "preparing" in preparing.progress_note.lower()

    fake.result_ready = True
    ready = await binding.status(credential, ref)
    assert ready.state is JobState.COMPLETED
    assert ready.provider_state == "completed"


async def test_subseq_result_is_retryable_while_completed_archive_is_not_ready(subseq):
    fake, binding = subseq
    fake.omit_manifest = True
    fake.result_ready = False
    fake.status_script = []
    ref = ProviderJobRef("subseq", "5bf2d83e40a47cf1", "esmfold")
    fake.jobs[ref.remote_id] = {"status": "completed", "program": "esmfold"}

    with pytest.raises(ProviderUnavailableError, match="still preparing"):
        await binding.fetch_result(
            _cred("subseq", CredentialScheme.BEARER, SQ_KEY), ref
        )
    assert not any(
        request.url.path.endswith("/job/download") for request in fake.requests
    )


async def test_subseq_fails_closed_when_result_archive_has_no_importable_files(subseq):
    fake, binding = subseq
    fake.omit_manifest = True
    fake.invalid_download = True
    fake.status_script = []
    ref = ProviderJobRef("subseq", "5bf2d83e40a47cf1", "esmfold")
    fake.jobs[ref.remote_id] = {"status": "completed", "program": "esmfold"}

    with pytest.raises(ProviderUnavailableError, match="no supported importable files"):
        await binding.fetch_result(
            _cred("subseq", CredentialScheme.BEARER, SQ_KEY), ref
        )


async def test_subseq_file_inputs_are_attachments_not_settings(subseq):
    fake, binding = subseq
    cred = _cred("subseq", CredentialScheme.BEARER, SQ_KEY)
    schema = await binding.get_schema(cred, "chai-1")
    assert schema["required"] == []
    assert "attach the file" in schema["properties"]["target_fasta"]["description"]
    assert (await binding.validate(cred, "chai-1", {})).ok

    def submits() -> int:
        return sum(1 for r in fake.requests if r.url.path.endswith("/job/submit"))

    before = submits()
    with pytest.raises(InvalidJobSettingsError) as info:
        await binding.submit(cred, SubmitRequest("chai-1", {}))
    assert info.value.problems == ("target_fasta: attach a file (.fasta, .fa)",)
    assert submits() == before
    await binding.submit(
        cred,
        SubmitRequest(
            "chai-1",
            {"target_fasta": "ubq.fasta"},
            files={"ubq.fasta": b">ubq\nMQIF\n"},
        ),
    )
    assert fake.submitted_params[-1] == {
        "target_fasta": "ubq.fasta",
        "mode": "structure_prediction",
    }


async def test_subseq_verify_needs_the_key_even_though_the_catalog_is_public(subseq):
    fake, binding = subseq
    wrong = _cred("subseq", CredentialScheme.BEARER, "wrong")
    assert await binding.list_tools(wrong)
    with pytest.raises(BadCredentialError):
        await binding.verify_credential(wrong)
    cred = _cred("subseq", CredentialScheme.BEARER, SQ_KEY)
    await binding.verify_credential(cred)
    assert fake.requests[-1].url.path.endswith("/api/v1/account/info")
    with pytest.raises(BadCredentialError):
        await binding.submit(
            wrong, SubmitRequest("esmfold", {"protein_sequence": "MKT"})
        )
    with pytest.raises(UnknownJobError):
        await binding.status(cred, ProviderJobRef("subseq", "sq-999", "esmfold"))


async def test_service_drives_all_three_bindings_through_the_same_operations():
    manifests = load_manifests(MANIFESTS)
    nv = NvidiaFake()
    sq = SubseqFake()

    class Scripted:
        provider_id = "tamarind"

        async def list_tools(self, credential, *, search=None, tags=()):
            return []

        async def get_schema(self, credential, tool_id):
            return {}

        async def validate(self, credential, tool_id, settings):
            raise AssertionError

        async def estimate(self, credential, tool_id, settings):
            raise AssertionError

        async def submit(self, credential, request):
            raise AssertionError

        async def status(self, credential, ref):
            raise AssertionError

        async def fetch_result(self, credential, ref):
            raise AssertionError

        async def cancel(self, credential, ref):
            raise AssertionError

    def factory(manifest):
        if manifest.id == "nvidia-nim":
            return NvidiaNimBinding(manifest, client=_client(nv))
        if manifest.id == "subseq":
            return SubseqBinding(manifest, client=_client(sq))
        return Scripted()

    service = ComputeService(manifests, binding_factory=factory)
    assert all(service.has_binding(pid) for pid in ("tamarind", "nvidia-nim", "subseq"))
    nv_cred = service.credential_for("nvidia-nim", NV_KEY)
    sq_cred = service.credential_for("subseq", SQ_KEY)
    assert (
        nv_cred.scheme is CredentialScheme.BEARER
        and sq_cred.scheme is CredentialScheme.BEARER
    )
    assert service.credential_for("tamarind", "k").header_name == "x-api-key"

    nv_ref = await service.submit(
        "nvidia-nim", nv_cred, SubmitRequest("alphafold2", {"sequence": "MKT"})
    )
    sq_ref = await service.submit(
        "subseq", sq_cred, SubmitRequest("esmfold", {"protein_sequence": "MKT"})
    )
    assert (
        await service.status("nvidia-nim", nv_cred, nv_ref)
    ).state is JobState.COMPLETED
    sq.status_script = ["completed"]
    assert (await service.status("subseq", sq_cred, sq_ref)).state is JobState.COMPLETED
    assert (
        await service.fetch_result("nvidia-nim", nv_cred, nv_ref)
    ).output_kind is OutputKind.STRUCTURE
    assert (
        await service.fetch_result("subseq", sq_cred, sq_ref)
    ).output_kind is OutputKind.STRUCTURE
