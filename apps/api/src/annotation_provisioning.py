"""One durable owner for DNAForge-managed annotation installation work."""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass

from fastapi import FastAPI

from .annotation.asset_updater import asset_needs_update
from .annotation.provisioning_lock import (
    AnnotationInstallationLease,
    annotation_installation_needs_recovery,
)
from .annotation.setup import (
    _plannotate_dbs_spec,
    _rfam_spec,
    ensure_databases,
    ensure_plannotate_dbs_current,
    ensure_rfam_current,
    ensure_rfam_platform_compatible,
    get_annotation_data_dir,
    get_app_data_base,
    get_database_status,
    is_rfam_runtime_ready,
    set_initial_annotation_provisioning,
)
from .annotation.tools import ensure_tools, get_tools_dir, validate_tools
from .annotation_provisioning_contract import (
    AnnotationProvisioningInput,
    AnnotationProvisioningResult,
    AnnotationProvisioningSubmission,
    annotation_provisioning_subject_id,
    current_annotation_provisioning_input,
    prepare_annotation_provisioning_submission,
)
from .control_plane import new_uuid7
from .operations import (
    ACTIVE_STATES,
    ActorKind,
    ClientChannel,
    ManagedOperationService,
    OperationExecutionError,
    OperationPrincipal,
    OperationSnapshot,
)
from .services.plannotate import check_required_binaries, find_binaries_dir

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AnnotationProvisioningReadiness:
    tools_ready: bool
    databases_ready: bool
    rfam_runtime_ready: bool
    updates_current: bool

    @property
    def ready(self) -> bool:
        return (
            self.tools_ready
            and self.databases_ready
            and self.rfam_runtime_ready
            and self.updates_current
        )


def _tools_ready() -> bool:
    bundled = os.environ.get("WAYPOINT_BINARIES_PATH")
    if bundled:
        status = check_required_binaries(find_binaries_dir())
        if status and all(status.values()):
            return True
    status = validate_tools(get_tools_dir())
    return bool(status) and all(status.values())


def annotation_provisioning_readiness() -> AnnotationProvisioningReadiness:
    data_dir = get_annotation_data_dir()
    database = get_database_status(data_dir)
    databases_ready = bool(database["downloaded"]) and not bool(
        database["needs_update"]
    )
    offline = os.environ.get("DNAFORGE_OFFLINE_ANNOTATION") == "1"
    updates_current = (
        databases_ready
        and not annotation_installation_needs_recovery(get_app_data_base())
        and (
            offline
            or not (
                asset_needs_update(_rfam_spec(), data_dir)
                or asset_needs_update(_plannotate_dbs_spec(), data_dir)
            )
        )
    )
    return AnnotationProvisioningReadiness(
        tools_ready=_tools_ready(),
        databases_ready=databases_ready,
        rfam_runtime_ready=is_rfam_runtime_ready(),
        updates_current=updates_current,
    )


def annotation_provisioning_required() -> bool:
    return not annotation_provisioning_readiness().ready


async def execute_managed_annotation_provisioning(
    value: AnnotationProvisioningInput,
    _cancel: threading.Event | None,
) -> AnnotationProvisioningResult:
    current = current_annotation_provisioning_input()
    if value != current:
        raise OperationExecutionError(
            "ANNOTATION_PROVISIONING_INPUT_STALE",
            "The annotation setup target changed before this attempt started.",
        )

    lease = AnnotationInstallationLease(
        get_app_data_base(), owner_id=f"operation-{new_uuid7()}"
    )
    set_initial_annotation_provisioning(True)
    try:
        await lease.acquire_async()
        try:
            if not annotation_provisioning_required():
                readiness = annotation_provisioning_readiness()
                return AnnotationProvisioningResult(
                    installation_revision=value.installation_revision,
                    disposition="already_current",
                    tools_ready=readiness.tools_ready,
                    databases_ready=readiness.databases_ready,
                    rfam_runtime_ready=readiness.rfam_runtime_ready,
                )

            await ensure_tools()
            await ensure_databases()
            if value.offline:
                await ensure_rfam_platform_compatible()
            else:
                await ensure_rfam_current()
                await ensure_rfam_platform_compatible()
                await ensure_plannotate_dbs_current()

            readiness = annotation_provisioning_readiness()
            if not readiness.ready:
                raise OperationExecutionError(
                    "ANNOTATION_PROVISIONING_FAILED",
                    "Annotation setup did not produce a usable installation.",
                    details={
                        "tools_ready": readiness.tools_ready,
                        "databases_ready": readiness.databases_ready,
                        "rfam_runtime_ready": readiness.rfam_runtime_ready,
                        "updates_current": readiness.updates_current,
                    },
                )
            return AnnotationProvisioningResult(
                installation_revision=value.installation_revision,
                disposition="installed",
                tools_ready=readiness.tools_ready,
                databases_ready=readiness.databases_ready,
                rfam_runtime_ready=readiness.rfam_runtime_ready,
            )
        finally:
            lease.release()
    finally:
        set_initial_annotation_provisioning(False)


class AnnotationProvisioningCoordinator:
    """Choose one attempt for startup and all concurrent Toolbox Retry calls."""

    def __init__(
        self,
        service: ManagedOperationService,
        *,
        scope_id: str,
        owner_id: str,
    ) -> None:
        self._service = service
        self._scope_id = scope_id
        self._principal = OperationPrincipal(
            actor_kind=ActorKind.HUMAN,
            actor_id=owner_id,
            channel=ClientChannel.DESKTOP_UI,
            scope_ids={scope_id},
        )
        self._lock = asyncio.Lock()

    async def start_if_needed(self) -> OperationSnapshot | None:
        if not annotation_provisioning_required():
            return None
        return await self._start_or_join()

    async def retry(self) -> OperationSnapshot:
        return await self._start_or_join()

    async def _start_or_join(self) -> OperationSnapshot:
        async with self._lock:
            current = current_annotation_provisioning_input()
            subject_id = annotation_provisioning_subject_id(current)
            existing = self._service.list(
                self._principal,
                scope_id=self._scope_id,
                subject_id=subject_id,
                limit=100,
            )
            for operation in existing:
                if (
                    operation.kind == "annotation-provisioning"
                    and operation.subject.input_revision
                    == current.installation_revision
                    and operation.state in ACTIVE_STATES
                ):
                    return operation

            request = AnnotationProvisioningSubmission(
                submission_key=f"annotation-provisioning-{new_uuid7()}",
                scope_id=self._scope_id,
                input_revision=current.installation_revision,
            )
            return await self._service.start(
                self._principal,
                prepare_annotation_provisioning_submission(request),
                kind="annotation-provisioning",
            )


@asynccontextmanager
async def annotation_provisioning_lifespan(
    app: FastAPI,
    service: ManagedOperationService,
    *,
    scope_id: str,
    owner_id: str,
) -> AsyncIterator[AnnotationProvisioningCoordinator]:
    if getattr(app.state, "annotation_provisioning", None) is not None:
        raise RuntimeError("This application already has an annotation setup owner")
    coordinator = AnnotationProvisioningCoordinator(
        service,
        scope_id=scope_id,
        owner_id=owner_id,
    )
    app.state.annotation_provisioning = coordinator
    set_initial_annotation_provisioning(True)
    try:
        try:
            operation = await coordinator.start_if_needed()
        except Exception:
            set_initial_annotation_provisioning(False)
            logger.exception("Could not start managed annotation provisioning")
        else:
            if operation is None:
                set_initial_annotation_provisioning(False)
        yield coordinator
    finally:
        set_initial_annotation_provisioning(False)
        app.state.annotation_provisioning = None


__all__ = [
    "AnnotationProvisioningCoordinator",
    "AnnotationProvisioningReadiness",
    "annotation_provisioning_lifespan",
    "annotation_provisioning_readiness",
    "annotation_provisioning_required",
    "execute_managed_annotation_provisioning",
]
