import json
import socket

import pytest

from src.external.remote_range import RemoteRangeService
from src.external.replay import build_replay_client, build_replay_resolver
from src.main import _external_replay_allowed_environment


@pytest.mark.asyncio
async def test_external_replay_matches_fixture_and_fails_closed():
    client = build_replay_client("tests/fixtures/external/replay")
    try:
        hit = await client.get(
            "https://rest.uniprot.org/uniprotkb/search",
            params={
                "query": "checksum:404C07CB677254E1E7AAF759B0FFB43A",
                "size": "10",
                "fields": "accession,reviewed,xref_pdb",
            },
        )
        assert hit.status_code == 200
        assert hit.json()["results"][0]["primaryAccession"] == "A0A0H3JZA8"

        miss = await client.get(
            "https://rest.uniprot.org/uniprotkb/search",
            params={
                "query": "checksum:DOES_NOT_EXIST",
                "size": "10",
                "fields": "accession,reviewed,xref_pdb",
            },
        )
        assert miss.status_code == 599
        assert miss.headers["X-Waypoint-External-Replay"] == "miss"
        assert miss.json()["error"] == "external_replay_miss"
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_external_replay_supports_binary_base64_bodies():
    client = build_replay_client("tests/fixtures/external/replay")
    try:
        response = await client.get(
            "https://cdn.rcsb.org/images/structures/1fs0_assembly-1.jpeg"
        )

        assert response.status_code == 200
        assert response.headers["Content-Type"] == "image/jpeg"
        assert response.content.startswith(b"\xff\xd8\xff")
        assert len(response.content) > 100
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_external_replay_serves_arbitrary_ranges_from_a_binary_fixture(tmp_path):
    replay_dir = tmp_path / "replay"
    binary_dir = tmp_path / "binary"
    replay_dir.mkdir()
    binary_dir.mkdir()
    payload = bytes(range(128))
    (binary_dir / "signal.bw").write_bytes(payload)
    (replay_dir / "range.json").write_text(
        json.dumps(
            {
                "method": "GET",
                "host": "downloads.example.org",
                "path": "/signal.bw",
                "response": {
                    "body_file": "../binary/signal.bw",
                    "serve_ranges": True,
                    "headers": {"ETag": '"fixture-v1"'},
                },
            }
        )
    )

    client = build_replay_client(str(replay_dir))
    try:
        response = await client.get(
            "https://downloads.example.org/signal.bw",
            headers={"Range": "bytes=31-47"},
        )

        assert response.status_code == 206
        assert response.content == payload[31:48]
        assert response.headers["Content-Range"] == "bytes 31-47/128"
        assert response.headers["Accept-Ranges"] == "bytes"
        assert response.headers["Content-Length"] == "17"
        assert response.headers["ETag"] == '"fixture-v1"'
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_external_replay_records_range_requests_without_query_values(tmp_path):
    replay_dir = tmp_path / "replay"
    binary_dir = tmp_path / "binary"
    trace_file = tmp_path / "requests.jsonl"
    replay_dir.mkdir()
    binary_dir.mkdir()
    (binary_dir / "signal.bw").write_bytes(bytes(range(128)))
    (replay_dir / "range.json").write_text(
        json.dumps(
            {
                "method": "GET",
                "host": "downloads.example.org",
                "path": "/signal.bw",
                "response": {
                    "body_file": "../binary/signal.bw",
                    "serve_ranges": True,
                    "headers": {"ETag": '"fixture-v1"'},
                },
            }
        )
    )

    client = build_replay_client(str(replay_dir), trace_file=str(trace_file))
    try:
        response = await client.get(
            "https://downloads.example.org/signal.bw?ignored=secret",
            headers={"Range": "bytes=31-47"},
        )
        assert response.status_code == 599
    finally:
        await client.aclose()

    records = [json.loads(line) for line in trace_file.read_text().splitlines()]
    assert len(records) == 2
    generation = records[0].pop("processGeneration")
    assert generation
    assert records[0] == {
        "event": "process-start",
        "matched": True,
        "authorized": True,
        "authorizationScheme": None,
        "headerNames": [],
        "method": "PROCESS",
        "originHost": "",
        "path": "",
        "range": None,
    }
    assert records[1].pop("processGeneration") == generation
    assert records[1].pop("headerNames") == sorted(
        {"accept", "accept-encoding", "connection", "host", "range", "user-agent"}
    )
    assert records[1:] == [
        {
            "event": "request",
            "matched": False,
            "authorized": False,
            "authorizationScheme": None,
            "method": "GET",
            "originHost": "downloads.example.org",
            "path": "/signal.bw",
            "range": "bytes=31-47",
        }
    ]
    assert "secret" not in trace_file.read_text()


@pytest.mark.asyncio
async def test_external_replay_enforces_credential_requirements_without_tracing_values(
    tmp_path,
):
    replay_dir = tmp_path / "replay"
    binary_dir = tmp_path / "binary"
    trace_file = tmp_path / "requests.jsonl"
    replay_dir.mkdir()
    binary_dir.mkdir()
    payload = bytes(range(128))
    (binary_dir / "signal.bw").write_bytes(payload)
    canary = "INERT_REPLAY_CREDENTIAL_CANARY_123456"
    (replay_dir / "private.json").write_text(
        json.dumps(
            {
                "entries": [
                    {
                        "method": "GET",
                        "host": "private.example.org",
                        "path": "/signal.bw",
                        "require_headers": {"Authorization": f"Bearer {canary}"},
                        "response": {
                            "body_file": "../binary/signal.bw",
                            "serve_ranges": True,
                            "headers": {"ETag": '"fixture-v1"'},
                        },
                    },
                    {
                        "method": "GET",
                        "host": "s3.us-west-2.amazonaws.com",
                        "path": "/bucket/signal.bw",
                        "require_headers": {"x-amz-request-payer": "requester"},
                        "require_header_patterns": {
                            "Authorization": r"AWS4-HMAC-SHA256 Credential=TESTKEY/\d{8}/us-west-2/s3/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}"
                        },
                        "unauthorized_status": 403,
                        "response": {
                            "body_file": "../binary/signal.bw",
                            "serve_ranges": True,
                            "headers": {"ETag": '"fixture-v1"'},
                        },
                    },
                ]
            }
        )
    )

    client = build_replay_client(str(replay_dir), trace_file=str(trace_file))
    try:
        anonymous = await client.get(
            "https://private.example.org/signal.bw", headers={"Range": "bytes=0-3"}
        )
        wrong = await client.get(
            "https://private.example.org/signal.bw",
            headers={"Range": "bytes=0-3", "Authorization": "Bearer wrong-token"},
        )
        authorized = await client.get(
            "https://private.example.org/signal.bw",
            headers={"Range": "bytes=0-3", "Authorization": f"Bearer {canary}"},
        )
        unsigned_s3 = await client.get(
            "https://s3.us-west-2.amazonaws.com/bucket/signal.bw",
            headers={"Range": "bytes=0-3", "x-amz-request-payer": "requester"},
        )
        signed_s3 = await client.get(
            "https://s3.us-west-2.amazonaws.com/bucket/signal.bw",
            headers={
                "Range": "bytes=0-3",
                "x-amz-request-payer": "requester",
                "Authorization": (
                    "AWS4-HMAC-SHA256 Credential=TESTKEY/20260921/us-west-2/s3/aws4_request, "
                    "SignedHeaders=host;range;x-amz-request-payer, Signature="
                    + "a" * 64
                ),
            },
        )

        assert anonymous.status_code == 401
        assert anonymous.headers["X-Waypoint-External-Replay"] == "unauthorized"
        assert anonymous.json()["error"] == "external_replay_unauthorized"
        assert wrong.status_code == 401
        assert authorized.status_code == 206
        assert authorized.content == payload[:4]
        assert unsigned_s3.status_code == 403
        assert signed_s3.status_code == 206
    finally:
        await client.aclose()

    records = [json.loads(line) for line in trace_file.read_text().splitlines()]
    requests = [record for record in records if record["event"] == "request"]
    assert [
        (r["matched"], r["authorized"], r["authorizationScheme"]) for r in requests
    ] == [
        (True, False, None),
        (True, False, "Bearer"),
        (True, True, "Bearer"),
        (True, False, None),
        (True, True, "AWS4-HMAC-SHA256"),
    ]
    assert "x-amz-request-payer" in requests[4]["headerNames"]
    trace_text = trace_file.read_text()
    assert canary not in trace_text
    assert "wrong-token" not in trace_text
    assert "a" * 64 not in trace_text


@pytest.mark.asyncio
async def test_external_replay_matches_validated_ip_connection_by_original_host(
    tmp_path,
):
    replay_dir = tmp_path / "replay"
    binary_dir = tmp_path / "binary"
    replay_dir.mkdir()
    binary_dir.mkdir()
    payload = bytes(range(128))
    (binary_dir / "signal.bw").write_bytes(payload)
    (replay_dir / "range.json").write_text(
        json.dumps(
            {
                "method": "GET",
                "host": "downloads.example.org",
                "path": "/signal.bw",
                "response": {
                    "body_file": "../binary/signal.bw",
                    "serve_ranges": True,
                    "headers": {"ETag": '"fixture-v1"'},
                },
            }
        )
    )

    client = build_replay_client(str(replay_dir))
    try:
        hit = await client.get(
            "https://203.0.113.10/signal.bw",
            headers={"Host": "downloads.example.org", "Range": "bytes=31-47"},
        )
        spoof = await client.get(
            "https://203.0.113.10/signal.bw",
            headers={"Host": "attacker.example", "Range": "bytes=31-47"},
        )

        assert hit.status_code == 206
        assert hit.content == payload[31:48]
        assert spoof.status_code == 599
        assert spoof.json()["error"] == "external_replay_miss"
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_external_replay_resolves_only_fixture_hosts_for_range_admission():
    replay_dir = "tests/fixtures/external/replay"
    client = build_replay_client(replay_dir)
    resolver = build_replay_resolver(replay_dir)
    service = RemoteRangeService(client, resolver=resolver)
    try:
        grant = await service.admit(
            "https://hgdownload.soe.ucsc.edu/gbdb/hg38/bbi/gc5BaseBw/gc5Base.bw",
            expected_format="bigwig",
            provenance_id="ucsc:hg38:gc5BaseBw",
        )
        payload = await service.read(grant.source_token, 0, 4)

        assert grant.accepts_ranges is True
        assert payload == bytes.fromhex("26fc8f88")
        with pytest.raises(socket.gaierror):
            await resolver("unlisted.example", 443, type=socket.SOCK_STREAM)
    finally:
        await service.aclose()
        await client.aclose()


@pytest.mark.asyncio
async def test_external_replay_rejects_duplicate_query_keys():
    client = build_replay_client("tests/fixtures/external/replay")
    try:
        response = await client.get(
            "https://rest.uniprot.org/uniprotkb/search",
            params=[
                ("query", "checksum:DOES_NOT_EXIST"),
                ("query", "checksum:404C07CB677254E1E7AAF759B0FFB43A"),
                ("size", "10"),
                ("fields", "accession,reviewed,xref_pdb"),
            ],
        )

        assert response.status_code == 599
        assert response.headers["X-Waypoint-External-Replay"] == "miss"
        assert response.json()["error"] == "external_replay_miss"
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_external_replay_rejects_unexpected_query_when_fixture_has_none():
    client = build_replay_client("tests/fixtures/external/replay")
    try:
        response = await client.get(
            "https://alphafold.ebi.ac.uk/api/prediction/A0A0H3JZA8",
            params={"unexpected": "1"},
        )

        assert response.status_code == 599
        assert response.headers["X-Waypoint-External-Replay"] == "miss"
        assert response.json()["error"] == "external_replay_miss"
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_external_replay_matches_only_declared_dynamic_query_fields(tmp_path):
    replay_dir = tmp_path / "replay"
    replay_dir.mkdir()
    (replay_dir / "htsget.json").write_text(
        json.dumps(
            {
                "method": "GET",
                "host": "htsget.example.org",
                "path": "/reads/sample-1",
                "query": {"format": "CRAM", "referenceName": "chrIV"},
                "query_regex": {"start": r"\d+", "end": r"\d+"},
                "response": {"json": {"htsget": {"format": "CRAM", "urls": []}}},
            }
        )
    )

    client = build_replay_client(str(replay_dir))
    try:
        hit = await client.get(
            "https://htsget.example.org/reads/sample-1",
            params={
                "format": "CRAM",
                "referenceName": "chrIV",
                "start": "3000",
                "end": "4000",
            },
        )
        wrong_format = await client.get(
            "https://htsget.example.org/reads/sample-1",
            params={
                "format": "BAM",
                "referenceName": "chrIV",
                "start": "3000",
                "end": "4000",
            },
        )
        malformed_region = await client.get(
            "https://htsget.example.org/reads/sample-1",
            params={
                "format": "CRAM",
                "referenceName": "chrIV",
                "start": "three-thousand",
                "end": "4000",
            },
        )
        unexpected_parameter = await client.get(
            "https://htsget.example.org/reads/sample-1",
            params={
                "format": "CRAM",
                "referenceName": "chrIV",
                "start": "3000",
                "end": "4000",
                "fields": "QNAME",
            },
        )

        assert hit.status_code == 200
        assert wrong_format.status_code == 599
        assert malformed_region.status_code == 599
        assert unexpected_parameter.status_code == 599
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_external_replay_rejects_wrong_scheme():
    client = build_replay_client("tests/fixtures/external/replay")
    try:
        response = await client.get(
            "http://rest.uniprot.org/uniprotkb/search",
            params={
                "query": "checksum:404C07CB677254E1E7AAF759B0FFB43A",
                "size": "10",
                "fields": "accession,reviewed,xref_pdb",
            },
        )

        assert response.status_code == 599
        assert response.headers["X-Waypoint-External-Replay"] == "miss"
        assert response.json()["error"] == "external_replay_miss"
    finally:
        await client.aclose()


@pytest.mark.parametrize(
    ("waypoint_environment", "env", "allowed"),
    [
        ("test", None, True),
        ("development", None, True),
        ("ci", None, True),
        (None, "test", True),
        (None, None, False),
        ("production", None, False),
        ("production ", None, False),
        ("prod", None, False),
        (None, "production", False),
        ("test", "production", False),
    ],
)
def test_external_replay_environment_is_allowlisted(
    monkeypatch,
    waypoint_environment,
    env,
    allowed,
):
    monkeypatch.delenv("WAYPOINT_ENVIRONMENT", raising=False)
    monkeypatch.delenv("ENV", raising=False)
    if waypoint_environment is not None:
        monkeypatch.setenv("WAYPOINT_ENVIRONMENT", waypoint_environment)
    if env is not None:
        monkeypatch.setenv("ENV", env)

    assert _external_replay_allowed_environment() is allowed
