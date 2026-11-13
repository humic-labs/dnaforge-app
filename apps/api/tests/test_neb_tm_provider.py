""" — NEB Tm provider tests via httpx.MockTransport (no live NEB call).

The response fixtures are recorded from real `tmapi.neb.com/tm` responses
(captured 2026-07-13). NEB Tm is a compute call (submit a primer, get Tm/Ta),
not a canonical-resource fetch — so the provider exposes `compute_tm`, not the
fetch-shaped Protocol methods (which are inert stubs so it can still register).
"""

from __future__ import annotations

import httpx
import pytest

from src.external.contract import (
    Capability,
    ExternalProvider,
    FetchOptions,
    ProviderContractError,
)
from src.external.providers.neb_tm import NebTmProvider

_Q5_PAIR = {
    "success": True,
    "data": {
        "p1": [
            {
                "tm": 75.21894800370973,
                "fgc": 0.48,
                "len": 21,
                "seq": "GACCATGATTACGCCAAGCTT",
            }
        ],
        "tm1min": 75,
        "tm1max": 75,
        "p2": [
            {
                "tm": 72.88336470459808,
                "fgc": 0.48,
                "len": 21,
                "seq": "CAGGAAACAGCTATGACCATG",
            }
        ],
        "ta": 72,
        "tm2min": 73,
        "tm2max": 73,
        "conc": 500,
        "notes": ["Q5 annealing temperatures (Ta = Tm_lower+1)"],
    },
    "meta": {"datetime": "2026-07-13T21:36:42.589Z", "version": "0.19.0"},
}


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_conforms_to_external_provider_protocol():
    assert isinstance(NebTmProvider(), ExternalProvider)


def test_declares_compute_tm_capability():
    assert Capability.EXTERNAL_COMPUTE_TM in NebTmProvider().declared_capabilities()


async def test_compute_tm_parses_pair_into_typed_result():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/tm"
        assert request.url.params["seq1"] == "GACCATGATTACGCCAAGCTT"
        assert request.url.params["seq2"] == "CAGGAAACAGCTATGACCATG"
        assert request.url.params["prodcode"] == "q5-0"
        assert request.url.params["conc"] == "500"
        return httpx.Response(200, json=_Q5_PAIR)

    provider = NebTmProvider(client=_client(handler))
    result = await provider.compute_tm(
        "GACCATGATTACGCCAAGCTT",
        seq2="CAGGAAACAGCTATGACCATG",
        prodcode="q5-0",
        conc_nm=500,
        opts=FetchOptions(),
    )
    assert result.prodcode == "q5-0"
    assert result.conc_nm == 500
    assert result.p1.tm == pytest.approx(75.219, abs=1e-3)
    assert result.p2 is not None and result.p2.tm == pytest.approx(72.883, abs=1e-3)
    assert result.ta == 72
    assert result.api_version == "0.19.0"


async def test_compute_tm_single_primer_has_no_p2_or_ta():
    single = {
        "success": True,
        "data": {
            "p1": [
                {"tm": 75.2, "fgc": 0.48, "len": 21, "seq": "GACCATGATTACGCCAAGCTT"}
            ],
            "tm1min": 75,
            "tm1max": 75,
            "conc": 500,
            "notes": [],
        },
        "meta": {"version": "0.19.0"},
    }

    provider = NebTmProvider(
        client=_client(lambda req: httpx.Response(200, json=single))
    )
    result = await provider.compute_tm(
        "GACCATGATTACGCCAAGCTT", conc_nm=500, opts=FetchOptions()
    )
    assert result.p1.tm == pytest.approx(75.2)
    assert result.p2 is None
    assert result.ta is None


async def test_compute_tm_maps_unsuccessful_body_to_contract_error():
    body = {"success": False, "data": {}, "meta": {"version": "0.19.0"}}
    provider = NebTmProvider(client=_client(lambda req: httpx.Response(200, json=body)))
    with pytest.raises(ProviderContractError):
        await provider.compute_tm(
            "GACCATGATTACGCCAAGCTT", conc_nm=500, opts=FetchOptions()
        )


async def test_compute_tm_batch_posts_one_request_for_every_sequence():
    import json

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert request.url.path == "/tm/batch"
        assert request.method == "POST"
        assert body["seqpairs"] == [
            ["GACCATGATTACGCCAAGCTT"],
            ["CAGGAAACAGCTATGACCATG"],
        ]
        assert body["prodcode"] == "q5-0"
        assert body["conc"] == "500"
        return httpx.Response(
            200,
            json={
                "success": True,
                "data": [
                    {"tm1": 75.2, "seq1": "GACCATGATTACGCCAAGCTT", "conc": 500},
                    {"tm1": 72.9, "seq1": "CAGGAAACAGCTATGACCATG", "conc": 500},
                ],
                "meta": {"version": "0.19.0"},
            },
        )

    provider = NebTmProvider(client=_client(handler))
    results = await provider.compute_tm_batch(
        ["GACCATGATTACGCCAAGCTT", "CAGGAAACAGCTATGACCATG"],
        prodcode="q5-0",
        conc_nm=500,
        opts=FetchOptions(),
    )
    assert len(results) == 2
    assert results[0].p1.tm == pytest.approx(75.2)
    assert results[1].p1.tm == pytest.approx(72.9)
    assert results[0].api_version == "0.19.0"


async def test_compute_tm_rejects_too_short_sequence_before_calling():
    called = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(200, json=_Q5_PAIR)

    provider = NebTmProvider(client=_client(handler))
    with pytest.raises(ProviderContractError):
        await provider.compute_tm("GACCAT", conc_nm=500, opts=FetchOptions())
    assert called is False
