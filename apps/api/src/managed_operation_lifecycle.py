"""Lease and connection lifetime shared by the desktop and foreground server."""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import TypeVar

from fastapi import FastAPI
from pydantic import BaseModel

from .operation_connection import (
    publish_operation_connection,
    retire_operation_connection,
)
from .operations import ManagedOperationService

InputT = TypeVar("InputT", bound=BaseModel)
ResultT = TypeVar("ResultT", bound=BaseModel)


@asynccontextmanager
async def managed_operation_lifespan(
    app: FastAPI,
    *,
    create_service: Callable[[], ManagedOperationService[InputT, ResultT]],
    connection_path: Path,
    url: str | None,
    session_token: str | None,
    operation_token: str | None,
    scope_id: str,
    owner_id: str,
    mcp_stdio: bool = False,
) -> AsyncIterator[ManagedOperationService[InputT, ResultT]]:
    if getattr(app.state, "managed_operations", None) is not None:
        raise RuntimeError("This application already has a managed operation owner")
    service = create_service()
    try:
        app.state.managed_operations = service
        app.state.managed_annotation_operations = service
        if url and session_token and operation_token:
            publish_operation_connection(
                connection_path,
                url=url,
                session_token=session_token,
                operation_token=operation_token,
                scope_id=scope_id,
                owner_id=owner_id,
                owner_instance=service.owner_instance_id,
                mcp_stdio=mcp_stdio,
            )
        yield service
    finally:
        retire_operation_connection(
            connection_path, owner_instance=service.owner_instance_id
        )
        try:
            await service.aclose()
        finally:
            app.state.managed_operations = None
            app.state.managed_annotation_operations = None
