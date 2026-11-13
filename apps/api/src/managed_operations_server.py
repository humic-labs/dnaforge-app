"""Foreground HTTP owner for explicitly configured managed operations."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import secrets
import socket
import sqlite3
import stat
import sys
import threading
from collections.abc import Iterator
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Any

import uvicorn
from dnaforge_annotation.contract import (
    AnnotationRequest,
    AnnotationResult,
    AnnotationRuntime,
)
from dnaforge_annotation.core import run_annotation
from fastapi import FastAPI
from pydantic import ValidationError

from .annotation_provisioning import execute_managed_annotation_provisioning
from .control_plane import ControlPlaneStore
from .managed_alignment_coverage import execute_managed_alignment_coverage
from .managed_alignment_index import execute_managed_alignment_index
from .managed_genome_index import execute_managed_genome_index
from .managed_msa import execute_managed_msa
from .managed_operation_lifecycle import managed_operation_lifespan
from .managed_operations import MANAGED_OPERATION_SYSTEM
from .managed_pairwise_session_alignment import (
    execute_managed_pairwise_session_alignment,
)
from .managed_primer_library_search import execute_managed_primer_library_search
from .managed_track_registration import execute_managed_track_registration
from .managed_variant_source import execute_managed_variant_source
from .operation_connection import operation_connection_path, operation_runtime_directory
from .operation_kinds import (
    ALIGNMENT_COVERAGE_PREPARATION_OPERATION_KIND,
    ALIGNMENT_INDEX_PREPARATION_OPERATION_KIND,
    ANNOTATION_OPERATION_KIND,
    ANNOTATION_PROVISIONING_OPERATION_KIND,
    FASTQ_PREPROCESSING_OPERATION_KIND,
    GENOME_INDEXING_OPERATION_KIND,
    MULTIPLE_SEQUENCE_ALIGNMENT_OPERATION_KIND,
    NGS_READ_ANALYSIS_OPERATION_KIND,
    PAIRWISE_SESSION_ALIGNMENT_OPERATION_KIND,
    PRIMER_LIBRARY_SEARCH_OPERATION_KIND,
    TRACK_REGISTRATION_OPERATION_KIND,
    VARIANT_SOURCE_PREPARATION_OPERATION_KIND,
)
from .operations import (
    ManagedOperationService,
    OperationExecutionError,
)
from .routes.operations import router as operations_router
from .security.local_access import LocalAccessMiddleware
from .services.fastq_preprocessing import execute_fastq_preprocessing
from .services.ngs_read_analysis import execute_ngs_read_analysis

_RUNTIME_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")
_MAX_RUNTIME_CONFIG_BYTES = 64 * 1024
_MANAGED_DATABASE_TABLES = frozenset({"managed_operation", "managed_operation_owner"})


def validate_runtime_name(name: str) -> str:
    """Return a path-safe scope name or reject it."""
    if not _RUNTIME_NAME.fullmatch(name) or name in {".", ".."}:
        raise ValueError(
            "The runtime name must be 1-64 ASCII letters, digits, dots, underscores, or hyphens."
        )
    return name


def _absolute(path: Path) -> Path:
    expanded = path.expanduser()
    if not expanded.is_absolute():
        expanded = Path.cwd() / expanded
    return expanded.resolve(strict=False)


def _assert_managed_database(path: Path) -> None:
    if path.is_symlink():
        raise ValueError("The managed-operation database cannot be a symbolic link.")
    try:
        metadata = path.stat()
    except FileNotFoundError:
        return
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError("The managed-operation database path must be a regular file.")
    try:
        uri = path.resolve().as_uri() + "?mode=ro"
        with sqlite3.connect(uri, uri=True) as connection:
            tables = {
                str(row[0])
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
    except sqlite3.Error as exc:
        raise ValueError(
            "The selected database is not an existing managed-operation database."
        ) from exc
    if not _MANAGED_DATABASE_TABLES.issubset(tables):
        raise ValueError(
            "The selected database is not an existing managed-operation database."
        )


def resolve_database_path(name: str, db_path: Path | None) -> Path:
    """Choose an isolated ledger without repurposing an unrelated existing file."""
    runtime_name = validate_runtime_name(name)
    selected = (
        db_path
        if db_path is not None
        else operation_runtime_directory() / runtime_name / "managed-operations.sqlite3"
    )
    if selected.expanduser().is_symlink():
        raise ValueError("The managed-operation database cannot be a symbolic link.")
    resolved = _absolute(selected)
    _assert_managed_database(resolved)
    return resolved


def _read_runtime_config(path: Path) -> dict[str, Any]:
    selected = path.expanduser()
    if not selected.is_absolute():
        selected = Path.cwd() / selected
    if selected.is_symlink():
        raise ValueError(
            "The annotation runtime configuration cannot be a symbolic link."
        )
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(selected, flags)
    except OSError as exc:
        raise ValueError("Cannot open the annotation runtime configuration.") from exc
    with os.fdopen(descriptor, "r", encoding="utf-8") as source:
        metadata = os.fstat(source.fileno())
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError(
                "The annotation runtime configuration must be a regular file."
            )
        if metadata.st_size > _MAX_RUNTIME_CONFIG_BYTES:
            raise ValueError("The annotation runtime configuration is too large.")
        try:
            payload = json.load(source)
        except (ValueError, UnicodeError) as exc:
            raise ValueError(
                "The annotation runtime configuration is not valid JSON."
            ) from exc
    if not isinstance(payload, dict):
        raise ValueError("The annotation runtime configuration must be a JSON object.")
    return payload


def load_annotation_runtime(path: Path) -> AnnotationRuntime:
    """Load one explicit runtime, resolving relative resource paths beside its JSON file."""
    config_path = _absolute(path)
    runtime = AnnotationRuntime.model_validate(_read_runtime_config(path))
    base = config_path.parent

    def anchored(value: Path | None) -> Path | None:
        if value is None:
            return None
        return _absolute(value if value.is_absolute() else base / value)

    return AnnotationRuntime(
        data_dir=anchored(runtime.data_dir),
        executables={
            "blastn": anchored(runtime.executables.blastn),
            "diamond": anchored(runtime.executables.diamond),
            "cmscan": anchored(runtime.executables.cmscan),
        },
        temp_dir=anchored(runtime.temp_dir),
        threads=runtime.threads,
        database_config=anchored(runtime.database_config),
    )


def _managed_service(
    store: ControlPlaneStore,
    *,
    scope_id: str,
    runtime: AnnotationRuntime,
) -> ManagedOperationService:
    async def execute(
        request: AnnotationRequest, _cancel: threading.Event
    ) -> AnnotationResult:
        try:
            result = await asyncio.to_thread(run_annotation, request, runtime)
        except Exception as exc:
            message = str(exc).splitlines()[0][:1024] or "Annotation execution failed."
            raise OperationExecutionError("ANNOTATION_FAILED", message) from exc
        if result.error:
            raise OperationExecutionError(
                "ANNOTATION_FAILED", result.error.splitlines()[0][:1024]
            )
        return result

    return ManagedOperationService(
        store=store,
        runtime_scope=scope_id,
        adapters=MANAGED_OPERATION_SYSTEM.bind_executors(
            {
                NGS_READ_ANALYSIS_OPERATION_KIND.key: execute_ngs_read_analysis,
                FASTQ_PREPROCESSING_OPERATION_KIND.key: execute_fastq_preprocessing,
                ALIGNMENT_COVERAGE_PREPARATION_OPERATION_KIND.key: execute_managed_alignment_coverage,
                ALIGNMENT_INDEX_PREPARATION_OPERATION_KIND.key: execute_managed_alignment_index,
                ANNOTATION_OPERATION_KIND.key: execute,
                ANNOTATION_PROVISIONING_OPERATION_KIND.key: execute_managed_annotation_provisioning,
                GENOME_INDEXING_OPERATION_KIND.key: execute_managed_genome_index,
                MULTIPLE_SEQUENCE_ALIGNMENT_OPERATION_KIND.key: execute_managed_msa,
                PAIRWISE_SESSION_ALIGNMENT_OPERATION_KIND.key: execute_managed_pairwise_session_alignment,
                PRIMER_LIBRARY_SEARCH_OPERATION_KIND.key: execute_managed_primer_library_search,
                TRACK_REGISTRATION_OPERATION_KIND.key: execute_managed_track_registration,
                VARIANT_SOURCE_PREPARATION_OPERATION_KIND.key: execute_managed_variant_source,
            }
        ),
    )


def _create_app(
    *,
    name: str,
    runtime: AnnotationRuntime,
    db_path: Path,
    connection_path: Path,
    url: str,
    session_token: str,
    operation_token: str,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        store = ControlPlaneStore(db_path)
        try:
            store.initialize()

            def create_service() -> ManagedOperationService:
                return _managed_service(store, scope_id=name, runtime=runtime)

            async with managed_operation_lifespan(
                app,
                create_service=create_service,
                connection_path=connection_path,
                url=url,
                session_token=session_token,
                operation_token=operation_token,
                scope_id=name,
                owner_id="local-human",
            ):
                yield
        finally:
            store.close()

    app = FastAPI(
        title="DNAForge Managed Operations",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.add_middleware(LocalAccessMiddleware)
    app.include_router(operations_router)
    return app


@contextmanager
def _runtime_environment(values: dict[str, str]) -> Iterator[None]:
    previous = {key: os.environ.get(key) for key in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def serve(
    name: str,
    runtime_config: Path,
    db_path: Path | None = None,
    port: int = 0,
) -> int:
    """Own an explicit annotation queue in this foreground process until stopped."""
    runtime_name = validate_runtime_name(name)
    if isinstance(port, bool) or not isinstance(port, int) or not 0 <= port <= 65535:
        raise ValueError("The managed runtime port must be between 0 and 65535.")
    runtime = load_annotation_runtime(runtime_config)
    database = resolve_database_path(runtime_name, db_path)
    session_token = secrets.token_urlsafe(32)
    operation_token = secrets.token_urlsafe(32)
    while operation_token == session_token:
        operation_token = secrets.token_urlsafe(32)

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", port))
        listener.set_inheritable(False)
        actual_port = int(listener.getsockname()[1])
        url = f"http://127.0.0.1:{actual_port}"

        connection = operation_connection_path(database, runtime_name)
        app = _create_app(
            name=runtime_name,
            runtime=runtime,
            db_path=database,
            connection_path=connection,
            url=url,
            session_token=session_token,
            operation_token=operation_token,
        )
        config = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=actual_port,
            access_log=False,
            date_header=False,
            proxy_headers=False,
            server_header=False,
            timeout_graceful_shutdown=None,
            workers=1,
            lifespan="on",
        )
        server = uvicorn.Server(config)
        environment = {
            "DNAFORGE_MCP_SESSION_TOKEN": session_token,
            "DNAFORGE_HUMAN_OPERATION_TOKEN": operation_token,
            "DNAFORGE_OPERATION_SCOPE": runtime_name,
            "DNAFORGE_OPERATION_OWNER_ID": "local-human",
        }
        with _runtime_environment(environment):
            server.run(sockets=[listener])
        return 0 if server.started else 1


def _port(value: str) -> int:
    try:
        port = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("port must be an integer") from exc
    if not 0 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be between 0 and 65535")
    return port


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run one explicit managed annotation owner in the foreground."
    )
    parser.add_argument("name", help="Path-safe runtime name and operation scope")
    parser.add_argument(
        "runtime_config", type=Path, help="Explicit AnnotationRuntime JSON"
    )
    parser.add_argument(
        "--db", type=Path, help="Isolated managed-operation SQLite ledger"
    )
    parser.add_argument(
        "--port", type=_port, default=0, help="Loopback port; default 0 selects one"
    )
    arguments = parser.parse_args(argv)
    try:
        return serve(
            arguments.name,
            arguments.runtime_config,
            db_path=arguments.db,
            port=arguments.port,
        )
    except (OSError, ValueError, ValidationError) as exc:
        print(f"dnaforge-jobs: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
