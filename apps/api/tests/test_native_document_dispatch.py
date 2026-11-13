import json

import httpx
import pytest
from dnaforge_annotation.contract import AnnotationFeature, AnnotationResult

from src.native_document_dispatch import dispatch_native_document_command
from src.security.native_document_authority import NativeDocumentAuthority


@pytest.mark.asyncio
async def test_inspection_accepts_candidate_wrappers_around_a_valid_large_retained_result():
    feature = AnnotationFeature(
        name="Synthetic transport fixture",
        start=1,
        end=4,
        strand=1,
        identity=100,
        coverage=100,
        fragment=False,
        type="misc_feature",
        ref_start=1,
        ref_end=4,
        ref_length=4,
        db_source="nucleotide",
    ).model_dump(mode="json")
    operation_id = "01234567-89ab-cdef-0123-456789abcdef"
    count = 60_000
    retained = AnnotationResult(
        features=[feature] * count, sequence_length=4
    ).model_dump(mode="json")
    retained_bytes = json.dumps(retained, separators=(",", ":")).encode()
    assert len(retained_bytes) <= 16 * 1024 * 1024
    inspection = {
        "candidates": [
            {"id": f"{operation_id}:{index}", "index": index, "feature": feature}
            for index in range(count)
        ]
    }
    response = httpx.Response(
        200,
        json={
            "ok": True,
            "ownerInstanceId": "native-owner-a",
            "result": inspection,
        },
    )
    assert len(response.content) > 17 * 1024 * 1024
    calls = 0

    async def post(*args, **kwargs):
        nonlocal calls
        calls += 1
        return response

    result = await dispatch_native_document_command(
        authority(),
        {
            "command": "annotation.inspect",
            "target": {"operationId": operation_id},
            "authority": {"result": retained},
        },
        post=post,
    )
    assert result.disposition == "completed"
    assert len(result.result["candidates"]) == count
    assert calls == 1


@pytest.mark.asyncio
async def test_oversized_native_response_stops_reading_and_closes_without_another_command():
    class Stream(httpx.AsyncByteStream):
        chunks = 0
        closed = False

        async def __aiter__(self):
            for _ in range(1024):
                self.chunks += 1
                yield b" " * (64 * 1024)

        async def aclose(self):
            self.closed = True

    stream = Stream()
    calls = 0

    async def post(*args, **kwargs):
        nonlocal calls
        calls += 1
        return httpx.Response(200, stream=stream)

    result = await dispatch_native_document_command(
        authority(),
        {"command": "annotation.apply"},
        post=post,
    )
    assert result.disposition == "outcome-unresolved"
    assert calls == 1
    assert stream.closed
    assert stream.chunks < 1024


def authority(url="http://127.0.0.1:43210"):
    return NativeDocumentAuthority("native-private", "native-owner-a", url)


@pytest.mark.asyncio
async def test_dispatch_uses_only_the_private_credential_and_binds_the_native_owner():
    calls = []

    async def post(url, **kwargs):
        calls.append((url, kwargs))
        return httpx.Response(
            200,
            json={
                "ok": True,
                "ownerInstanceId": "native-owner-a",
                "result": {"applicable": True},
            },
        )

    result = await dispatch_native_document_command(
        authority(),
        {"command": "annotation.inspect", "ownerInstanceId": "forged"},
        post=post,
    )
    assert result.disposition == "completed"
    assert result.result == {"applicable": True}
    assert len(calls) == 1
    url, sent = calls[0]
    assert url == "http://127.0.0.1:43210/internal/native-documents/call"
    assert sent["headers"] == {"X-DNAForge-Native-Document-Authority": "native-private"}
    assert sent["json"]["ownerInstanceId"] == "native-owner-a"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "code", ["NATIVE_DOCUMENT_REQUEST_REFUSED", "NATIVE_DOCUMENT_OWNER_CHANGED"]
)
async def test_an_explicit_refusal_establishes_that_the_native_request_was_not_accepted(
    code,
):
    async def post(*args, **kwargs):
        return httpx.Response(
            409, json={"ok": False, "accepted": False, "error": {"code": code}}
        )

    result = await dispatch_native_document_command(
        authority(), {"command": "annotation.apply"}, post=post
    )
    assert result.disposition == "refused"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(
            200, json={"ok": True, "ownerInstanceId": "another-owner", "result": {}}
        ),
        httpx.Response(
            500, json={"ok": True, "ownerInstanceId": "native-owner-a", "result": {}}
        ),
        httpx.Response(
            200,
            json={
                "ok": False,
                "accepted": False,
                "error": {"code": "NATIVE_DOCUMENT_REQUEST_REFUSED"},
            },
        ),
        httpx.Response(
            500,
            json={
                "ok": False,
                "accepted": True,
                "error": {"code": "NATIVE_DOCUMENT_OUTCOME_UNCONFIRMED"},
            },
        ),
        httpx.Response(
            409,
            json={"ok": False, "error": {"code": "NATIVE_DOCUMENT_REQUEST_REFUSED"}},
        ),
        httpx.Response(302, headers={"Location": "https://example.com"}),
        httpx.Response(200, text="not JSON"),
    ],
)
async def test_ambiguous_or_inconsistent_responses_are_never_retried_or_reported_as_refusals(
    response,
):
    calls = 0

    async def post(*args, **kwargs):
        nonlocal calls
        calls += 1
        return response

    result = await dispatch_native_document_command(
        authority(), {"command": "annotation.apply"}, post=post
    )
    assert result.disposition == "outcome-unresolved"
    assert calls == 1


@pytest.mark.asyncio
async def test_a_lost_response_does_not_repeat_the_native_command():
    calls = 0

    async def post(*args, **kwargs):
        nonlocal calls
        calls += 1
        raise httpx.ReadTimeout("native-private must not appear in a user error")

    result = await dispatch_native_document_command(
        authority(), {"command": "annotation.apply"}, post=post
    )
    assert result.disposition == "outcome-unresolved"
    assert "native-private" not in result.reason
    assert calls == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url", [None, "http://example.com", "http://127.0.0.1:1234/path"]
)
async def test_missing_or_foreign_native_runtime_configuration_performs_no_request(url):
    async def post(*args, **kwargs):
        pytest.fail("Invalid native configuration must not make a request")

    result = await dispatch_native_document_command(
        authority(url), {"command": "annotation.inspect"}, post=post
    )
    assert result.disposition == "refused"
