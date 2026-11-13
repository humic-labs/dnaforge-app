"""Generic, manifest-driven MCP binding .

One class serves every provider whose manifest says `transport: "mcp"`. It is an
MCP *client* to the provider's remote streamable-HTTP server; the manifest's
`toolMap` names the remote tool for each of our eight operations and binds the
remote tool's arguments to placeholders this binding resolves per call.

Why the agent does not talk to the remote server directly: every compute call
must pass DNAForge's single authorization + audit gate (`callRendererTool`).
Putting the MCP client here, behind our routes, keeps that invariant and still
gives us the provider's agent-tuned tool surface (Tamarind: `estimateTime`,
`getJobSchema`, read-only annotations) without provider-specific code.

Session model: one MCP session per call. Stateless, so no credential is held
between calls and a dropped connection cannot poison later calls. The cost is
one `initialize` round trip per operation, acceptable for minute-scale jobs.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Callable, Mapping

import anyio
import httpx2
from mcp import ClientSession
from mcp import types as mcp_types
from mcp.client.streamable_http import streamable_http_client

from .contract import (
    BadCredentialError,
    BudgetExhaustedError,
    ComputeOperation,
    ComputeProviderError,
    ComputeRateLimitError,
    CostEstimate,
    InvalidJobSettingsError,
    JobState,
    JobStatus,
    MappedToolMissingError,
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
from .manifests import ProviderManifest, ToolMapping
from .result_archive import RESULT_TEXT_EXT, extract_text_result_archive

logger = logging.getLogger(__name__)

HttpClientFactory = Callable[[dict[str, str]], httpx2.AsyncClient]

_DEFAULT_TIMEOUT = httpx2.Timeout(30.0, read=300.0)


def _default_http_client(headers: dict[str, str]) -> httpx2.AsyncClient:
    return httpx2.AsyncClient(
        headers=headers, timeout=_DEFAULT_TIMEOUT, follow_redirects=False
    )


DownloadClientFactory = Callable[[], httpx2.AsyncClient]
_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024


def _default_download_client() -> httpx2.AsyncClient:
    return httpx2.AsyncClient(
        timeout=httpx2.Timeout(30.0, read=300.0), follow_redirects=True
    )


def _result_url(payload: Any) -> str | None:
    """Tamarind's `getResult` answers with a signed link to the whole result bundle,
    as a bare string or under `url`/`downloadUrl`/`presignedUrl` (official
    tamarind-cli `_result_url`, read 2026-09-10)."""
    if isinstance(payload, str) and payload.strip().startswith("https://"):
        return payload.strip()
    if isinstance(payload, Mapping):
        for key in ("url", "downloadUrl", "presignedUrl", "resultUrl", "ResultsURL"):
            value = payload.get(key)
            if isinstance(value, str) and value.startswith("https://"):
                return value
    return None


_METRIC_DENY = frozenset(
    {"sequence", "sequences", "pdb_filepath", "filepath", "path", "name", "jobname"}
)
_METRIC_MAX_KEYS = 24


def _as_number(text: Any) -> float | int | None:
    try:
        value = float(text)
    except (TypeError, ValueError):
        return None
    return int(value) if value.is_integer() and abs(value) < 1e15 else value


def _metrics_from_files(files: list[ResultFile]) -> dict[str, Any]:
    """Provider-reported scores that travelled inside the RESULT BUNDLE.

    Live Tamarind answers `getResult` with a signed zip and no numbers in the reply
    at all, so the pTM and pLDDT it had already computed sat unread inside
    `metrics.csv` while the job record showed nothing. NVIDIA and Boltz report
    theirs as JSON fields and are unaffected; this is the file-shaped case.

    Numeric values only, and never a column that names the input, so a submitted
    sequence cannot end up presented as a score.
    """
    metrics: dict[str, Any] = {}
    for f in files:
        name = f.name.lower()
        if f.content is None or not ("metric" in name or "score" in name):
            continue
        if name.endswith(".json"):
            try:
                parsed = json.loads(f.content.decode("utf-8", "replace"))
            except ValueError:
                continue
            if isinstance(parsed, Mapping):
                for key, value in parsed.items():
                    if str(key).lower() in _METRIC_DENY:
                        continue
                    number = _as_number(value)
                    if number is not None:
                        metrics.setdefault(str(key), number)
        elif name.endswith((".csv", ".tsv")):
            sep = "\t" if name.endswith(".tsv") else ","
            rows = [
                r
                for r in f.content.decode("utf-8", "replace").splitlines()
                if r.strip()
            ]
            if len(rows) < 2:
                continue
            for key, raw in zip(rows[0].split(sep), rows[1].split(sep), strict=False):
                key = key.strip()
                if key.lower() in _METRIC_DENY:
                    continue
                number = _as_number(raw.strip())
                if number is not None:
                    metrics.setdefault(key, number)
    for f in files:
        m = re.search(r"ptm([0-9]*\.?[0-9]+)", f.name, re.I)
        if not m:
            continue
        metrics.setdefault("pae_file", f.name)
        if not any(k.lower() == "ptm" for k in metrics):
            number = _as_number(m.group(1))
            if number is not None:
                metrics["ptm"] = number
        break
    return dict(list(metrics.items())[:_METRIC_MAX_KEYS])


def _output_kind(files: list[ResultFile] | tuple[ResultFile, ...]) -> OutputKind:
    names = " ".join(f.name.lower() for f in files)
    if re.search(r"\.(pdb|cif|mmcif|bcif)\b", names):
        return OutputKind.STRUCTURE
    if re.search(r"\.(fa|fasta|faa)\b", names):
        return OutputKind.SEQUENCE_SET
    if re.search(r"\.(csv|tsv|json)\b", names):
        return OutputKind.TABLE
    return OutputKind.BINARY


def _validation_label(tool_id: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_-]", "-", tool_id)[:40]
    return f"dnaforge-validate-{safe}-{uuid.uuid4().hex[:8]}"


def _find_compute_error(exc: BaseException) -> ComputeProviderError | None:
    """Unwrap anyio/TaskGroup ExceptionGroups down to a ComputeProviderError, if any."""
    if isinstance(exc, ComputeProviderError):
        return exc
    if isinstance(exc, BaseExceptionGroup):
        for inner in exc.exceptions:
            found = _find_compute_error(inner)
            if found is not None:
                return found
    return None


def _is_mcp_failure(exc: BaseException) -> bool:
    """True when the exception (or any member of an ExceptionGroup) came from the
    MCP/transport stack rather than from our own code."""
    from mcp.shared.exceptions import MCPError

    if isinstance(
        exc,
        (
            MCPError,
            httpx2.HTTPError,
            anyio.ClosedResourceError,
            anyio.BrokenResourceError,
            OSError,
        ),
    ):
        return True
    if isinstance(exc, BaseExceptionGroup):
        return any(_is_mcp_failure(inner) for inner in exc.exceptions)
    return False


def _walk(obj: Any, path: str) -> Any:
    """Dotted-path lookup with `[n]` list indexes. Missing → None."""
    if not path:
        return obj
    current = obj
    for part in re.split(r"\.(?![^\[]*\])", path):
        if not part:
            continue
        m = re.fullmatch(r"([^\[]*)((?:\[\d+\])*)", part)
        if not m:
            return None
        key, indexes = m.group(1), m.group(2)
        if key:
            if not isinstance(current, Mapping) or key not in current:
                return None
            current = current[key]
        for idx in re.findall(r"\[(\d+)\]", indexes):
            if not isinstance(current, list) or int(idx) >= len(current):
                return None
            current = current[int(idx)]
    return current


def _parsed_document(value: Any) -> Any:
    """Unwrap a JSON document that a provider returned as TEXT.

    Live Tamarind answers every tool with a JSON document serialized into a single
    string, which the MCP server SDK then reports as a scalar result. Without this,
    each coercion below received a `str`, matched none of its shapes, and silently
    produced nothing: a real key verified and then offered an EMPTY catalog.

    Only an object/array document is parsed. A plain sentence ("job submitted.") and
    a bare scalar are returned untouched, so a numeric job id stays the string it was.
    """
    if not isinstance(value, str):
        return value
    text = value.strip()
    if not text or text[0] not in "{[":
        return value
    try:
        parsed = json.loads(text)
    except ValueError:
        return value
    if isinstance(parsed, (Mapping, list)):
        return parsed
    return value


def _result_payload(result: mcp_types.CallToolResult) -> Any:
    """Prefer structured content; else parse the first text block as JSON; else raw text."""
    if result.structured_content is not None:
        structured = result.structured_content
        if isinstance(structured, Mapping) and set(structured) == {"result"}:
            return _parsed_document(structured["result"])
        return structured
    texts = [c.text for c in result.content if isinstance(c, mcp_types.TextContent)]
    if not texts:
        return None
    joined = "\n".join(texts)
    try:
        return _parsed_document(json.loads(joined))
    except ValueError:
        return joined


def _error_text(result: mcp_types.CallToolResult) -> str:
    payload = _result_payload(result)
    return payload if isinstance(payload, str) else json.dumps(payload)[:500]


def classify_tool_error(message: str) -> ComputeProviderError:
    """Map a provider's error text onto our typed errors. Conservative: only
    unambiguous signals get a specific class; everything else is generic."""
    lowered = message.lower()
    if re.search(r"\b401\b|unauthori[sz]ed|invalid api key|api key", lowered):
        return BadCredentialError(message, status_code=401)
    if re.search(
        r"budget|insufficient credits|out of credits|quota exceeded|"
        r"monthly[_ ](?:job )?limit(?: exceeded)?|monthly_limit_exceeded",
        lowered,
    ):
        return BudgetExhaustedError(message, status_code=403)
    if re.search(r"\b429\b|rate limit|too many requests", lowered):
        return ComputeRateLimitError(message)
    if re.search(r"not found|unknown job|no such job", lowered):
        return UnknownJobError(message, status_code=404)
    if re.search(r"\b5\d\d\b|at_capacity|queue is full|service unavailable", lowered):
        return ProviderUnavailableError(message, status_code=503)
    if re.search(r"invalid|missing|required|must be", lowered):
        return InvalidJobSettingsError(message)
    return ComputeProviderError(message)


class McpProviderBinding:
    """`ProviderBinding` over a remote MCP server, configured only by the manifest."""

    def __init__(
        self,
        manifest: ProviderManifest,
        *,
        http_client_factory: HttpClientFactory = _default_http_client,
        download_client_factory: DownloadClientFactory = _default_download_client,
    ) -> None:
        if manifest.transport != "mcp" or not manifest.mcp_url:
            raise ValueError(
                f"{manifest.id}: McpProviderBinding requires transport 'mcp' with mcpUrl"
            )
        self.manifest = manifest
        self.provider_id = manifest.id
        self._http_client_factory = http_client_factory
        self._download_client_factory = download_client_factory

    @asynccontextmanager
    async def _session(
        self, credential: ProviderCredential
    ) -> AsyncIterator[ClientSession]:
        headers = credential.as_headers()
        last_status: list[int] = []
        body_raised = False

        async def _record(response: httpx2.Response) -> None:
            if response.status_code >= 400:
                last_status.append(response.status_code)

        try:
            async with self._http_client_factory(headers) as http_client:
                http_client.event_hooks["response"] = [
                    *http_client.event_hooks.get("response", []),
                    _record,
                ]
                async with streamable_http_client(
                    self.manifest.mcp_url or "", http_client=http_client
                ) as (read, write):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        try:
                            yield session
                        except BaseException:
                            body_raised = True
                            raise
        except ComputeProviderError:
            raise
        except httpx2.HTTPStatusError as exc:  # pragma: no cover - transport-specific
            raise self._from_http_status(exc.response.status_code, str(exc)) from exc
        except (
            httpx2.TransportError,
            anyio.ClosedResourceError,
            anyio.BrokenResourceError,
            OSError,
        ) as exc:
            raise ProviderUnavailableError(
                f"{self.provider_id}: cannot reach MCP server: {exc}"
            ) from exc
        except (
            BaseException
        ) as exc:  # noqa: BLE001 - the MCP stack raises anyio ExceptionGroups
            ours = _find_compute_error(exc)
            if ours is not None:
                raise ours from exc
            if last_status:
                raise self._from_http_status(last_status[-1], str(exc)) from exc
            mapped = self._from_exception(exc)
            if mapped is not None:
                raise mapped from exc
            if body_raised and not _is_mcp_failure(exc):
                raise
            if isinstance(exc, Exception):
                raise ProviderUnavailableError(
                    f"{self.provider_id}: MCP session failed: {exc}"
                ) from exc
            raise

    def _from_http_status(self, status_code: int, message: str) -> ComputeProviderError:
        if status_code in (401, 403):
            return BadCredentialError(
                f"{self.provider_id}: rejected credential ({status_code})",
                status_code=status_code,
            )
        if status_code == 429:
            return ComputeRateLimitError(f"{self.provider_id}: rate limited")
        if status_code >= 500:
            return ProviderUnavailableError(
                f"{self.provider_id}: MCP server error {status_code}",
                status_code=status_code,
            )
        return ComputeProviderError(
            f"{self.provider_id}: {message}", status_code=status_code
        )

    def _from_exception(self, exc: BaseException) -> ComputeProviderError | None:
        """The MCP client surfaces HTTP failures as ExceptionGroups / McpError;
        dig for a status code or a transport failure."""
        text = str(exc)
        m = re.search(r"\b(401|403|429|5\d\d)\b", text)
        if m:
            return self._from_http_status(int(m.group(1)), text)
        from mcp.shared.exceptions import MCPError

        if isinstance(exc, MCPError):
            mapped = classify_tool_error(f"{self.provider_id}: {exc}")
            if isinstance(
                mapped,
                (BadCredentialError, BudgetExhaustedError, ComputeRateLimitError),
            ):
                return mapped
        if isinstance(exc, BaseExceptionGroup):
            for inner in exc.exceptions:
                mapped = self._from_exception(inner)
                if mapped is not None:
                    return mapped
        if isinstance(exc, (httpx2.TransportError, OSError)):
            return ProviderUnavailableError(
                f"{self.provider_id}: cannot reach MCP server: {exc}"
            )
        if "connect" in text.lower() or "unreachable" in text.lower():
            return ProviderUnavailableError(
                f"{self.provider_id}: cannot reach MCP server: {exc}"
            )
        return None

    def _mapping(self, operation: ComputeOperation) -> ToolMapping:
        mapping = self.manifest.mapping_for(operation)
        if mapping is None:
            raise MappedToolMissingError(
                operation, f"<no toolMap entry for {operation.value}>"
            )
        return mapping

    @staticmethod
    def _bind_args(mapping: ToolMapping, values: Mapping[str, Any]) -> dict[str, Any]:
        args: dict[str, Any] = {}
        for remote_arg, placeholder in mapping.args.items():
            value = values.get(placeholder)
            if value is None:
                continue
            args[remote_arg] = value
        return args

    async def _call(
        self,
        session: ClientSession,
        operation: ComputeOperation,
        values: Mapping[str, Any],
    ) -> Any:
        mapping = self._mapping(operation)
        listed = await session.list_tools()
        if mapping.tool not in {t.name for t in listed.tools}:
            raise MappedToolMissingError(operation, mapping.tool)
        result = await session.call_tool(mapping.tool, self._bind_args(mapping, values))
        if not isinstance(result, mcp_types.CallToolResult):
            raise ComputeProviderError(
                f"{self.provider_id}: {mapping.tool} returned an unexpected result type"
            )
        if result.is_error:
            raise classify_tool_error(
                f"{self.provider_id}/{mapping.tool}: {_error_text(result)}"
            )
        payload = _result_payload(result)
        self._raise_payload_fault(operation, mapping, payload)
        return _walk(payload, mapping.result_path) if mapping.result_path else payload

    def _raise_payload_fault(
        self, operation: ComputeOperation, mapping: ToolMapping, payload: Any
    ) -> None:
        """Reject a provider fault delivered as a SUCCESSFUL tool result.

        Live Tamarind answers an overloaded jobs list with `isError` unset and a
        body of `{"error": "{...\"status\":503,\"code\":\"lane_at_capacity\"...}"}`.
        Read as data, that payload carries no status, so `_coerce_status` reported a
        perfectly healthy QUEUED job and the poller waited forever. Validation is
        excluded because `validateJob` legitimately reports a rejection the same way
        (`{valid: false, error: "sequence: required"}`).
        """
        if operation is ComputeOperation.VALIDATE:
            return
        if not isinstance(payload, Mapping):
            return
        fault = payload.get("error")
        if not fault:
            return
        if isinstance(fault, Mapping):
            detail = str(fault.get("detail") or fault.get("message") or fault)
            status = fault.get("status")
        else:
            detail = str(fault)
            status = None
        text = f"{self.provider_id}/{mapping.tool}: {detail}"[:500]
        if isinstance(status, int):
            raise self._from_http_status(status, text)
        raise classify_tool_error(text)

    async def list_tools(
        self,
        credential: ProviderCredential,
        *,
        search: str | None = None,
        tags: tuple[str, ...] = (),
    ) -> list[ToolDescriptor]:
        async with self._session(credential) as session:
            payload = await self._call(
                session,
                ComputeOperation.LIST_TOOLS,
                {
                    "$search": search,
                    "$tags": list(tags) or None,
                    "$tag": tags[0].lower() if tags else None,
                },
            )
        return _coerce_tools(payload, tags)

    async def verify_credential(self, credential: ProviderCredential) -> None:
        """Connect-time proof the key works: call the manifest's `verify` tool. Live
        Tamarind accepts `initialize` from ANY key and reports a wrong one only in
        the tool's reply (HTTP 200), so this has to be a real, read-only tool call
        classified from the tool's own error text."""
        target = str(self.manifest.verify.get("target") or "")
        async with self._session(credential) as session:
            if not target:
                await session.list_tools()
                return
            result = await session.call_tool(target, {})
            if not isinstance(result, mcp_types.CallToolResult):
                raise ComputeProviderError(
                    f"{self.provider_id}: {target} returned an unexpected result type"
                )
            if result.is_error:
                raise classify_tool_error(
                    f"{self.provider_id}/{target}: {_error_text(result)}"
                )

    async def get_schema(
        self, credential: ProviderCredential, tool_id: str
    ) -> Mapping[str, Any]:
        async with self._session(credential) as session:
            payload = await self._call(
                session, ComputeOperation.GET_SCHEMA, {"$tool_id": tool_id}
            )
        if isinstance(payload, Mapping):
            return dict(payload)
        return {"schema": payload}

    async def validate(
        self, credential: ProviderCredential, tool_id: str, settings: Mapping[str, Any]
    ) -> ValidationResult:
        if self.manifest.mapping_for(ComputeOperation.VALIDATE) is None:
            return ValidationResult(
                ok=True, problems=("provider has no validate tool; schema-only",)
            )
        async with self._session(credential) as session:
            try:
                payload = await self._call(
                    session,
                    ComputeOperation.VALIDATE,
                    {
                        "$tool_id": tool_id,
                        "$settings": dict(settings),
                        "$label": _validation_label(tool_id),
                    },
                )
            except InvalidJobSettingsError as exc:
                return ValidationResult(ok=False, problems=exc.problems or (str(exc),))
        return _coerce_validation(payload)

    async def estimate(
        self, credential: ProviderCredential, tool_id: str, settings: Mapping[str, Any]
    ) -> CostEstimate:
        if self.manifest.mapping_for(ComputeOperation.ESTIMATE) is None:
            return CostEstimate(
                amount=None, unit=self.manifest.cost, note="provider cannot estimate"
            )
        async with self._session(credential) as session:
            payload = await self._call(
                session,
                ComputeOperation.ESTIMATE,
                {"$tool_id": tool_id, "$settings": dict(settings)},
            )
        return _coerce_estimate(payload)

    async def submit(
        self, credential: ProviderCredential, request: SubmitRequest
    ) -> ProviderJobRef:
        label = request.label or _default_label(request)
        remote_name = _remote_job_name(label, request)
        async with self._session(credential) as session:
            payload = await self._call(
                session,
                ComputeOperation.SUBMIT,
                {
                    "$tool_id": request.tool_id,
                    "$settings": dict(request.settings),
                    "$label": remote_name,
                    "$files": {
                        k: v.decode("utf-8", "replace")
                        for k, v in request.files.items()
                    }
                    or None,
                    "$idempotency_key": request.idempotency_key,
                },
            )
        remote_id = remote_name
        if self.manifest.remote_id_path:
            found = _walk(payload, self.manifest.remote_id_path)
            if isinstance(found, (str, int)):
                remote_id = str(found)
        return ProviderJobRef(self.provider_id, remote_id, request.tool_id)

    async def status(
        self, credential: ProviderCredential, ref: ProviderJobRef
    ) -> JobStatus:
        async with self._session(credential) as session:
            payload = await self._call(
                session, ComputeOperation.STATUS, {"$remote_id": ref.remote_id}
            )
        return self._coerce_status(ref, payload)

    async def fetch_result(
        self, credential: ProviderCredential, ref: ProviderJobRef
    ) -> ResultBundle:
        async with self._session(credential) as session:
            payload = await self._call(
                session, ComputeOperation.FETCH_RESULT, {"$remote_id": ref.remote_id}
            )
        bundle_url = _result_url(payload)
        base = _coerce_result(ref, None if isinstance(payload, str) else payload)
        files = [f for f in base.files if f.content is not None]
        skipped: list[str] = []
        if bundle_url is not None:
            data = await self._download(bundle_url)
            if data[:4] == b"PK\x03\x04":
                files.extend(extract_text_result_archive(data))
            else:
                name = bundle_url.split("?", 1)[0].rsplit("/", 1)[-1] or "result"
                if RESULT_TEXT_EXT.search(name):
                    files.append(ResultFile(name=name, content=data))
                else:
                    skipped.append(name)
        for f in base.files:
            if f.content is None and f.url:
                if RESULT_TEXT_EXT.search(f.name):
                    files.append(
                        ResultFile(name=f.name, content=await self._download(f.url))
                    )
                else:
                    skipped.append(f.name)
        provenance = dict(base.provenance)
        if skipped:
            provenance["skipped_files"] = ", ".join(skipped)[:500]
        return ResultBundle(
            ref=ref,
            output_kind=_output_kind(files),
            files=tuple(files),
            metrics=base.metrics or _metrics_from_files(files),
            provenance=provenance,
        )

    async def _download(self, url: str) -> bytes:
        if not url.startswith("https://"):
            raise ProviderUnavailableError(
                f"{self.provider_id}: refusing a non-https result link"
            )
        chunks: list[bytes] = []
        total = 0
        try:
            async with self._download_client_factory() as client:
                async with client.stream("GET", url) as response:
                    if response.status_code != 200:
                        raise ProviderUnavailableError(
                            f"{self.provider_id}: result download failed "
                            f"({response.status_code}); the link may have expired, "
                            "fetch the result again",
                            status_code=response.status_code,
                        )
                    async for chunk in response.aiter_bytes():
                        total += len(chunk)
                        if total > _DOWNLOAD_MAX_BYTES:
                            raise ProviderUnavailableError(
                                f"{self.provider_id}: result bundle is larger than "
                                f"{_DOWNLOAD_MAX_BYTES // (1024 * 1024)} MB"
                            )
                        chunks.append(chunk)
        except (httpx2.TransportError, OSError) as exc:
            raise ProviderUnavailableError(
                f"{self.provider_id}: cannot download the result ({type(exc).__name__})"
            ) from exc
        return b"".join(chunks)

    async def cancel(
        self, credential: ProviderCredential, ref: ProviderJobRef
    ) -> JobStatus:
        if self.manifest.mapping_for(ComputeOperation.CANCEL) is None:
            raise ComputeProviderError(
                f"{self.provider_id}: provider has no cancel tool"
            )
        async with self._session(credential) as session:
            await self._call(
                session, ComputeOperation.CANCEL, {"$remote_id": ref.remote_id}
            )
        return JobStatus(ref, JobState.CANCELED, provider_state="canceled-by-client")

    def _coerce_status(self, ref: ProviderJobRef, payload: Any) -> JobStatus:
        record = payload
        if isinstance(payload, Mapping) and isinstance(payload.get("jobs"), list):
            jobs = payload["jobs"]
            record = next(
                (
                    j
                    for j in jobs
                    if isinstance(j, Mapping)
                    and str(j.get("JobName", j.get("jobName"))) == ref.remote_id
                ),
                jobs[0] if jobs else None,
            )
        if record is None:
            raise UnknownJobError(
                f"{self.provider_id}: job {ref.remote_id!r} not found", status_code=404
            )
        raw_state = (
            _walk(record, self.manifest.status_path)
            if self.manifest.status_path
            else None
        )
        if raw_state is None and isinstance(record, Mapping):
            raw_state = record.get("status") or record.get("state")
        provider_state = str(raw_state or "")
        mapped = self.manifest.status_map.get(provider_state.lower())
        if mapped is None:
            logger.warning(
                "compute.%s: unmapped provider status %r for %s",
                self.provider_id,
                provider_state,
                ref.remote_id,
            )
            state = JobState.RUNNING if provider_state else JobState.QUEUED
        else:
            state = JobState(mapped)
        cost = None
        if isinstance(record, Mapping):
            for key in ("WeightedHours", "weightedHours", "cost"):
                if isinstance(record.get(key), (int, float)):
                    cost = CostEstimate(
                        amount=float(record[key]),
                        unit="weighted_hours" if "eighted" in key else "credits",
                    )
                    break
        return JobStatus(ref, state, provider_state=provider_state, cost=cost)


_MAX_REMOTE_JOB_NAME = 100


def _remote_job_name(label: str, request: SubmitRequest) -> str:
    """A provider-safe job name derived from a human label.

    Keeps it within `_MAX_REMOTE_JOB_NAME`, restricted to characters that survive
    a URL and a file path, and still unique: a truncated name keeps a digest of
    the full label so two long labels cannot collide.
    """
    import hashlib
    import re

    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", label).strip("-._")
    if not cleaned:
        return _default_label(request)
    if len(cleaned) <= _MAX_REMOTE_JOB_NAME:
        return cleaned
    digest = hashlib.sha256(label.encode()).hexdigest()[:8]
    head = cleaned[: _MAX_REMOTE_JOB_NAME - len(digest) - 1].rstrip("-._")
    return f"{head}-{digest}"


def _default_label(request: SubmitRequest) -> str:
    import hashlib
    import time

    digest = hashlib.sha256(
        json.dumps(request.settings, sort_keys=True, default=str).encode()
    ).hexdigest()[:8]
    return f"dnaforge-{request.tool_id}-{int(time.time())}-{digest}"


def _coerce_tools(payload: Any, tags: tuple[str, ...]) -> list[ToolDescriptor]:
    items: list[Any]
    if isinstance(payload, Mapping):
        for key in ("tools", "items", "results", "data"):
            if isinstance(payload.get(key), list):
                items = payload[key]
                break
        else:
            items = [
                {
                    "name": k,
                    **(v if isinstance(v, Mapping) else {"description": str(v)}),
                }
                for k, v in payload.items()
            ]
    elif isinstance(payload, list):
        items = payload
    else:
        items = []
    out: list[ToolDescriptor] = []
    wanted = {t.lower() for t in tags}
    for item in items:
        if isinstance(item, str):
            out.append(ToolDescriptor(id=item, display_name=item))
            continue
        if not isinstance(item, Mapping):
            continue
        tool_id = item.get("name") or item.get("id") or item.get("type")
        if not tool_id:
            continue
        item_tags: list[str] = []
        for key in (
            "tags",
            "functions",
            "function",
            "modality",
            "modalities",
            "category",
            "categories",
        ):
            v = item.get(key)
            if isinstance(v, str):
                item_tags.append(v)
            elif isinstance(v, list):
                item_tags.extend(str(x) for x in v)
        if wanted and not (wanted & {t.lower() for t in item_tags}):
            continue
        out.append(
            ToolDescriptor(
                id=str(tool_id),
                display_name=str(
                    item.get("title") or item.get("displayName") or tool_id
                ),
                description=str(item.get("description") or ""),
                tags=tuple(item_tags),
                output_kind=_guess_output_kind(item),
            )
        )
    return out


_OUTPUT_TYPE_KINDS: tuple[tuple[frozenset[str], OutputKind], ...] = (
    (
        frozenset({"pdb", "cif", "mmcif", "pdbqt", "structure", "sdf", "mol2"}),
        OutputKind.STRUCTURE,
    ),
    (frozenset({"fasta", "fa", "sequence", "sequences"}), OutputKind.SEQUENCE_SET),
    (frozenset({"csv", "tsv", "table", "json", "scores"}), OutputKind.TABLE),
    (frozenset({"zip", "npz", "binary", "archive"}), OutputKind.BINARY),
)


def _guess_output_kind(item: Mapping[str, Any]) -> OutputKind | None:
    raw = item.get("outputKind") or item.get("output_kind")
    if isinstance(raw, str):
        try:
            return OutputKind(raw)
        except ValueError:
            return None
    declared = item.get("outputTypes") or item.get("output_types")
    if isinstance(declared, str):
        declared = [declared]
    if isinstance(declared, list):
        lowered = {str(x).lower().lstrip(".") for x in declared}
        for names, kind in _OUTPUT_TYPE_KINDS:
            if lowered & names:
                return kind
    return None


def _coerce_validation(payload: Any) -> ValidationResult:
    if isinstance(payload, Mapping):
        ok = payload.get("valid", payload.get("ok", payload.get("isValid")))
        problems = (
            payload.get("errors")
            or payload.get("problems")
            or payload.get("issues")
            or payload.get("error")
            or []
        )
        if isinstance(problems, str):
            problems = [problems]
        if ok is None:
            ok = not problems
        mutated = payload.get("mutatedFields")
        if mutated:
            fields = (
                ", ".join(str(m) for m in mutated)
                if isinstance(mutated, (list, tuple))
                else str(mutated)
            )
            problems = [
                *problems,
                f"provider changed these settings while validating: {fields}; fix them and validate again",
            ]
            ok = False
        return ValidationResult(ok=bool(ok), problems=tuple(str(p) for p in problems))
    if isinstance(payload, str):
        lowered = payload.lower()
        ok = "valid" in lowered and "invalid" not in lowered
        return ValidationResult(ok=ok, problems=() if ok else (payload,))
    return ValidationResult(ok=True)


def _coerce_estimate(payload: Any) -> CostEstimate:
    if isinstance(payload, Mapping):
        amount = None
        unit = "weighted_hours"
        for key, u in (
            ("weightedHours", "weighted_hours"),
            ("WeightedHours", "weighted_hours"),
            ("weighted_hours", "weighted_hours"),
            ("credits", "credits"),
            ("cost", "credits"),
        ):
            if isinstance(payload.get(key), (int, float)):
                amount, unit = float(payload[key]), u
                break
        seconds = None
        for key in ("estimatedSeconds", "estimated_seconds", "seconds"):
            if isinstance(payload.get(key), (int, float)):
                seconds = float(payload[key])
                break
        for key in ("estimatedMinutes", "minutes"):
            if seconds is None and isinstance(payload.get(key), (int, float)):
                seconds = float(payload[key]) * 60
        for key in ("estimatedHours", "hours"):
            if seconds is None and isinstance(payload.get(key), (int, float)):
                seconds = float(payload[key]) * 3600
        note = str(payload.get("note") or payload.get("message") or "")
        return CostEstimate(
            amount=amount, unit=unit, estimated_seconds=seconds, note=note
        )
    return CostEstimate(amount=None, unit="unknown", note=str(payload or "")[:200])


def _coerce_result(ref: ProviderJobRef, payload: Any) -> ResultBundle:
    files: list[ResultFile] = []
    metrics: dict[str, Any] = {}
    provenance: dict[str, str] = {
        "provider": ref.provider_id,
        "remote_id": ref.remote_id,
        "tool": ref.tool_id,
    }
    kind = OutputKind.BINARY
    if isinstance(payload, Mapping):
        candidates = (
            payload.get("files")
            or payload.get("outputs")
            or payload.get("results")
            or []
        )
        if isinstance(candidates, Mapping):
            candidates = [
                {"name": k, **(v if isinstance(v, Mapping) else {"url": v})}
                for k, v in candidates.items()
            ]
        for f in candidates if isinstance(candidates, list) else []:
            if isinstance(f, str):
                files.append(ResultFile(name=f.rsplit("/", 1)[-1], url=f))
            elif isinstance(f, Mapping):
                name = str(
                    f.get("name") or f.get("path") or f.get("filename") or "result"
                )
                url = f.get("url") or f.get("downloadUrl") or f.get("href")
                content = f.get("content")
                if isinstance(content, str):
                    files.append(
                        ResultFile(
                            name=name,
                            content=content.encode(),
                            media_type=str(f.get("mediaType") or "text/plain"),
                        )
                    )
                elif isinstance(url, str):
                    files.append(
                        ResultFile(name=name, url=url, size_bytes=f.get("size"))
                    )
        for key in (
            "metrics",
            "scores",
            "Score",
            "score",
            "confidence",
            "iptm",
            "ptm",
            "plddt",
            "affinity",
        ):
            if key in payload:
                metrics[key] = payload[key]
        for key in ("version", "TamarindSchemaVersion", "modelVersion", "tool_version"):
            if isinstance(payload.get(key), (str, int, float)):
                provenance[key] = str(payload[key])
        for key in ("pdb", "pdbs", "cif", "structure"):
            v = payload.get(key)
            if isinstance(v, str):
                files.append(
                    ResultFile(
                        name=f"model.{'cif' if key == 'cif' else 'pdb'}",
                        content=v.encode(),
                        media_type="chemical/x-pdb",
                    )
                )
            elif isinstance(v, list):
                for i, s in enumerate(v):
                    if isinstance(s, str):
                        files.append(
                            ResultFile(
                                name=f"model_{i + 1}.pdb",
                                content=s.encode(),
                                media_type="chemical/x-pdb",
                            )
                        )
    elif isinstance(payload, str) and payload.strip():
        files.append(
            ResultFile(
                name="result.txt", content=payload.encode(), media_type="text/plain"
            )
        )
    kind = _output_kind(files)
    return ResultBundle(
        ref=ref,
        output_kind=kind,
        files=tuple(files),
        metrics=metrics,
        provenance=provenance,
    )


__all__ = ["HttpClientFactory", "McpProviderBinding", "classify_tool_error"]
