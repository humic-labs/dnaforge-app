import asyncio

import pytest

from src.concurrency import builtins
from src.concurrency.tool_registry import ToolContext
from tests.test_job_cancellation_acceptance import (
    cancellation as cancellation,
)
from tests.test_job_cancellation_acceptance import (
    finish,
    spec,
    submit,
)


async def test_human_collection_keeps_stopping_job_active(cancellation, monkeypatch):
    client, manager, store = cancellation
    monkeypatch.setenv("DNAFORGE_HUMAN_OPERATION_TOKEN", "cancel-human")
    monkeypatch.setenv("DNAFORGE_OPERATION_SCOPE", "cancel-scope")
    monkeypatch.setenv("DNAFORGE_OPERATION_OWNER_ID", "cancel-owner")
    store.ensure_agent_identity(
        "human-job-agent",
        scope=["debug.echo"],
        parent_human_identity_id="cancel-owner",
        environment_id="cancel-scope",
    )
    entered, cleaning, release = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def handler(args, context):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleaning.set()
            await release.wait()

    job = await manager.submit(
        spec=spec(),
        args={},
        handler=handler,
        agent_identity_id="human-job-agent",
        agent_capabilities=["debug.echo"],
    )
    owner = job.task
    await entered.wait()
    headers = {"X-DNAForge-Operation-Authority": "cancel-human"}
    try:
        response = await client.delete(
            f"/operations/agent-jobs/{job.id}", headers=headers
        )
        assert response.status_code == 204, response.text
        await asyncio.wait_for(cleaning.wait(), 1)
        response = await client.get("/operations/agent-jobs", headers=headers)
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["active_count"] == 1
        assert body["terminal_count"] == 0
        assert body["jobs"][0]["state"] == "running"
        assert body["jobs"][0]["completed_at"] is None
        assert manager.counts()["active"] == 1
        await finish(owner, release)
        body = (await client.get("/operations/agent-jobs", headers=headers)).json()
        assert body["active_count"] == 0
        assert body["terminal_count"] == 1
        assert body["jobs"][0]["state"] == "canceled"
    finally:
        await finish(owner, release)


async def test_cancel_pool_waiter_never_enters_its_handler(cancellation):
    _, manager, _ = cancellation
    entered, release = asyncio.Event(), asyncio.Event()
    second_calls = []

    async def first_handler(args, context):
        entered.set()
        await release.wait()
        return {"echo": {}, "jobId": context.job_id}

    async def second_handler(args, context):
        second_calls.append(True)
        return {"echo": {}, "jobId": context.job_id}

    first = await submit(manager, first_handler)
    first_owner = first.task
    await entered.wait()
    second = await submit(manager, second_handler)
    second_owner = second.task
    try:
        await asyncio.sleep(0)
        assert await manager.cancel(second.id)
        await second_owner
        assert second_calls == []
        assert manager.snapshot(second.id)["status"] == "canceled"
        assert not first_owner.done()
    finally:
        await finish(first_owner, release)


@pytest.mark.parametrize(
    "handler",
    [
        builtins.echo_handler,
        builtins.prepare_workflow_run_handler,
        builtins.register_artifact_handler,
        builtins.create_analysis_run_handler,
        builtins.create_resource_link_handler,
    ],
)
async def test_builtin_acknowledges_cancel_without_success_payload(handler):
    signal = asyncio.Event()
    signal.set()
    context = ToolContext("cancel-action", "cancel-agent", [], signal)
    with pytest.raises(asyncio.CancelledError):
        await handler({}, context)
