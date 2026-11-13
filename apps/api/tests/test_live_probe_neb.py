"""Tests for the  NEB Tm live probe helper.

These tests inject an httpx.MockTransport so they stay hermetic and run in
normal CI. The probe script itself (scripts/live_probe_neb.py) is what
actually calls the real tmapi.neb.com endpoint when run without an injected
client -- see that file's docstring for the manual/local invocation.
"""

from __future__ import annotations

import httpx
import pytest

from scripts.live_probe_neb import run_enzyme_selector_probe, run_probe

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


def _handler(request: httpx.Request) -> httpx.Response:
    assert request.url.path == "/tm"
    assert request.url.params["seq1"] == "GACCATGATTACGCCAAGCTT"
    assert request.url.params["seq2"] == "CAGGAAACAGCTATGACCATG"
    assert request.url.params["prodcode"] == "q5-0"
    assert request.url.params["conc"] == "500"
    return httpx.Response(200, json=_Q5_PAIR)


@pytest.mark.asyncio
async def test_neb_live_probe_uses_compute_tm_contract_and_detects_no_drift():
    client = httpx.AsyncClient(transport=httpx.MockTransport(_handler))
    try:
        summary = await run_probe(client=client)
    finally:
        await client.aclose()

    assert summary["ok"] is True
    assert summary["provider"] == "neb-tm"
    assert summary["p1_tm"] == pytest.approx(75.21894800370973)
    assert summary["p2_tm"] == pytest.approx(72.88336470459808)
    assert summary["ta"] == pytest.approx(72.0)
    assert summary["api_version"] == "0.19.0"
    assert summary["api_version_matches_recorded"] is True
    assert summary["tm1_drift_c"] == pytest.approx(0.0)
    assert summary["tm2_drift_c"] == pytest.approx(0.0)
    assert summary["ta_drift_c"] == pytest.approx(0.0)
    assert summary["fetch_log_count"] == 1


@pytest.mark.asyncio
async def test_neb_live_probe_single_primer_has_no_p2():
    single = {
        "success": True,
        "data": {
            "p1": [
                {"tm": 75.2, "fgc": 0.48, "len": 21, "seq": "GACCATGATTACGCCAAGCTT"}
            ],
            "conc": 500,
            "notes": [],
        },
        "meta": {"version": "0.19.0"},
    }
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda req: httpx.Response(200, json=single))
    )
    try:
        summary = await run_probe(client=client, seq2=None)
    finally:
        await client.aclose()

    assert summary["ok"] is True
    assert summary["p2_tm"] is None
    assert summary["ta"] is None


@pytest.mark.asyncio
async def test_neb_live_probe_raises_on_tm_drift_beyond_tolerance():
    """Proves the drift check itself actually fires -- not just a no-op field.

    A real schema/Tm-math regression on NEB's side would still parse fine but
    produce a value far from the recorded fixture; this pins that the probe
    treats that as a hard failure rather than silently reporting "ok".
    """
    drifted = {
        "success": True,
        "data": {
            "p1": [
                {
                    "tm": 75.21894800370973 + 5.0,
                    "fgc": 0.48,
                    "len": 21,
                    "seq": "GACCATGATTACGCCAAGCTT",
                }
            ],
            "p2": [
                {
                    "tm": 72.88336470459808,
                    "fgc": 0.48,
                    "len": 21,
                    "seq": "CAGGAAACAGCTATGACCATG",
                }
            ],
            "ta": 72,
            "conc": 500,
            "notes": [],
        },
        "meta": {"version": "0.19.0"},
    }
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda req: httpx.Response(200, json=drifted))
    )
    try:
        with pytest.raises(RuntimeError, match="drifted"):
            await run_probe(client=client)
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_neb_live_probe_raises_when_pair_requested_but_no_p2_returned():
    missing_p2 = {
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
            "conc": 500,
            "notes": [],
        },
        "meta": {"version": "0.19.0"},
    }
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda req: httpx.Response(200, json=missing_p2))
    )
    try:
        with pytest.raises(RuntimeError, match="no second oligo"):
            await run_probe(client=client)
    finally:
        await client.aclose()


def _single_oligo_response(tm: float, *, version: str = "0.19.0") -> dict:
    return {
        "success": True,
        "data": {
            "p1": [{"tm": tm, "fgc": 0.48, "len": 21, "seq": "GACCATGATTACGCCAAGCTT"}],
            "conc": 500,
            "notes": [],
        },
        "meta": {"version": version},
    }


_REAL_TM_BY_FAMILY_PRODCODE = {
    "q5-0": 75.21894800370973,
    "phusion-0": 70.9409530501938,
    "onetaq-0": 67.42001811207734,
    "taq-0": 67.57709757909839,
    "lataq-0": 72.36153897368746,
}


@pytest.mark.asyncio
async def test_enzyme_selector_probe_confirms_families_produce_different_tm():
    """The core  proof: switching the product/enzyme selector must
    actually change the computed Tm, not silently keep returning one family's
    number regardless of which product code was requested."""

    def handler(request: httpx.Request) -> httpx.Response:
        prodcode = request.url.params["prodcode"]
        tm = _REAL_TM_BY_FAMILY_PRODCODE[prodcode]
        return httpx.Response(200, json=_single_oligo_response(tm))

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        summary = await run_enzyme_selector_probe(client=client)
    finally:
        await client.aclose()

    assert summary["ok"] is True
    assert set(summary["tm_by_family"]) == {
        "q5",
        "phusion",
        "onetaq",
        "taq",
        "longamp",
    }
    assert summary["tm_by_family"]["q5"] == pytest.approx(75.21894800370973)
    assert summary["tm_by_family"]["onetaq"] == pytest.approx(67.42001811207734)
    assert summary["cross_family_spread_c"] > summary["min_required_spread_c"]


@pytest.mark.asyncio
async def test_enzyme_selector_probe_raises_when_prodcode_is_silently_ignored():
    """RED-path proof: if a provider/service bug dropped `prodcode` on the way
    to NEB (or cached Tm keyed only on sequence), every family would come back
    with the SAME Tm. This must be a hard failure, not a quietly-passing probe."""

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_single_oligo_response(75.21894800370973))

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(RuntimeError, match="spread"):
            await run_enzyme_selector_probe(client=client)
    finally:
        await client.aclose()
