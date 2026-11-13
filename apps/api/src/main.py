"""
FastAPI Application Entry Point
Molecular Biology Suite Tools Service

This service provides bioinformatics compute operations ONLY.
All CRUD operations (projects, sequences, annotations) are handled
by the desktop app via Drizzle/SQLite directly.
"""

import logging
import os
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.routing import Route

from .annotation_provisioning import annotation_provisioning_lifespan
from .compute.service import ComputeService
from .compute_scheduling import compute_scheduling_lifespan
from .concurrency import get_job_manager, register_builtin_agent_tools
from .concurrency.workspace_binding_activation import (
    WorkspaceBindingActivationMiddleware,
)
from .control_plane import get_control_plane_store, initialize_control_plane
from .external.providers import (
    NcbiNuccoreProvider,
    NebTmProvider,
    PaperSourceProvider,
    RCSBProvider,
    UcscProvider,
    UniProtProvider,
)
from .external.providers.jev import JevProvider
from .external.providers.protein_context import ProteinContextProvider
from .external.replay import build_replay_client, build_replay_resolver
from .external.service import UCSC_REMOTE_RANGE_HOSTS, ExternalResourcesService
from .mcp_companion.http_endpoint import (
    MCP_HTTP_PATH,
    McpHttpEndpoint,
    serve_mcp_only_port,
)
from .plugins.loader import load_plugins_from_config
from .routes import compute as compute_routes
from .routes import external as external_routes
from .routes import health
from .routes.agent_grants import router as agent_grants_router
from .routes.agent_tools import router as agent_tools_router
from .routes.annotation import router as annotation_router
from .routes.annotation_output import router as annotation_output_router
from .routes.external import router as external_router
from .routes.genome import router as genome_router
from .routes.jobs import router as jobs_router
from .routes.mcp import router as mcp_router
from .routes.mcp_auth import bootstrap_session_grant
from .routes.mcp_caller import router as mcp_caller_router
from .routes.mcp_discovery import router as mcp_discovery_router
from .routes.mcp_jobs import router as mcp_jobs_router
from .routes.native_documents import router as native_documents_router
from .routes.operations import (
    operation_owner_id,
    operation_scope_id,
)
from .routes.operations import (
    router as operations_router,
)
from .routes.renderer_audit import router as renderer_audit_router
from .routes.services import router as services_router
from .routes.sidecar import router as sidecar_router
from .routes.tiles import router as tiles_router
from .routes.toolbox import router as toolbox_router
from .security.local_access import (
    ALLOWED_CORS_HEADERS,
    ALLOWED_CORS_METHODS,
    ALLOWED_CORS_ORIGIN_REGEX,
    EXPOSED_CORS_HEADERS,
    LocalAccessMiddleware,
    configured_allowed_origins,
)
from .security.native_document_authority import capture_native_document_authority
from .toolbox.annotation import register_annotation_capability
from .toolbox.builtins import register_builtin_capabilities
from .toolbox.plugins import register_plugin_capabilities
from .tools import (
    alignment_router,
    primer_bind_router,
    primer_design_router,
)

try:
    from .tools.adjacency_router import router as adjacency_router
except ModuleNotFoundError as error:
    if error.name != f"{__package__}.tools.adjacency_router":
        raise
    adjacency_router = None

logger = logging.getLogger(__name__)

_REPLAY_ALLOWED_ENVIRONMENTS = {"test", "development", "ci"}


def _external_replay_allowed_environment() -> bool:
    """Replay fixtures are only valid in explicit non-production runtimes."""
    markers = [
        value.strip().lower()
        for value in (
            os.getenv("WAYPOINT_ENVIRONMENT"),
            os.getenv("ENV"),
        )
        if value is not None and value.strip()
    ]
    return bool(markers) and all(
        marker in _REPLAY_ALLOWED_ENVIRONMENTS for marker in markers
    )


mcp_http_endpoint = McpHttpEndpoint()


@asynccontextmanager
async def _service_lifespan(app: FastAPI) -> AsyncGenerator:
    """Application lifespan context manager for startup/shutdown events"""
    app.state.native_document_authority = capture_native_document_authority()
    print("Starting Molecular Biology Suite Tools Service")
    print("   Purpose: Bioinformatics compute (BLAST, primer design, etc.)")
    print("   Data access: Handled by desktop app via Drizzle/SQLite")
    initialize_control_plane()
    bootstrap_session_grant()
    load_plugins_from_config()
    register_builtin_agent_tools()
    register_annotation_capability()
    register_builtin_capabilities()
    register_plugin_capabilities()
    get_job_manager().reconcile_interrupted_actions()
    replay_dir = os.getenv("EXTERNAL_REPLAY_DIR")
    if replay_dir and not _external_replay_allowed_environment():
        logger.error("Refusing to start with EXTERNAL_REPLAY_DIR outside test/dev/CI")
        raise RuntimeError("EXTERNAL_REPLAY_DIR is only allowed in test/dev/CI")
    replay_client = (
        build_replay_client(
            replay_dir,
            trace_file=os.getenv("EXTERNAL_REPLAY_TRACE_FILE"),
        )
        if replay_dir
        else None
    )
    replay_resolver = build_replay_resolver(replay_dir) if replay_dir else None
    if replay_dir:
        logger.warning("External provider replay is ACTIVE: %s", replay_dir)
        print(f"   External provider replay: {replay_dir}")
    remote_range_hosts = (
        UCSC_REMOTE_RANGE_HOSTS | frozenset({"example.org"})
        if replay_dir
        else UCSC_REMOTE_RANGE_HOSTS
    )
    external_service = ExternalResourcesService(
        get_control_plane_store(),
        client=replay_client,
        remote_range_allowed_hosts=remote_range_hosts,
        remote_range_resolver=replay_resolver,
    )
    external_service.register(UniProtProvider(client=replay_client))
    external_service.register(
        JevProvider(api_key=os.getenv("TYPESAFE_API_KEY"), client=replay_client)
    )
    external_service.register(RCSBProvider(client=replay_client))
    external_service.register(ProteinContextProvider("protein-mcp"))
    external_service.register(ProteinContextProvider("uniprot-mcp"))
    external_service.register(
        NcbiNuccoreProvider(
            client=replay_client,
            email=os.getenv("NCBI_TOOL_EMAIL"),
            api_key=os.getenv("NCBI_API_KEY"),
        )
    )
    external_service.register(NebTmProvider(client=replay_client))
    external_service.register(
        PaperSourceProvider(client=replay_client, resolver=replay_resolver)
    )
    external_service.register(UcscProvider(client=replay_client))
    external_routes.set_service(external_service)
    external_service.start_background_cache_maintenance()

    try:
        compute_routes.set_service(
            ComputeService.from_manifest_dir(rest_client=replay_client)
        )
    except (
        Exception
    ) as exc:  # noqa: BLE001 - degrade to "no providers", keep the sidecar up
        print(f"   Compute endpoints unavailable: {exc}")
        compute_routes.set_service(None)

    try:
        human_operation_token = os.environ.get("DNAFORGE_HUMAN_OPERATION_TOKEN")
        from .managed_annotation import (
            create_managed_operation_service,
            operation_connection_path,
        )
        from .managed_operation_lifecycle import managed_operation_lifespan

        store = get_control_plane_store()
        scope_id = operation_scope_id()
        owner_id = operation_owner_id()
        async with managed_operation_lifespan(
            app,
            create_service=lambda: create_managed_operation_service(
                store, runtime_scope=scope_id
            ),
            connection_path=operation_connection_path(store, scope_id),
            url=os.environ.get("DNAFORGE_OPERATION_URL"),
            session_token=os.environ.get("DNAFORGE_MCP_SESSION_TOKEN"),
            operation_token=human_operation_token,
            scope_id=scope_id,
            owner_id=owner_id,
            mcp_stdio=bool(os.environ.get("DNAFORGE_RENDERER_BRIDGE_URL")),
        ) as managed_operations:
            async with annotation_provisioning_lifespan(
                app,
                managed_operations,
                scope_id=scope_id,
                owner_id=owner_id,
            ):
                async with mcp_http_endpoint.run(), serve_mcp_only_port(
                    mcp_http_endpoint
                ) as mcp_http_internal_port:
                    app.state.mcp_http_internal_port = mcp_http_internal_port
                    yield
    finally:
        await external_service.aclose()
        if replay_client is not None:
            await replay_client.aclose()
        print("Shutting down Molecular Biology Suite Tools Service")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator:
    async with compute_scheduling_lifespan(), _service_lifespan(app):
        yield


app = FastAPI(
    title="Molecular Biology Suite Tools Service",
    description="Bioinformatics tools API (BLAST, primer design, alignment, file parsing). "
    "Data operations handled by desktop app via Drizzle/SQLite.",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(WorkspaceBindingActivationMiddleware)
app.add_middleware(LocalAccessMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=configured_allowed_origins(),
    allow_origin_regex=ALLOWED_CORS_ORIGIN_REGEX,
    allow_credentials=False,
    allow_methods=ALLOWED_CORS_METHODS,
    allow_headers=ALLOWED_CORS_HEADERS,
    expose_headers=EXPOSED_CORS_HEADERS,
)

app.include_router(health.router, tags=["Health"])
app.include_router(services_router)
app.include_router(annotation_router)
app.include_router(annotation_output_router)
app.include_router(operations_router)
app.include_router(native_documents_router)
app.include_router(jobs_router)
app.include_router(sidecar_router)
app.include_router(mcp_router)
app.router.routes.append(
    Route(
        MCP_HTTP_PATH,
        endpoint=mcp_http_endpoint,
        methods=["GET", "POST", "DELETE"],
    )
)
app.include_router(mcp_caller_router)
app.include_router(mcp_discovery_router)
app.include_router(mcp_jobs_router)
app.include_router(agent_grants_router)
app.include_router(renderer_audit_router)
app.include_router(external_router)
app.include_router(compute_routes.router)
app.include_router(genome_router)
app.include_router(tiles_router)
if primer_design_router is not None:
    app.include_router(primer_design_router, tags=["Primer Design"])
app.include_router(alignment_router, tags=["Sequence Alignment"])
if adjacency_router is not None:
    app.include_router(adjacency_router, include_in_schema=False)
app.include_router(primer_bind_router, tags=["Primer Binding"])
app.include_router(agent_tools_router)
app.include_router(toolbox_router)


@app.get("/")
async def root():
    """Root endpoint - API information"""
    return {
        "name": "Molecular Biology Suite Tools Service",
        "version": "0.1.0",
        "purpose": "Bioinformatics compute operations",
        "architecture": "Data CRUD handled by desktop app via Drizzle/SQLite, not this API",
        "docs": "/docs",
        "status": "operational",
    }
