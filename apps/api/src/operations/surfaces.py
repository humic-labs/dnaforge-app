from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel

from .contracts import OperationSnapshot
from .registration import (
    CompiledOperationSystem,
    ExecutableOperationKind,
    OperationKindPackage,
)

OperationRouteHandler = Callable[
    [Request, OperationKindPackage, BaseModel], Awaitable[Any]
]


def _operation_id(action: str, kind: str, suffix: str) -> str:
    normalized = kind.replace("-", "_")
    return f"{action}_{normalized}_operation_operations_{normalized}_{suffix}"


def _start_endpoint(
    package: ExecutableOperationKind,
    handler: OperationRouteHandler,
):
    async def endpoint(request: Request, body: BaseModel):
        return await handler(request, package, body)

    endpoint.__name__ = f"start_{package.key.kind.replace('-', '_')}_operation"
    endpoint.__annotations__["body"] = package.start.request_model
    return endpoint


def _import_endpoint(
    package: ExecutableOperationKind,
    handler: OperationRouteHandler,
):
    async def endpoint(request: Request, body: BaseModel):
        return await handler(request, package, body)

    endpoint.__name__ = (
        f"import_recorded_{package.key.kind.replace('-', '_')}_operation"
    )
    assert package.recorded_import is not None
    endpoint.__annotations__["body"] = package.recorded_import.request_model
    return endpoint


def build_registered_operation_kind_router(
    system: CompiledOperationSystem,
    *,
    start: OperationRouteHandler,
    import_recorded: OperationRouteHandler,
) -> APIRouter:
    router = APIRouter(prefix="/operations", tags=["Operations"])
    install_registered_operation_kind_routes(
        router, system, start=start, import_recorded=import_recorded
    )
    return router


def install_registered_operation_kind_routes(
    router: APIRouter,
    system: CompiledOperationSystem,
    *,
    start: OperationRouteHandler,
    import_recorded: OperationRouteHandler,
) -> None:
    for package in system.packages:
        if not isinstance(package, ExecutableOperationKind):
            continue
        kind = package.key.kind
        router.add_api_route(
            f"/{kind}",
            _start_endpoint(package, start),
            methods=["POST"],
            status_code=202,
            response_model=OperationSnapshot,
            operation_id=_operation_id("start", kind, "post"),
        )
        if package.recorded_import is not None:
            router.add_api_route(
                f"/{kind}/import-recorded",
                _import_endpoint(package, import_recorded),
                methods=["POST"],
                response_model=OperationSnapshot,
                operation_id=_operation_id(
                    "import_recorded", kind, "import_recorded_post"
                ),
            )
