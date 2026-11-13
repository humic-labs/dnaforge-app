"""Agent adapters for the same native document commands used by human clients."""

from typing import Any, Literal

from pydantic import BaseModel

from .annotation_document_contract import (
    AnnotationDocumentSelection,
    AnnotationDocumentTarget,
)
from .annotation_document_responses import (
    AnnotationDocumentInspection,
    DocumentNotSaved,
    DocumentOutcomeUnresolved,
    DocumentSaved,
)
from .concurrency.renderer_bridge import RENDERER_TOOL_SPECS, _renderer_tool_spec
from .concurrency.schema import DNAForgeTool, ToolHome
from .concurrency.tool_errors import ToolExecutionFailure
from .concurrency.tool_registry import (
    ToolContext,
    ToolHandler,
    ToolReplayPolicy,
    agent_tool_registry,
)
from .managed_annotation_document_actions import ManagedAnnotationDocumentActions
from .managed_annotation_documents import ManagedAnnotationDocuments
from .managed_operation_agent_tools import (
    _link_operation,
    _principal,
    _service,
    _validate_input,
    managed_operation_audit_result,
)
from .native_document_dispatch import dispatch_native_document_command
from .operations import ManagedOperationError


class AnnotationInspectionToolOutput(BaseModel):
    ok: Literal[True]
    result: AnnotationDocumentInspection


class AnnotationApplyToolOutput(BaseModel):
    ok: Literal[True]
    operationId: str
    actionId: str
    result: DocumentSaved


def _documents(context: ToolContext) -> ManagedAnnotationDocuments:
    authority = context.native_document_authority
    return ManagedAnnotationDocuments(
        actions=ManagedAnnotationDocumentActions(
            service=_service(context),
            native_owner_instance_id=authority.owner_instance_id if authority else "",
        ),
        authority=authority,
        dispatch=dispatch_native_document_command,
    )


def _refused(exc: ManagedOperationError) -> ToolExecutionFailure:
    return ToolExecutionFailure(code=exc.code, message=str(exc), retriable=False)


async def inspect_managed_annotation_document_handler(
    args: dict[str, Any], context: ToolContext
) -> dict[str, Any]:
    parsed = _validate_input(AnnotationDocumentTarget, args)
    assert isinstance(parsed, AnnotationDocumentTarget)
    documents = _documents(context)
    service = documents.actions.service
    try:
        inspection = await documents.inspect(_principal(context, service), parsed)
    except ManagedOperationError as exc:
        raise _refused(exc) from exc
    _link_operation(service, context, parsed.operation_id)
    return {
        "ok": True,
        "result": inspection.model_dump(mode="json", by_alias=True, exclude_none=True),
    }


async def apply_managed_annotation_document_handler(
    args: dict[str, Any], context: ToolContext
) -> dict[str, Any]:
    parsed = _validate_input(AnnotationDocumentSelection, args)
    assert isinstance(parsed, AnnotationDocumentSelection)
    documents = _documents(context)
    service = documents.actions.service
    principal = _principal(context, service)
    try:
        documents.actions.inspection_authority(principal, parsed)
        _link_operation(service, context, parsed.operation_id)
        response = await documents.apply(principal, parsed)
    except ManagedOperationError as exc:
        raise _refused(exc) from exc
    outcome = response.outcome
    if isinstance(outcome, (DocumentNotSaved, DocumentOutcomeUnresolved)):
        code = {
            "blocked": "MANAGED_ANNOTATION_APPLY_BLOCKED",
            "save-failed": "MANAGED_ANNOTATION_SAVE_FAILED",
            "outcome-unresolved": "OUTCOME_UNRESOLVED",
        }[outcome.status]
        raise ToolExecutionFailure(
            code=code,
            message=outcome.reason,
            retriable=False,
            details={
                "actionId": response.action_id,
                "operationId": parsed.operation_id,
                "stateMayHaveChanged": isinstance(outcome, DocumentOutcomeUnresolved),
                "outcome": outcome.model_dump(
                    mode="json", by_alias=True, exclude_none=True
                ),
            },
        )
    return {
        "ok": True,
        "operationId": parsed.operation_id,
        "actionId": response.action_id,
        "result": outcome.model_dump(mode="json", by_alias=True, exclude_none=True),
    }


def _definition(name: str, handler: ToolHandler) -> tuple[DNAForgeTool, ToolHandler]:
    config = next(spec for spec in RENDERER_TOOL_SPECS if spec["name"] == name)
    spec = _renderer_tool_spec(config).model_copy(
        update={
            "home": ToolHome.NATIVE.value,
            "handler_ref": f"src.managed_annotation_document_tools.{handler.__name__}",
            "outputs": (
                AnnotationInspectionToolOutput
                if name == "operations.annotation.inspect"
                else AnnotationApplyToolOutput
            ).model_json_schema(by_alias=True),
        }
    )
    return spec, handler


def register_managed_annotation_document_tools() -> None:
    for spec, handler in (
        _definition(
            "operations.annotation.inspect", inspect_managed_annotation_document_handler
        ),
        _definition(
            "operations.annotation.apply", apply_managed_annotation_document_handler
        ),
    ):
        agent_tool_registry.register(
            spec,
            handler,
            replay_policy=ToolReplayPolicy.EXECUTE,
            audit_result_projector=managed_operation_audit_result,
        )
