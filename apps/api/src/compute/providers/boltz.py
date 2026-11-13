"""Boltz hosted API binding (Boltz sponsors the hackathon; this is direct, not
through NVIDIA or Tamarind).

Shapes come from the official `boltz-api` 0.50.0 SDK types and the REST reference,
read on 2026-09-10, plus a live unauthenticated probe (401
`{"code": "unauthorized", "message": "Invalid or missing API key"}`):

- base `https://api.boltz.bio`, header `x-api-key` (`sk_bc_ws_live_…`; `sk_bc_ws_test_…`
  keys run free and return fake results)
- verify: `GET /compute/v1/auth/me`
- Boltz-2.1: `POST /compute/v1/predictions/structure-and-binding` with
  `{"model": "boltz-2.1", "input": {"entities": [...], ...}, "idempotency_key"}`,
  poll `GET …/{id}` (status `pending|running|succeeded|failed`)
- `POST …/estimate-cost` takes the same body and never uses a GPU
- results: `output.best_sample.structure.url` is a short-lived download link to an
  mmCIF; metrics are inline. Predictions cannot be cancelled.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any, Mapping
from urllib.parse import quote, urlparse

import httpx

from ..contract import (
    BudgetExhaustedError,
    ComputeProviderError,
    CostEstimate,
    InvalidJobSettingsError,
    JobState,
    JobStatus,
    OutputKind,
    ProviderCredential,
    ProviderJobRef,
    ProviderUnavailableError,
    ResultBundle,
    ResultFile,
    SubmitRequest,
    ToolDescriptor,
    UnknownJobError,
    ValidationResult,
)
from ..manifests import ProviderManifest
from ..rest_binding import RestProviderBinding

MODEL = "boltz-2.1"
PREDICTIONS_PATH = "/compute/v1/predictions/structure-and-binding"
ENTITY_TYPES = ("protein", "dna", "rna", "ligand_smiles", "ligand_ccd")
_INPUT_PASSTHROUGH = (
    "num_samples",
    "binding",
    "constraints",
    "bonds",
    "model_options",
    "templates",
)
_MAX_SAMPLE_FILES = 10
_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024

_STATE_MAP = {
    "pending": JobState.QUEUED,
    "running": JobState.RUNNING,
    "succeeded": JobState.COMPLETED,
    "failed": JobState.FAILED,
    "stopped": JobState.CANCELED,
}

_SCHEMA: Mapping[str, Any] = {
    "type": "object",
    "description": (
        "Boltz-2.1 structure and binding prediction. Give `entities`, one entry per "
        "molecule, or `sequence` as a shortcut for a single protein chain A."
    ),
    "anyOf": [{"required": ["entities"]}, {"required": ["sequence"]}],
    "required": [],
    "properties": {
        "entities": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "required": ["type", "value", "chain_ids"],
                "properties": {
                    "type": {"type": "string", "enum": list(ENTITY_TYPES)},
                    "value": {
                        "type": "string",
                        "description": "One-letter protein/DNA/RNA sequence, a SMILES string, or a CCD code.",
                    },
                    "chain_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": 'Chain ids this entity occupies, e.g. ["A"]; ["A", "B"] makes a homodimer.',
                    },
                    "cyclic": {"type": "boolean"},
                },
            },
        },
        "sequence": {
            "type": "string",
            "description": "Shortcut for one protein chain: the one-letter amino-acid sequence.",
        },
        "chain_id": {
            "type": "string",
            "default": "A",
            "description": "Chain id for the `sequence` shortcut.",
        },
        "num_samples": {"type": "integer", "minimum": 1, "maximum": 10, "default": 1},
        "binding": {
            "type": "object",
            "description": (
                'Optional binding request: {"type": "ligand_protein_binding", "binder_chain_id": "B"} '
                'or {"type": "protein_protein_binding", "binder_chain_ids": ["B"]}.'
            ),
        },
        "model_options": {
            "type": "object",
            "properties": {
                "recycling_steps": {"type": "integer"},
                "sampling_steps": {"type": "integer"},
                "step_scale": {"type": "number"},
            },
        },
    },
}


def prediction_input(settings: Mapping[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """The API's `input` object from agent settings, plus every problem found."""
    problems: list[str] = []
    entities = settings.get("entities")
    sequence = settings.get("sequence")
    if not entities and isinstance(sequence, str) and sequence.strip():
        entities = [
            {
                "type": "protein",
                "value": re.sub(r"\s+", "", sequence),
                "chain_ids": [str(settings.get("chain_id") or "A")],
            }
        ]
    if not isinstance(entities, list) or not entities:
        problems.append("entities: required (or give `sequence` for one protein chain)")
        entities = []
    for index, entity in enumerate(entities):
        where = f"entities[{index}]"
        if not isinstance(entity, Mapping):
            problems.append(f"{where}: must be an object")
            continue
        if entity.get("type") not in ENTITY_TYPES:
            problems.append(f"{where}.type: must be one of {', '.join(ENTITY_TYPES)}")
        value = entity.get("value")
        if not isinstance(value, str) or not value.strip():
            problems.append(f"{where}.value: required")
        chain_ids = entity.get("chain_ids")
        if (
            not isinstance(chain_ids, list)
            or not chain_ids
            or not all(isinstance(c, str) and c for c in chain_ids)
        ):
            problems.append(f'{where}.chain_ids: required, e.g. ["A"]')
    samples = settings.get("num_samples")
    if samples is not None and not (
        isinstance(samples, int)
        and not isinstance(samples, bool)
        and 1 <= samples <= 10
    ):
        problems.append("num_samples: must be an integer from 1 to 10")
    body: dict[str, Any] = {
        "entities": [dict(e) for e in entities if isinstance(e, Mapping)]
    }
    for key in _INPUT_PASSTHROUGH:
        if settings.get(key) is not None:
            body[key] = settings[key]
    return body, problems


def _structure_name(stem: str, url: str, content: bytes) -> str:
    suffix = (
        urlparse(url).path.rsplit(".", 1)[-1].lower()
        if "." in urlparse(url).path
        else ""
    )
    if suffix not in ("cif", "mmcif", "pdb"):
        head = content.lstrip()[:16]
        suffix = (
            "pdb"
            if head.startswith((b"ATOM", b"HEADER", b"MODEL", b"REMARK"))
            else "cif"
        )
    return f"{stem}.{suffix}"


class BoltzBinding(RestProviderBinding):
    """`ProviderBinding` for Boltz's hosted API (Boltz-2.1 structure and binding)."""

    def __init__(
        self,
        manifest: ProviderManifest,
        *,
        client: httpx.AsyncClient | None = None,
        retry_delay_s: float = 3.0,
    ) -> None:
        super().__init__(manifest, client=client)
        self.retry_delay_s = retry_delay_s
        self._tools: dict[str, Mapping[str, Any]] = {
            str(t["id"]): t for t in manifest.static_tools
        }

    def error_for(self, response: httpx.Response) -> ComputeProviderError:
        try:
            lowered = response.text[:400].lower()
        except Exception:  # noqa: BLE001 - error text is best-effort
            lowered = ""
        if response.status_code in (402, 403) and re.search(
            r"spending|insufficient|credit|balance|billing|payment", lowered
        ):
            return BudgetExhaustedError(
                f"{self.provider_id}: {response.text[:200]}",
                status_code=response.status_code,
            )
        return super().error_for(response)

    def _tool_or_raise(self, tool_id: str) -> Mapping[str, Any]:
        tool = self._tools.get(tool_id)
        if tool is None:
            raise InvalidJobSettingsError(
                f"{self.provider_id}: unknown tool {tool_id!r}",
                problems=(f"tool_id: unknown ({', '.join(sorted(self._tools))})",),
            )
        return tool

    async def list_tools(
        self,
        credential: ProviderCredential,
        *,
        search: str | None = None,
        tags: tuple[str, ...] = (),
    ) -> list[ToolDescriptor]:
        out: list[ToolDescriptor] = []
        for tool in self._tools.values():
            tool_id = str(tool["id"])
            display = str(tool.get("displayName") or tool_id)
            haystack = (
                f"{tool_id} {display} boltz structure prediction fold folding cofold "
                "complex protein dna rna ligand affinity binding"
            ).lower()
            if search and not all(word in haystack for word in search.lower().split()):
                continue
            out.append(
                ToolDescriptor(
                    id=tool_id,
                    display_name=display,
                    description="Boltz hosted API: structure and binding prediction for proteins, nucleic acids, and ligands.",
                    tags=("structure-prediction", "protein", "ligand"),
                    output_kind=OutputKind.STRUCTURE,
                )
            )
        return out

    async def get_schema(
        self, credential: ProviderCredential, tool_id: str
    ) -> Mapping[str, Any]:
        self._tool_or_raise(tool_id)
        return dict(_SCHEMA)

    async def validate(
        self, credential: ProviderCredential, tool_id: str, settings: Mapping[str, Any]
    ) -> ValidationResult:
        self._tool_or_raise(tool_id)
        _body, problems = prediction_input(settings)
        return ValidationResult(ok=not problems, problems=tuple(problems))

    def _body(self, tool_id: str, settings: Mapping[str, Any]) -> dict[str, Any]:
        self._tool_or_raise(tool_id)
        body_input, problems = prediction_input(settings)
        if problems:
            raise InvalidJobSettingsError(
                f"{self.provider_id}: invalid settings", problems=tuple(problems)
            )
        return {"model": MODEL, "input": body_input}

    async def estimate(
        self, credential: ProviderCredential, tool_id: str, settings: Mapping[str, Any]
    ) -> CostEstimate:
        response = await self._request(
            "POST",
            f"{PREDICTIONS_PATH}/estimate-cost",
            credential,
            json_body=self._body(tool_id, settings),
        )
        payload = self.json_of(response)
        payload = payload if isinstance(payload, Mapping) else {}
        try:
            amount: float | None = float(payload.get("estimated_cost_usd"))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            amount = None
        return CostEstimate(
            amount=amount,
            unit="USD",
            note=str(
                payload.get("disclaimer")
                or "Boltz bills measured compute; this is an estimate."
            ),
        )

    async def submit(
        self, credential: ProviderCredential, request: SubmitRequest
    ) -> ProviderJobRef:
        body = self._body(request.tool_id, request.settings)
        if request.idempotency_key:
            body["idempotency_key"] = request.idempotency_key
        try:
            response = await self._request(
                "POST", PREDICTIONS_PATH, credential, json_body=body
            )
        except ProviderUnavailableError:
            if not request.idempotency_key:
                raise
            await asyncio.sleep(self.retry_delay_s)
            response = await self._request(
                "POST", PREDICTIONS_PATH, credential, json_body=body
            )
        payload = self.json_of(response)
        job_id = payload.get("id") if isinstance(payload, Mapping) else None
        if not isinstance(job_id, str) or not job_id:
            raise ComputeProviderError(
                f"{self.provider_id}: submit returned no prediction id"
            )
        return ProviderJobRef(self.provider_id, job_id, request.tool_id)

    async def _prediction(
        self, credential: ProviderCredential, ref: ProviderJobRef
    ) -> Mapping[str, Any]:
        response = await self._request(
            "GET", f"{PREDICTIONS_PATH}/{quote(ref.remote_id, safe='')}", credential
        )
        payload = self.json_of(response)
        if not isinstance(payload, Mapping):
            raise ComputeProviderError(
                f"{self.provider_id}: non-JSON prediction response"
            )
        return payload

    async def status(
        self, credential: ProviderCredential, ref: ProviderJobRef
    ) -> JobStatus:
        payload = await self._prediction(credential, ref)
        raw = str(payload.get("status") or "")
        notes: list[str] = []
        if payload.get("livemode") is False:
            notes.append("Test-mode key: Boltz returns fake results.")
        error = payload.get("error")
        if isinstance(error, Mapping) and error.get("message"):
            notes.append(str(error["message"]))
        return JobStatus(
            ref,
            _STATE_MAP.get(raw, JobState.RUNNING),
            provider_state=raw,
            progress_note=" ".join(notes),
        )

    async def _download(self, url: str) -> bytes:
        if not url.startswith("https://"):
            raise ProviderUnavailableError(
                f"{self.provider_id}: refusing non-https result link"
            )
        try:
            response = await self._client.get(url, headers={"Accept": "*/*"})
        except (httpx.TransportError, httpx.TimeoutException) as exc:
            raise ProviderUnavailableError(
                f"{self.provider_id}: cannot download the result: {exc}"
            ) from exc
        if response.status_code != 200:
            raise ProviderUnavailableError(
                f"{self.provider_id}: result download failed ({response.status_code}); "
                "the link may have expired, fetch the result again",
                status_code=response.status_code,
            )
        if len(response.content) > _DOWNLOAD_MAX_BYTES:
            raise ProviderUnavailableError(
                f"{self.provider_id}: result file is too large"
            )
        return response.content

    async def fetch_result(
        self, credential: ProviderCredential, ref: ProviderJobRef
    ) -> ResultBundle:
        payload = await self._prediction(credential, ref)
        status = str(payload.get("status") or "")
        if status != "succeeded":
            raise ProviderUnavailableError(
                f"{self.provider_id}: prediction {ref.remote_id} is {status or 'unknown'}, not finished"
            )
        output = payload.get("output")
        if payload.get("data_deleted_at") or not isinstance(output, Mapping):
            raise UnknownJobError(
                f"{self.provider_id}: results for {ref.remote_id} are gone "
                "(Boltz keeps them 7 days by default)",
                status_code=404,
            )
        stem = re.sub(r"[^A-Za-z0-9_-]", "_", ref.remote_id)[:60]
        files: list[ResultFile] = []
        best = (
            output.get("best_sample")
            if isinstance(output.get("best_sample"), Mapping)
            else {}
        )
        best_url = (
            (best.get("structure") or {}).get("url")
            if isinstance(best.get("structure"), Mapping)
            else None
        )
        if isinstance(best_url, str):
            content = await self._download(best_url)
            files.append(
                ResultFile(
                    name=_structure_name(f"{stem}_best", best_url, content),
                    content=content,
                    media_type="chemical/x-mmcif",
                )
            )
        samples = [
            s for s in output.get("all_sample_results") or [] if isinstance(s, Mapping)
        ]
        if len(samples) > 1:
            for index, sample in enumerate(samples[:_MAX_SAMPLE_FILES]):
                structure = sample.get("structure")
                url = structure.get("url") if isinstance(structure, Mapping) else None
                if isinstance(url, str):
                    content = await self._download(url)
                    files.append(
                        ResultFile(
                            name=_structure_name(
                                f"{stem}_sample_{index + 1}", url, content
                            ),
                            content=content,
                            media_type="chemical/x-mmcif",
                        )
                    )
        if not files:
            raise ComputeProviderError(
                f"{self.provider_id}: prediction has no structure file"
            )
        metrics: dict[str, Any] = {}
        if isinstance(best.get("metrics"), Mapping):
            metrics.update({k: v for k, v in best["metrics"].items() if v is not None})
        binding = output.get("binding_metrics")
        if isinstance(binding, Mapping):
            metrics.update(
                {f"binding_{k}": v for k, v in binding.items() if v is not None}
            )
        return ResultBundle(
            ref=ref,
            output_kind=OutputKind.STRUCTURE,
            files=tuple(files),
            metrics=metrics,
            provenance={
                "provider": self.provider_id,
                "tool": ref.tool_id,
                "remote_id": ref.remote_id,
                "model": str(payload.get("model") or MODEL),
                "version": str(payload.get("version") or ""),
                "livemode": str(payload.get("livemode")).lower(),
            },
            provider_request=(
                {
                    "input": dict(payload["input"]),
                    "model": payload["model"],
                    "version": payload["version"],
                }
                if isinstance(payload.get("input"), Mapping)
                and isinstance(payload.get("model"), str)
                and payload["model"]
                and isinstance(payload.get("version"), str)
                and payload["version"]
                else None
            ),
        )

    async def cancel(
        self, credential: ProviderCredential, ref: ProviderJobRef
    ) -> JobStatus:
        raise ComputeProviderError(
            f"{self.provider_id}: Boltz cannot cancel a structure prediction once submitted; "
            "it will finish and be billed"
        )


__all__ = ["BoltzBinding", "MODEL", "PREDICTIONS_PATH", "prediction_input"]
