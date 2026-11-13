"""subseq.bio binding .

Shape (from https://subseq.bio/docs/api, 2026-09-09): base `/api/v1`, bearer
key, uniform `{success, data?, error?}` envelope. Dynamic catalog via
`GET /program/list` and `GET /program/params?program=`; jobs via
`POST /job/submit` (multipart: program + params + optional files), status via
`GET /job/view?jobid=`, files via `GET /job/file?jobid=&path=` or a ZIP via
`GET /job/download?jobid=`. Per-program `cost_per_hour`, `submit_fee`,
`min_run_time` make a rate-card estimate possible; `GET /account/info` shows
credits. Rate limit ~6 req/s per IP with `Retry-After` on 429.
"""

from __future__ import annotations

import json
import re
from typing import Any, Mapping

import httpx

from ..contract import (
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
from ..result_archive import extract_text_result_archive

_STATE_MAP = {
    "pending": JobState.QUEUED,
    "queued": JobState.QUEUED,
    "running": JobState.RUNNING,
    "completed": JobState.COMPLETED,
    "complete": JobState.COMPLETED,
    "finished": JobState.COMPLETED,
    "failed": JobState.FAILED,
    "error": JobState.FAILED,
    "canceled": JobState.CANCELED,
    "cancelled": JobState.CANCELED,
}

_TEXT_EXT = re.compile(
    r"\.(pdb|cif|mmcif|fa|fasta|faa|csv|tsv|json|txt|log|a3m|sto)$", re.I
)

_INLINE_MAX_BYTES = 25 * 1024 * 1024

_PARAM_TYPES = {
    "sequence_text": "string",
    "string": "string",
    "text": "string",
    "ligand_smiles": "string",
    "int": "integer",
    "integer": "integer",
    "float": "number",
    "number": "number",
    "bool": "boolean",
    "boolean": "boolean",
    "repeatable_group": "array",
    "length_range": "string",
    "residue_selector": "string",
}


def _is_file_param(param: Mapping[str, Any]) -> bool:
    """File inputs travel as uploads, not as values inside `params`. Live subseq marks
    every one with a `*_file` or `input_folder` type and an `extensions` list (all 44
    file-like parameters across its 29 programs, 2026-09-10)."""
    kind = str(param.get("type") or "")
    return (
        kind.endswith("_file")
        or kind == "input_folder"
        or bool(param.get("extensions"))
    )


def _named(items: Any) -> list[Mapping[str, Any]]:
    return [i for i in items or [] if isinstance(i, Mapping) and i.get("name")]


def _default_mode(program: Mapping[str, Any]) -> str | None:
    modes = _named(program.get("modes"))
    for mode in modes:
        if mode.get("default"):
            return str(mode["name"])
    return str(modes[0]["name"]) if modes else None


def _param_property(param: Mapping[str, Any]) -> dict[str, Any]:
    kind = str(param.get("type") or "string")
    prop: dict[str, Any] = {"type": _PARAM_TYPES.get(kind, "string")}
    notes: list[str] = []
    text = param.get("help") or param.get("description") or param.get("label")
    if text:
        notes.append(str(text))
    if _is_file_param(param):
        extensions = ", ".join(str(e) for e in param.get("extensions") or [])
        notes.append(
            "File input: attach the file to the job"
            + (f" ({extensions})" if extensions else "")
            + " and put its file name here."
        )
    if param.get("modes"):
        notes.append(f"Only used in mode: {', '.join(str(m) for m in param['modes'])}.")
    depends = param.get("depends_on")
    if isinstance(depends, Mapping) and depends.get("param"):
        notes.append(f"Only used when {depends['param']} is {depends.get('value')!r}.")
    if notes:
        prop["description"] = " ".join(notes)
    if "default" in param:
        prop["default"] = param["default"]
    options = param.get("options") or param.get("choices")
    if options:
        prop["enum"] = list(options)
    if isinstance(param.get("min"), (int, float)):
        prop["minimum"] = param["min"]
    if isinstance(param.get("max"), (int, float)):
        prop["maximum"] = param["max"]
    if kind == "repeatable_group":
        fields = _named(param.get("fields"))
        prop["items"] = {
            "type": "object",
            "properties": {str(f["name"]): _param_property(f) for f in fields},
            "required": [str(f["name"]) for f in fields if f.get("required")],
        }
        if isinstance(param.get("min_items"), int):
            prop["minItems"] = param["min_items"]
        if isinstance(param.get("max_items"), int):
            prop["maxItems"] = param["max_items"]
    return prop


def _applies(
    param: Mapping[str, Any],
    mode: str | None,
    settings: Mapping[str, Any],
    by_name: Mapping[str, Mapping[str, Any]],
) -> bool:
    """A parameter counts only in its own modes and when its `depends_on` holds."""
    modes = param.get("modes")
    if modes and mode is not None and mode not in modes:
        return False
    depends = param.get("depends_on")
    if isinstance(depends, Mapping) and depends.get("param"):
        other = str(depends["param"])
        current = settings.get(other, (by_name.get(other) or {}).get("default"))
        return current == depends.get("value")
    return True


def _entry_path(entry: Any) -> str:
    if isinstance(entry, Mapping):
        path = entry.get("path")
        return path if isinstance(path, str) else ""
    return entry if isinstance(entry, str) else ""


class SubseqBinding(RestProviderBinding):
    """`ProviderBinding` for subseq.bio."""

    def __init__(
        self, manifest: ProviderManifest, *, client: httpx.AsyncClient | None = None
    ) -> None:
        super().__init__(manifest, client=client)
        self._programs: dict[str, Mapping[str, Any]] = {}
        self._params_cache: dict[str, Mapping[str, Any]] = {}

    def _data(self, response: httpx.Response) -> Any:
        payload = self.json_of(response)
        if not isinstance(payload, Mapping):
            raise ComputeProviderError(f"{self.provider_id}: non-JSON response")
        if payload.get("success") is False:
            message = str(payload.get("error") or "request failed")
            lowered = message.lower()
            if "credit" in lowered or "balance" in lowered:
                from ..contract import BudgetExhaustedError

                raise BudgetExhaustedError(
                    f"{self.provider_id}: {message}", status_code=response.status_code
                )
            if "not found" in lowered:
                raise UnknownJobError(f"{self.provider_id}: {message}", status_code=404)
            raise InvalidJobSettingsError(
                f"{self.provider_id}: {message}", problems=(message,)
            )
        return payload.get("data", payload)

    async def _load_programs(
        self, credential: ProviderCredential
    ) -> dict[str, Mapping[str, Any]]:
        response = await self._request("GET", "/program/list", credential)
        data = self._data(response)
        items = data.get("programs", data) if isinstance(data, Mapping) else data
        programs: dict[str, Mapping[str, Any]] = {}
        for item in items if isinstance(items, list) else []:
            if isinstance(item, Mapping) and item.get("name"):
                programs[str(item["name"])] = item
            elif isinstance(item, str):
                programs[item] = {"name": item}
        self._programs = programs
        return programs

    async def list_tools(
        self,
        credential: ProviderCredential,
        *,
        search: str | None = None,
        tags: tuple[str, ...] = (),
    ) -> list[ToolDescriptor]:
        programs = await self._load_programs(credential)
        out: list[ToolDescriptor] = []
        for name, prog in programs.items():
            display = str(prog.get("display_name") or prog.get("title") or name)
            description = str(prog.get("description") or "")
            haystack = f"{name} {display} {description}".lower()
            if search and not all(word in haystack for word in search.lower().split()):
                continue
            prog_tags = tuple(str(t) for t in (prog.get("tags") or []))
            if tags and not (
                {t.lower() for t in tags} & {t.lower() for t in prog_tags}
            ):
                continue
            out.append(
                ToolDescriptor(
                    id=name,
                    display_name=display,
                    description=description,
                    tags=prog_tags,
                )
            )
        return out

    async def _program_params(
        self, credential: ProviderCredential, tool_id: str
    ) -> Mapping[str, Any]:
        cached = self._params_cache.get(tool_id)
        if cached is not None:
            return cached
        response = await self._request(
            "GET", "/program/params", credential, params={"program": tool_id}
        )
        data = self._data(response)
        if not isinstance(data, Mapping):
            data = {"params": data if isinstance(data, list) else []}
        self._params_cache[tool_id] = data
        return data

    async def get_schema(
        self, credential: ProviderCredential, tool_id: str
    ) -> Mapping[str, Any]:
        """JSON Schema for the agent, built from subseq's live parameter format:
        `modes` become a `mode` enum; `help`/`options`/`min`/`max` carry over;
        only the default mode's applicable inputs are `required` (live ESMFold
        marks both the typed sequence and the FASTA file required, each for a
        different mode)."""
        program = await self._program_params(credential, tool_id)
        if program.get("type") == "object":
            return dict(program)
        params = _named(program.get("params"))
        by_name = {str(p["name"]): p for p in params}
        mode = _default_mode(program)
        properties: dict[str, Any] = {}
        modes = _named(program.get("modes"))
        if modes:
            properties["mode"] = {
                "type": "string",
                "enum": [str(m["name"]) for m in modes],
                "default": mode,
                "description": "Which input variant to run. "
                + " ".join(
                    f"{m['name']}: {m.get('description') or m.get('label') or ''}".strip()
                    for m in modes
                ),
            }
        required: list[str] = []
        for param in params:
            name = str(param["name"])
            properties[name] = _param_property(param)
            if (
                param.get("required")
                and not _is_file_param(param)
                and _applies(param, mode, {}, by_name)
            ):
                required.append(name)
        return {"type": "object", "properties": properties, "required": required}

    async def validate(
        self, credential: ProviderCredential, tool_id: str, settings: Mapping[str, Any]
    ) -> ValidationResult:
        program = await self._program_params(credential, tool_id)
        params = _named(program.get("params"))
        by_name = {str(p["name"]): p for p in params}
        mode_names = [str(m["name"]) for m in _named(program.get("modes"))]
        mode = settings.get("mode") or _default_mode(program)
        if mode_names and mode not in mode_names:
            return ValidationResult(
                ok=False, problems=(f"mode: must be one of {', '.join(mode_names)}",)
            )
        problems = [
            f"{param['name']}: required"
            for param in params
            if param.get("required")
            and not _is_file_param(param)
            and _applies(param, mode, settings, by_name)
            and settings.get(str(param["name"])) in (None, "", [])
        ]
        return ValidationResult(ok=not problems, problems=tuple(problems))

    async def estimate(
        self, credential: ProviderCredential, tool_id: str, settings: Mapping[str, Any]
    ) -> CostEstimate:
        programs = self._programs or await self._load_programs(credential)
        prog = programs.get(tool_id)
        if prog is None:
            raise InvalidJobSettingsError(
                f"{self.provider_id}: unknown program {tool_id!r}",
                problems=("tool_id: unknown",),
            )
        rate = prog.get("cost_per_hour")
        fee = prog.get("submit_fee") or 0
        min_hours = (
            float(prog.get("min_run_time") or 0) / 3600
            if isinstance(prog.get("min_run_time"), (int, float))
            else 0.0
        )
        if not isinstance(rate, (int, float)):
            return CostEstimate(
                amount=None, unit="credits", note="program publishes no rate"
            )
        amount = round(float(fee) + float(rate) * max(min_hours, 0.0), 4)
        return CostEstimate(
            amount=amount,
            unit="credits",
            estimated_seconds=(
                float(prog["min_run_time"])
                if isinstance(prog.get("min_run_time"), (int, float))
                else None
            ),
            note=f"submit fee {fee} + {rate} credits/hour; minimum run time billed",
        )

    async def submit(
        self, credential: ProviderCredential, request: SubmitRequest
    ) -> ProviderJobRef:
        settings = dict(request.settings)
        if "mode" not in settings:
            try:
                default_mode = _default_mode(
                    await self._program_params(credential, request.tool_id)
                )
            except ComputeProviderError:
                default_mode = None
            if default_mode:
                settings["mode"] = default_mode
        missing = await self._missing_files(
            credential, request.tool_id, settings, request.files
        )
        if missing:
            raise InvalidJobSettingsError(
                f"{self.provider_id}: required input file not attached",
                problems=tuple(missing),
            )
        parts: list[tuple[str, Any]] = [
            ("program", (None, request.tool_id)),
            ("params", (None, json.dumps(settings))),
        ]
        if request.label:
            parts.append(("memo", (None, request.label)))
        for name, content in request.files.items():
            parts.append(("folder", (name, content)))
        response = await self._request("POST", "/job/submit", credential, files=parts)
        payload = self._data(response)
        job_id = (
            payload.get("job_id") or payload.get("jobid") or payload.get("id")
            if isinstance(payload, Mapping)
            else None
        )
        if not job_id:
            raise ComputeProviderError(f"{self.provider_id}: submit returned no job id")
        return ProviderJobRef(self.provider_id, str(job_id), request.tool_id)

    async def status(
        self, credential: ProviderCredential, ref: ProviderJobRef
    ) -> JobStatus:
        response = await self._request(
            "GET", "/job/view", credential, params={"jobid": ref.remote_id}
        )
        job = self._data(response)
        if not isinstance(job, Mapping):
            raise UnknownJobError(
                f"{self.provider_id}: job {ref.remote_id} not found", status_code=404
            )
        raw = str(job.get("status") or "").lower()
        state = _STATE_MAP.get(raw, JobState.RUNNING)
        provider_state = raw
        progress_note = ""
        if state is JobState.COMPLETED and job.get("dl_ready") is False:
            state = JobState.RUNNING
            provider_state = "completed (preparing results)"
            progress_note = "Compute finished; Subseq is still preparing result files."
        cost = None
        if isinstance(job.get("cost"), (int, float)):
            cost = CostEstimate(amount=float(job["cost"]), unit="credits")
        return JobStatus(
            ref,
            state,
            provider_state=provider_state,
            progress_note=progress_note,
            cost=cost,
        )

    async def fetch_result(
        self, credential: ProviderCredential, ref: ProviderJobRef
    ) -> ResultBundle:
        response = await self._request(
            "GET", "/job/view", credential, params={"jobid": ref.remote_id}
        )
        job = self._data(response)
        entries = (
            (job.get("manifest") or job.get("files") or job.get("outputs") or [])
            if isinstance(job, Mapping)
            else []
        )
        if not entries and isinstance(job, Mapping) and job.get("dl_ready") is False:
            raise ProviderUnavailableError(
                f"{self.provider_id}: result archive for {ref.remote_id} is still preparing"
            )
        main_dir = await self._main_output_dir(credential, ref.tool_id)
        if main_dir:
            entries = sorted(
                entries, key=lambda e: 0 if _entry_path(e).startswith(main_dir) else 1
            )
        files: list[ResultFile] = []
        for entry in entries:
            path = _entry_path(entry)
            if not path:
                continue
            name = path.rsplit("/", 1)[-1]
            size = entry.get("size") if isinstance(entry, Mapping) else None
            too_big = isinstance(size, (int, float)) and size > _INLINE_MAX_BYTES
            if _TEXT_EXT.search(name) and not too_big:
                file_response = await self._request(
                    "GET",
                    "/job/file",
                    credential,
                    params={"jobid": ref.remote_id, "path": path},
                )
                files.append(
                    ResultFile(
                        name=name,
                        content=file_response.content,
                        media_type=str(
                            file_response.headers.get("content-type", "text/plain")
                        ),
                        size_bytes=len(file_response.content),
                    )
                )
            else:
                files.append(
                    ResultFile(
                        name=name,
                        url=f"{self.base_url}/job/file?jobid={ref.remote_id}&path={path}",
                    )
                )
        if not files:
            archive_response = await self._request(
                "GET",
                "/job/download",
                credential,
                params={"jobid": ref.remote_id},
            )
            files.extend(extract_text_result_archive(archive_response.content))
            if not files:
                raise ProviderUnavailableError(
                    f"{self.provider_id}: result archive for {ref.remote_id} "
                    "contains no supported importable files"
                )
        names = " ".join(f.name.lower() for f in files)
        kind = (
            OutputKind.STRUCTURE
            if re.search(r"\.(pdb|cif|mmcif)\b", names)
            else (
                OutputKind.SEQUENCE_SET
                if re.search(r"\.(fa|fasta|faa)\b", names)
                else (
                    OutputKind.TABLE
                    if re.search(r"\.(csv|tsv|json)\b", names)
                    else OutputKind.BINARY
                )
            )
        )
        metrics = {
            k: v
            for k, v in (job.items() if isinstance(job, Mapping) else [])
            if k in ("score", "scores", "metrics", "cost")
        }
        return ResultBundle(
            ref=ref,
            output_kind=kind,
            files=tuple(files),
            metrics=metrics,
            provenance={
                "provider": self.provider_id,
                "tool": ref.tool_id,
                "remote_id": ref.remote_id,
            },
        )

    async def _missing_files(
        self,
        credential: ProviderCredential,
        tool_id: str,
        settings: Mapping[str, Any],
        files: Mapping[str, bytes],
    ) -> list[str]:
        if files:
            return []
        try:
            program = await self._program_params(credential, tool_id)
        except ComputeProviderError:
            return []
        params = _named(program.get("params"))
        by_name = {str(p["name"]): p for p in params}
        mode = settings.get("mode") or _default_mode(program)
        missing: list[str] = []
        for param in params:
            if (
                param.get("required")
                and _is_file_param(param)
                and _applies(param, mode, settings, by_name)
            ):
                extensions = ", ".join(str(e) for e in param.get("extensions") or [])
                missing.append(
                    f"{param['name']}: attach a file"
                    + (f" ({extensions})" if extensions else "")
                )
        return missing

    async def _main_output_dir(
        self, credential: ProviderCredential, tool_id: str
    ) -> str:
        try:
            programs = self._programs or await self._load_programs(credential)
        except ComputeProviderError:
            return ""
        return str((programs.get(tool_id) or {}).get("main_output_dir") or "").rstrip(
            "/"
        )

    async def cancel(
        self, credential: ProviderCredential, ref: ProviderJobRef
    ) -> JobStatus:
        response = await self._request(
            "POST",
            "/job/cancel",
            credential,
            params={"jobid": ref.remote_id},
            accept_statuses=(200, 202, 404),
        )
        if response.status_code == 404:
            raise UnknownJobError(
                f"{self.provider_id}: job {ref.remote_id} not found", status_code=404
            )
        return JobStatus(ref, JobState.CANCELED, provider_state="canceled")


__all__ = ["SubseqBinding"]
