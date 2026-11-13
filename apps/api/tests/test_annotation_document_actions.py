from __future__ import annotations

from functools import partial

import pytest
from dnaforge_annotation.contract import AnnotationRequest, AnnotationResult
from fastapi import FastAPI

from src.annotation_document_contract import (
    AnnotationDocumentSelection,
    AnnotationDocumentTarget,
)
from src.annotation_result_authority import result_sha256 as _result_sha256
from src.control_plane import ControlPlaneStore
from src.managed_annotation_document_actions import ManagedAnnotationDocumentActions
from src.managed_annotation_documents import (
    ManagedAnnotationDocuments,
    NativeDocumentConnectionUnavailable,
    NativeDocumentInspectionUnavailable,
)
from src.native_document_dispatch import NativeDocumentDispatchResult
from src.operation_agent_authority import validate_operation_principal
from src.operations import (
    ManagedOperationService,
    OperationAccessDenied,
    OperationPrincipal,
    SubmissionConflict,
)
from src.operations.document_actions import DocumentWriteIntent
from src.routes.native_documents import router as native_document_router
from src.routes.operations import router as operations_router
from src.security.local_access import LocalAccessMiddleware
from src.security.native_document_authority import (
    NativeDocumentAuthority,
    capture_native_document_authority,
)
from tests.sidecar_test_client import AuthenticatedSidecarTestClient
from tests.test_managed_document_admission import operation

CAPABILITIES = frozenset(
    {"operations.read", "read-workspace", "read-sequences", "write-workspace"}
)


@pytest.fixture
async def runtime(tmp_path):
    store = ControlPlaneStore(tmp_path / "annotation-document.sqlite3")
    store.initialize()
    store.ensure_agent_identity(
        "agent-a",
        parent_human_identity_id="human-a",
        scope=sorted(CAPABILITIES),
        environment_id="runtime-a",
    )

    async def never_execute(_request, _cancel):
        pytest.fail("Applying a retained result must not run computation")

    service = ManagedOperationService(
        store=store,
        runtime_scope="runtime-a",
        kind="annotation",
        input_model=AnnotationRequest,
        result_model=AnnotationResult,
        executor=never_execute,
        principal_validator=partial(
            validate_operation_principal,
            store=store,
            runtime_scope="runtime-a",
            owner_id="human-a",
        ),
    )
    operation_id = operation(store, scope_id="runtime-a")
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
    store.put_managed_operation_result(
        operation_id, payload=result.model_dump(mode="json"), size_bytes=512
    )
    selection = AnnotationDocumentSelection(
        operationId=operation_id,
        targetDocumentId="document-first",
        expectedOperationVersion=2,
        expectedResultSha256=_result_sha256(result),
        expectedTargetDocumentRevision=f"annotation-document-v1:sha256:{'3' * 64}",
        selectedCandidateIds=[f"{operation_id}:0"],
    )
    actions = ManagedAnnotationDocumentActions(
        service=service, native_owner_instance_id="native-owner-a"
    )
    try:
        yield store, service, actions, selection
    finally:
        await service.aclose()
        store.close()


def principal(channel="managed_cli"):
    return OperationPrincipal(
        actor_kind="agent" if channel == "agent" else "human",
        actor_id="agent-a" if channel == "agent" else "human-a",
        channel=channel,
        scope_ids={"runtime-a"},
        capabilities=CAPABILITIES if channel == "agent" else frozenset(),
    )


def write_intent(selection, **changes):
    values = {
        "before_sha256": f"sha256:{'1' * 64}",
        "after_sha256": f"sha256:{'2' * 64}",
        "target_revision": f"annotation-document-v1:sha256:{'4' * 64}",
        "selection_sha256": selection.selection_sha256(),
        "selection_count": 1,
    }
    values.update(changes)
    return DocumentWriteIntent(**values)


@pytest.mark.parametrize("channel", ["desktop_ui", "managed_cli", "agent"])
def test_all_clients_retain_their_actual_identity_through_native_write_permission(
    runtime, channel
):
    store, _, actions, selection = runtime
    admitted = actions.admit(principal(channel), selection)
    assert admitted.status == "admitted"
    action_id = admitted.record["id"]
    assert action_id != selection.operation_id
    authority = actions.authority(action_id, selection)
    assert authority["operation"]["id"] == selection.operation_id
    assert (
        actions.begin_write(action_id, selection, write_intent(selection)).status
        == "permitted"
    )
    row = store.get_managed_operation_action(action_id)
    caller = principal(channel)
    assert (row["actor_kind"], row["actor_id"], row["channel"]) == (
        caller.actor_kind.value,
        caller.actor_id,
        channel,
    )


def test_revoking_an_agent_between_admission_and_write_refuses_the_intent(runtime):
    store, _, actions, selection = runtime
    action_id = actions.admit(principal("agent"), selection).record["id"]
    store.revoke_agent_identity("agent-a")
    with pytest.raises(OperationAccessDenied):
        actions.begin_write(action_id, selection, write_intent(selection))
    assert (
        store.get_managed_operation_action(action_id)["outcome"] == "document_admitted"
    )


def test_read_only_agent_cannot_admit_a_document_write(runtime):
    store, _, actions, selection = runtime
    caller = principal("agent").model_copy(
        update={"capabilities": CAPABILITIES - {"write-workspace"}}
    )
    with pytest.raises(OperationAccessDenied):
        actions.admit(caller, selection)
    assert store.page_managed_operation_actions(selection.operation_id)[1] == 0


@pytest.mark.parametrize("channel", ["desktop_ui", "managed_cli", "agent"])
def test_inspection_authority_does_not_require_or_create_a_write_admission(
    runtime, channel
):
    store, _, actions, selection = runtime
    caller = principal(channel)
    if channel == "agent":
        caller = caller.model_copy(
            update={"capabilities": CAPABILITIES - {"write-workspace"}}
        )
    target = AnnotationDocumentTarget(
        operationId=selection.operation_id,
        targetDocumentId=selection.target_document_id,
    )
    authority = actions.inspection_authority(caller, target)
    assert authority["operation"]["id"] == selection.operation_id
    assert authority["resultSha256"] == selection.expected_result_sha256
    assert store.page_managed_operation_actions(selection.operation_id)[1] == 0
    assert not store.has_pending_managed_document_action(selection.operation_id)


def test_read_only_inspection_rechecks_the_actual_live_grant_and_document_target(
    runtime,
):
    store, _, actions, selection = runtime
    target = AnnotationDocumentTarget(
        operationId=selection.operation_id, targetDocumentId="another-document"
    )
    with pytest.raises(SubmissionConflict):
        actions.inspection_authority(principal("agent"), target)
    store.revoke_agent_identity("agent-a")
    with pytest.raises(OperationAccessDenied):
        actions.inspection_authority(
            principal("agent"),
            target.model_copy(
                update={"target_document_id": selection.target_document_id}
            ),
        )


@pytest.mark.parametrize(
    "change",
    [
        {"expected_operation_version": 1},
        {"expected_result_sha256": f"sha256:{'f' * 64}"},
        {"selected_candidate_ids": ["unrelated-operation:0"]},
        {"target_document_id": "another-document"},
    ],
)
def test_stale_or_mismatched_selection_never_acquires_an_action(runtime, change):
    store, _, actions, selection = runtime
    with pytest.raises(SubmissionConflict):
        actions.admit(principal(), selection.model_copy(update=change))
    assert store.page_managed_operation_actions(selection.operation_id)[1] == 0


def test_native_intent_must_match_the_admitted_selection(runtime):
    store, _, actions, selection = runtime
    action_id = actions.admit(principal(), selection).record["id"]
    with pytest.raises(SubmissionConflict):
        actions.begin_write(
            action_id, selection, write_intent(selection, selection_count=2)
        )
    assert (
        store.get_managed_operation_action(action_id)["outcome"] == "document_admitted"
    )


@pytest.mark.asyncio
async def test_result_release_and_document_admission_use_the_same_owner(runtime):
    _, service, actions, selection = runtime
    actions.admit(principal(), selection)
    response = await service.release_result(principal(), selection.operation_id)
    assert response.disposition == "unavailable"
    assert service.get_result(principal(), selection.operation_id).status == "available"


@pytest.fixture
def native_client(runtime, monkeypatch):
    _, service, _, _ = runtime
    monkeypatch.setenv("DNAFORGE_NATIVE_DOCUMENT_TOKEN", "private-native-token")
    monkeypatch.setenv("DNAFORGE_NATIVE_DOCUMENT_OWNER_ID", "native-owner-a")
    monkeypatch.setenv("DNAFORGE_NATIVE_DOCUMENT_URL", "http://127.0.0.1:43210")
    monkeypatch.setenv("DNAFORGE_HUMAN_OPERATION_TOKEN", "human-operation-secret")
    monkeypatch.setenv("DNAFORGE_OPERATION_SCOPE", "runtime-a")
    monkeypatch.setenv("DNAFORGE_OPERATION_OWNER_ID", "human-a")
    app = FastAPI()
    app.state.native_document_authority = capture_native_document_authority()
    app.state.managed_operations = service
    app.add_middleware(LocalAccessMiddleware)
    app.include_router(native_document_router)
    app.include_router(operations_router)
    with AuthenticatedSidecarTestClient(app) as client:
        yield client


def test_private_routes_record_one_native_save_in_the_existing_human_history(
    runtime, native_client
):
    _, service, actions, selection = runtime
    action_id = actions.admit(principal(), selection).record["id"]
    path = f"/internal/managed-documents/actions/{action_id}"
    headers = {"X-DNAForge-Native-Document-Authority": "private-native-token"}
    selected = selection.model_dump(mode="json", by_alias=True)
    assert (
        native_client.post(
            path + "/authority", json={"selection": selected}, headers=headers
        ).status_code
        == 200
    )
    intent = write_intent(selection)
    body = {"selection": selected, "intent": intent.model_dump()}
    first = native_client.post(path + "/intent", json=body, headers=headers)
    assert first.status_code == 200, first.text
    assert first.json()["status"] == "permitted"
    assert (
        native_client.post(path + "/intent", json=body, headers=headers).json()[
            "status"
        ]
        == "existing"
    )
    saved = native_client.post(
        path + "/settlement",
        headers=headers,
        json={
            "request_sha256": selection.request_sha256(),
            "settlement": {
                "status": "saved",
                "observed_sha256": intent.after_sha256,
                "target_revision": intent.target_revision,
                "checkpoint": {"status": "not-required"},
            },
        },
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["status"] == "recorded"
    history = service.list_actions_page(principal(), selection.operation_id)
    assert len(history.actions) == 1
    assert history.actions[0].outcome == "document_saved"
    assert history.actions[0].actor_kind == "human"
    assert history.actions[0].actor_id == "human-a"
    assert history.actions[0].channel == "managed_cli"
    assert history.actions[0].details["write_after_sha256"] == intent.after_sha256
    assert history.actions[0].details["saved_target_revision"] == intent.target_revision
    assert history.actions[0].details["checkpoint_status"] == "not-required"
    assert history.actions[0].details["selection_count"] == 1


def test_only_the_current_private_owner_can_observe_and_recover_a_predecessor(
    runtime, native_client
):
    store, service, actions, selection = runtime
    row = actions.admit(principal("agent"), selection).record
    intent = write_intent(selection)
    actions.begin_write(row["id"], selection, intent)
    native_client.app.state.native_document_authority = NativeDocumentAuthority(
        "successor-token", "native-owner-b"
    )
    path = f'/internal/managed-documents/actions/{row["id"]}/recovery'
    body = {
        "request_sha256": selection.request_sha256(),
        "previous_native_owner_instance_id": "native-owner-a",
        "settlement": {
            "status": "saved",
            "observed_sha256": intent.after_sha256,
            "target_revision": intent.target_revision,
            "checkpoint": {"status": "committed", "commit": "c" * 40},
        },
    }
    for token in (None, "private-native-token"):
        headers = {"X-DNAForge-Native-Document-Authority": token} if token else {}
        assert (
            native_client.get(
                "/internal/managed-documents/pending", headers=headers
            ).status_code
            == 403
        )
        assert native_client.post(path, json=body, headers=headers).status_code == 403
    headers = {"X-DNAForge-Native-Document-Authority": "successor-token"}
    page = native_client.get("/internal/managed-documents/pending", headers=headers)
    assert page.status_code == 200, page.text
    assert page.json()["native_owner_instance_id"] == "native-owner-b"
    assert [action["id"] for action in page.json()["actions"]] == [row["id"]]
    assert (
        native_client.get(
            "/internal/managed-documents/pending?limit=33", headers=headers
        ).status_code
        == 422
    )
    saved = native_client.post(path, json=body, headers=headers)
    assert saved.status_code == 200, saved.text
    assert saved.json()["status"] == "recorded"
    assert (
        native_client.post(path, json=body, headers=headers).json()["status"]
        == "existing"
    )
    assert (
        native_client.get(
            "/internal/managed-documents/pending", headers=headers
        ).json()["actions"]
        == []
    )
    history = service.list_actions_page(principal(), selection.operation_id)
    assert len(history.actions) == 1
    record = history.actions[0]
    assert record.actor_kind == "agent"
    assert record.actor_id == "agent-a"
    assert record.channel == "agent"
    assert record.details["native_owner_instance_id"] == "native-owner-a"
    assert record.details["recovered_by_native_owner_instance_id"] == "native-owner-b"
    assert record.details["checkpoint_commit"] == "c" * 40
    assert not store.has_pending_managed_document_action(selection.operation_id)


def test_real_native_route_refuses_a_human_client_forging_completion(
    runtime, native_client
):
    store, _, actions, selection = runtime
    action_id = actions.admit(principal(), selection).record["id"]
    intent = write_intent(selection)
    result = native_client.post(
        f"/internal/managed-documents/actions/{action_id}/settlement",
        json={
            "request_sha256": selection.request_sha256(),
            "settlement": {
                "status": "saved",
                "observed_sha256": intent.after_sha256,
                "target_revision": intent.target_revision,
                "checkpoint": {"status": "not-required"},
            },
        },
        headers={"X-DNAForge-Operation-Authority": "human-operation-secret"},
    )
    assert result.status_code == 403
    assert (
        store.get_managed_operation_action(action_id)["outcome"] == "document_admitted"
    )


def document_service(actions, dispatch=None):
    options = {
        "actions": actions,
        "authority": NativeDocumentAuthority(
            "native-private", "native-owner-a", "http://127.0.0.1:43210"
        ),
    }
    if dispatch is not None:
        options["dispatch"] = dispatch
    return ManagedAnnotationDocuments(**options)


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", ["desktop_ui", "managed_cli", "agent"])
async def test_document_service_reports_only_the_native_save_recorded_for_its_actual_caller(
    runtime, channel
):
    store, _, actions, selection = runtime

    async def dispatch(authority, command):
        request = command["request"]
        assert authority.owner_instance_id == "native-owner-a"
        intent = write_intent(selection)
        assert (
            actions.begin_write(request["actionId"], selection, intent).status
            == "permitted"
        )
        actions.journal.settle(
            action_id=request["actionId"],
            request_sha256=selection.request_sha256(),
            status="saved",
            observed_sha256=intent.after_sha256,
            target_revision=intent.target_revision,
            checkpoint={"status": "committed", "commit": "b" * 40},
        )
        return NativeDocumentDispatchResult(
            "completed",
            result={
                "status": "saved",
                "targetDocumentRevision": intent.target_revision,
                "checkpoint": {"status": "committed", "commit": "b" * 40},
                "display": "not-required",
            },
        )

    result = await document_service(actions, dispatch).apply(
        principal(channel), selection
    )
    assert result.outcome.status == "saved"
    assert result.outcome.display == "not-required"
    row = store.get_managed_operation_action(result.action_id)
    assert row["channel"] == channel
    assert row["actor_kind"] == principal(channel).actor_kind.value
    assert row["actor_id"] == principal(channel).actor_id
    assert not store.has_pending_managed_document_action(selection.operation_id)


@pytest.mark.asyncio
async def test_native_success_without_the_common_journal_cannot_be_reported_as_a_saved_document(
    runtime,
):
    store, _, actions, selection = runtime

    async def dispatch(*args):
        return NativeDocumentDispatchResult(
            "completed",
            result={
                "status": "saved",
                "targetDocumentRevision": write_intent(selection).target_revision,
                "checkpoint": {"status": "not-required"},
                "display": "refreshed",
            },
        )

    result = await document_service(actions, dispatch).apply(principal(), selection)
    assert result.outcome.status == "outcome-unresolved"
    assert store.has_pending_managed_document_action(selection.operation_id)


@pytest.mark.asyncio
async def test_explicit_native_preacceptance_refusal_closes_only_the_unwritten_admission(
    runtime,
):
    store, _, actions, selection = runtime

    async def dispatch(*args):
        return NativeDocumentDispatchResult(
            "refused", reason="The native owner is shutting down."
        )

    result = await document_service(actions, dispatch).apply(principal(), selection)
    assert result.outcome.status == "blocked"
    assert result.outcome.reason == "The native owner is shutting down."
    assert (
        store.get_managed_operation_action(result.action_id)["outcome"]
        == "document_blocked"
    )
    assert not store.has_pending_managed_document_action(selection.operation_id)


@pytest.mark.asyncio
async def test_a_connection_without_a_native_owner_does_not_reserve_a_document_write(
    runtime,
):
    store, _, actions, selection = runtime
    documents = ManagedAnnotationDocuments(actions=actions, authority=None)
    with pytest.raises(NativeDocumentConnectionUnavailable):
        await documents.apply(principal(), selection)
    assert not store.has_pending_managed_document_action(selection.operation_id)
    assert store.page_managed_operation_actions(selection.operation_id)[1] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reply", ["lost", "wrong-revision", "wrong-checkpoint", "malformed"]
)
async def test_a_saved_receipt_survives_a_lost_or_conflicting_reply_without_inventing_refresh(
    runtime, reply
):
    store, _, actions, selection = runtime
    calls = []

    async def dispatch(authority, command):
        calls.append(command)
        action_id = command["request"]["actionId"]
        intent = write_intent(selection)
        actions.begin_write(action_id, selection, intent)
        actions.journal.settle(
            action_id=action_id,
            request_sha256=selection.request_sha256(),
            status="saved",
            observed_sha256=intent.after_sha256,
            target_revision=intent.target_revision,
            checkpoint={"status": "not-required"},
        )
        if reply == "lost":
            return NativeDocumentDispatchResult("outcome-unresolved")
        native = {
            "status": "saved",
            "targetDocumentRevision": intent.target_revision,
            "checkpoint": {"status": "not-required"},
            "display": "refreshed",
        }
        if reply == "wrong-revision":
            native["targetDocumentRevision"] = "another-revision"
        elif reply == "wrong-checkpoint":
            native["checkpoint"] = {"status": "committed", "commit": "a" * 40}
        else:
            native["checkpoint"] = {"status": "committed", "commit": "invalid"}
        return NativeDocumentDispatchResult("completed", result=native)

    result = await document_service(actions, dispatch).apply(principal(), selection)
    assert result.outcome.status == "saved"
    assert (
        result.outcome.target_document_revision
        == write_intent(selection).target_revision
    )
    assert result.outcome.checkpoint.status == "not-required"
    assert result.outcome.display == "pending"
    assert len(calls) == 1
    assert not store.has_pending_managed_document_action(selection.operation_id)


@pytest.mark.asyncio
async def test_a_refusal_cannot_clear_a_write_that_already_has_an_intent(runtime):
    store, _, actions, selection = runtime
    calls = []

    async def dispatch(authority, command):
        calls.append(command)
        actions.begin_write(
            command["request"]["actionId"], selection, write_intent(selection)
        )
        return NativeDocumentDispatchResult(
            "refused", reason="A conflicting delivery was refused."
        )

    documents = document_service(actions, dispatch)
    result = await documents.apply(principal(), selection)
    assert result.outcome.status == "outcome-unresolved"
    assert (
        store.get_managed_operation_action(result.action_id)["outcome"]
        == "document_writing"
    )
    assert store.has_pending_managed_document_action(selection.operation_id)
    with pytest.raises(SubmissionConflict):
        await documents.apply(principal(), selection)
    assert len(calls) == 1
    assert store.page_managed_operation_actions(selection.operation_id)[1] == 1


def inspection_result(command, selection):
    authority = command["authority"]
    return {
        **command["target"],
        "operationVersion": authority["operation"]["version"],
        "resultSha256": authority["resultSha256"],
        "targetDocumentRevision": selection.expected_target_document_revision,
        "analyzedInputRevision": authority["operation"]["subject"]["input_revision"],
        "candidates": [
            {
                "id": f"{selection.operation_id}:{index}",
                "index": index,
                "sourceFeature": feature,
                "feature": feature,
                "substitutionOverlap": False,
            }
            for index, feature in enumerate(authority["result"]["features"])
        ],
        "applicable": True,
        "coordinates": "exact",
        "transitionCount": 0,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change", ["none", "mapped", "source", "target", "candidate", "permission"]
)
async def test_native_inspection_remains_read_only_and_bound_to_the_live_caller_and_retained_result(
    runtime, change
):
    store, _, actions, selection = runtime
    calls = []

    async def dispatch(authority, command):
        calls.append(command)
        result = inspection_result(command, selection)
        if change == "target":
            result["targetDocumentId"] = "another-document"
        if change == "candidate":
            result["candidates"][0]["id"] = "another-operation:0"
        if change == "source":
            result["candidates"][0]["sourceFeature"] = {
                **result["candidates"][0]["sourceFeature"],
                "name": "untrusted source",
            }
        if change == "mapped":
            result["coordinates"] = "mapped"
            result["transitionCount"] = 1
            result["candidates"][0]["feature"] = {
                **result["candidates"][0]["feature"],
                "start": result["candidates"][0]["feature"]["start"] + 2,
                "end": result["candidates"][0]["feature"]["end"] + 2,
            }
        if change == "permission":
            store.revoke_agent_identity("agent-a")
        return NativeDocumentDispatchResult("completed", result=result)

    documents = document_service(actions, dispatch)
    caller = principal("agent").model_copy(
        update={"capabilities": CAPABILITIES - {"write-workspace"}}
    )
    target = AnnotationDocumentTarget(
        operationId=selection.operation_id,
        targetDocumentId=selection.target_document_id,
    )
    if change in {"none", "mapped"}:
        result = await documents.inspect(caller, target)
        assert result.candidates[0].id == selection.selected_candidate_ids[0]
        if change == "mapped":
            assert result.candidates[0].feature.start == 3
        with pytest.raises(OperationAccessDenied):
            await documents.apply(caller, selection)
    else:
        expected = (
            OperationAccessDenied
            if change == "permission"
            else NativeDocumentInspectionUnavailable
        )
        with pytest.raises(expected):
            await documents.inspect(caller, target)
    assert len(calls) == 1
    assert store.page_managed_operation_actions(selection.operation_id)[1] == 0
    assert not store.has_pending_managed_document_action(selection.operation_id)


@pytest.mark.parametrize("channel", ["desktop_ui", "managed_cli"])
def test_public_document_routes_use_the_authenticated_human_and_validate_input(
    runtime, native_client, monkeypatch, channel
):
    store, _, _, selection = runtime
    calls = []

    async def dispatch(authority, command):
        calls.append(command)
        if command["command"] == "annotation.inspect":
            return NativeDocumentDispatchResult(
                "completed", result=inspection_result(command, selection)
            )
        return NativeDocumentDispatchResult(
            "refused", reason="This fixture refuses before writing."
        )

    original_init = ManagedAnnotationDocuments.__init__

    def with_dispatch(self, **options):
        original_init(self, **options, dispatch=dispatch)

    monkeypatch.setattr(ManagedAnnotationDocuments, "__init__", with_dispatch)
    headers = {
        "X-DNAForge-Operation-Authority": "human-operation-secret",
        "X-DNAForge-Operation-Channel": channel,
    }
    target = {
        "operationId": selection.operation_id,
        "targetDocumentId": selection.target_document_id,
    }
    inspected = native_client.post(
        "/operations/annotation/documents/inspect", json=target, headers=headers
    )
    assert inspected.status_code == 200, inspected.text
    assert (
        inspected.json()["candidates"][0]["id"] == selection.selected_candidate_ids[0]
    )
    assert store.page_managed_operation_actions(selection.operation_id)[1] == 0
    selected = selection.model_dump(mode="json", by_alias=True)
    forged = native_client.post(
        "/operations/annotation/documents/apply",
        json={**selected, "actor_id": "someone-else"},
        headers=headers,
    )
    assert forged.status_code == 422
    assert "someone-else" not in forged.text
    denied = native_client.post("/operations/annotation/documents/apply", json=selected)
    assert denied.status_code == 403
    applied = native_client.post(
        "/operations/annotation/documents/apply", json=selected, headers=headers
    )
    assert applied.status_code == 200, applied.text
    result = applied.json()
    assert result["outcome"]["status"] == "blocked"
    row = store.get_managed_operation_action(result["actionId"])
    assert (row["actor_kind"], row["actor_id"], row["channel"]) == (
        "human",
        "human-a",
        channel,
    )
    assert len(calls) == 2


def test_public_document_route_without_a_native_connection_is_explicitly_unavailable(
    runtime, native_client
):
    store, _, _, selection = runtime
    native_client.app.state.native_document_authority = None
    response = native_client.post(
        "/operations/annotation/documents/apply",
        json=selection.model_dump(mode="json", by_alias=True),
        headers={"X-DNAForge-Operation-Authority": "human-operation-secret"},
    )
    assert response.status_code == 503, response.text
    assert response.json()["detail"]["code"] == "NATIVE_DOCUMENT_CONNECTION_UNAVAILABLE"
    assert store.page_managed_operation_actions(selection.operation_id)[1] == 0


def test_real_native_route_rechecks_a_revoked_agent_before_permission(
    runtime, native_client
):
    store, _, actions, selection = runtime
    action_id = actions.admit(principal("agent"), selection).record["id"]
    store.revoke_agent_identity("agent-a")
    result = native_client.post(
        f"/internal/managed-documents/actions/{action_id}/intent",
        json={
            "selection": selection.model_dump(mode="json", by_alias=True),
            "intent": write_intent(selection).model_dump(),
        },
        headers={"X-DNAForge-Native-Document-Authority": "private-native-token"},
    )
    assert result.status_code == 403, result.text
    assert (
        store.get_managed_operation_action(action_id)["outcome"] == "document_admitted"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("change", "expected_reason"),
    [
        ("dispatch", "dispatch_incomplete"),
        ("schema", "schema_invalid"),
        ("target", "identity_mismatch"),
        ("version", "operation_version_mismatch"),
        ("result", "result_mismatch"),
        ("input", "input_revision_mismatch"),
        ("applicability", "applicability_mismatch"),
        ("order", "candidate_order_mismatch"),
        ("bounds", "candidate_bounds_mismatch"),
        ("coordinates", "coordinate_mismatch"),
        ("candidate", "candidate_identity_mismatch"),
        ("source", "candidate_source_mismatch"),
        ("feature", "candidate_mapping_mismatch"),
    ],
)
async def test_inspection_failures_have_bounded_reasons_without_scientific_payloads(
    runtime, change, expected_reason
):
    store, _, actions, selection = runtime

    async def dispatch(authority, command):
        result = inspection_result(command, selection)
        if change == "dispatch":
            return NativeDocumentDispatchResult(
                "outcome-unresolved", reason="private file /secret/customer.gb"
            )
        if change == "schema":
            result["candidates"][0]["index"] = "private scientific label"
        if change == "target":
            result["targetDocumentId"] = "/secret/customer.gb"
        if change == "version":
            result["operationVersion"] += 1
        if change == "result":
            result["resultSha256"] = "sha256:" + "a" * 64
        if change == "input":
            result["analyzedInputRevision"] = "annotation-input-v1:sha256:" + "a" * 64
        if change == "applicability":
            result["blockReason"] = "private scientific label"
        if change == "order":
            result["candidates"] *= 2
        if change == "bounds":
            result["candidates"][0]["index"] = 999
        if change == "coordinates":
            result["transitionCount"] = 1
        if change == "candidate":
            result["candidates"][0]["id"] = "private scientific label"
        if change == "source":
            result["candidates"][0]["sourceFeature"] = {
                **result["candidates"][0]["sourceFeature"],
                "name": "private scientific label",
            }
        if change == "feature":
            result["candidates"][0]["feature"] = {
                **result["candidates"][0]["feature"],
                "name": "private scientific label",
            }
        return NativeDocumentDispatchResult("completed", result=result)

    target = AnnotationDocumentTarget(
        operationId=selection.operation_id,
        targetDocumentId=selection.target_document_id,
    )
    with pytest.raises(NativeDocumentInspectionUnavailable) as caught:
        await document_service(actions, dispatch).inspect(principal(), target)
    assert caught.value.reason_code == expected_reason
    assert "Refresh review" in str(caught.value)
    assert "/secret" not in str(caught.value)
    assert "private scientific label" not in str(caught.value)
    assert store.page_managed_operation_actions(selection.operation_id)[1] == 0


@pytest.mark.asyncio
async def test_inspection_changed_authority_remains_blocked_without_admission(
    runtime, monkeypatch
):
    store, _, actions, selection = runtime
    original = actions.inspection_authority
    calls = 0

    def changing_authority(principal, target):
        nonlocal calls
        calls += 1
        authority = original(principal, target)
        if calls == 2:
            authority = {**authority, "resultSha256": "sha256:" + "a" * 64}
        return authority

    monkeypatch.setattr(actions, "inspection_authority", changing_authority)

    async def dispatch(authority, command):
        return NativeDocumentDispatchResult(
            "completed", result=inspection_result(command, selection)
        )

    target = AnnotationDocumentTarget(
        operationId=selection.operation_id,
        targetDocumentId=selection.target_document_id,
    )
    with pytest.raises(NativeDocumentInspectionUnavailable) as caught:
        await document_service(actions, dispatch).inspect(principal(), target)
    assert caught.value.reason_code == "authority_changed"
    assert store.page_managed_operation_actions(selection.operation_id)[1] == 0


def test_rest_inspection_failure_exposes_only_closed_reason_and_safe_recovery(
    runtime, native_client, monkeypatch
):
    _, _, _, selection = runtime

    async def dispatch(authority, command):
        return NativeDocumentDispatchResult(
            "outcome-unresolved", reason="/private/customer.gb scientific sequence"
        )

    original_init = ManagedAnnotationDocuments.__init__

    def with_dispatch(self, **options):
        original_init(self, **options, dispatch=dispatch)

    monkeypatch.setattr(ManagedAnnotationDocuments, "__init__", with_dispatch)
    response = native_client.post(
        "/operations/annotation/documents/inspect",
        json={
            "operationId": selection.operation_id,
            "targetDocumentId": selection.target_document_id,
        },
        headers={
            "X-DNAForge-Operation-Authority": "human-operation-secret",
            "X-DNAForge-Operation-Channel": "desktop_ui",
        },
    )
    assert response.status_code == 502
    assert response.json()["detail"]["reasonCode"] == "dispatch_incomplete"
    assert "Refresh review" in response.json()["detail"]["message"]
    assert "/private" not in response.text
    assert "scientific sequence" not in response.text
