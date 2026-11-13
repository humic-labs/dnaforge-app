""" P2 — tile-route ERROR CONTRACT (bug #3's true home).

The recurring assembly read-pileup bug #3 is "reads records=0 / empty on a CRAM
that actually has reads" — caused by a CRAM opened WITHOUT its reference: htslib
raises the MISLEADING ``OSError('truncated file')`` mid-fetch, which (if swallowed)
reads as "no reads here" (empty count:0) or (if unhandled) as a 500 the renderer
treats as still-pending. Either way the user sees a blank band on a region that has
data. The CONTRACT this test pins:

  - CRAM tile with a MISSING/INVALID reference .fai  => HTTP 404 (loud), NOT
    empty-count:0, NOT 500-as-pending.
  - missing .bai / .crai (explicit index path that doesn't exist) => 404.
  - missing .fai for a provided reference => 404.
  - ManagedPool QueueRefusal => a DEFINED 429 shadow state (queue_full), NOT a hang
    and NOT a 500.

FIXTURE: real NA12718 CRAM + its .crai. Absent => INVALID RUN (distinct from a
contract RED).
"""

from __future__ import annotations

import os

import pytest

from tests.sidecar_test_client import AuthenticatedSidecarTestClient as TestClient

CRAM = os.path.expanduser("~/projects/wp-assets/bam-cache/NA12718.final.cram")
CRAI = os.path.expanduser("~/projects/wp-assets/bam-cache/NA12718.final.cram.crai")
REF = os.path.expanduser(
    "~/projects/wp-assets/reference/GRCh38_full_analysis_set_plus_decoy_hla.fa"
)


@pytest.fixture(scope="module")
def client() -> TestClient:
    from src.main import app

    return TestClient(app)


@pytest.fixture(scope="module", autouse=True)
def _require_cram_fixture():
    if not os.path.isfile(CRAM):
        pytest.skip(f"wp-assets fixture not present: {CRAM}")
    if not os.path.isfile(CRAI):
        pytest.fail(f"INVALID RUN: fixture missing -- {CRAI} not on disk")


def _fine_level() -> int:
    return 0


def test_cram_missing_reference_is_404_not_empty_not_500(client):
    """The keystone of bug #3: an alignment tile over a CRAM with NO reference must
    be a LOUD 404 — never an empty reads array (count:0) and never a 500."""
    resp = client.post(
        f"/tiles/alignment/{_fine_level()}/5103",
        json={"bamPath": CRAM, "chrom": "chr11", "indexPath": CRAI},
    )
    assert (
        resp.status_code == 404
    ), f"expected 404 for referenceless CRAM, got {resp.status_code}: {resp.text}"
    body = resp.json()
    assert "reads" not in body or body.get("count", 0) == 0 and resp.status_code == 404


def test_cram_invalid_reference_fai_is_404(client):
    """A reference path whose .fai is missing => 404 (htslib needs faidx for CRAM)."""
    resp = client.post(
        f"/tiles/alignment/{_fine_level()}/5103",
        json={
            "bamPath": CRAM,
            "chrom": "chr11",
            "indexPath": CRAI,
            "referencePath": "/nonexistent/reference.fa",
        },
    )
    assert resp.status_code == 404, resp.text


def test_missing_crai_index_is_404(client):
    """An explicit index path that does not exist => 404 (loud, not slow fallback)."""
    resp = client.post(
        f"/tiles/alignment/{_fine_level()}/5103",
        json={
            "bamPath": CRAM,
            "chrom": "chr11",
            "indexPath": "/nonexistent/index.crai",
            "referencePath": REF,
        },
    )
    assert resp.status_code == 404, resp.text


def test_missing_gff_tabix_source_is_404(client):
    """A missing annotation GFF source => 404 (not an empty 'no genes' tile)."""
    resp = client.post(
        "/tiles/annotation/0/5103",
        json={"gffPath": "/nonexistent/chr11.gff3.gz", "chrom": "chr11"},
    )
    assert resp.status_code == 404, resp.text


def test_cram_with_valid_reference_returns_reads_not_404(client):
    """Inverse of bug #3: WITH a valid reference, the same CRAM tile returns reads
    (a 200), proving the 404 above is specifically the missing-reference contract —
    not a blanket CRAM rejection."""
    if not os.path.isfile(REF):
        pytest.skip(f"wp-assets fixture not present: {REF}")
    if not os.path.isfile(REF + ".fai"):
        pytest.fail(f"INVALID RUN: fixture missing -- reference index {REF}.fai")
    resp = client.post(
        f"/tiles/alignment/{_fine_level()}/5103",
        json={
            "bamPath": CRAM,
            "chrom": "chr11",
            "indexPath": CRAI,
            "referencePath": REF,
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["fine"] is True
    assert "reads" in body and isinstance(body["reads"], list)


def test_queue_refusal_surfaces_as_429_shadow_state(client, monkeypatch):
    """A ManagedPool QueueRefusal must surface as a DEFINED 429 (queue_full) shadow
    state — never a hang, never a 500. Forced by stubbing the TILE_IO pool's slot()
    to refuse immediately."""
    from contextlib import asynccontextmanager

    from src.concurrency.pools import get_pool_manager
    from src.concurrency.refusals import QueueRefusal
    from src.concurrency.schema import PoolName

    pool = get_pool_manager().get(PoolName.TILE_IO.value)

    @asynccontextmanager
    async def _refusing_slot():
        raise QueueRefusal(
            pool=PoolName.TILE_IO.value,
            queue_depth=128,
            pool_capacity=8,
            refusal_kind="saturated",
        )
        yield

    monkeypatch.setattr(pool, "slot", _refusing_slot)
    resp = client.post(
        "/tiles/coverage/10/0",
        json={"bamPath": CRAM, "chrom": "chr11", "referencePath": REF},
    )
    assert resp.status_code == 429, resp.text
    body = resp.json()
    assert body["error"] == "queue_full"
    assert body["refusal_kind"] == "saturated"
