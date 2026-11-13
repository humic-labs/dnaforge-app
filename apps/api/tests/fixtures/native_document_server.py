"""Bounded transport fixture using the production document callbacks and ledger."""

from __future__ import annotations

import argparse
import json
import socket
from contextlib import asynccontextmanager
from functools import partial
from pathlib import Path

import uvicorn
from dnaforge_annotation.contract import AnnotationRequest, AnnotationResult
from dnaforge_annotation.identity import annotation_input_revision
from fastapi import FastAPI

from src.annotation_document_contract import AnnotationDocumentSelection
from src.annotation_result_authority import result_sha256 as _result_sha256
from src.control_plane import ControlPlaneStore
from src.managed_annotation_document_actions import ManagedAnnotationDocumentActions
from src.operation_agent_authority import validate_operation_principal
from src.operations import ManagedOperationService, OperationPrincipal
from src.routes.native_documents import router as native_router
from src.routes.operations import router as operations_router
from src.security.local_access import LocalAccessMiddleware
from src.security.native_document_authority import capture_native_document_authority


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--document-revision")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--no-admission", action="store_true")
    parser.add_argument("--feature-count", type=int, choices=(1, 60_000), default=1)
    args = parser.parse_args()
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(128)
    port = listener.getsockname()[1]

    @asynccontextmanager
    async def lifespan(app):
        app.state.native_document_authority = capture_native_document_authority()
        store = ControlPlaneStore(args.database)
        store.initialize()

        async def never_execute(_request, _cancel):
            raise AssertionError("A document Apply cannot run computation")

        service = ManagedOperationService(
            store=store,
            runtime_scope="runtime-integration",
            kind="annotation",
            input_model=AnnotationRequest,
            result_model=AnnotationResult,
            executor=never_execute,
            principal_validator=partial(
                validate_operation_principal,
                store=store,
                runtime_scope="runtime-integration",
                owner_id="human-integration",
            ),
        )
        app.state.managed_operations = service
        try:
            if args.resume:
                print(json.dumps({"url": f"http://127.0.0.1:{port}"}), flush=True)
                yield
                return
            if not args.document_revision:
                raise ValueError(
                    "An initial document revision is required when seeding"
                )
            result = AnnotationResult.model_validate(
                {
                    "sequence_length": 4,
                    "features": [
                        {
                            "name": "Recorded candidate",
                            "type": "misc_feature",
                            "start": 1,
                            "end": 4,
                            "strand": 1,
                            "identity": 100,
                            "coverage": 100,
                            "fragment": False,
                            "ref_start": 1,
                            "ref_end": 4,
                            "ref_length": 4,
                            "db_source": "nucleotide",
                        }
                    ],
                }
            )
            result.features = [
                result.features[0].model_copy() for _ in range(args.feature_count)
            ]
            operation_id = store.insert_managed_operation(
                runtime_scope=service.runtime_scope,
                scope_id=service.runtime_scope,
                kind="annotation",
                subject_id="document-integration",
                input_revision=annotation_input_revision(
                    AnnotationRequest(sequence="ATGC", linear=True)
                ),
                submission_key="retained-fixture",
                submission_payload_hash="fixture",
                actor_kind="human",
                actor_id="human-integration",
                channel="managed_cli",
                owner_instance_id=service.owner_instance_id,
                now=service.clock(),
            )
            retained_payload = result.model_dump(mode="json")
            retained_bytes = len(
                json.dumps(retained_payload, separators=(",", ":")).encode()
            )
            assert retained_bytes <= 16 * 1024 * 1024
            store.put_managed_operation_result(
                operation_id, payload=retained_payload, size_bytes=retained_bytes
            )
            store.transition_managed_operation(
                operation_id,
                expected_states={"queued"},
                state="succeeded",
                owner_instance_id=service.owner_instance_id,
                now=service.clock(),
                result_status="available",
                mark_settled=True,
            )
            selection = AnnotationDocumentSelection(
                operationId=operation_id,
                targetDocumentId="document-integration",
                expectedOperationVersion=2,
                expectedResultSha256=_result_sha256(result),
                expectedTargetDocumentRevision=args.document_revision,
                selectedCandidateIds=[f"{operation_id}:0"],
            )
            caller = OperationPrincipal(
                actor_kind="human",
                actor_id="human-integration",
                channel="managed_cli",
                scope_ids={service.runtime_scope},
            )
            actions = ManagedAnnotationDocumentActions(
                service=service,
                native_owner_instance_id=app.state.native_document_authority.owner_instance_id,
            )
            action_id = None
            if not args.no_admission:
                admitted = actions.admit(caller, selection)
                assert admitted.status == "admitted" and admitted.record is not None
                action_id = admitted.record["id"]
            print(
                json.dumps(
                    {
                        "url": f"http://127.0.0.1:{port}",
                        "actionId": action_id,
                        "requestSha256": selection.request_sha256(),
                        "selection": selection.model_dump(mode="json", by_alias=True),
                    }
                ),
                flush=True,
            )
            yield
        finally:
            await service.aclose()
            store.close()

    app = FastAPI(lifespan=lifespan)
    app.add_middleware(LocalAccessMiddleware)
    app.include_router(native_router)
    app.include_router(operations_router)

    uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False)).run(
        sockets=[listener]
    )


if __name__ == "__main__":
    main()
