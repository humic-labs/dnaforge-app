"""Shared fakes for compute-endpoint tests .

`FakeTamarindMcp` is an in-process MCP server with Tamarind-shaped tool names
and result shapes, served over an ASGI transport so the real MCP client code
path is exercised with no network. A header gate in front of it plays the
provider's auth layer (401 on a bad key, optional 429/500 injection).
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

import httpx2
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings

GOOD_KEY = "tmr-test-key-GOODSECRET"
RESULTS_HOST = "results.tamarind.example"
RESULT_SIGNATURE = "signed-link-secret"
BAD_KEY = "tmr-test-key-BAD"
LIVE_UNAUTHORIZED_TEXT = (
    "Unauthorized: the provided credential is invalid or not recognized. "
    "Supply a valid Tamarind API key (x-api-key) or OAuth token."
)


@dataclass
class FakeState:
    jobs: dict[str, dict[str, Any]] = field(default_factory=dict)
    calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    force_status: int = 0
    hidden_tools: set[str] = field(default_factory=set)
    status_script: dict[str, list[str]] = field(default_factory=dict)
    bad_key_style: str = "http"
    unexpected_tool_failure: str | None = None


TAMARIND_MAX_JOB_NAME = 100

TAMARIND_LANE_AT_CAPACITY = json.dumps(
    {
        "error": json.dumps(
            {
                "type": "https://app.tamarind.bio/errors/lane_at_capacity",
                "title": "Service unavailable",
                "status": 503,
                "code": "lane_at_capacity",
                "detail": "The public-jobs-list queue is full. Please retry.",
            }
        )
    }
)


def build_fake_tamarind(state: FakeState) -> MCPServer:
    server = MCPServer("fake-tamarind")

    @server.tool()
    def listModalities() -> str:
        state.calls.append(("listModalities", {}))
        return json.dumps(
            ["protein", "antibody", "peptide", "small-molecule", "nucleic-acid"]
        )

    @server.tool()
    def getAvailableTools(
        search: str | None = None,
        modality: str | None = None,
        function: str | None = None,
        tag: str | None = None,
        category: str | None = None,
    ) -> str:
        state.calls.append(
            (
                "getAvailableTools",
                {
                    "search": search,
                    "modality": modality,
                    "function": function,
                    "tag": tag,
                    "category": category,
                },
            )
        )
        tools = [
            {
                "name": "alphafold",
                "displayName": "AlphaFold2",
                "description": "AlphaFold2 structure prediction",
                "categories": ["protein", "peptide"],
                "outputTypes": ["pdb"],
                "tags": ["structure-prediction"],
            },
            {
                "name": "esmfold",
                "displayName": "ESMFold",
                "description": "ESMFold single-sequence",
                "categories": ["protein", "peptide"],
                "outputTypes": ["pdb", "sequence"],
                "tags": ["structure-prediction"],
            },
            {
                "name": "proteinmpnn",
                "displayName": "ProteinMPNN",
                "description": "Sequence design",
                "categories": ["protein"],
                "outputTypes": ["fasta"],
                "tags": ["sequence-design"],
            },
        ]
        if search:
            tools = [t for t in tools if search.lower() in t["name"]]
        for value, key in ((tag, "tags"), (function, "tags"), (category, "categories")):
            if value:
                tools = [t for t in tools if value in t[key]]
        if modality:
            tools = [t for t in tools if modality in t["categories"]]
        filtered = any((search, modality, function, tag, category))
        if not filtered:
            tools = [
                {k: v for k, v in t.items() if k not in ("description", "tags")}
                for t in tools
            ]
        return json.dumps(
            {
                "totalTools": len(tools),
                "tools": tools,
                "descriptionsOmitted": not filtered,
                "filters": {
                    "search": search,
                    "modality": modality,
                    "function": function,
                    "tag": tag,
                    "category": category,
                },
                "availableCategories": ["protein", "peptide", "antibody"],
                "availableTags": ["structure-prediction", "sequence-design"],
                "hint": (
                    "Use getJobSchema(jobType='<name>') for a tool's description + "
                    "parameters. Filter with category=/tag= using the values in "
                    "availableCategories/availableTags."
                ),
            }
        )

    @server.tool()
    def getJobSchema(jobType: str) -> str:
        state.calls.append(("getJobSchema", {"jobType": jobType}))
        if jobType not in ("alphafold", "esmfold", "proteinmpnn"):
            raise ToolError(f"unknown tool: {jobType}")
        return json.dumps(
            {
                "jobType": jobType,
                "displayName": {
                    "alphafold": "AlphaFold",
                    "esmfold": "ESMFold",
                    "proteinmpnn": "ProteinMPNN",
                }[jobType],
                "description": f"{jobType} run on Tamarind",
                "parameters": [
                    {
                        "name": "sequence",
                        "displayName": "Sequence",
                        "type": "sequence",
                        "required": True,
                        "descr": "Amino acid sequence; ':' separates chains",
                        "example": "M" * 30,
                    },
                    {
                        "name": "numModels",
                        "displayName": "Number of models",
                        "type": "number",
                        "required": False,
                        "default": 5,
                    },
                ],
                "exampleJob": {
                    "jobName": f"{jobType}-example",
                    "type": jobType,
                    "settings": {"sequence": "M" * 30},
                },
                "outputs": {"produces": ["pdb"]},
                "outputTypes": ["pdb"],
                "tags": ["structure-prediction"],
                "categories": ["protein"],
            }
        )

    @server.tool()
    def validateJob(jobName: str, type: str, settings: dict) -> str:
        state.calls.append(
            ("validateJob", {"jobName": jobName, "type": type, "settings": settings})
        )
        sequence = settings.get("sequence") or ""
        if not sequence:
            return json.dumps({"valid": False, "error": "sequence: required"})
        if " " in sequence:
            return json.dumps(
                {
                    "valid": True,
                    "normalized": {"sequence": sequence.replace(" ", "")},
                    "mutatedFields": ["sequence"],
                }
            )
        return json.dumps({"valid": True})

    @server.tool()
    def estimateTime(type: str, settings: dict) -> str:
        state.calls.append(("estimateTime", {"type": type, "settings": settings}))
        n = len(settings.get("sequence", ""))
        return json.dumps(
            {
                "estimatedMinutes": max(1, n // 50),
                "weightedHours": round(0.01 * max(1, n // 50), 3),
            }
        )

    @server.tool()
    def submitJob(jobName: str, type: str, settings: dict) -> str:
        state.calls.append(
            ("submitJob", {"jobName": jobName, "type": type, "settings": settings})
        )
        if state.unexpected_tool_failure is not None:
            raise ValueError(state.unexpected_tool_failure)
        if len(jobName) > TAMARIND_MAX_JOB_NAME:
            raise ToolError(f"Input validation error: '{jobName}' is too long")
        if not settings.get("sequence"):
            raise ToolError("Invalid settings: sequence is required")
        if jobName in state.jobs:
            raise ToolError(f"Job {jobName} already exists")
        state.jobs[jobName] = {
            "JobName": jobName,
            "Type": type,
            "Settings": settings,
            "JobStatus": "In Queue",
            "WeightedHours": 0.02,
        }
        return f"{jobName} submitted to queue."

    @server.tool()
    def getJobs(jobName: str | None = None) -> str:
        state.calls.append(("getJobs", {"jobName": jobName}))
        fault = getattr(state, "getjobs_fault", None)
        if fault:
            return fault
        if jobName is None:
            return json.dumps({"jobs": list(state.jobs.values())})
        job = state.jobs.get(jobName)
        if job is None:
            raise ToolError(f"Job not found: {jobName}")
        script = state.status_script.get(jobName)
        if script:
            job["JobStatus"] = script.pop(0) if len(script) > 1 else script[0]
        return json.dumps(dict(job))

    @server.tool()
    def getResult(jobName: str) -> str:
        state.calls.append(("getResult", {"jobName": jobName}))
        if jobName not in state.jobs:
            raise ToolError(f"Job not found: {jobName}")
        return (
            f"https://{RESULTS_HOST}/{jobName}.zip?X-Amz-Signature={RESULT_SIGNATURE}"
        )

    @server.tool()
    def cancelJob(jobName: str) -> str:
        state.calls.append(("cancelJob", {"jobName": jobName}))
        job = state.jobs.get(jobName)
        if job is None:
            raise ToolError(f"Job not found: {jobName}")
        job["JobStatus"] = "Stopped"
        return f"{jobName} stopped."

    return server


class HeaderGate:
    """ASGI middleware playing the provider's auth + failure injection layer."""

    def __init__(
        self, app: Any, state: FakeState, expected_key: str = GOOD_KEY
    ) -> None:
        self.app, self.state, self.expected_key = app, state, expected_key
        self.seen_headers: list[dict[str, str]] = []

    async def __call__(self, scope, receive, send):  # type: ignore[no-untyped-def]
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {k.decode().lower(): v.decode() for k, v in scope["headers"]}
        self.seen_headers.append(headers)
        status = 0
        if self.state.force_status:
            status, self.state.force_status = self.state.force_status, 0
        elif headers.get("x-api-key") != self.expected_key:
            if self.state.bad_key_style == "jsonrpc" and scope.get("method") == "POST":
                await self._live_shaped_refusal(scope, receive, send)
                return
            status = 401
        if status:
            body = json.dumps({"error": {"status": status}}).encode()
            await send(
                {
                    "type": "http.response.start",
                    "status": status,
                    "headers": [(b"content-type", b"application/json")],
                }
            )
            await send({"type": "http.response.body", "body": body})
            return
        await self.app(scope, receive, send)

    async def _live_shaped_refusal(self, scope, receive, send):  # type: ignore[no-untyped-def]
        chunks: list[bytes] = []
        while True:
            message = await receive()
            chunks.append(message.get("body", b""))
            if not message.get("more_body"):
                break
        body = b"".join(chunks)
        try:
            request = json.loads(body or b"{}")
        except ValueError:
            request = {}
        method = request.get("method") if isinstance(request, dict) else None
        if method not in ("tools/list", "tools/call"):
            replayed = False

            async def replay():  # type: ignore[no-untyped-def]
                nonlocal replayed
                if not replayed:
                    replayed = True
                    return {"type": "http.request", "body": body, "more_body": False}
                return await receive()

            await self.app(scope, replay, send)
            return
        if method == "tools/list":
            reply: dict[str, Any] = {
                "jsonrpc": "2.0",
                "id": request.get("id"),
                "error": {"code": 0, "message": LIVE_UNAUTHORIZED_TEXT},
            }
        else:
            reply = {
                "jsonrpc": "2.0",
                "id": request.get("id"),
                "result": {
                    "content": [{"type": "text", "text": LIVE_UNAUTHORIZED_TEXT}],
                    "isError": True,
                },
            }
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", b"application/json")],
            }
        )
        await send({"type": "http.response.body", "body": json.dumps(reply).encode()})


@asynccontextmanager
async def fake_tamarind_transport(
    state: FakeState,
) -> AsyncIterator[tuple[httpx2.ASGITransport, HeaderGate]]:
    server = build_fake_tamarind(state)
    for name in list(state.hidden_tools):
        server.remove_tool(name)
    app = server.streamable_http_app(
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=False
        )
    )
    gate = HeaderGate(app, state)
    lifespan = app.router.lifespan_context(app)
    await lifespan.__aenter__()
    try:
        yield httpx2.ASGITransport(app=gate), gate
    finally:
        await lifespan.__aexit__(None, None, None)


def http_client_factory_for(transport: httpx2.ASGITransport):
    def factory(headers: dict[str, str]) -> httpx2.AsyncClient:
        return httpx2.AsyncClient(
            transport=transport, base_url="http://127.0.0.1", headers=headers
        )

    return factory


def result_bundle_zip() -> bytes:
    """A Tamarind-style result bundle: structures in subfolders with a repeated
    basename, a score table, and a binary that must not be imported."""
    import io
    import zipfile

    pdb = "ATOM      1  CA  MET A   1      11.104   6.134  -6.504  1.00 90.00           C\nEND\n"
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("scores.json", '{"plddt": 88.5, "ptm": 0.81}')
        archive.writestr("ranked_0.pdb", pdb)
        archive.writestr("seed_1/model.pdb", pdb)
        archive.writestr("seed_2/model.pdb", pdb)
        archive.writestr("features.pkl", b"\x80\x04binary")
    return buffer.getvalue()


def live_metrics_bundle_zip() -> bytes:
    """What live Tamarind actually returned for ESMFold on 2026-09-11: the model, a
    metrics CSV of header + one row, its processed twin, a PAE matrix whose NAME
    carries the pTM, and the echoed settings. None of those numbers appear in the
    JSON reply, which is only a signed link."""
    import io
    import zipfile

    pdb = "ATOM      1  CA  MET A   1      11.104   6.134  -6.504  1.00 90.00           C\nEND\n"
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("model.pdb", pdb)
        archive.writestr(
            "metrics.csv",
            "sequence,ptm,plddt,num_recycles,chain_linker\nMQIFVKTLTG,0.829,90.477,3,25\n",
        )
        archive.writestr(
            "metrics-processed.csv",
            "pdb_filepath,sequence,ptm,plddt,num_recycles,chain_linker\n"
            "model.pdb,MQIFVKTLTG,0.829,90.477,3,25\n",
        )
        archive.writestr("ptm0.829_r3_default.pae.txt", "0 1\n1 0\n")
        archive.writestr(
            "settings.json",
            '{"sequence": "MQIFVKTLTG", "submit_method": "api", "type": "esmfold"}',
        )
    return buffer.getvalue()


def download_client_factory_for(
    seen: list, status: int = 200, body: bytes | None = None
):
    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        if request.url.host != RESULTS_HOST:
            return httpx2.Response(404)
        if status != 200:
            return httpx2.Response(status, text="Request has expired")
        return httpx2.Response(
            200, content=result_bundle_zip() if body is None else body
        )

    def factory() -> httpx2.AsyncClient:
        return httpx2.AsyncClient(transport=httpx2.MockTransport(handler))

    return factory
