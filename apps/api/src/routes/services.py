"""API routes for service discovery and execution."""

import json
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..plugins.registry import plugin_registry
from ..services import registry

router = APIRouter(prefix="/services", tags=["Services"])


PLUGIN_RESPONSE_MAX_BYTES = 16 * 1024 * 1024


class ServiceListResponse(BaseModel):
    """Response for listing available services."""

    services: list[dict]


@router.get("/", response_model=ServiceListResponse)
async def list_services() -> ServiceListResponse:
    """List all available services with their schemas."""
    schemas = registry.list_schemas() + plugin_registry.list_schemas()
    return ServiceListResponse(services=schemas)


@router.get("/{name}/schema")
async def get_service_schema(name: str):
    """Get schema for a specific service."""
    service = registry.get(name)
    if service is not None:
        return service.get_schema()

    plugin = plugin_registry.get(name)
    if plugin is not None:
        return plugin["manifest"]

    raise HTTPException(status_code=404, detail=f"Service '{name}' not found")


@router.post("/{name}/execute")
async def execute_service(name: str, request: dict):
    """Execute a configured plugin service.

    Plugin manifests describe their own messages, so this route deliberately
    forwards an open JSON object. Built-in services have typed routes with
    validated request/result models (annotation: ``POST /annotation``) and are
    not executed here.
    """

    if registry.get(name) is not None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Built-in service '{name}' is not executed through this route; "
                "use its typed route (annotation: POST /annotation)."
            ),
        )

    plugin = plugin_registry.get(name)
    if plugin is not None:
        return await _execute_plugin(name, plugin["url"], request)

    raise HTTPException(status_code=404, detail=f"Service '{name}' not found")


async def _execute_plugin(name: str, url: str, request: dict) -> Any:
    try:
        async with httpx.AsyncClient() as client:
            async with client.stream(
                "POST",
                f"{url}/execute",
                json=request,
                headers={"Accept-Encoding": "identity"},
                timeout=300,
            ) as response:
                if response.status_code >= 400:
                    raise HTTPException(
                        status_code=502,
                        detail=f"Plugin '{name}' returned HTTP {response.status_code}",
                    )
                encoding = (
                    response.headers.get("Content-Encoding", "").strip().casefold()
                )
                if encoding not in {"", "identity"}:
                    raise HTTPException(
                        status_code=502,
                        detail=f"Plugin '{name}' returned unsupported content encoding",
                    )
                declared_length = response.headers.get("Content-Length")
                if declared_length is not None:
                    try:
                        length = int(declared_length)
                    except ValueError as exc:
                        raise HTTPException(
                            status_code=502,
                            detail=f"Plugin '{name}' returned invalid Content-Length",
                        ) from exc
                    if length < 0:
                        raise HTTPException(
                            status_code=502,
                            detail=f"Plugin '{name}' returned invalid Content-Length",
                        )
                    if length > PLUGIN_RESPONSE_MAX_BYTES:
                        raise HTTPException(
                            status_code=502,
                            detail=f"Plugin '{name}' response exceeds {PLUGIN_RESPONSE_MAX_BYTES} bytes",
                        )
                payload = bytearray()
                async for chunk in response.aiter_raw():
                    if len(payload) + len(chunk) > PLUGIN_RESPONSE_MAX_BYTES:
                        raise HTTPException(
                            status_code=502,
                            detail=f"Plugin '{name}' response exceeds {PLUGIN_RESPONSE_MAX_BYTES} bytes",
                        )
                    payload.extend(chunk)
                try:
                    return json.loads(payload)
                except ValueError as exc:
                    raise HTTPException(
                        status_code=502, detail=f"Plugin '{name}' returned invalid JSON"
                    ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502, detail=f"Plugin '{name}' is unreachable: {exc}"
        ) from exc
