"""Remote input references owned by the existing durable operation lifecycle.

This contains no job store and no payloads. A failed/ambiguous release remains
on its operation row, blocks metadata pruning, and is retried after restart.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Protocol

from ..control_plane import ControlPlaneStore
from ..control_plane.managed_operation_rows import ManagedOperationRow
from .contracts import OperationAcceptedWorkspaceInput

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class OperationInputReference:
    operation_id: str
    workspace_id: str
    account_id: str
    version_id: str
    manifest_sha256: str

    @classmethod
    def from_row(cls, row: ManagedOperationRow) -> OperationInputReference:
        source = OperationAcceptedWorkspaceInput.model_validate(
            row["accepted_workspace_input_json"]
        )
        if source.workspace_id != row["scope_id"]:
            raise ValueError("Operation input workspace does not match its scope")
        return cls(
            row["id"],
            row["scope_id"],
            row["actor_id"],
            source.version_id,
            source.manifest_sha256,
        )


class OperationInputRetainer(Protocol):
    async def retain(self, reference: OperationInputReference) -> None: ...

    async def release(self, reference: OperationInputReference) -> None: ...


class OperationInputRetention:
    def __init__(
        self,
        store: ControlPlaneStore,
        runtime_scope: str,
        retainer: OperationInputRetainer,
    ):
        self.store = store
        self.runtime_scope = runtime_scope
        self.retainer = retainer
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._closed = False

    async def retain(self, row: ManagedOperationRow) -> None:
        async with self._lock:
            await self.retainer.retain(OperationInputReference.from_row(row))
            self.store.mark_managed_input_retention(
                row["id"], expected="retain_pending", state="held"
            )

    async def reconcile(self) -> None:
        for row in self.store.list_managed_input_retentions(
            self.runtime_scope, "retain_pending"
        ):
            await self.retain(row)
        await self._release_pending()
        self.kick()

    def kick(self) -> None:
        self.store.prepare_managed_input_releases(self.runtime_scope)
        if self._closed or (self._task is not None and not self._task.done()):
            return
        if not self.store.list_managed_input_retentions(
            self.runtime_scope, "release_pending"
        ):
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._task = loop.create_task(self._drain())

    async def _release_pending(self) -> bool:
        self.store.prepare_managed_input_releases(self.runtime_scope)
        rows = self.store.list_managed_input_retentions(
            self.runtime_scope, "release_pending"
        )
        for row in rows:
            async with self._lock:
                current = self.store.get_managed_operation(row["id"])
                if (
                    current is None
                    or current["input_retention_state"] != "release_pending"
                ):
                    continue
                try:
                    await self.retainer.release(OperationInputReference.from_row(row))
                except Exception:
                    logger.warning("Operation input release pending: %s", row["id"])
                    return True
                else:
                    self.store.mark_managed_input_retention(
                        row["id"], expected="release_pending", state="released"
                    )
        return False

    async def _drain(self) -> None:
        while not self._closed:
            if await self._release_pending():
                await asyncio.sleep(30)
            elif not self.store.list_managed_input_retentions(
                self.runtime_scope, "release_pending"
            ):
                return

    async def aclose(self) -> None:
        self._closed = True
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
