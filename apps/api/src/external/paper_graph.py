"""Workspace-scoped paper reference traces over the external-resource graph.

Public identifier nodes are deliberately content-free. Exact source paths,
quotes, and locators stay on workspace-scoped bindings and are never promoted
to global cross-reference rows.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from ..control_plane.store import ControlPlaneStore

PAPER_TRACE_SCHEMA = "dnaforge.paper-reference-trace.v1"
PAPER_RELATIONSHIPS = frozenset(
    {"identifies_as", "cites", "uses_method_from", "supplement_to"}
)
_PROVIDERS = {"pmid": "pubmed", "pmcid": "pmc", "doi": "doi"}
_PROVIDER_TO_SCHEME = {provider: scheme for scheme, provider in _PROVIDERS.items()}
_PMID_RE = re.compile(r"[1-9][0-9]{0,11}")
_PMCID_RE = re.compile(r"PMC[1-9][0-9]{0,11}")
_DOI_RE = re.compile(r"10\.[0-9]{4,9}/[^\s\x00-\x1f\x7f]+")
_SHA256_RE = re.compile(r"[a-f0-9]{64}")
_MAX_METADATA_BYTES = 100_000


@dataclass(frozen=True)
class PaperIdentifier:
    scheme: str
    value: str


@dataclass(frozen=True)
class NormalizedPaperIdentifier:
    scheme: str
    provider: str
    value: str

    @property
    def node_id(self) -> str:
        return f"publication:{self.provider}:{self.value}"


@dataclass(frozen=True)
class PaperReferenceTrace:
    relationship: str
    target: PaperIdentifier
    metadata: dict[str, Any]


@dataclass(frozen=True)
class PaperReferenceRecordResult:
    source_uri: str
    source_sha256: str
    edge_count: int
    identifiers: list[dict[str, str]]
    replayed: bool


@dataclass(frozen=True)
class PaperReferenceGraph:
    source_uri: str
    nodes: list[dict[str, Any]]
    edges: list[dict[str, Any]]
    truncated: bool


def normalize_paper_identifier(
    identifier: PaperIdentifier,
) -> NormalizedPaperIdentifier:
    scheme = identifier.scheme.strip().lower()
    if scheme not in _PROVIDERS:
        raise ValueError(f"Unsupported paper identifier scheme: {identifier.scheme}")

    value = identifier.value.strip()
    if scheme == "pmid":
        if _PMID_RE.fullmatch(value) is None:
            raise ValueError("PMID must be a positive decimal identifier")
    elif scheme == "pmcid":
        value = value.upper()
        if _PMCID_RE.fullmatch(value) is None:
            raise ValueError("PMCID must use the form PMC followed by positive digits")
    else:
        value = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", value, flags=re.IGNORECASE)
        value = re.sub(r"^doi:\s*", "", value, flags=re.IGNORECASE).lower()
        if len(value) > 255 or _DOI_RE.fullmatch(value) is None:
            raise ValueError("DOI must be a bare 10.<registrant>/<suffix> identifier")

    return NormalizedPaperIdentifier(
        scheme=scheme,
        provider=_PROVIDERS[scheme],
        value=value,
    )


def paper_source_uri(source_sha256: str) -> str:
    digest = source_sha256.removeprefix("sha256:").lower()
    if _SHA256_RE.fullmatch(digest) is None:
        raise ValueError(
            "Paper source SHA-256 must contain 64 lowercase hexadecimal digits"
        )
    return f"paper://sha256/{digest}"


def record_paper_reference_trace(
    store: ControlPlaneStore,
    *,
    workspace_id: str,
    source_sha256: str,
    traces: list[PaperReferenceTrace],
    source_metadata: dict[str, Any],
) -> PaperReferenceRecordResult:
    """Atomically persist one validated renderer trace batch."""
    if not workspace_id or len(workspace_id) > 2_000:
        raise ValueError("workspace_id must be non-empty and at most 2000 characters")
    if not 1 <= len(traces) <= 100:
        raise ValueError("A paper reference trace batch must contain 1 to 100 edges")

    source_uri = paper_source_uri(source_sha256)
    digest = source_uri.rsplit("/", 1)[-1]
    normalized: list[tuple[PaperReferenceTrace, NormalizedPaperIdentifier]] = []
    seen: set[tuple[str, str, str]] = set()
    for trace in traces:
        if trace.relationship not in PAPER_RELATIONSHIPS:
            raise ValueError(f"Unsupported paper relationship: {trace.relationship}")
        target = normalize_paper_identifier(trace.target)
        key = (trace.relationship, target.provider, target.value)
        if key in seen:
            raise ValueError("Duplicate paper relationship in one trace batch")
        seen.add(key)
        normalized.append((trace, target))

    source_json = _bounded_json(source_metadata, "source metadata")
    source_metadata = json.loads(source_json)
    identifiers: list[dict[str, str]] = []
    replayed = True

    with store.transaction():
        existing_rows = store.list_external_resource_bindings(
            workspace_id=workspace_id,
            source_uri=source_uri,
            limit=500,
        )
        existing = {
            (row["external_resource_id"], row["relationship"]): row
            for row in existing_rows
        }

        for trace, target in normalized:
            resource_id = store.upsert_external_resource_stub(
                provider=target.provider,
                external_id=target.value,
            )
            binding_metadata = {
                "schema": PAPER_TRACE_SCHEMA,
                "source": source_metadata,
                "evidence": json.loads(_bounded_json(trace.metadata, "trace evidence")),
                "target": {"scheme": target.scheme, "value": target.value},
            }
            prior = existing.get((resource_id, trace.relationship))
            evidence = (
                "inferred" if trace.relationship == "uses_method_from" else "asserted"
            )
            if (
                prior is None
                or prior["evidence"] != evidence
                or prior["metadata_json"] != binding_metadata
            ):
                replayed = False
            store.upsert_external_resource_binding(
                workspace_id=workspace_id,
                source_kind="paper",
                source_uri=source_uri,
                external_resource_id=resource_id,
                relationship=trace.relationship,
                evidence=evidence,
                metadata=binding_metadata,
            )
            identifiers.append(
                {
                    "scheme": target.scheme,
                    "value": target.value,
                    "nodeId": target.node_id,
                }
            )

    return PaperReferenceRecordResult(
        source_uri=source_uri,
        source_sha256=digest,
        edge_count=len(normalized),
        identifiers=identifiers,
        replayed=replayed,
    )


def get_paper_reference_graph(
    store: ControlPlaneStore,
    *,
    workspace_id: str,
    source_sha256: str,
    depth: int = 1,
    max_nodes: int = 100,
) -> PaperReferenceGraph:
    """Return a deterministic workspace-local paper/identifier neighborhood.

    One depth expands a paper to its identifiers and to other local papers that
    share those identifiers. Depth two repeats that expansion once for the newly
    discovered local papers.
    """
    if not workspace_id or len(workspace_id) > 2_000:
        raise ValueError("workspace_id must be non-empty and at most 2000 characters")
    if depth not in (1, 2):
        raise ValueError("Paper graph depth must be 1 or 2")
    if not 1 <= max_nodes <= 100:
        raise ValueError("Paper graph max_nodes must be between 1 and 100")

    start_uri = paper_source_uri(source_sha256)
    nodes: dict[str, dict[str, Any]] = {
        start_uri: _paper_source_node(start_uri, source_metadata={})
    }
    edges: dict[str, dict[str, Any]] = {}
    frontier = [start_uri]
    expanded_sources: set[str] = set()
    truncated = False

    for _level in range(depth):
        resource_ids: set[str] = set()
        for source_uri in sorted(frontier):
            if source_uri in expanded_sources:
                continue
            expanded_sources.add(source_uri)
            bindings = _paper_bindings(
                store.list_external_resource_bindings(
                    workspace_id=workspace_id,
                    source_uri=source_uri,
                    limit=500,
                )
            )
            for binding in bindings:
                resource = store.get_external_resource(binding["external_resource_id"])
                identifier = _identifier_from_resource(resource)
                if identifier is None:
                    continue
                if identifier.node_id not in nodes:
                    if len(nodes) >= max_nodes:
                        truncated = True
                        continue
                    nodes[identifier.node_id] = {
                        "id": identifier.node_id,
                        "kind": "publication_identifier",
                        "scheme": identifier.scheme,
                        "value": identifier.value,
                    }
                resource_ids.add(binding["external_resource_id"])
                _add_binding_edge(edges, binding, identifier.node_id)
                _merge_source_metadata(nodes[source_uri], binding)

        discovered_sources: set[str] = set()
        for resource_id in sorted(resource_ids):
            resource = store.get_external_resource(resource_id)
            identifier = _identifier_from_resource(resource)
            if identifier is None or identifier.node_id not in nodes:
                continue
            bindings = _paper_bindings(
                store.list_external_resource_bindings(
                    workspace_id=workspace_id,
                    external_resource_id=resource_id,
                    limit=500,
                )
            )
            for binding in bindings:
                source_uri = binding["source_uri"]
                if source_uri not in nodes:
                    if len(nodes) >= max_nodes:
                        truncated = True
                        continue
                    nodes[source_uri] = _paper_source_node(
                        source_uri,
                        source_metadata=binding["metadata_json"].get("source", {}),
                    )
                _add_binding_edge(edges, binding, identifier.node_id)
                _merge_source_metadata(nodes[source_uri], binding)
                if source_uri not in expanded_sources:
                    discovered_sources.add(source_uri)
        frontier = sorted(discovered_sources)
        if not frontier:
            break

    return PaperReferenceGraph(
        source_uri=start_uri,
        nodes=[nodes[node_id] for node_id in sorted(nodes)],
        edges=sorted(
            edges.values(),
            key=lambda edge: (
                edge["from"],
                edge["relationship"],
                edge["to"],
                edge["id"],
            ),
        ),
        truncated=truncated,
    )


def _bounded_json(value: dict[str, Any], label: str) -> str:
    try:
        encoded = json.dumps(value, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Paper {label} must be JSON serializable") from exc
    if len(encoded.encode("utf-8")) > _MAX_METADATA_BYTES:
        raise ValueError(f"Paper {label} exceeds {_MAX_METADATA_BYTES} bytes")
    return encoded


def _paper_bindings(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        (
            row
            for row in rows
            if row["source_kind"] == "paper"
            and row["relationship"] in PAPER_RELATIONSHIPS
            and isinstance(row["metadata_json"], dict)
            and row["metadata_json"].get("schema") == PAPER_TRACE_SCHEMA
        ),
        key=lambda row: (
            row["source_uri"],
            row["relationship"],
            row["external_resource_id"],
            row["id"],
        ),
    )


def _identifier_from_resource(
    resource: dict[str, Any] | None,
) -> NormalizedPaperIdentifier | None:
    if resource is None:
        return None
    scheme = _PROVIDER_TO_SCHEME.get(resource["provider"])
    if scheme is None:
        return None
    try:
        return normalize_paper_identifier(
            PaperIdentifier(scheme=scheme, value=resource["external_id"])
        )
    except ValueError:
        return None


def _paper_source_node(
    source_uri: str, *, source_metadata: dict[str, Any]
) -> dict[str, Any]:
    return {
        "id": source_uri,
        "kind": "paper_source",
        "sha256": source_uri.rsplit("/", 1)[-1],
        "source": source_metadata,
    }


def _merge_source_metadata(node: dict[str, Any], binding: dict[str, Any]) -> None:
    if node.get("source"):
        return
    metadata = binding["metadata_json"]
    source = metadata.get("source") if isinstance(metadata, dict) else None
    if isinstance(source, dict):
        node["source"] = source


def _add_binding_edge(
    edges: dict[str, dict[str, Any]],
    binding: dict[str, Any],
    target_node_id: str,
) -> None:
    metadata = binding["metadata_json"]
    edges[binding["id"]] = {
        "id": binding["id"],
        "from": binding["source_uri"],
        "to": target_node_id,
        "relationship": binding["relationship"],
        "evidence": binding["evidence"],
        "trace": metadata.get("evidence", {}) if isinstance(metadata, dict) else {},
    }
