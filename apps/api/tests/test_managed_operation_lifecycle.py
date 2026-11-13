"""Owner cleanup covers startup failure as well as normal application shutdown."""

import asyncio

import pytest
from dnaforge_annotation.contract import AnnotationRequest, AnnotationResult
from fastapi import FastAPI

from src.control_plane import ControlPlaneStore
from src.managed_operation_lifecycle import managed_operation_lifespan
from src.operations import ManagedOperationService, OperationKind


@pytest.mark.parametrize("failure", ["publication", "application", None])
def test_failure_retires_connection_and_releases_the_actual_owner(tmp_path, failure):
    async def scenario():
        store = ControlPlaneStore(tmp_path / "ledger.sqlite3")
        store.initialize()
        app = FastAPI()
        connection = tmp_path / "connection.json"
        if failure == "publication":
            connection.mkdir()

        async def execute(request, _cancel):
            return AnnotationResult(features=[], sequence_length=len(request.sequence))

        def create_service():
            return ManagedOperationService(
                store=store,
                runtime_scope="test",
                kind=OperationKind.ANNOTATION,
                input_model=AnnotationRequest,
                result_model=AnnotationResult,
                executor=execute,
            )

        async def use_owner():
            async with managed_operation_lifespan(
                app,
                create_service=create_service,
                connection_path=connection,
                url="http://127.0.0.1:8888",
                session_token="launch-secret",
                operation_token="human-secret",
                scope_id="test",
                owner_id="local-human",
            ) as owner:
                assert app.state.managed_operations is owner
                assert app.state.managed_annotation_operations is owner
                assert connection.is_file()
                if failure == "application":
                    raise RuntimeError("Later application startup failed")

        try:
            if failure:
                with pytest.raises((OSError, RuntimeError)):
                    await use_owner()
            else:
                await use_owner()
            assert app.state.managed_operations is None
            assert app.state.managed_annotation_operations is None
            if failure != "publication":
                assert not connection.exists()
            replacement = create_service()
            await replacement.aclose()
        finally:
            store.close()

    asyncio.run(scenario())
