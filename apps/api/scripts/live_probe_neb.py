#!/usr/bin/env python3
""" NEB Tm live probe.

Runs the NEB Tm compute provider through the full service (session ->
resilience -> provider) against a temporary SQLite store and prints a JSON
summary. This is a live smoke probe for local evidence, not a hermetic unit
test; the unit test injects an httpx.MockTransport client.

Every other NEB Tm test in this repo (test_neb_tm_provider.py,
test_neb_tm_route.py, and the desktop-side Vitest suites) mocks the HTTP
layer against a response fixture recorded from tmapi.neb.com on 2026-07-13.
This probe is the one thing in the repo that actually calls the real
endpoint. It does two independent checks:

1. `run_probe()` -- computes one q5-0 result and diffs it against that
   frozen 2026-07-13 fixture (tolerance-bounded) to catch silent drift in
   NEB's Tm math or response schema for the specific product code the
   fixture was recorded against.
2. `run_enzyme_selector_probe()` -- computes the SAME primer pair under
   several DIFFERENT NEB product codes (the exact choices the desktop app's
   enzyme/product selector offers -- see NEB_TM_OPTIONS in
   apps/desktop/src/features/design/algorithms/tm-model.ts) and asserts the
   values actually DIFFER across polymerase families. A provider bug that
   silently ignored `prodcode` (always computing Q5 conditions regardless of
   selection) would pass every mocked test in the repo -- they only ever
   exercise one product code -- while every dial in the enzyme selector
   secretly did nothing. This is the check that would catch that.

Usage:
    cd apps/api
    uv run python scripts/live_probe_neb.py | jq
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import tempfile
from pathlib import Path
from typing import Any

import httpx

from src.control_plane.store import ControlPlaneStore
from src.external.providers import NebTmProvider
from src.external.service import ExternalResourcesService

_RECORDED_PRODCODE = "q5-0"
_RECORDED_TM1 = 75.21894800370973
_RECORDED_TM2 = 72.88336470459808
_RECORDED_TA = 72.0
_RECORDED_API_VERSION = "0.19.0"
_TM_DRIFT_TOLERANCE_C = 1.0

_ENZYME_SELECTOR_PRODCODES: dict[str, str] = {
    "q5": "q5-0",
    "phusion": "phusion-0",
    "onetaq": "onetaq-0",
    "taq": "taq-0",
    "longamp": "lataq-0",
}
_MIN_CROSS_FAMILY_SPREAD_C = 1.0


async def run_probe(
    *,
    client: httpx.AsyncClient | None = None,
    seq1: str = "GACCATGATTACGCCAAGCTT",
    seq2: str | None = "CAGGAAACAGCTATGACCATG",
    prodcode: str = "q5-0",
    conc_nm: float = 500.0,
) -> dict[str, Any]:
    """Compute one real NEB Tm result and verify the  contract."""
    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient()

    with tempfile.TemporaryDirectory(prefix="fixture-neb-live-probe-") as tmp:
        store = ControlPlaneStore(Path(tmp) / "control-plane.sqlite3")
        store.initialize()
        service = ExternalResourcesService(store, client=client)
        service.register(NebTmProvider(client=client))

        try:
            result = await service.compute_primer_tm(
                seq1,
                seq2=seq2,
                prodcode=prodcode,
                conc_nm=conc_nm,
                granted_capabilities=["external-compute:tm"],
                workspace_id="fixture-live-probe",
            )

            if result.p1 is None:
                raise RuntimeError("NEB Tm probe returned no primary oligo (p1)")
            if seq2 is not None and result.p2 is None:
                raise RuntimeError(
                    "NEB Tm probe requested a pair but got no second oligo (p2)"
                )
            if not result.api_version:
                raise RuntimeError("NEB Tm probe returned no api_version")

            fetch_logs = store.list_external_fetch_log(provider="neb-tm")

            summary: dict[str, Any] = {
                "ok": True,
                "provider": "neb-tm",
                "requested_seq1": seq1,
                "requested_seq2": seq2,
                "prodcode": prodcode,
                "conc_nm": conc_nm,
                "p1_tm": result.p1.tm,
                "p1_gc_fraction": result.p1.gc_fraction,
                "p1_len": result.p1.length,
                "p2_tm": result.p2.tm if result.p2 else None,
                "ta": result.ta,
                "api_version": result.api_version,
                "notes": result.notes,
                "fetch_log_count": len(fetch_logs),
            }

            if prodcode == _RECORDED_PRODCODE:
                tm1_drift = result.p1.tm - _RECORDED_TM1
                tm2_drift = (result.p2.tm - _RECORDED_TM2) if result.p2 else None
                ta_drift = (result.ta - _RECORDED_TA) if result.ta is not None else None
                drift_within_tolerance = (
                    abs(tm1_drift) <= _TM_DRIFT_TOLERANCE_C
                    and (tm2_drift is None or abs(tm2_drift) <= _TM_DRIFT_TOLERANCE_C)
                    and (ta_drift is None or abs(ta_drift) <= _TM_DRIFT_TOLERANCE_C)
                )
                if not drift_within_tolerance:
                    raise RuntimeError(
                        "NEB Tm live result drifted from the recorded "
                        f"{_RECORDED_PRODCODE} fixture (2026-07-13) beyond tolerance "
                        f"({_TM_DRIFT_TOLERANCE_C}C): tm1_drift={tm1_drift:.4f} "
                        f"tm2_drift={tm2_drift} ta_drift={ta_drift} -- re-record the "
                        "fixtures in test_neb_tm_provider.py/test_neb_tm_route.py if "
                        "this is a genuine NEB-side change."
                    )
                summary.update(
                    {
                        "recorded_fixture_date": "2026-07-13",
                        "tm1_drift_c": tm1_drift,
                        "tm2_drift_c": tm2_drift,
                        "ta_drift_c": ta_drift,
                        "drift_tolerance_c": _TM_DRIFT_TOLERANCE_C,
                        "api_version_matches_recorded": result.api_version
                        == _RECORDED_API_VERSION,
                    }
                )
            return summary
        finally:
            await service.aclose()
            store.close()
            if owns_client:
                await client.aclose()


async def run_enzyme_selector_probe(
    *,
    client: httpx.AsyncClient | None = None,
    seq1: str = "GACCATGATTACGCCAAGCTT",
    prodcodes: dict[str, str] | None = None,
    conc_nm: float = 500.0,
) -> dict[str, Any]:
    """Prove the enzyme/product selector is honored end-to-end by the live API.

    Computes a single-primer Tm for the SAME sequence under every family in
    `prodcodes` (default: one representative per NEB_TM_OPTIONS family) and
    asserts the results actually differ across families. A provider/service
    bug that dropped `prodcode` on the way to NEB (or a caching bug keyed
    only on sequence) would return the identical Tm for every family -- this
    is the check that catches it; the mocked suite cannot, since it only
    ever exercises one product code.
    """
    prodcodes = dict(prodcodes or _ENZYME_SELECTOR_PRODCODES)
    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient()

    with tempfile.TemporaryDirectory(prefix="fixture-neb-enzyme-selector-") as tmp:
        store = ControlPlaneStore(Path(tmp) / "control-plane.sqlite3")
        store.initialize()
        service = ExternalResourcesService(store, client=client)
        service.register(NebTmProvider(client=client))

        try:
            tm_by_family: dict[str, float] = {}
            for family, prodcode in prodcodes.items():
                result = await service.compute_primer_tm(
                    seq1,
                    prodcode=prodcode,
                    conc_nm=conc_nm,
                    granted_capabilities=["external-compute:tm"],
                    workspace_id="fixture-live-probe-enzyme-selector",
                )
                if result.p1 is None:
                    raise RuntimeError(
                        f"NEB Tm enzyme-selector probe: {family} ({prodcode}) "
                        "returned no primary oligo"
                    )
                tm_by_family[family] = result.p1.tm

            values = list(tm_by_family.values())
            spread = max(values) - min(values)
            if spread < _MIN_CROSS_FAMILY_SPREAD_C:
                raise RuntimeError(
                    "NEB Tm enzyme selector probe found suspiciously little spread "
                    f"across families ({spread:.4f}C, expected >= "
                    f"{_MIN_CROSS_FAMILY_SPREAD_C}C) for identical sequence "
                    f"{seq1!r}: {tm_by_family!r}. Either NEB's calculator "
                    "converged on near-identical values for these specific "
                    "products+sequence (re-verify by hand at "
                    "https://tmapi.neb.com), or `prodcode` is silently not "
                    "reaching the real NEB request."
                )

            return {
                "ok": True,
                "requested_seq1": seq1,
                "tm_by_family": tm_by_family,
                "cross_family_spread_c": spread,
                "min_required_spread_c": _MIN_CROSS_FAMILY_SPREAD_C,
            }
        finally:
            await service.aclose()
            store.close()
            if owns_client:
                await client.aclose()


async def _main_async(
    seq1: str,
    seq2: str | None,
    prodcode: str,
    conc_nm: float,
    *,
    skip_enzyme_selector_check: bool,
) -> int:
    summary: dict[str, Any] = {
        "fixture_probe": await run_probe(
            seq1=seq1, seq2=seq2, prodcode=prodcode, conc_nm=conc_nm
        )
    }
    if not skip_enzyme_selector_check:
        summary["enzyme_selector_probe"] = await run_enzyme_selector_probe(seq1=seq1)
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--seq1", default="GACCATGATTACGCCAAGCTT", help="Primary primer sequence"
    )
    parser.add_argument(
        "--seq2",
        default="CAGGAAACAGCTATGACCATG",
        help="Second primer sequence (pass '' for a single-primer probe)",
    )
    parser.add_argument("--prodcode", default="q5-0", help="NEB product code")
    parser.add_argument("--conc", type=float, default=500.0, help="Primer conc (nM)")
    parser.add_argument(
        "--skip-enzyme-selector-check",
        action="store_true",
        help="Skip the cross-family enzyme-selector differentiation probe",
    )
    args = parser.parse_args(argv)
    seq2 = args.seq2 or None
    return asyncio.run(
        _main_async(
            args.seq1,
            seq2,
            args.prodcode,
            args.conc,
            skip_enzyme_selector_check=args.skip_enzyme_selector_check,
        )
    )


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"[live_probe_neb] FAIL: {exc}", file=sys.stderr)
        raise SystemExit(1) from None
