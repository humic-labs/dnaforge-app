"""Demo — NCBI nuccore provider tests via httpx.MockTransport (no network)."""

from __future__ import annotations

import httpx
import pytest

from src.external.contract import (
    ExternalProvider,
    FetchOptions,
    ProviderContractError,
)
from src.external.providers.ncbi_nuccore import NcbiNuccoreProvider

_GENBANK = """LOCUS       NC_002506            1072315 bp    DNA     circular CON 23-AUG-2025
DEFINITION  Vibrio cholerae O1 biovar El Tor str. N16961 chromosome II, complete
            sequence.
ACCESSION   NC_002506
VERSION     NC_002506.1
SOURCE      Vibrio cholerae O1 biovar El Tor str. N16961
  ORGANISM  Vibrio cholerae O1 biovar El Tor str. N16961
FEATURES             Location/Qualifiers
     source          1..1072315
                     /organism="Vibrio cholerae O1 biovar El Tor str. N16961"
                     /db_xref="taxon:243277"
ORIGIN
        1 atgc
//
"""


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_conforms_to_external_provider_protocol():
    assert isinstance(NcbiNuccoreProvider(), ExternalProvider)


@pytest.mark.parametrize(
    "raw",
    [
        "NC_002506.1",
        "NC_000913.3",
        "nm_001301717.1",
        "U00096.3",
        "AABC01000001",
        "AE003853",
    ],
)
def test_detect_id_accepts_ncbi_accessions(raw):
    pid = NcbiNuccoreProvider().detect_id(raw)
    assert pid is not None
    assert pid.provider == "ncbi-nuccore"
    assert pid.canonical_id == raw.strip().upper()


@pytest.mark.parametrize("raw", ["P00875", "1RBL", "", "not-an-accession", "P00875-1"])
def test_detect_id_rejects_non_ncbi(raw):
    assert NcbiNuccoreProvider().detect_id(raw) is None


async def test_fetch_parses_genbank_into_content_and_metadata():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["db"] == "nuccore"
        assert request.url.params["id"] == "NC_002506.1"
        assert request.url.params["rettype"] == "gbwithparts"
        assert request.url.params["retmode"] == "text"
        return httpx.Response(200, text=_GENBANK)

    provider = NcbiNuccoreProvider(client=_client(handler))
    pid = provider.detect_id("NC_002506.1")
    result = await provider.fetch(pid, FetchOptions())

    assert result.content_bytes is not None and result.content_bytes.startswith(
        b"LOCUS"
    )
    assert result.content_mime_type == "text/plain"
    assert len(result.content_sha256) == 64
    assert result.metadata["length"] == 1072315
    assert result.metadata["topology"] == "circular"
    assert result.metadata["organism"].startswith("Vibrio cholerae")
    assert result.metadata["taxon_id"] == "243277"
    assert result.metadata["accession"] == "NC_002506.1"
    assert "ncbi.nlm.nih.gov/nuccore/NC_002506.1" in result.external_url
    assert result.license.startswith("Public domain")


async def test_fetch_accepts_valid_record_with_error_substring_in_definition():
    genbank = (
        "LOCUS       NC_002506            1072315 bp    DNA     circular CON 23-AUG-2025\n"
        'DEFINITION  Synthetic construct clone "Error: recovery" complete sequence.\n'
        "ACCESSION   NC_002506\n"
        "VERSION     NC_002506.1\n"
        "FEATURES             Location/Qualifiers\n"
        "ORIGIN\n"
        "        1 atgc\n"
        "//\n"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=genbank)

    provider = NcbiNuccoreProvider(client=_client(handler))
    pid = provider.detect_id("NC_002506.1")
    result = await provider.fetch(pid, FetchOptions())
    assert result.content_bytes is not None and result.content_bytes.startswith(
        b"LOCUS"
    )
    assert result.metadata["accession"] == "NC_002506.1"


async def test_fetch_rejects_ncbi_200_error_body():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, text="Error: CEFetchApplication::query: Empty result - nothing to do\n"
        )

    provider = NcbiNuccoreProvider(client=_client(handler))
    pid = provider.detect_id("NC_999999.1")
    with pytest.raises(ProviderContractError):
        await provider.fetch(pid, FetchOptions())


async def test_fetch_rejects_accession_mismatch():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=_GENBANK)

    provider = NcbiNuccoreProvider(client=_client(handler))
    pid = provider.detect_id("NC_002505.1")
    with pytest.raises(ProviderContractError):
        await provider.fetch(pid, FetchOptions())


def test_rate_limit_is_per_provider_key_aware():
    assert NcbiNuccoreProvider().rate_limit_per_s == 3.0
    assert NcbiNuccoreProvider(api_key="abc").rate_limit_per_s == 10.0


def test_declares_annotation_capability_and_no_xrefs():
    from src.external.contract import Capability

    provider = NcbiNuccoreProvider()
    assert provider.declared_capabilities() == [Capability.EXTERNAL_FETCH_ANNOTATION]
