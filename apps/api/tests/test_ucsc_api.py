from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import src.external.providers.ucsc as ucsc_provider_module
from src.control_plane.store import ControlPlaneStore
from src.external.contract import ProviderContractError
from src.external.providers.ucsc import UcscApiEndpoint, UcscProvider
from src.external.service import ExternalResourcesService
from src.routes import external as external_routes
from src.routes.external import router as external_router

TEST_TOKEN = "ucsc-api-test-session"
GRCZ12TU_HUB = (
    "https://hgdownload.soe.ucsc.edu/hubs/GCF/049/306/965/GCF_049306965.2/hub.txt"
)
OFFICIAL_TEXT_FILES_RESPONSE = """# downloadTime: \"2026:09:01T10:50:53Z\"
# genome: hs1
https://hgdownload.soe.ucsc.edu/goldenPath/hs1/bigZips/hs1.2bit
# itemsReturned: 1
"""

OFFICIAL_RESPONSES: dict[str, dict[str, Any]] = {
    "/findGenome": {
        "downloadTime": "2026:09:01T08:51:04Z",
        "browser": "mustExist",
        "GCF_049306965.2": {
            "commonName": "zebrafish (Tuebingen 2025)",
            "scientificName": "Danio rerio",
            "description": "GRCz12tu 7955 2025-04-04",
            "browserExists": True,
            "hubUrl": "GCF/049/306/965/GCF_049306965.2/hub.txt",
            "versionStatus": "latest",
            "assemblyLevel": "complete ",
        },
        "itemCount": 1,
    },
    "/list/publicHubs": {
        "downloadTime": "2026:09:01T08:52:23Z",
        "publicHubs": [
            {
                "hubUrl": "https://example.org/public/hub.txt",
                "shortLabel": "Public example",
                "longLabel": "Public example track hub",
                "dbCount": 1,
                "dbList": "hg38,",
            }
        ],
    },
    "/list/ucscGenomes": {
        "downloadTime": "2026:09:01T08:52:54Z",
        "ucscGenomes": {
            "GRCz12tu": {
                "description": "Apr. 2025 (GRCz12tu/GCF_049306965.1)",
                "nibPath": "hub:/gbdb/genark/GCF/049/306/965/GCF_049306965.1",
                "scientificName": "Danio rerio",
            }
        },
    },
    "/list/genarkGenomes": {
        "downloadTime": "2026:09:01T08:51:09Z",
        "hubUrlPrefix": "/gbdb/genark",
        "genarkGenomes": {
            "GCF_049306965.2": {
                "hubUrl": "GCF/049/306/965/GCF_049306965.2/hub.txt",
                "asmName": "GRCz12tu",
                "scientificName": "Danio rerio",
                "commonName": "zebrafish (Tuebingen 2025)",
                "taxId": 7955,
                "clade": "fish",
            }
        },
        "itemsReturned": 1,
    },
    "/list/hubGenomes": {
        "downloadTime": "2026:09:01T08:52:18Z",
        "hubUrl": GRCZ12TU_HUB,
        "genomes": {
            "GCF_049306965.2": {
                "organism": "GRCz12tu Apr. 2025",
                "description": "zebrafish (Tuebingen 2025)",
                "twoBitPath": f"{GRCZ12TU_HUB.rsplit('/', 1)[0]}/GCF_049306965.2.2bit",
            }
        },
    },
    "/list/files": {
        "downloadTime": "2026:09:01T08:51:34Z",
        "genome": "GCF_049306965.2",
        "rsyncHost": "rsync://hgdownload.soe.ucsc.edu",
        "urlList": [
            {
                "sizeBytes": 379658001,
                "dateTime": "2026/08/17T06:40:25",
                "url": ("hubs/GCF/049/306/965/GCF_049306965.2/GCF_049306965.2.2bit"),
            }
        ],
        "itemsReturned": 1,
    },
    "/list/tracks": {
        "downloadTime": "2026:09:01T08:51:29Z",
        "hubUrl": "/gbdb/genark/GCF/049/306/965/GCF_049306965.2/hub.txt",
        "GCF_049306965.2": {
            "assembly": {
                "shortLabel": "Assembly",
                "longLabel": "Assembly",
                "type": "bigBed 6",
                "bigDataUrl": (
                    "/gbdb/genark/GCF/049/306/965/GCF_049306965.2/bbi/"
                    "GCF_049306965.2_GRCz12tu.assembly.bb"
                ),
            }
        },
    },
    "/list/chromosomes": {
        "downloadTime": "2026:09:01T08:53:00Z",
        "hubUrl": "/gbdb/genark/GCF/049/306/965/GCF_049306965.2/hub.txt",
        "chromosomes": {"NC_133182.1": 80416488},
    },
    "/list/schema": {
        "downloadTime": "2026:09:01T08:53:19Z",
        "genome": "GCF_049306965.2",
        "track": "assembly",
        "type": "bigBed 6",
        "columnTypes": [
            {
                "name": "chrom",
                "sqlType": "varchar(255)",
                "jsonType": "string",
                "description": "Reference sequence chromosome or scaffold",
            }
        ],
    },
    "/getData/sequence": {
        "downloadTime": "2026:09:01T08:53:08Z",
        "genome": "GCF_049306965.2",
        "chrom": "NC_133182.1",
        "start": 26805496,
        "end": 26805506,
        "dna": "ttattttcag",
    },
    "/getData/track": {
        "downloadTime": "2026:09:01T08:53:14Z",
        "genome": "GCF_049306965.2",
        "track": "assembly",
        "chrom": "NC_133182.1",
        "start": 26805496,
        "end": 26815496,
        "itemsReturned": 1,
        "assembly": [
            {
                "chrom": "NC_133182.1",
                "chromStart": 0,
                "chromEnd": 80416488,
                "name": "JBMGRA010000007.1",
                "score": 0,
                "strand": "+",
            }
        ],
    },
    "/search": {
        "downloadTime": "2026:09:01T09:06:34Z",
        "genome": "hg38",
        "positionMatches": [
            {
                "name": "trackDb",
                "trackName": "trackDb",
                "description": "Track names or descriptions",
                "matches": [
                    {
                        "position": "wgEncodeRegDnaseSignal:Signal",
                        "hgFindMatches": "",
                        "posName": "wgEncodeRegDnaseSignal:Signal",
                        "highlight": None,
                        "canonical": False,
                        "description": "<b>Signal</b> track",
                    }
                ],
            }
        ],
    },
}

PROVIDER_CASES: list[tuple[UcscApiEndpoint, dict[str, str]]] = [
    (
        UcscApiEndpoint.FIND_GENOME,
        {
            "q": "GCF_049306965.2",
            "browser": "mustExist",
            "maxItemsOutput": "10",
        },
    ),
    (UcscApiEndpoint.LIST_PUBLIC_HUBS, {}),
    (UcscApiEndpoint.LIST_UCSC_GENOMES, {}),
    (
        UcscApiEndpoint.LIST_GENARK_GENOMES,
        {"genome": "GCF_049306965.2", "maxItemsOutput": "10"},
    ),
    (UcscApiEndpoint.LIST_HUB_GENOMES, {"hubUrl": GRCZ12TU_HUB}),
    (
        UcscApiEndpoint.LIST_FILES,
        {"genome": "GCF_049306965.2", "maxItemsOutput": "10"},
    ),
    (
        UcscApiEndpoint.LIST_TRACKS,
        {"genome": "GCF_049306965.2", "trackLeavesOnly": "1"},
    ),
    (
        UcscApiEndpoint.LIST_CHROMOSOMES,
        {"genome": "GCF_049306965.2", "track": "assembly"},
    ),
    (
        UcscApiEndpoint.LIST_SCHEMA,
        {"genome": "GCF_049306965.2", "track": "assembly"},
    ),
    (
        UcscApiEndpoint.GET_SEQUENCE,
        {
            "genome": "GCF_049306965.2",
            "chrom": "NC_133182.1",
            "start": "26805496",
            "end": "26805506",
        },
    ),
    (
        UcscApiEndpoint.GET_TRACK,
        {
            "genome": "GCF_049306965.2",
            "track": "assembly",
            "chrom": "NC_133182.1",
            "start": "26805496",
            "end": "26815496",
            "maxItemsOutput": "5",
        },
    ),
    (
        UcscApiEndpoint.SEARCH,
        {"search": "signal", "genome": "hg38", "categories": "trackDb"},
    ),
]


@pytest.mark.asyncio
async def test_provider_dispatches_every_documented_ucsc_json_endpoint():
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=OFFICIAL_RESPONSES[request.url.path])

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    provider = UcscProvider(client=client)
    try:
        for endpoint, params in PROVIDER_CASES:
            result = await provider.request_api(endpoint, params=params)
            assert result == OFFICIAL_RESPONSES[endpoint.value]
    finally:
        await client.aclose()

    assert [request.url.path for request in requests] == [
        endpoint.value for endpoint, _params in PROVIDER_CASES
    ]
    assert [dict(request.url.params) for request in requests] == [
        params for _endpoint, params in PROVIDER_CASES
    ]


@pytest.mark.asyncio
async def test_provider_supports_official_plain_text_file_listing():
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, text=OFFICIAL_TEXT_FILES_RESPONSE)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    provider = UcscProvider(client=client)
    try:
        result = await provider.request_api(
            UcscApiEndpoint.LIST_FILES,
            params={"genome": "hs1", "format": "text", "maxItemsOutput": "5"},
        )
    finally:
        await client.aclose()

    assert result == OFFICIAL_TEXT_FILES_RESPONSE
    assert len(requests) == 1
    assert dict(requests[0].url.params) == {
        "genome": "hs1",
        "format": "text",
        "maxItemsOutput": "5",
    }
    assert requests[0].headers["Accept"] == "text/plain"


_MAX_ITEMS_ENDPOINT_CASES: list[tuple[UcscApiEndpoint, dict[str, str]]] = [
    (UcscApiEndpoint.FIND_GENOME, {"q": "GRCz12tu"}),
    (UcscApiEndpoint.LIST_GENARK_GENOMES, {}),
    (UcscApiEndpoint.LIST_FILES, {"genome": "hs1"}),
    (
        UcscApiEndpoint.GET_TRACK,
        {"genome": "hg38", "track": "gold", "chrom": "chrM"},
    ),
]


@pytest.mark.parametrize("max_items_output", [-1, 1, 1_000_000])
@pytest.mark.parametrize(("endpoint", "required_params"), _MAX_ITEMS_ENDPOINT_CASES)
@pytest.mark.asyncio
async def test_provider_accepts_official_max_items_output_domain(
    endpoint: UcscApiEndpoint,
    required_params: dict[str, str],
    max_items_output: int,
):
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"itemsReturned": 0})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    provider = UcscProvider(client=client)
    try:
        result = await provider.request_api(
            endpoint,
            params={
                **required_params,
                "maxItemsOutput": str(max_items_output),
            },
        )
    finally:
        await client.aclose()

    assert result == {"itemsReturned": 0}
    assert dict(requests[0].url.params)["maxItemsOutput"] == str(max_items_output)


@pytest.mark.parametrize("max_items_output", [0, 1_000_001])
@pytest.mark.parametrize(("endpoint", "required_params"), _MAX_ITEMS_ENDPOINT_CASES)
@pytest.mark.asyncio
async def test_provider_rejects_values_outside_official_max_items_output_domain(
    endpoint: UcscApiEndpoint,
    required_params: dict[str, str],
    max_items_output: int,
):
    network_called = False

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal network_called
        network_called = True
        return httpx.Response(200, json={})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    provider = UcscProvider(client=client)
    try:
        with pytest.raises(ProviderContractError, match="-1 or between 1 and 1000000"):
            await provider.request_api(
                endpoint,
                params={
                    **required_params,
                    "maxItemsOutput": str(max_items_output),
                },
            )
    finally:
        await client.aclose()

    assert network_called is False


@pytest.mark.asyncio
async def test_provider_api_boundary_reuses_existing_ssrf_and_interval_guards():
    network_called = False

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal network_called
        network_called = True
        return httpx.Response(200, json={})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    provider = UcscProvider(client=client)
    try:
        with pytest.raises(ProviderContractError, match="public host"):
            await provider.request_api(
                UcscApiEndpoint.LIST_HUB_GENOMES,
                params={"hubUrl": "http://127.0.0.1/hub.txt"},
            )
        with pytest.raises(ProviderContractError, match="supplied together"):
            await provider.request_api(
                UcscApiEndpoint.GET_SEQUENCE,
                params={
                    "genome": "GCF_049306965.2",
                    "chrom": "NC_133182.1",
                    "start": "10",
                },
            )
        with pytest.raises(ProviderContractError, match="Unsupported parameter"):
            await provider.request_api(
                UcscApiEndpoint.LIST_UCSC_GENOMES,
                params={"hubUrl": GRCZ12TU_HUB},
            )
    finally:
        await client.aclose()

    assert network_called is False


def _route_cases() -> list[tuple[str, dict[str, Any], UcscApiEndpoint]]:
    common = {"granted_capabilities": ["external-fetch:annotation"]}
    return [
        (
            "/external/ucsc/api/findGenome",
            {"q": "GCF_049306965.2", "max_items_output": 10, **common},
            UcscApiEndpoint.FIND_GENOME,
        ),
        (
            "/external/ucsc/api/list/publicHubs",
            common,
            UcscApiEndpoint.LIST_PUBLIC_HUBS,
        ),
        (
            "/external/ucsc/api/list/ucscGenomes",
            common,
            UcscApiEndpoint.LIST_UCSC_GENOMES,
        ),
        (
            "/external/ucsc/api/list/genarkGenomes",
            {
                "genome": "GCF_049306965.2",
                "max_items_output": 10,
                **common,
            },
            UcscApiEndpoint.LIST_GENARK_GENOMES,
        ),
        (
            "/external/ucsc/api/list/hubGenomes",
            {"hub_url": GRCZ12TU_HUB, **common},
            UcscApiEndpoint.LIST_HUB_GENOMES,
        ),
        (
            "/external/ucsc/api/list/files",
            {
                "genome": "GCF_049306965.2",
                "max_items_output": 10,
                **common,
            },
            UcscApiEndpoint.LIST_FILES,
        ),
        (
            "/external/ucsc/api/list/tracks",
            {
                "genome": "GCF_049306965.2",
                "track_leaves_only": True,
                **common,
            },
            UcscApiEndpoint.LIST_TRACKS,
        ),
        (
            "/external/ucsc/api/list/chromosomes",
            {"genome": "GCF_049306965.2", "track": "assembly", **common},
            UcscApiEndpoint.LIST_CHROMOSOMES,
        ),
        (
            "/external/ucsc/api/list/schema",
            {"genome": "GCF_049306965.2", "track": "assembly", **common},
            UcscApiEndpoint.LIST_SCHEMA,
        ),
        (
            "/external/ucsc/api/getData/sequence",
            {
                "genome": "GCF_049306965.2",
                "chrom": "NC_133182.1",
                "start": 26805496,
                "end": 26805506,
                **common,
            },
            UcscApiEndpoint.GET_SEQUENCE,
        ),
        (
            "/external/ucsc/api/getData/track",
            {
                "genome": "GCF_049306965.2",
                "track": "assembly",
                "chrom": "NC_133182.1",
                "start": 26805496,
                "end": 26815496,
                "max_items_output": 5,
                **common,
            },
            UcscApiEndpoint.GET_TRACK,
        ),
        (
            "/external/ucsc/api/search",
            {
                "search": "signal",
                "genome": "hg38",
                "categories": "trackDb",
                **common,
            },
            UcscApiEndpoint.SEARCH,
        ),
    ]


def test_routes_expose_complete_typed_ucsc_api_and_accession_only_genark(
    tmp_path, monkeypatch
):
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/list/files" and request.url.params.get("format"):
            return httpx.Response(200, text=OFFICIAL_TEXT_FILES_RESPONSE)
        return httpx.Response(200, json=OFFICIAL_RESPONSES[request.url.path])

    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_TOKEN)
    store = ControlPlaneStore(tmp_path / "ucsc-api.sqlite3")
    store.initialize()
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = ExternalResourcesService(store, client=http_client)
    provider = UcscProvider(client=http_client)
    provider.rate_limit_per_s = 100_000.0
    provider.rate_limit_burst = 100_000.0
    service.register(provider)
    external_routes.set_service(service)

    app = FastAPI()
    app.include_router(external_router)
    client = TestClient(app, headers={"X-DNAForge-Session": TEST_TOKEN})
    try:
        common = {"granted_capabilities": ["external-fetch:annotation"]}
        responses: dict[UcscApiEndpoint, Mapping[str, Any]] = {}
        for path, body, endpoint in _route_cases():
            response = client.post(path, json=body)
            assert response.status_code == 200, response.text
            assert response.json()["endpoint"] == endpoint.value
            assert response.json()["data"] == OFFICIAL_RESPONSES[endpoint.value]
            responses[endpoint] = response.json()["data"]

        initial_requests = requests[: len(PROVIDER_CASES)]
        assert [request.url.path for request in initial_requests] == [
            endpoint.value for _path, _body, endpoint in _route_cases()
        ]
        assert [dict(request.url.params) for request in initial_requests] == [
            params for _endpoint, params in PROVIDER_CASES
        ]

        genark = responses[UcscApiEndpoint.LIST_GENARK_GENOMES]
        assert genark["genarkGenomes"]["GCF_049306965.2"]["asmName"] == "GRCz12tu"
        assert (
            responses[UcscApiEndpoint.FIND_GENOME]["GCF_049306965.2"]["browserExists"]
            is True
        )

        max_items_routes = [
            ("/external/ucsc/api/findGenome", {"q": "GRCz12tu", **common}),
            ("/external/ucsc/api/list/genarkGenomes", common),
            ("/external/ucsc/api/list/files", {"genome": "hs1", **common}),
            (
                "/external/ucsc/api/getData/track",
                {"genome": "hg38", "track": "gold", **common},
            ),
        ]
        first_default_request = len(requests)
        for path, body in max_items_routes:
            response = client.post(path, json=body)
            assert response.status_code == 200, response.text
        assert all(
            "maxItemsOutput" not in request.url.params
            for request in requests[first_default_request:]
        )

        for max_items_output in (-1, 1_000_000):
            first_bounded_request = len(requests)
            for path, body in max_items_routes:
                response = client.post(
                    path,
                    json={**body, "max_items_output": max_items_output},
                )
                assert response.status_code == 200, response.text
            assert all(
                request.url.params["maxItemsOutput"] == str(max_items_output)
                for request in requests[first_bounded_request:]
            )

        text_response = client.post(
            "/external/ucsc/api/list/files",
            json={
                "genome": "hs1",
                "format": "text",
                "max_items_output": 5,
                **common,
            },
        )
        assert text_response.status_code == 200, text_response.text
        assert text_response.json() == {
            "endpoint": UcscApiEndpoint.LIST_FILES.value,
            "data": OFFICIAL_TEXT_FILES_RESPONSE,
        }
        assert dict(requests[-1].url.params) == {
            "genome": "hs1",
            "format": "text",
            "maxItemsOutput": "5",
        }

        before_invalid = len(requests)
        for max_items_output in (0, 1_000_001):
            for path, body in max_items_routes:
                response = client.post(
                    path,
                    json={**body, "max_items_output": max_items_output},
                )
                assert response.status_code == 422, response.text
        assert len(requests) == before_invalid

        before_denied = len(requests)
        denied = client.post(
            "/external/ucsc/api/list/genarkGenomes",
            json={
                "genome": "GCF_049306965.2",
                "granted_capabilities": [],
            },
        )
        assert denied.status_code == 403
        assert len(requests) == before_denied

        invalid = client.post(
            "/external/ucsc/api/getData/sequence",
            json={
                "genome": "GCF_049306965.2",
                "chrom": "NC_133182.1",
                "start": 10,
                **{"granted_capabilities": ["external-fetch:annotation"]},
            },
        )
        assert invalid.status_code == 422
        assert len(requests) == before_denied
    finally:
        external_routes.set_service(None)  # type: ignore[arg-type]
        client.close()


def test_routes_streams_large_response_without_materializing(tmp_path, monkeypatch):
    """A tiny ceiling models a large response without a hazardous fixture."""

    upstream_body = b'{"ucscGenomes":{"large":"bounded-stream-canary"}}'
    monkeypatch.setattr(ucsc_provider_module, "_MAX_JSON_RESPONSE_BYTES", 16)

    def fail_if_materialized(_payload):
        raise AssertionError("the generic UCSC route materialized its response")

    monkeypatch.setattr(
        ucsc_provider_module,
        "_load_json_and_close",
        fail_if_materialized,
    )

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=upstream_body)

    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_TOKEN)
    store = ControlPlaneStore(tmp_path / "ucsc-api-stream.sqlite3")
    store.initialize()
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = ExternalResourcesService(store, client=http_client)
    provider = UcscProvider(client=http_client)
    provider.rate_limit_per_s = 100_000.0
    provider.rate_limit_burst = 100_000.0
    service.register(provider)
    external_routes.set_service(service)

    app = FastAPI()
    app.include_router(external_router)
    client = TestClient(app, headers={"X-DNAForge-Session": TEST_TOKEN})
    try:
        response = client.post(
            "/external/ucsc/api/list/ucscGenomes",
            json={"granted_capabilities": ["external-fetch:annotation"]},
        )
        assert response.status_code == 200, response.text
        assert response.json() == {
            "endpoint": UcscApiEndpoint.LIST_UCSC_GENOMES.value,
            "data": {"ucscGenomes": {"large": "bounded-stream-canary"}},
        }
    finally:
        external_routes.set_service(None)  # type: ignore[arg-type]
        client.close()


@pytest.mark.parametrize(
    ("upstream_body", "expected_message"),
    [
        (b"not-json", "UCSC returned a non-JSON body"),
        (b"[]", "UCSC returned a non-object JSON body"),
        (b'{"error":"rejected"}', "UCSC rejected the request: rejected"),
        (b'{"value":"\xff"}', "UCSC returned a non-JSON body"),
    ],
)
def test_routes_reject_invalid_or_error_streams_before_starting_response(
    tmp_path,
    monkeypatch,
    upstream_body,
    expected_message,
):
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=upstream_body)

    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", TEST_TOKEN)
    store = ControlPlaneStore(tmp_path / "ucsc-api-invalid-stream.sqlite3")
    store.initialize()
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = ExternalResourcesService(store, client=http_client)
    provider = UcscProvider(client=http_client)
    provider.rate_limit_per_s = 100_000.0
    provider.rate_limit_burst = 100_000.0
    service.register(provider)
    external_routes.set_service(service)

    app = FastAPI()
    app.include_router(external_router)
    client = TestClient(app, headers={"X-DNAForge-Session": TEST_TOKEN})
    try:
        response = client.post(
            "/external/ucsc/api/list/ucscGenomes",
            json={"granted_capabilities": ["external-fetch:annotation"]},
        )
        assert response.status_code == 502, response.text
        assert response.json()["detail"]["message"] == expected_message
    finally:
        external_routes.set_service(None)  # type: ignore[arg-type]
        client.close()


@pytest.mark.asyncio
async def test_live_official_ucsc_api_surface_writes_a_durable_receipt():
    if os.environ.get("DNAFORGE_UCSC_LIVE_API") != "1":
        pytest.skip("set DNAFORGE_UCSC_LIVE_API=1 to call the public UCSC API")

    cases = [
        *PROVIDER_CASES,
        (
            UcscApiEndpoint.LIST_FILES,
            {"genome": "hs1", "format": "text", "maxItemsOutput": "5"},
        ),
    ]
    receipt_calls: list[dict[str, Any]] = []
    previous_started_monotonic: float | None = None
    async with httpx.AsyncClient(follow_redirects=True) as client:
        provider = UcscProvider(client=client)
        for index, (endpoint, params) in enumerate(cases):
            if index:
                await asyncio.sleep(1.05)
            started_monotonic = time.monotonic()
            seconds_since_previous_start = (
                None
                if previous_started_monotonic is None
                else started_monotonic - previous_started_monotonic
            )
            if seconds_since_previous_start is not None:
                assert seconds_since_previous_start >= 1.0
            previous_started_monotonic = started_monotonic
            started_at = datetime.now(UTC).isoformat()
            result = await provider.request_api(endpoint, params=params)
            serialized = (
                result
                if isinstance(result, str)
                else json.dumps(result, sort_keys=True, separators=(",", ":"))
            )
            receipt_calls.append(
                {
                    "endpoint": endpoint.value,
                    "params": params,
                    "started_at": started_at,
                    "seconds_since_previous_start": seconds_since_previous_start,
                    "response_kind": "text" if isinstance(result, str) else "json",
                    "response_bytes": len(serialized.encode("utf-8")),
                    "response_sha256": hashlib.sha256(
                        serialized.encode("utf-8")
                    ).hexdigest(),
                    "top_level_keys": (
                        [] if isinstance(result, str) else sorted(result.keys())
                    ),
                }
            )

    configured_receipt = os.environ.get("DNAFORGE_UCSC_LIVE_RECEIPT_PATH")
    receipt_path = (
        Path(configured_receipt).expanduser()
        if configured_receipt
        else Path(__file__).resolve().parents[3]
        / "test-results"
        / "ucsc-official-api-live-receipt.json"
    )
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    receipt_path.write_text(
        json.dumps(
            {
                "schema": "dnaforge.ucsc-official-api-live-receipt.v1",
                "completed_at": datetime.now(UTC).isoformat(),
                "base_url": UcscProvider.DEFAULT_BASE_URL,
                "minimum_interval_seconds": 1.05,
                "call_count": len(receipt_calls),
                "calls": receipt_calls,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )

    assert len(receipt_calls) == 13
    assert {call["endpoint"] for call in receipt_calls} == {
        endpoint.value for endpoint in UcscApiEndpoint
    }
    assert (
        sum(
            1
            for call in receipt_calls
            if call["endpoint"] == UcscApiEndpoint.LIST_FILES.value
        )
        == 2
    )
    assert receipt_path.is_file()


CHIMP_ACCESSION = "GCF_028858775.2"
CHIMP_HUB = (
    "https://hgdownload.soe.ucsc.edu/hubs/GCF/028/858/775/GCF_028858775.2/hub.txt"
)
CHIMP_GENARK_RESPONSE = {
    "hubUrlPrefix": "/gbdb/genark",
    "genarkGenomes": {
        CHIMP_ACCESSION: {
            "hubUrl": "GCF/028/858/775/GCF_028858775.2/hub.txt",
            "asmName": "NHGRI_mPanTro3-v2.0_pri",
            "scientificName": "Pan troglodytes",
            "taxId": 9598,
        }
    },
}


def _genark_client(
    response: dict[str, Any] | None,
    requests: list[httpx.Request] | None = None,
) -> httpx.AsyncClient:
    async def handler(request: httpx.Request) -> httpx.Response:
        if requests is not None:
            requests.append(request)
        if response is None:
            return httpx.Response(500, json={"error": "upstream is unhappy"})
        return httpx.Response(200, json=response)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_genark_hub_url_resolves_the_relative_path_ucsc_returns():
    requests: list[httpx.Request] = []
    client = _genark_client(CHIMP_GENARK_RESPONSE, requests)
    provider = UcscProvider(client=client)
    try:
        resolved = await provider.resolve_genark_hub_url(CHIMP_ACCESSION)
    finally:
        await client.aclose()

    assert resolved == CHIMP_HUB
    assert requests[0].url.path == UcscApiEndpoint.LIST_GENARK_GENOMES.value
    assert dict(requests[0].url.params) == {"genome": CHIMP_ACCESSION}


@pytest.mark.asyncio
async def test_genark_hub_url_is_asked_for_once_per_assembly():
    requests: list[httpx.Request] = []
    client = _genark_client(CHIMP_GENARK_RESPONSE, requests)
    provider = UcscProvider(client=client)
    try:
        first = await provider.resolve_genark_hub_url(CHIMP_ACCESSION)
        second = await provider.resolve_genark_hub_url(CHIMP_ACCESSION)
    finally:
        await client.aclose()

    assert first == second == CHIMP_HUB
    assert len(requests) == 1


@pytest.mark.asyncio
async def test_a_native_genome_never_asks_genark_about_itself():
    requests: list[httpx.Request] = []
    client = _genark_client(CHIMP_GENARK_RESPONSE, requests)
    provider = UcscProvider(client=client)
    try:
        assert await provider.resolve_genark_hub_url("hg38") is None
        assert await provider.resolve_genark_hub_url("sacCer3") is None
        assert await provider.resolve_genark_hub_url("") is None
    finally:
        await client.aclose()

    assert requests == []


@pytest.mark.asyncio
async def test_an_unresolvable_hub_leaves_the_fetch_exactly_where_it_was():
    client = _genark_client(None)
    provider = UcscProvider(client=client)
    try:
        assert await provider.resolve_genark_hub_url(CHIMP_ACCESSION) is None
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_an_absolute_hub_url_is_left_alone():
    absolute = dict(CHIMP_GENARK_RESPONSE)
    absolute["genarkGenomes"] = {CHIMP_ACCESSION: {"hubUrl": CHIMP_HUB}}
    client = _genark_client(absolute)
    provider = UcscProvider(client=client)
    try:
        assert await provider.resolve_genark_hub_url(CHIMP_ACCESSION) == CHIMP_HUB
    finally:
        await client.aclose()


from src.external.providers.ucsc import (  # noqa: E402
    _hub_catalog_tree,
    _hub_relative_url,
    _hub_stanzas,
)

ALFA_TRACK_DB = """\
track ALFA
compositeTrack on
shortLabel ALFA
longLabel ALFA: Allele Frequency Aggregator
type bigBed 9 + .

    track ALFA_GLB
    parent ALFA on
    shortLabel NCBI ALFA: Global
    bigDataUrl ALFA_GLB.bb
    type bigBed 9 + .

    track ALFA_EUR
    parent ALFA off
    shortLabel NCBI ALFA: European
    bigDataUrl sub/ALFA_EUR.bb
    type bigBed 9 + .
"""


def test_hub_stanzas_split_on_blank_lines_and_ignore_comments():
    stanzas = _hub_stanzas(
        "# a note\ntrack one\nshortLabel One\n\n"
        "track two\nshortLabel Two\n   # indented note\n"
    )
    assert [stanza["track"] for stanza in stanzas] == ["one", "two"]
    assert stanzas[0]["shortLabel"] == "One"


def test_hub_stanzas_join_a_continued_line():
    stanzas = _hub_stanzas("track one\nlongLabel first \\\n second part\n")
    assert stanzas[0]["longLabel"] == "first second part"


def test_hub_relative_url_keeps_a_hub_inside_its_own_origin():
    hub = "https://example.org/hubs/mine/hub.txt"
    assert (
        _hub_relative_url(hub, "genomes.txt")
        == "https://example.org/hubs/mine/genomes.txt"
    )
    assert (
        _hub_relative_url(hub, "https://example.org/other/trackDb.txt")
        == "https://example.org/other/trackDb.txt"
    )
    assert _hub_relative_url(hub, "https://elsewhere.example/evil.txt") is None
    assert _hub_relative_url(hub, "file:///etc/passwd") is None
    assert _hub_relative_url(hub, "") is None


def test_hub_catalog_tree_nests_children_the_way_ucsc_does():
    track_db = "https://example.org/hubs/mine/hg38/trackDb.txt"
    tree = _hub_catalog_tree(_hub_stanzas(ALFA_TRACK_DB), track_db)

    assert list(tree) == ["ALFA"]
    composite = tree["ALFA"]
    assert set(composite) >= {"ALFA_GLB", "ALFA_EUR"}
    assert composite["ALFA_GLB"]["shortLabel"] == "NCBI ALFA: Global"


def test_hub_catalog_tree_resolves_data_urls_against_the_track_db():
    track_db = "https://example.org/hubs/mine/hg38/trackDb.txt"
    tree = _hub_catalog_tree(_hub_stanzas(ALFA_TRACK_DB), track_db)
    child = tree["ALFA"]["ALFA_GLB"]
    assert child["bigDataUrl"] == "https://example.org/hubs/mine/hg38/ALFA_GLB.bb"
    nested = tree["ALFA"]["ALFA_EUR"]
    assert nested["bigDataUrl"] == "https://example.org/hubs/mine/hg38/sub/ALFA_EUR.bb"


def test_hub_catalog_tree_names_a_track_that_omitted_its_labels():
    tree = _hub_catalog_tree(_hub_stanzas(ALFA_TRACK_DB), "https://example.org/t.txt")
    child = tree["ALFA"]["ALFA_GLB"]
    assert child["longLabel"] == "NCBI ALFA: Global"

    unnamed = _hub_catalog_tree(
        _hub_stanzas("track solo\ntype bigBed\n"), "https://e/t"
    )
    assert unnamed["solo"]["shortLabel"] == "solo"
    assert unnamed["solo"]["longLabel"] == "solo"


def test_hub_catalog_tree_survives_a_parent_cycle():
    cyclic = "track a\nparent b\n\ntrack b\nparent a\n"
    tree = _hub_catalog_tree(_hub_stanzas(cyclic), "https://example.org/t.txt")
    assert set(tree) == {"a", "b"}
