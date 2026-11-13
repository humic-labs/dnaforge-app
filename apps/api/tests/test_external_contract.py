""" / L0 — pure-function tests for the provider contract + UniProt parsing.

No HTTP. No DB. No async. Asserts that the parsing primitives the service
layer relies on are correct in isolation.
"""

from __future__ import annotations

import pytest

from src.external.contract import (
    Capability,
    ExternalProvider,
    FetchOptions,
    ParsedId,
    ProviderError,
    ProviderHttpError,
    ProviderRateLimitError,
    ProviderTimeoutError,
)
from src.external.providers import UniProtProvider
from src.external.providers.uniprot import (
    _extract_entry_metadata,
    _xref_metadata_from_properties,
)


def test_capability_vocabulary_is_a_closed_set():
    """Codex 13: capability vocab must be enumerable, not free-form."""
    expected = {
        "external-fetch:annotation",
        "external-fetch:xref-resolution",
        "external-fetch:structure",
        "external-fetch:homology-search",
        "external-fetch:bulk-download",
        "external-fetch:paper",
        "external-compute:tm",
        "external-compute:discover",
        "external-compute:submit",
        "external-compute:manage",
        "external-inference:discovery",
    }
    actual = {c.value for c in Capability}
    assert actual == expected


def test_capability_round_trips_via_string_value():
    """Wire format is the .value string; ensure round-trip works for the
    capability_check_json columns on audit_record + external_fetch_log."""
    for c in Capability:
        assert Capability(c.value) is c


def test_parsed_id_cache_key_canonical_only():
    """Canonical id with no sub-resource disambiguators returns just the id."""
    pid = ParsedId(canonical_id="P00875", provider="uniprot")
    assert pid.cache_key() == "P00875"


def test_parsed_id_cache_key_includes_subresource_disambiguators():
    """Sub-resource disambiguators participate in the cache key — fixing
    the isoform/version/chain collision where fetching `P00875-1` would
    otherwise overwrite cached `P00875` metadata. Each sub-resource gets
    its own external_resource row.
    """
    iso = ParsedId(canonical_id="P00875", provider="uniprot", isoform="1")
    assert iso.cache_key() == "P00875-1"

    versioned = ParsedId(canonical_id="P00875", provider="uniprot", version="2")
    assert versioned.cache_key() == "P00875.2"

    chain = ParsedId(canonical_id="1RBL", provider="rcsb", chain="A")
    assert chain.cache_key() == "1RBL/A"

    full = ParsedId(
        canonical_id="P00875",
        provider="uniprot",
        isoform="1",
        version="2",
        chain="A",
        entity="3",
    )
    assert full.cache_key() == "P00875-1.2/A#3"


def test_parsed_id_is_frozen():
    """frozen=True on a dataclass raises dataclasses.FrozenInstanceError on
    attribute assignment. Pinning the immutability so callers can safely
    use ParsedId as dict keys / share across threads."""
    from dataclasses import FrozenInstanceError

    pid = ParsedId(canonical_id="P00875", provider="uniprot")
    with pytest.raises(FrozenInstanceError):
        pid.canonical_id = "P12345"  # type: ignore[misc]


@pytest.mark.parametrize(
    "raw,expected_canonical,expected_isoform,expected_version",
    [
        ("P00875", "P00875", None, None),
        ("Q01234", "Q01234", None, None),
        ("O95257", "O95257", None, None),
        ("P0AD86", "P0AD86", None, None),
        ("P0A6F5", "P0A6F5", None, None),
        ("A0A0R4IGZ8", "A0A0R4IGZ8", None, None),
        ("P00875-1", "P00875", "1", None),
        ("P02786-12", "P02786", "12", None),
        ("P00875.2", "P00875", None, "2"),
        ("p00875", "P00875", None, None),
        ("p00875-1", "P00875", "1", None),
        ("  P00875  ", "P00875", None, None),
    ],
)
def test_uniprot_detect_id_accepts_real_accession_formats(
    raw, expected_canonical, expected_isoform, expected_version
):
    p = UniProtProvider()
    pid = p.detect_id(raw)
    assert pid is not None
    assert pid.canonical_id == expected_canonical
    assert pid.isoform == expected_isoform
    assert pid.version == expected_version
    assert pid.provider == "uniprot"


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "1RBL",
        "AF-P00875-F1",
        "hello-world",
        "P00875extra",
        "P00875-",
        "P00875.",
        "X12345",
        "12345",
    ],
)
def test_uniprot_detect_id_rejects_non_uniprot_strings(raw):
    p = UniProtProvider()
    assert p.detect_id(raw) is None


def _real_p00875_response() -> dict:
    """A trimmed but real-shape UniProt JSON response for P00875.

    Field shapes match the live REST API as of 2026-04 (verified by curl).
    """
    return {
        "primaryAccession": "P00875",
        "entryType": "UniProtKB reviewed (Swiss-Prot)",
        "organism": {
            "scientificName": "Synechococcus elongatus (strain PCC 6301 / SAUG 1402/1)",
            "taxonId": 269084,
        },
        "sequence": {"length": 472, "molWeight": 52000},
        "genes": [{"geneName": {"value": "rbcL"}}],
        "proteinDescription": {
            "recommendedName": {
                "fullName": {"value": "Ribulose bisphosphate carboxylase large chain"},
                "ecNumbers": [{"value": "4.1.1.39"}],
            }
        },
        "entryAudit": {"entryVersion": 178},
        "uniProtKBCrossReferences": [
            {
                "database": "PDB",
                "id": "1RBL",
                "properties": [
                    {"key": "Method", "value": "X-ray"},
                    {"key": "Resolution", "value": "2.20 A"},
                    {"key": "Chains", "value": "A=1-472"},
                ],
            },
            {
                "database": "RefSeq",
                "id": "WP_011378050.1",
                "properties": [{"key": "NucleotideSequenceId", "value": "NC_007604.1"}],
            },
            {
                "database": "GeneID",
                "id": "3198942",
                "properties": [],
            },
            {
                "database": "AlphaFoldDB",
                "id": "P00875",
                "properties": [],
            },
            {
                "database": "Pfam",
                "id": "PF00016",
                "properties": [],
            },
        ],
    }


def test_extract_entry_metadata_pulls_documented_fields():
    payload = _real_p00875_response()
    meta = _extract_entry_metadata(payload)
    assert meta["name"] == "Ribulose bisphosphate carboxylase large chain"
    assert meta["gene"] == "rbcL"
    assert meta["organism"].startswith("Synechococcus elongatus")
    assert meta["taxon_id"] == "269084"
    assert meta["length"] == 472
    assert meta["ec_numbers"] == ["4.1.1.39"]
    assert meta["reviewed"] is True
    assert meta["primary_accession"] == "P00875"
    assert isinstance(meta["_uniprot_cross_references_raw"], list)
    assert len(meta["_uniprot_cross_references_raw"]) == 5


def test_extract_entry_metadata_handles_unreviewed_trembl():
    payload = {
        "primaryAccession": "Q9TREMBL",
        "entryType": "UniProtKB unreviewed (TrEMBL)",
        "organism": {"scientificName": "Custom organism", "taxonId": 12345},
        "sequence": {"length": 100},
    }
    meta = _extract_entry_metadata(payload)
    assert meta["reviewed"] is False
    assert meta["primary_accession"] == "Q9TREMBL"


def test_extract_entry_metadata_handles_minimal_response():
    """Tolerate sparse responses without crashing — UniProt can return entries
    with missing optional fields for legacy or stub records."""
    meta = _extract_entry_metadata({"primaryAccession": "Q00000"})
    assert meta["primary_accession"] == "Q00000"
    assert meta["name"] is None
    assert meta["gene"] is None
    assert meta["organism"] is None
    assert meta["ec_numbers"] == []


def test_xref_metadata_from_properties_flattens_key_value_bag():
    props = [
        {"key": "Method", "value": "X-ray"},
        {"key": "Resolution", "value": "2.20 A"},
        {"value": "no-key"},
        "string-instead-of-dict",
        {"key": "Chains", "value": "A=1-472"},
    ]
    out = _xref_metadata_from_properties(props)
    assert out == {
        "Method": "X-ray",
        "Resolution": "2.20 A",
        "Chains": "A=1-472",
    }


def test_uniprot_provider_conforms_to_external_provider_protocol():
    p = UniProtProvider()
    assert isinstance(p, ExternalProvider)


def test_uniprot_provider_declares_v1_capabilities():
    caps = UniProtProvider().declared_capabilities()
    assert Capability.EXTERNAL_FETCH_ANNOTATION in caps
    assert Capability.EXTERNAL_FETCH_XREF in caps
    assert Capability.EXTERNAL_FETCH_HOMOLOGY not in caps


def test_uniprot_provider_attribution_and_license_match_plan():
    """Plan's Legal + licensing section requires CC-BY-4.0 + UniProt
    Consortium attribution on every UniProt-derived row."""
    assert UniProtProvider.LICENSE == "CC-BY-4.0"
    assert "UniProt Consortium" in UniProtProvider.ATTRIBUTION


def test_provider_error_subclasses_carry_failure_kind():
    """failure_kind feeds external_fetch_log.failure_kind — the audit shape
    depends on each error class having a stable kind string."""
    assert ProviderHttpError("x").failure_kind == "http_error"
    assert ProviderRateLimitError("x").failure_kind == "rate_limited"
    assert ProviderTimeoutError("x").failure_kind == "timeout"
    assert ProviderError("x").failure_kind == "provider_error"


def test_rate_limit_error_carries_retry_after():
    exc = ProviderRateLimitError("rate limited", retry_after_s=5.0)
    assert exc.retry_after_s == 5.0
    assert exc.status_code == 429


def test_fetch_options_defaults_match_concurrency_spec():
    """The published budget in EXTERNAL_RESOURCES_CONCURRENCY.md assumes these
    defaults — drift them and the budget claims become fiction."""
    opts = FetchOptions()
    assert opts.total_timeout_s == 10.0
    assert opts.connect_timeout_s == 3.0
    assert opts.max_retries == 3
    assert "DNAForge" in opts.user_agent
