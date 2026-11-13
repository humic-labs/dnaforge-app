"""Local paper-reference graph tests.

The existing privacy mitigation is the required ``workspace_id`` predicate on
every binding read in ``ControlPlaneStore``. The cross-workspace case below is a
regression check for that shipped boundary, not a live red-team fixture. All
identifier strings are inert bibliographic examples; no network call occurs.
"""

from __future__ import annotations

import sqlite3

import pytest

from src.control_plane.store import ControlPlaneStore
from src.external.paper_graph import (
    PaperIdentifier,
    PaperReferenceTrace,
    get_paper_reference_graph,
    normalize_paper_identifier,
    record_paper_reference_trace,
)


def _store(tmp_path) -> ControlPlaneStore:
    store = ControlPlaneStore(tmp_path / "paper-graph.sqlite3")
    store.initialize()
    return store


@pytest.mark.parametrize(
    ("scheme", "value", "provider", "normalized"),
    [
        ("pmid", " 24157548 ", "pubmed", "24157548"),
        ("pmcid", "pmc4384742", "pmc", "PMC4384742"),
        ("doi", "https://doi.org/10.7554/eLife.05290", "doi", "10.7554/elife.05290"),
        ("doi", "doi:10.1000/Example", "doi", "10.1000/example"),
    ],
)
def test_normalize_paper_identifier(scheme, value, provider, normalized):
    result = normalize_paper_identifier(PaperIdentifier(scheme=scheme, value=value))
    assert result.provider == provider
    assert result.value == normalized


@pytest.mark.parametrize(
    ("scheme", "value"),
    [
        ("pmid", "0"),
        ("pmid", "24-157548"),
        ("pmcid", "PMC0"),
        ("doi", "10.1000"),
        ("doi", "10.1000/contains whitespace"),
        ("isbn", "9780000000000"),
    ],
)
def test_normalize_paper_identifier_rejects_unsupported_or_malformed_values(
    scheme, value
):
    with pytest.raises(ValueError):
        normalize_paper_identifier(PaperIdentifier(scheme=scheme, value=value))


def test_record_is_atomic_idempotent_and_connects_local_sources(tmp_path):
    store = _store(tmp_path)
    source_a = "a" * 64
    source_b = "b" * 64
    shared_doi = PaperIdentifier(scheme="doi", value="10.1000/example")

    first = record_paper_reference_trace(
        store,
        workspace_id="workspace-alpha",
        source_sha256=source_a,
        traces=[
            PaperReferenceTrace(
                relationship="identifies_as",
                target=PaperIdentifier(scheme="pmid", value="24157548"),
                metadata={"blockIds": ["p1-b1"], "quote": "PMID: 24157548"},
            ),
            PaperReferenceTrace(
                relationship="uses_method_from",
                target=shared_doi,
                metadata={
                    "blockIds": ["p1-b2"],
                    "quote": "The method follows doi:10.1000/example.",
                },
            ),
        ],
        source_metadata={"kind": "pdf", "path": "papers/source-a.pdf"},
    )
    replay = record_paper_reference_trace(
        store,
        workspace_id="workspace-alpha",
        source_sha256=source_a,
        traces=[
            PaperReferenceTrace(
                relationship="identifies_as",
                target=PaperIdentifier(scheme="pmid", value="24157548"),
                metadata={"blockIds": ["p1-b1"], "quote": "PMID: 24157548"},
            ),
            PaperReferenceTrace(
                relationship="uses_method_from",
                target=shared_doi,
                metadata={
                    "blockIds": ["p1-b2"],
                    "quote": "The method follows doi:10.1000/example.",
                },
            ),
        ],
        source_metadata={"kind": "pdf", "path": "papers/source-a.pdf"},
    )
    record_paper_reference_trace(
        store,
        workspace_id="workspace-alpha",
        source_sha256=source_b,
        traces=[
            PaperReferenceTrace(
                relationship="identifies_as",
                target=shared_doi,
                metadata={"blockIds": ["p1-b1"], "quote": "doi:10.1000/example"},
            )
        ],
        source_metadata={"kind": "pdf", "path": "papers/source-b.pdf"},
    )

    assert first.replayed is False
    assert first.edge_count == 2
    assert replay.replayed is True
    assert len(store.list_external_resource_bindings("workspace-alpha")) == 3

    graph = get_paper_reference_graph(
        store,
        workspace_id="workspace-alpha",
        source_sha256=source_a,
        depth=1,
        max_nodes=20,
    )
    assert graph.truncated is False
    assert {node["id"] for node in graph.nodes} >= {
        f"paper://sha256/{source_a}",
        f"paper://sha256/{source_b}",
        "publication:doi:10.1000/example",
        "publication:pubmed:24157548",
    }
    assert {edge["relationship"] for edge in graph.edges} == {
        "identifies_as",
        "uses_method_from",
    }
    store.close()


def test_record_preserves_existing_provider_metadata(tmp_path):
    store = _store(tmp_path)
    resource_id = store.upsert_external_resource(
        provider="doi",
        external_id="10.1000/example",
        metadata={"title": "Provider-owned title", "citationCount": 17},
        external_url="https://doi.org/10.1000/example",
        version_identifier="provider-version-3",
    )

    record_paper_reference_trace(
        store,
        workspace_id="workspace-alpha",
        source_sha256="a" * 64,
        traces=[
            PaperReferenceTrace(
                relationship="cites",
                target=PaperIdentifier(scheme="doi", value="10.1000/example"),
                metadata={"blockIds": ["p1-b1"], "quote": "doi:10.1000/example"},
            )
        ],
        source_metadata={"kind": "pdf", "path": "papers/source-a.pdf"},
    )

    resource = store.get_external_resource(resource_id)
    assert resource is not None
    assert resource["metadata_json"] == {
        "citationCount": 17,
        "title": "Provider-owned title",
    }
    assert resource["external_url"] == "https://doi.org/10.1000/example"
    assert resource["version_identifier"] == "provider-version-3"
    store.close()


def test_graph_query_never_returns_another_workspaces_local_source(tmp_path):
    store = _store(tmp_path)
    shared = PaperIdentifier(scheme="pmid", value="24157548")
    for workspace_id, digest in [
        ("workspace-alpha", "a" * 64),
        ("workspace-beta", "b" * 64),
    ]:
        record_paper_reference_trace(
            store,
            workspace_id=workspace_id,
            source_sha256=digest,
            traces=[
                PaperReferenceTrace(
                    relationship="identifies_as",
                    target=shared,
                    metadata={"blockIds": ["p1-b1"], "quote": "PMID 24157548"},
                )
            ],
            source_metadata={"kind": "pdf", "path": f"{workspace_id}/paper.pdf"},
        )

    graph = get_paper_reference_graph(
        store,
        workspace_id="workspace-alpha",
        source_sha256="a" * 64,
        depth=2,
        max_nodes=20,
    )
    source_nodes = [node for node in graph.nodes if node["kind"] == "paper_source"]
    assert [node["id"] for node in source_nodes] == [f"paper://sha256/{'a' * 64}"]
    assert all("workspace-beta" not in str(node) for node in graph.nodes)
    store.close()


def test_record_rolls_back_resource_when_binding_write_fails(tmp_path, monkeypatch):
    store = _store(tmp_path)

    def fail_binding(**_kwargs):
        raise sqlite3.OperationalError("inert forced binding failure")

    monkeypatch.setattr(store, "upsert_external_resource_binding", fail_binding)
    with pytest.raises(sqlite3.OperationalError, match="inert forced binding failure"):
        record_paper_reference_trace(
            store,
            workspace_id="workspace-alpha",
            source_sha256="a" * 64,
            traces=[
                PaperReferenceTrace(
                    relationship="cites",
                    target=PaperIdentifier(scheme="pmid", value="24157548"),
                    metadata={"blockIds": ["p1-b1"], "quote": "PMID 24157548"},
                )
            ],
            source_metadata={"kind": "pdf", "path": "papers/source-a.pdf"},
        )

    assert store.list_external_resources() == []
    assert store.list_external_resource_bindings("workspace-alpha") == []
    store.close()


def test_graph_query_obeys_node_budget_and_reports_truncation(tmp_path):
    store = _store(tmp_path)
    traces = [
        PaperReferenceTrace(
            relationship="cites",
            target=PaperIdentifier(scheme="pmid", value=str(20_000_000 + index)),
            metadata={
                "blockIds": [f"p1-b{index + 1}"],
                "quote": str(20_000_000 + index),
            },
        )
        for index in range(6)
    ]
    record_paper_reference_trace(
        store,
        workspace_id="workspace-alpha",
        source_sha256="a" * 64,
        traces=traces,
        source_metadata={"kind": "pdf", "path": "papers/source-a.pdf"},
    )

    graph = get_paper_reference_graph(
        store,
        workspace_id="workspace-alpha",
        source_sha256="a" * 64,
        depth=2,
        max_nodes=4,
    )
    assert len(graph.nodes) == 4
    assert graph.truncated is True
    store.close()
