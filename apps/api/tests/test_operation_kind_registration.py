from __future__ import annotations

import ast
import asyncio
import json
import threading
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI, Request
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

from src.concurrency.tool_registry import ToolContext
from src.control_plane import ControlPlaneStore
from src.managed_operation_agent_tools import managed_operation_tool_definitions
from src.operations import (
    ActorKind,
    CancellationMode,
    ClientChannel,
    ManagedOperationService,
    ManagedOperationSubmission,
    OperationPrincipal,
    OperationState,
    OperationSubject,
)
from src.operations.registration import (
    ExecutableOperationKind,
    HistoryOnlyOperationKind,
    OperationKindKey,
    OperationLimits,
    RecordedImportContract,
    ResultCodec,
    StartContract,
    compile_operation_system,
)
from src.operations.surfaces import build_registered_operation_kind_router


class ReportInput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    text: str = Field(min_length=1, max_length=128)


class ReportSubmission(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    submission_key: str
    scope_id: str
    subject_id: str
    input: ReportInput


class ReportResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    normalized: str


class CountInput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    values: list[int] = Field(max_length=16)


class CountSubmission(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    submission_key: str
    scope_id: str
    subject_id: str
    input: CountInput


class CountResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    count: int = Field(ge=0)


class RecordedReport(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    run_id: str
    scope_id: str
    subject_id: str
    result: ReportResult


def _prepare_report(value: ReportSubmission) -> ManagedOperationSubmission[ReportInput]:
    return ManagedOperationSubmission[ReportInput](
        submission_key=value.submission_key,
        subject=OperationSubject(
            scope_id=value.scope_id,
            subject_id=value.subject_id,
            input_revision=f"report-v1:{len(value.input.text)}",
        ),
        input=value.input,
    )


def _prepare_count(value: CountSubmission) -> ManagedOperationSubmission[CountInput]:
    return ManagedOperationSubmission[CountInput](
        submission_key=value.submission_key,
        subject=OperationSubject(
            scope_id=value.scope_id,
            subject_id=value.subject_id,
            input_revision=f"count-v1:{len(value.input.values)}",
        ),
        input=value.input,
    )


def _audit_projection(value: dict[str, Any]) -> dict[str, Any]:
    return {"keys": sorted(value)}


def _system():
    return compile_operation_system(
        ExecutableOperationKind(
            key=OperationKindKey(kind="report", version=1),
            title="Build report",
            input_model=ReportInput,
            result=ResultCodec(
                current_version=1,
                model=ReportResult,
                decoders={1: ReportResult.model_validate},
            ),
            start=StartContract(
                request_model=ReportSubmission,
                prepare=_prepare_report,
                required_capabilities=frozenset({"operations.start"}),
                audit_parameters=_audit_projection,
            ),
            recorded_import=RecordedImportContract(
                request_model=RecordedReport,
                prepare=lambda _value: None,
                required_capabilities=frozenset({"operations.import"}),
                audit_parameters=_audit_projection,
            ),
            cancellation=CancellationMode.QUEUED_ONLY,
            limits=OperationLimits(),
        ),
        ExecutableOperationKind(
            key=OperationKindKey(kind="count-items", version=3),
            title="Count items",
            input_model=CountInput,
            result=ResultCodec(
                current_version=2,
                model=CountResult,
                decoders={1: CountResult.model_validate, 2: CountResult.model_validate},
            ),
            start=StartContract(
                request_model=CountSubmission,
                prepare=_prepare_count,
                required_capabilities=frozenset({"operations.start"}),
                audit_parameters=_audit_projection,
            ),
            cancellation=CancellationMode.COOPERATIVE,
            limits=OperationLimits(max_result_bytes=4096),
        ),
        HistoryOnlyOperationKind(
            key=OperationKindKey(kind="retired-report", version=1),
            title="Retired report",
            result=ResultCodec(
                current_version=1,
                model=ReportResult,
                decoders={1: ReportResult.model_validate},
            ),
        ),
    )


def _called_name(value: ast.expr) -> str | None:
    if isinstance(value, ast.Name):
        return value.id
    if isinstance(value, ast.Attribute):
        return value.attr
    return None


def test_production_services_can_only_bind_runtime_adapters_from_a_compiled_system():
    source_root = Path(__file__).parents[1] / "src"
    handwritten_adapters = []
    uncompiled_services = []
    for path in source_root.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        relative = path.relative_to(source_root)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            called = _called_name(node.func)
            if called == "ManagedOperationKindAdapter" and relative not in {
                Path("operations/registration.py"),
                Path("operations/service.py"),
            }:
                handwritten_adapters.append(f"{relative}:{node.lineno}")
            if called != "ManagedOperationService" or relative == Path(
                "operations/service.py"
            ):
                continue
            adapters = next(
                (
                    keyword.value
                    for keyword in node.keywords
                    if keyword.arg == "adapters"
                ),
                None,
            )
            if (
                not isinstance(adapters, ast.Call)
                or _called_name(adapters.func) != "bind_executors"
            ):
                uncompiled_services.append(f"{relative}:{node.lineno}")

    assert handwritten_adapters == []
    assert uncompiled_services == []


def test_compiler_projects_only_real_actions_and_rejects_invalid_packages():
    system = _system()

    assert [descriptor.kind for descriptor in system.descriptors] == [
        "count-items",
        "report",
        "retired-report",
    ]
    descriptors = {descriptor.kind: descriptor for descriptor in system.descriptors}
    assert descriptors["report"].actions == (
        "start",
        "import_recorded",
        "list",
        "get",
        "result",
        "actions",
        "request_cancel",
        "release_result",
    )
    assert descriptors["count-items"].actions == (
        "start",
        "list",
        "get",
        "result",
        "actions",
        "request_cancel",
        "release_result",
    )
    assert descriptors["retired-report"].actions == (
        "list",
        "get",
        "result",
        "actions",
        "release_result",
    )
    assert descriptors["report"].surfaces.http_start == "/operations/report"
    assert descriptors["report"].surfaces.agent_start == "operations.report.start"
    assert descriptors["report"].surfaces.cli_submit == (
        "dnaforge jobs submit report --request FILE|-"
    )
    assert descriptors["report"].surfaces.cli_import_recorded == (
        "dnaforge jobs import-recorded report --request FILE|-"
    )
    assert descriptors["count-items"].surfaces.cli_import_recorded is None
    assert descriptors["report"].start_capabilities == ("operations.start",)
    assert descriptors["report"].agent_start_capabilities == ("operations.start",)
    assert descriptors["report"].recorded_import_capabilities == ("operations.import",)
    assert descriptors["retired-report"].start_capabilities == ()
    assert descriptors["retired-report"].agent_start_capabilities == ()
    assert descriptors["retired-report"].surfaces.http_start is None
    assert descriptors["retired-report"].surfaces.cli_import_recorded is None

    with pytest.raises(ValueError, match="safe lower-case slug"):
        compile_operation_system(
            HistoryOnlyOperationKind(
                key=OperationKindKey(kind="../unsafe", version=1),
                title="Unsafe",
                result=ResultCodec(
                    current_version=1,
                    model=ReportResult,
                    decoders={1: ReportResult.model_validate},
                ),
            )
        )
    with pytest.raises(ValueError, match="reserved"):
        compile_operation_system(
            HistoryOnlyOperationKind(
                key=OperationKindKey(kind="events", version=1),
                title="Events",
                result=ResultCodec(
                    current_version=1,
                    model=ReportResult,
                    decoders={1: ReportResult.model_validate},
                ),
            )
        )
    with pytest.raises(ValueError, match="unique"):
        compile_operation_system(_system().packages[0], _system().packages[0])


def test_production_annotation_kind_remains_one_sealed_registration():
    from src.annotation_operation_contract import AnnotationSubmission
    from src.managed_operations import MANAGED_OPERATION_SYSTEM

    descriptor = next(
        item
        for item in MANAGED_OPERATION_SYSTEM.descriptors
        if item.kind == "annotation"
    )
    assert descriptor.kind == "annotation"
    assert descriptor.contract_version == 1
    assert descriptor.result_schema_version == 1
    assert descriptor.surfaces.http_start == "/operations/annotation"
    assert descriptor.surfaces.http_import_recorded == (
        "/operations/annotation/import-recorded"
    )
    assert descriptor.surfaces.agent_start == "operations.annotation.start"
    assert descriptor.surfaces.agent_import_recorded == (
        "operations.annotation.import_recorded"
    )
    assert descriptor.surfaces.cli_import_recorded == (
        "dnaforge jobs import-recorded annotation --request FILE|-"
    )
    assert descriptor.input_schema == AnnotationSubmission.model_json_schema()


def test_result_decoder_registry_is_immutable_after_compilation():
    decoders = {1: ReportResult.model_validate}
    codec = ResultCodec(current_version=1, model=ReportResult, decoders=decoders)
    decoders[2] = ReportResult.model_validate

    assert set(codec.decoders) == {1}
    with pytest.raises(TypeError):
        codec.decoders[2] = ReportResult.model_validate


def test_compiler_builds_stable_exact_typed_http_routes_and_result_union():
    async def start(_request: Request, _package, _body: BaseModel):
        raise AssertionError("schema-only test")

    async def import_recorded(_request: Request, _package, _body: BaseModel):
        raise AssertionError("schema-only test")

    def schema() -> dict[str, Any]:
        app = FastAPI()
        app.include_router(
            build_registered_operation_kind_router(
                _system(), start=start, import_recorded=import_recorded
            )
        )
        return app.openapi()

    first = schema()
    second = schema()
    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)

    paths = first["paths"]
    assert "/operations/report" in paths
    assert "/operations/count-items" in paths
    assert "/operations/retired-report" not in paths
    assert paths["/operations/report"]["post"]["operationId"] == (
        "start_report_operation_operations_report_post"
    )
    assert paths["/operations/count-items"]["post"]["operationId"] == (
        "start_count_items_operation_operations_count_items_post"
    )
    assert paths["/operations/report"]["post"]["requestBody"]["content"][
        "application/json"
    ]["schema"] == {"$ref": "#/components/schemas/ReportSubmission"}
    assert paths["/operations/count-items"]["post"]["requestBody"]["content"][
        "application/json"
    ]["schema"] == {"$ref": "#/components/schemas/CountSubmission"}
    assert paths["/operations/count-items"]["post"]["responses"]["202"]["content"][
        "application/json"
    ]["schema"] == {"$ref": "#/components/schemas/OperationSnapshot"}
    assert "/operations/report/import-recorded" in paths
    assert "/operations/count-items/import-recorded" not in paths

    result_schema = TypeAdapter(_system().result_envelope).json_schema()
    assert result_schema["discriminator"]["propertyName"] == "kind"
    assert set(result_schema["discriminator"]["mapping"]) == {
        "count-items",
        "report",
        "retired-report",
    }
    for reference in result_schema["discriminator"]["mapping"].values():
        model_name = reference.rsplit("/", 1)[-1]
        assert {"kind", "result_schema_version"} <= set(
            result_schema["$defs"][model_name]["required"]
        )


def test_agent_tools_are_compiled_from_the_same_packages_and_install_atomically():
    import src.managed_operation_agent_tools as managed_agent_tools
    from src.concurrency.tool_registry import AgentToolRegistry
    from src.managed_operation_agent_tools import (
        managed_operation_tool_definitions,
        register_managed_operation_agent_tools,
    )

    definitions = managed_operation_tool_definitions(_system())
    by_name = {definition.spec.name: definition for definition in definitions}
    assert set(by_name) == {
        "operations.discover",
        "operations.list",
        "operations.get",
        "operations.result",
        "operations.actions",
        "operations.report.start",
        "operations.report.import_recorded",
        "operations.count-items.start",
        "operations.request_cancel",
        "operations.release_result",
    }
    assert by_name["operations.report.start"].spec.inputs == (
        ReportSubmission.model_json_schema()
    )
    assert by_name["operations.count-items.start"].spec.inputs == (
        CountSubmission.model_json_schema()
    )
    assert by_name["operations.report.import_recorded"].spec.inputs == (
        RecordedReport.model_json_schema()
    )
    assert by_name["operations.report.start"].audit_parameter_projector is (
        _audit_projection
    )
    assert "operations.retired-report.start" not in by_name

    registry = AgentToolRegistry()
    registry.register_many((by_name["operations.get"],))
    generated_name = "start_managed_report_handler"
    missing = object()
    handler_before_failed_install = getattr(
        managed_agent_tools, generated_name, missing
    )
    with pytest.raises(ValueError, match="already registered.*operations.get"):
        register_managed_operation_agent_tools(_system(), registry=registry)
    assert [tool.spec.name for tool in registry.list()] == ["operations.get"]
    assert (
        getattr(managed_agent_tools, generated_name, missing)
        is handler_before_failed_install
    )

    clean_registry = AgentToolRegistry()
    register_managed_operation_agent_tools(_system(), registry=clean_registry)
    assert {tool.spec.name for tool in clean_registry.list()} == set(by_name)
    assert (
        getattr(managed_agent_tools, generated_name)
        is clean_registry.require("operations.report.start").handler
    )

    register_managed_operation_agent_tools(
        _system(), registry=clean_registry, replace_existing=True
    )
    assert {tool.spec.name for tool in clean_registry.list()} == set(by_name)
    assert (
        getattr(managed_agent_tools, generated_name)
        is clean_registry.require("operations.report.start").handler
    )


@pytest.mark.asyncio
async def test_executor_binding_is_exact_and_history_decoding_is_versioned():
    system = _system()

    async def report_executor(
        value: ReportInput, _cancel: threading.Event
    ) -> ReportResult:
        return ReportResult(normalized=value.text.strip().lower())

    async def count_executor(
        value: CountInput, _cancel: threading.Event
    ) -> CountResult:
        return CountResult(count=len(value.values))

    adapters = system.bind_executors(
        {
            OperationKindKey(kind="report", version=1): report_executor,
            OperationKindKey(kind="count-items", version=3): count_executor,
        }
    )
    assert [adapter.kind for adapter in adapters] == [
        "count-items",
        "report",
        "retired-report",
    ]
    assert adapters[0].executor is count_executor
    assert adapters[1].executor is report_executor
    assert adapters[2].executor is None
    assert adapters[2].start_enabled is False
    assert set(adapters[2].result_decoders) == {1}
    assert tuple(adapter.descriptor() for adapter in adapters) == system.descriptors
    assert all(
        adapter.descriptor() is descriptor
        for adapter, descriptor in zip(adapters, system.descriptors, strict=True)
    )

    with pytest.raises(ValueError, match="Missing executor binding.*count-items"):
        system.bind_executors(
            {OperationKindKey(kind="report", version=1): report_executor}
        )
    with pytest.raises(ValueError, match="history-only.*retired-report"):
        system.bind_executors(
            {
                OperationKindKey(kind="report", version=1): report_executor,
                OperationKindKey(kind="count-items", version=3): count_executor,
                OperationKindKey(kind="retired-report", version=1): report_executor,
            }
        )

    decoded = system.decode_result(
        kind="count-items", result_schema_version=1, payload={"count": 4}
    )
    assert decoded == CountResult(count=4)
    with pytest.raises(ValueError, match="Unsupported result schema version 9"):
        system.decode_result(
            kind="count-items", result_schema_version=9, payload={"count": 4}
        )


@pytest.mark.asyncio
async def test_two_registered_kinds_share_one_owner_across_http_and_agent(tmp_path):
    system = _system()

    async def report_executor(
        value: ReportInput, _cancel: threading.Event
    ) -> ReportResult:
        return ReportResult(normalized=value.text.strip().lower())

    async def count_executor(
        value: CountInput, _cancel: threading.Event
    ) -> CountResult:
        return CountResult(count=len(value.values))

    store = ControlPlaneStore(tmp_path / "control.sqlite3")
    store.initialize()
    service = ManagedOperationService(
        store=store,
        runtime_scope="workspace-a",
        adapters=system.bind_executors(
            {
                OperationKindKey(kind="report", version=1): report_executor,
                OperationKindKey(kind="count-items", version=3): count_executor,
            }
        ),
    )
    human = OperationPrincipal(
        actor_kind=ActorKind.HUMAN,
        actor_id="human-a",
        channel=ClientChannel.DESKTOP_UI,
        scope_ids={"workspace-a"},
        capabilities={"operations.start", "operations.read"},
    )

    async def start(_request: Request, package, body: BaseModel):
        return await service.start(
            human,
            package.start.prepare(body),
            kind=package.key.kind,
        )

    async def import_recorded(_request: Request, _package, _body: BaseModel):
        raise AssertionError("recorded import is outside this acceptance path")

    app = FastAPI()
    app.include_router(
        build_registered_operation_kind_router(
            system,
            start=start,
            import_recorded=import_recorded,
        )
    )

    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
        ) as client:
            response = await client.post(
                "/operations/report",
                json={
                    "submission_key": "http-report",
                    "scope_id": "workspace-a",
                    "subject_id": "sample-a",
                    "input": {"text": " Report One "},
                },
            )
        assert response.status_code == 202
        http_operation = response.json()

        store.ensure_agent_identity(
            "agent-a",
            parent_human_identity_id="human-a",
            scope=["operations.start", "operations.read"],
        )
        job_id = store.insert_agent_action(
            agent_identity_id="agent-a",
            tool_name="operations.count-items.start",
            parameters={"redacted": True},
            authorized_scope=["workspace-a"],
        )
        tools = {
            definition.spec.name: definition
            for definition in managed_operation_tool_definitions(system)
        }
        agent_start = tools["operations.count-items.start"]
        assert agent_start.handler is not None
        agent_operation = await agent_start.handler(
            {
                "submission_key": "agent-count",
                "scope_id": "workspace-a",
                "subject_id": "sample-b",
                "input": {"values": [3, 5, 8]},
            },
            ToolContext(
                job_id=job_id,
                agent_identity_id="agent-a",
                agent_capabilities=["operations.start", "operations.read"],
                cancel_event=threading.Event(),
                managed_operations=service,
            ),
        )

        for operation_id in (http_operation["id"], agent_operation["id"]):
            for _ in range(200):
                snapshot = service.get(human, operation_id)
                if snapshot.state == OperationState.SUCCEEDED:
                    break
                await asyncio.sleep(0.005)
            assert snapshot.state == OperationState.SUCCEEDED

        rows = [
            store.get_managed_operation(http_operation["id"]),
            store.get_managed_operation(agent_operation["id"]),
        ]
        assert {row["kind"] for row in rows} == {"report", "count-items"}
        assert {row["owner_instance_id"] for row in rows} == {service.owner_instance_id}
        assert {row["channel"] for row in rows} == {"desktop_ui", "agent"}
        assert (
            store.get_agent_action(job_id)["managed_operation_id"]
            == agent_operation["id"]
        )
        assert [item.kind for item in service.kind_descriptors()] == [
            "count-items",
            "report",
            "retired-report",
        ]
    finally:
        await service.aclose()
        store.close()
