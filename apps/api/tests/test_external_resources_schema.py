""" / L0 — schema + DAO unit tests for the external_resource substrate.

Plan: tools/devops/plans/2026-05-02-bioinformatics-db-substrate.md
Concurrency spec: src/control_plane/EXTERNAL_RESOURCES_CONCURRENCY.md

Asserts every constraint in the schema with real biological fixtures:
  - 5 tables present, expected columns
  - WAL + busy_timeout pragmas applied to ControlPlaneStore connection
  - UPSERT idempotency on (provider, external_id), xref tuple, binding tuple
  - UNIQUE enforcement
  - CHECK enforcement (evidence enum, source_kind enum, [0,1] ranges)
  - FK enforcement (cascade for xref/binding, set null for fetch_log)
  - JSON roundtrip via _row_to_dict
  - Workspace-scoped binding listing (per-workspace privacy)

Fixtures in tests/fixtures/external_resources.py — real UniProt accessions /
PDB IDs / AlphaFold model ids. No synthetic IDs allowed by project policy.
"""

from __future__ import annotations

import sqlite3

import pytest

from src.control_plane.store import SCHEMA_SQL, ControlPlaneStore
from tests.fixtures.external_resources import (
    BIOLOGY_CROSS_REFS,
    LICENSE_TABLE,
    UNIPROT_RUBISCO_LARGE,
    canonical_external_resources,
    canonical_xrefs,
)


def _store(tmp_path) -> ControlPlaneStore:
    s = ControlPlaneStore(tmp_path / "sidecar.sqlite3")
    s.initialize()
    return s


def _all_resources(store: ControlPlaneStore) -> dict[tuple[str, str], str]:
    """Insert all 9 canonical fixtures, return {(provider, external_id): id}."""
    ids: dict[tuple[str, str], str] = {}
    for fx in canonical_external_resources():
        rid = store.upsert_external_resource(
            provider=fx.provider,
            external_id=fx.external_id,
            metadata=fx.metadata,
            external_url=fx.external_url,
            version_identifier=fx.version_identifier,
            license=fx.license,
            attribution=fx.attribution,
        )
        ids[(fx.provider, fx.external_id)] = rid
    return ids


def test_schema_creates_five_external_resource_tables(tmp_path):
    s = _store(tmp_path)
    raw = sqlite3.connect(s.db_path)
    tables = {
        row[0]
        for row in raw.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert {
        "data_file",
        "external_resource",
        "external_resource_xref",
        "external_resource_binding",
        "external_fetch_log",
    }.issubset(tables)
    s.close()


def test_indexes_exist_for_documented_query_paths(tmp_path):
    s = _store(tmp_path)
    raw = sqlite3.connect(s.db_path)
    indexes = {
        row[0]
        for row in raw.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
        )
    }
    assert {
        "data_file_lru",
        "data_file_provider",
        "external_resource_provider",
        "external_resource_data_file",
        "external_resource_xref_from",
        "external_resource_xref_to",
        "external_resource_binding_workspace",
        "external_resource_binding_source",
        "external_resource_binding_resource",
        "external_fetch_log_provider",
        "external_fetch_log_workspace",
        "external_fetch_log_resource",
    }.issubset(indexes)
    s.close()


def test_pragma_wal_busy_timeout_synchronous_set_on_store_connection(tmp_path):
    s = _store(tmp_path)
    assert s._conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
    assert s._conn.execute("PRAGMA busy_timeout").fetchone()[0] == 5000
    assert s._conn.execute("PRAGMA synchronous").fetchone()[0] == 1
    assert s._conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    assert s._conn.execute("PRAGMA cache_size").fetchone()[0] == -2048
    s.close()


def test_data_file_upsert_is_content_addressed_and_idempotent(tmp_path):
    s = _store(tmp_path)
    sha = "9" * 64
    s.upsert_data_file(
        sha256=sha,
        byte_size=12345,
        mime_type="chemical/x-mmcif",
        source_url="https://files.rcsb.org/download/1RBL.cif",
        source_provider="rcsb",
        license=LICENSE_TABLE["rcsb"]["license"],
        attribution=LICENSE_TABLE["rcsb"]["attribution"],
    )

    first = s.get_data_file(sha)
    assert first is not None
    first_used = first["last_used_at"]

    s.upsert_data_file(sha256=sha, byte_size=12345, source_provider="rcsb")
    second = s.get_data_file(sha)
    assert second is not None
    assert second["sha256"] == sha
    assert second["last_used_at"] >= first_used

    raw = sqlite3.connect(s.db_path)
    count = raw.execute("SELECT COUNT(*) FROM data_file").fetchone()[0]
    assert count == 1
    s.close()


def test_data_file_lru_listing_is_oldest_first(tmp_path):
    s = _store(tmp_path)
    older = "a" * 64
    newer = "b" * 64
    s.upsert_data_file(sha256=older, byte_size=100, source_provider="uniprot")
    s.upsert_data_file(sha256=newer, byte_size=200, source_provider="uniprot")
    s.touch_data_file(newer)

    rows = s.list_data_files_by_lru(limit=10)
    assert [r["sha256"] for r in rows] == [older, newer]
    s.close()


def test_external_resource_idempotent_on_provider_external_id(tmp_path):
    s = _store(tmp_path)
    fx = UNIPROT_RUBISCO_LARGE
    rid_a = s.upsert_external_resource(
        provider=fx.provider,
        external_id=fx.external_id,
        metadata=fx.metadata,
        license=fx.license,
        attribution=fx.attribution,
    )
    rid_b = s.upsert_external_resource(
        provider=fx.provider,
        external_id=fx.external_id,
        metadata={**fx.metadata, "fetched_again": True},
        license=fx.license,
        attribution=fx.attribution,
    )
    assert rid_a == rid_b

    raw = sqlite3.connect(s.db_path)
    count = raw.execute("SELECT COUNT(*) FROM external_resource").fetchone()[0]
    assert count == 1

    refreshed = s.get_external_resource(rid_a)
    assert refreshed is not None
    assert refreshed["metadata_json"]["fetched_again"] is True
    s.close()


def test_external_resource_lookup_by_provider_external_id(tmp_path):
    s = _store(tmp_path)
    _all_resources(s)
    row = s.get_external_resource_by_external_id("rcsb", "1RBL")
    assert row is not None
    assert row["provider"] == "rcsb"
    assert row["external_id"] == "1RBL"
    assert row["license"] == LICENSE_TABLE["rcsb"]["license"]
    assert row["metadata_json"]["resolution_a"] == 2.2
    s.close()


def test_external_resource_lookup_by_provider_external_id_misses_cleanly(tmp_path):
    s = _store(tmp_path)
    assert s.get_external_resource_by_external_id("uniprot", "MISSING") is None
    s.close()


def test_external_resource_listing_filters_by_provider(tmp_path):
    s = _store(tmp_path)
    _all_resources(s)
    uniprot_rows = s.list_external_resources(provider="uniprot")
    rcsb_rows = s.list_external_resources(provider="rcsb")
    afdb_rows = s.list_external_resources(provider="alphafold")
    assert {r["external_id"] for r in uniprot_rows} == {"P00875", "P0A6F5", "P02786"}
    assert {r["external_id"] for r in rcsb_rows} == {"1RBL", "1AON", "1SUV"}
    assert {r["external_id"] for r in afdb_rows} == {
        "AF-P00875-F1",
        "AF-P0A6F5-F1",
        "AF-P02786-F1",
    }
    s.close()


def test_external_resource_data_file_id_set_null_on_data_file_delete(tmp_path):
    s = _store(tmp_path)
    sha = "c" * 64
    s.upsert_data_file(sha256=sha, byte_size=42, source_provider="uniprot")
    rid = s.upsert_external_resource(
        provider="uniprot",
        external_id="P00875",
        metadata={"name": "RuBisCO"},
        data_file_id=sha,
    )
    raw = sqlite3.connect(s.db_path)
    raw.execute("PRAGMA foreign_keys = ON")
    raw.execute("DELETE FROM data_file WHERE sha256 = ?", (sha,))
    raw.commit()
    raw.close()

    refreshed = s.get_external_resource(rid)
    assert refreshed is not None
    assert refreshed["data_file_id"] is None
    s.close()


def test_xref_inserts_real_uniprot_to_pdb_relationships(tmp_path):
    s = _store(tmp_path)
    ids = _all_resources(s)
    for fx in canonical_xrefs():
        s.upsert_external_resource_xref(
            from_resource_id=ids[(fx.from_provider, fx.from_external_id)],
            to_resource_id=ids[(fx.to_provider, fx.to_external_id)],
            xref_type=fx.xref_type,
            evidence=fx.evidence,
            source_provider=fx.source_provider,
            confidence=fx.confidence,
            identity=fx.identity,
            coverage=fx.coverage,
        )

    raw = sqlite3.connect(s.db_path)
    n = raw.execute("SELECT COUNT(*) FROM external_resource_xref").fetchone()[0]
    assert n == len(BIOLOGY_CROSS_REFS)

    p00875 = ids[("uniprot", "P00875")]
    structures = s.list_external_resource_xrefs(
        from_resource_id=p00875, xref_type="has_structure"
    )
    structure_target_ids = {row["to_resource_id"] for row in structures}
    assert ids[("rcsb", "1RBL")] in structure_target_ids
    assert ids[("alphafold", "AF-P00875-F1")] in structure_target_ids
    s.close()


def test_xref_idempotent_on_unique_tuple_refreshes_confidence(tmp_path):
    s = _store(tmp_path)
    ids = _all_resources(s)
    p00875 = ids[("uniprot", "P00875")]
    one_rbl = ids[("rcsb", "1RBL")]

    first = s.upsert_external_resource_xref(
        from_resource_id=p00875,
        to_resource_id=one_rbl,
        xref_type="has_structure",
        evidence="asserted",
        source_provider="uniprot",
        confidence=0.95,
    )
    second = s.upsert_external_resource_xref(
        from_resource_id=p00875,
        to_resource_id=one_rbl,
        xref_type="has_structure",
        evidence="asserted",
        source_provider="uniprot",
        confidence=0.99,
    )
    assert first == second
    raw = sqlite3.connect(s.db_path)
    confidence = raw.execute(
        "SELECT confidence FROM external_resource_xref WHERE id = ?", (second,)
    ).fetchone()[0]
    assert confidence == pytest.approx(0.99)
    s.close()


def test_xref_evidence_check_constraint_rejects_unknown_value(tmp_path):
    s = _store(tmp_path)
    ids = _all_resources(s)
    with pytest.raises(sqlite3.IntegrityError):
        s.upsert_external_resource_xref(
            from_resource_id=ids[("uniprot", "P00875")],
            to_resource_id=ids[("rcsb", "1RBL")],
            xref_type="has_structure",
            evidence="rumored",
            source_provider="uniprot",
        )
    s.close()


def test_xref_confidence_range_check_rejects_out_of_bounds(tmp_path):
    s = _store(tmp_path)
    ids = _all_resources(s)
    with pytest.raises(sqlite3.IntegrityError):
        s.upsert_external_resource_xref(
            from_resource_id=ids[("uniprot", "P00875")],
            to_resource_id=ids[("rcsb", "1RBL")],
            xref_type="has_structure",
            evidence="asserted",
            source_provider="uniprot",
            confidence=1.5,
        )
    with pytest.raises(sqlite3.IntegrityError):
        s.upsert_external_resource_xref(
            from_resource_id=ids[("uniprot", "P00875")],
            to_resource_id=ids[("rcsb", "1RBL")],
            xref_type="has_structure",
            evidence="asserted",
            source_provider="uniprot",
            identity=-0.1,
        )
    s.close()


def test_xref_cascades_when_referenced_resource_deleted(tmp_path):
    s = _store(tmp_path)
    ids = _all_resources(s)
    for fx in canonical_xrefs():
        s.upsert_external_resource_xref(
            from_resource_id=ids[(fx.from_provider, fx.from_external_id)],
            to_resource_id=ids[(fx.to_provider, fx.to_external_id)],
            xref_type=fx.xref_type,
            evidence=fx.evidence,
            source_provider=fx.source_provider,
            confidence=fx.confidence,
        )

    raw = sqlite3.connect(s.db_path)
    raw.execute("PRAGMA foreign_keys = ON")
    raw.execute(
        "DELETE FROM external_resource WHERE provider='rcsb' AND external_id='1RBL'"
    )
    raw.commit()
    remaining = raw.execute(
        """
        SELECT COUNT(*) FROM external_resource_xref
        WHERE from_resource_id = ? OR to_resource_id = ?
        """,
        (ids[("rcsb", "1RBL")], ids[("rcsb", "1RBL")]),
    ).fetchone()[0]
    assert remaining == 0
    raw.close()
    s.close()


def test_binding_workspace_scoping_isolates_private_internal_ids(tmp_path):
    """Codex point 2: globally-scoped external_resource must not leak across
    workspaces. Bindings are workspace-scoped; the resource is shared cache."""
    s = _store(tmp_path)
    ids = _all_resources(s)
    p00875 = ids[("uniprot", "P00875")]

    s.upsert_external_resource_binding(
        workspace_id="alice-private-lab",
        source_kind="sequence",
        source_uri="waypoint://workspace/alice-private-lab/sequence/secret-rbcl.gb",
        external_resource_id=p00875,
        relationship="derived_from",
        evidence="asserted",
    )
    s.upsert_external_resource_binding(
        workspace_id="bob-public-lab",
        source_kind="sequence",
        source_uri="waypoint://workspace/bob-public-lab/sequence/rubisco.gb",
        external_resource_id=p00875,
        relationship="derived_from",
        evidence="asserted",
    )

    alice = s.list_external_resource_bindings(workspace_id="alice-private-lab")
    bob = s.list_external_resource_bindings(workspace_id="bob-public-lab")

    assert len(alice) == 1
    assert len(bob) == 1
    assert "secret-rbcl.gb" in alice[0]["source_uri"]
    assert "secret-rbcl.gb" not in bob[0]["source_uri"]
    s.close()


def test_binding_idempotent_on_unique_tuple(tmp_path):
    s = _store(tmp_path)
    ids = _all_resources(s)
    p00875 = ids[("uniprot", "P00875")]
    a = s.upsert_external_resource_binding(
        workspace_id="ws-1",
        source_kind="sequence",
        source_uri="waypoint://workspace/ws-1/sequence/rubisco.gb",
        external_resource_id=p00875,
        relationship="derived_from",
        evidence="asserted",
        confidence=0.9,
    )
    b = s.upsert_external_resource_binding(
        workspace_id="ws-1",
        source_kind="sequence",
        source_uri="waypoint://workspace/ws-1/sequence/rubisco.gb",
        external_resource_id=p00875,
        relationship="derived_from",
        evidence="asserted",
        confidence=0.99,
    )
    assert a == b
    rows = s.list_external_resource_bindings(workspace_id="ws-1")
    assert len(rows) == 1
    assert rows[0]["confidence"] == pytest.approx(0.99)
    s.close()


def test_binding_source_kind_check_constraint(tmp_path):
    s = _store(tmp_path)
    ids = _all_resources(s)
    with pytest.raises(sqlite3.IntegrityError):
        s.upsert_external_resource_binding(
            workspace_id="ws-1",
            source_kind="organism",
            source_uri="waypoint://workspace/ws-1/sequence/rubisco.gb",
            external_resource_id=ids[("uniprot", "P00875")],
            relationship="derived_from",
            evidence="asserted",
        )
    s.close()


def test_binding_accepts_workspace_scoped_paper_sources(tmp_path):
    s = _store(tmp_path)
    ids = _all_resources(s)

    binding_id = s.upsert_external_resource_binding(
        workspace_id="workspace-paper-lab",
        source_kind="paper",
        source_uri=f"paper://sha256/{'a' * 64}",
        external_resource_id=ids[("uniprot", "P00875")],
        relationship="cites",
        evidence="asserted",
    )

    rows = s.list_external_resource_bindings(
        workspace_id="workspace-paper-lab",
        external_resource_id=ids[("uniprot", "P00875")],
    )
    assert [row["id"] for row in rows] == [binding_id]
    assert rows[0]["source_kind"] == "paper"
    s.close()


def test_initialize_migrates_legacy_binding_constraint_without_losing_rows(tmp_path):
    db_path = tmp_path / "legacy-sidecar.sqlite3"
    raw = sqlite3.connect(db_path)
    raw.executescript(SCHEMA_SQL)
    raw.executescript("""
        DROP INDEX external_resource_binding_resource;
        DROP INDEX external_resource_binding_source;
        DROP INDEX external_resource_binding_workspace;
        ALTER TABLE external_resource_binding RENAME TO external_resource_binding_current;
        CREATE TABLE external_resource_binding (
          id                    TEXT PRIMARY KEY,
          workspace_id          TEXT NOT NULL,
          source_kind           TEXT NOT NULL CHECK (source_kind IN ('sequence','feature','project')),
          source_uri            TEXT NOT NULL,
          external_resource_id  TEXT NOT NULL REFERENCES external_resource(id) ON DELETE CASCADE,
          relationship          TEXT NOT NULL,
          evidence              TEXT NOT NULL CHECK (evidence IN ('asserted','inferred','predicted')),
          confidence            REAL CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
          alignment_coords_json TEXT,
          metadata_json         TEXT NOT NULL,
          created_at            TEXT NOT NULL,
          UNIQUE(workspace_id, source_uri, external_resource_id, relationship)
        );
        INSERT INTO external_resource_binding
          SELECT * FROM external_resource_binding_current;
        DROP TABLE external_resource_binding_current;
        CREATE INDEX external_resource_binding_workspace
          ON external_resource_binding(workspace_id, created_at DESC);
        CREATE INDEX external_resource_binding_source
          ON external_resource_binding(source_uri);
        CREATE INDEX external_resource_binding_resource
          ON external_resource_binding(external_resource_id);
        """)
    raw.execute(
        """
        INSERT INTO external_resource (
          id, provider, external_id, metadata_json, fetched_at, last_checked
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            "resource-existing",
            "uniprot",
            "P00875",
            "{}",
            "2026-08-19T00:00:00Z",
            "2026-08-19T00:00:00Z",
        ),
    )
    raw.execute(
        """
        INSERT INTO external_resource_binding (
          id, workspace_id, source_kind, source_uri, external_resource_id,
          relationship, evidence, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "binding-existing",
            "workspace-existing",
            "sequence",
            "waypoint://workspace-existing/sequence/rubisco.gb",
            "resource-existing",
            "derived_from",
            "asserted",
            "{}",
            "2026-08-19T00:00:00Z",
        ),
    )
    raw.commit()
    raw.close()

    migrated = ControlPlaneStore(db_path)
    migrated.initialize()
    assert migrated.list_external_resource_bindings("workspace-existing")[0]["id"] == (
        "binding-existing"
    )
    migrated.upsert_external_resource_binding(
        workspace_id="workspace-existing",
        source_kind="paper",
        source_uri=f"paper://sha256/{'b' * 64}",
        external_resource_id="resource-existing",
        relationship="identifies_as",
        evidence="asserted",
    )
    assert len(migrated.list_external_resource_bindings("workspace-existing")) == 2
    migrated.close()


def test_binding_cascades_on_external_resource_delete(tmp_path):
    s = _store(tmp_path)
    ids = _all_resources(s)
    p00875 = ids[("uniprot", "P00875")]
    s.upsert_external_resource_binding(
        workspace_id="ws-1",
        source_kind="sequence",
        source_uri="waypoint://workspace/ws-1/sequence/rubisco.gb",
        external_resource_id=p00875,
        relationship="derived_from",
        evidence="asserted",
    )

    raw = sqlite3.connect(s.db_path)
    raw.execute("PRAGMA foreign_keys = ON")
    raw.execute("DELETE FROM external_resource WHERE id = ?", (p00875,))
    raw.commit()
    n = raw.execute("SELECT COUNT(*) FROM external_resource_binding").fetchone()[0]
    raw.close()
    assert n == 0
    s.close()


def test_fetch_log_records_per_fetch_with_capability_check_json(tmp_path):
    s = _store(tmp_path)
    ids = _all_resources(s)
    p00875 = ids[("uniprot", "P00875")]
    log_id = s.insert_external_fetch_log(
        provider="uniprot",
        endpoint="https://rest.uniprot.org/uniprotkb/P00875.json",
        method="GET",
        status_code=200,
        latency_ms=87,
        bytes_received=14523,
        cache_hit=False,
        external_resource_id=p00875,
        workspace_id="ws-1",
        capability_check={"required": ["external-fetch:annotation"], "satisfied": True},
    )
    assert log_id

    rows = s.list_external_fetch_log(provider="uniprot")
    assert len(rows) == 1
    assert rows[0]["status_code"] == 200
    assert rows[0]["cache_hit"] is False
    assert rows[0]["capability_check_json"]["satisfied"] is True
    s.close()


def test_fetch_log_survives_resource_deletion_via_set_null(tmp_path):
    s = _store(tmp_path)
    ids = _all_resources(s)
    p00875 = ids[("uniprot", "P00875")]
    log_id = s.insert_external_fetch_log(
        provider="uniprot",
        endpoint="https://rest.uniprot.org/uniprotkb/P00875.json",
        method="GET",
        external_resource_id=p00875,
        capability_check={"required": ["external-fetch:annotation"], "satisfied": True},
    )

    raw = sqlite3.connect(s.db_path)
    raw.execute("PRAGMA foreign_keys = ON")
    raw.execute("DELETE FROM external_resource WHERE id = ?", (p00875,))
    raw.commit()
    rows = raw.execute(
        "SELECT * FROM external_fetch_log WHERE id = ?", (log_id,)
    ).fetchall()
    assert len(rows) == 1
    raw.row_factory = sqlite3.Row
    row = raw.execute(
        "SELECT * FROM external_fetch_log WHERE id = ?", (log_id,)
    ).fetchone()
    assert row["external_resource_id"] is None
    raw.close()
    s.close()


def test_fetch_log_listing_filters_by_provider_and_workspace(tmp_path):
    s = _store(tmp_path)
    ids = _all_resources(s)
    s.insert_external_fetch_log(
        provider="uniprot",
        endpoint="https://rest.uniprot.org/uniprotkb/P00875.json",
        method="GET",
        external_resource_id=ids[("uniprot", "P00875")],
        workspace_id="ws-A",
        capability_check={"required": ["external-fetch:annotation"], "satisfied": True},
    )
    s.insert_external_fetch_log(
        provider="rcsb",
        endpoint="https://files.rcsb.org/download/1RBL.cif",
        method="GET",
        external_resource_id=ids[("rcsb", "1RBL")],
        workspace_id="ws-B",
        capability_check={"required": ["external-fetch:structure"], "satisfied": True},
    )

    only_uniprot = s.list_external_fetch_log(provider="uniprot")
    only_workspace_b = s.list_external_fetch_log(workspace_id="ws-B")
    assert len(only_uniprot) == 1 and only_uniprot[0]["provider"] == "uniprot"
    assert len(only_workspace_b) == 1 and only_workspace_b[0]["workspace_id"] == "ws-B"
    s.close()


def test_json_columns_roundtrip_for_xref_and_binding(tmp_path):
    s = _store(tmp_path)
    ids = _all_resources(s)
    s.upsert_external_resource_xref(
        from_resource_id=ids[("uniprot", "P00875")],
        to_resource_id=ids[("rcsb", "1RBL")],
        xref_type="has_structure",
        evidence="asserted",
        source_provider="uniprot",
        alignment_coords={
            "from_start": 1,
            "from_end": 472,
            "to_start": 1,
            "to_end": 470,
        },
        metadata={"db_xref_section": "PDB"},
    )
    rows = s.list_external_resource_xrefs(from_resource_id=ids[("uniprot", "P00875")])
    assert rows[0]["alignment_coords_json"]["from_end"] == 472
    assert rows[0]["metadata_json"]["db_xref_section"] == "PDB"
    s.close()


def test_dna82_existing_tables_still_function_after_substrate_load(tmp_path):
    """Don't regress 's substrate when the new substrate co-exists."""
    s = _store(tmp_path)
    ids = _all_resources(s)
    s.ensure_agent_identity("agent-rubisco", scope=["external-fetch:annotation"])
    action_id = s.insert_agent_action(
        agent_identity_id="agent-rubisco",
        tool_name="external.fetch",
        parameters={"provider": "uniprot", "external_id": "P00875"},
    )
    s.insert_audit_record(
        action_id=action_id,
        actor_kind="agent",
        actor_identity="agent-rubisco",
        actor_scope=["external-fetch:annotation"],
        side_effects=[
            {
                "kind": "external_resource_upsert",
                "resource_id": ids[("uniprot", "P00875")],
            }
        ],
        capability_check={"required": ["external-fetch:annotation"], "satisfied": True},
    )
    s.complete_agent_action(action_id, result={"ok": True})

    audits = s.get_audit_records_for_action(action_id)
    assert len(audits) == 1
    assert (
        audits[0]["side_effects_json"][0]["resource_id"] == ids[("uniprot", "P00875")]
    )
    s.close()


def test_get_data_file_returns_none_for_missing_sha(tmp_path):
    s = _store(tmp_path)
    assert s.get_data_file("0" * 64) is None
    s.close()


def test_get_external_resource_returns_none_for_missing_id(tmp_path):
    s = _store(tmp_path)
    assert s.get_external_resource("00000000-0000-0000-0000-000000000000") is None
    s.close()


@pytest.mark.parametrize(
    "limit,expected_max",
    [(0, 1), (-5, 1), (1, 1), (100, 100), (10_000, 500)],
)
def test_list_methods_clamp_limit_uniformly(tmp_path, limit, expected_max):
    """Every list_* method clamps limit into [1, 500]. A future maintainer
    removing the clamp would otherwise expose unbounded result sets."""
    s = _store(tmp_path)
    ids = _all_resources(s)
    for fx in canonical_external_resources():
        s.upsert_data_file(
            sha256=f"{ord(fx.provider[0]):064x}"[:64].rjust(64, "0"),
            byte_size=1,
            source_provider=fx.provider,
        )
    for fx in canonical_xrefs():
        s.upsert_external_resource_xref(
            from_resource_id=ids[(fx.from_provider, fx.from_external_id)],
            to_resource_id=ids[(fx.to_provider, fx.to_external_id)],
            xref_type=fx.xref_type,
            evidence=fx.evidence,
            source_provider=fx.source_provider,
        )
    s.upsert_external_resource_binding(
        workspace_id="ws-1",
        source_kind="sequence",
        source_uri="waypoint://workspace/ws-1/sequence/rubisco.gb",
        external_resource_id=ids[("uniprot", "P00875")],
        relationship="derived_from",
        evidence="asserted",
    )
    s.insert_external_fetch_log(
        provider="uniprot",
        endpoint="https://rest.uniprot.org/uniprotkb/P00875.json",
        method="GET",
        external_resource_id=ids[("uniprot", "P00875")],
        capability_check={"required": ["external-fetch:annotation"], "satisfied": True},
    )

    assert 1 <= len(s.list_data_files_by_lru(limit=limit)) <= expected_max
    assert 1 <= len(s.list_external_resources(limit=limit)) <= expected_max
    assert 1 <= len(s.list_external_resource_xrefs(limit=limit)) <= expected_max
    assert (
        1
        <= len(s.list_external_resource_bindings(workspace_id="ws-1", limit=limit))
        <= expected_max
    )
    assert 1 <= len(s.list_external_fetch_log(limit=limit)) <= expected_max
    s.close()


def test_list_external_resource_xrefs_filter_combinations(tmp_path):
    """Cover every branch of the dynamic WHERE-builder: from-only, to-only,
    type-only, two-arg combinations, no filters at all (full scan)."""
    s = _store(tmp_path)
    ids = _all_resources(s)
    for fx in canonical_xrefs():
        s.upsert_external_resource_xref(
            from_resource_id=ids[(fx.from_provider, fx.from_external_id)],
            to_resource_id=ids[(fx.to_provider, fx.to_external_id)],
            xref_type=fx.xref_type,
            evidence=fx.evidence,
            source_provider=fx.source_provider,
        )
    p00875 = ids[("uniprot", "P00875")]
    pdb_1rbl = ids[("rcsb", "1RBL")]

    no_filters = s.list_external_resource_xrefs()
    from_only = s.list_external_resource_xrefs(from_resource_id=p00875)
    to_only = s.list_external_resource_xrefs(to_resource_id=pdb_1rbl)
    type_only = s.list_external_resource_xrefs(xref_type="has_structure")
    from_and_to = s.list_external_resource_xrefs(
        from_resource_id=p00875, to_resource_id=pdb_1rbl
    )
    from_and_type = s.list_external_resource_xrefs(
        from_resource_id=p00875, xref_type="has_structure"
    )

    assert len(no_filters) == len(BIOLOGY_CROSS_REFS)
    assert all(r["from_resource_id"] == p00875 for r in from_only)
    assert all(r["to_resource_id"] == pdb_1rbl for r in to_only)
    assert all(r["xref_type"] == "has_structure" for r in type_only)
    assert len(from_and_to) == 1
    assert from_and_to[0]["from_resource_id"] == p00875
    assert from_and_to[0]["to_resource_id"] == pdb_1rbl
    assert all(
        r["from_resource_id"] == p00875 and r["xref_type"] == "has_structure"
        for r in from_and_type
    )
    s.close()


def test_list_external_fetch_log_filter_combinations(tmp_path):
    """no-filter / provider-only / workspace-only / both."""
    s = _store(tmp_path)
    ids = _all_resources(s)
    s.insert_external_fetch_log(
        provider="uniprot",
        endpoint="https://rest.uniprot.org/uniprotkb/P00875.json",
        method="GET",
        external_resource_id=ids[("uniprot", "P00875")],
        workspace_id="ws-A",
        capability_check={"required": ["external-fetch:annotation"], "satisfied": True},
    )
    s.insert_external_fetch_log(
        provider="rcsb",
        endpoint="https://files.rcsb.org/download/1RBL.cif",
        method="GET",
        external_resource_id=ids[("rcsb", "1RBL")],
        workspace_id="ws-B",
        capability_check={"required": ["external-fetch:structure"], "satisfied": True},
    )
    s.insert_external_fetch_log(
        provider="uniprot",
        endpoint="https://rest.uniprot.org/uniprotkb/P0A6F5.json",
        method="GET",
        external_resource_id=ids[("uniprot", "P0A6F5")],
        workspace_id="ws-A",
        capability_check={"required": ["external-fetch:annotation"], "satisfied": True},
    )

    assert len(s.list_external_fetch_log()) == 3
    only_uniprot = s.list_external_fetch_log(provider="uniprot")
    only_ws_a = s.list_external_fetch_log(workspace_id="ws-A")
    both = s.list_external_fetch_log(provider="uniprot", workspace_id="ws-A")
    assert len(only_uniprot) == 2 and {r["provider"] for r in only_uniprot} == {
        "uniprot"
    }
    assert len(only_ws_a) == 2 and {r["workspace_id"] for r in only_ws_a} == {"ws-A"}
    assert len(both) == 2
    assert all(r["provider"] == "uniprot" and r["workspace_id"] == "ws-A" for r in both)
    s.close()


def test_list_external_resources_no_filter_returns_everything(tmp_path):
    s = _store(tmp_path)
    _all_resources(s)
    rows = s.list_external_resources()
    providers = {r["provider"] for r in rows}
    assert providers == {"uniprot", "rcsb", "alphafold"}
    assert len(rows) == 9
    s.close()


def test_list_external_resource_bindings_no_source_filter(tmp_path):
    """Workspace-required is enforced; a workspace_id with no source_uri
    filter must list every binding for that workspace, not error or
    silently return []."""
    s = _store(tmp_path)
    ids = _all_resources(s)
    s.upsert_external_resource_binding(
        workspace_id="ws-1",
        source_kind="sequence",
        source_uri="waypoint://workspace/ws-1/sequence/a.gb",
        external_resource_id=ids[("uniprot", "P00875")],
        relationship="derived_from",
        evidence="asserted",
    )
    s.upsert_external_resource_binding(
        workspace_id="ws-1",
        source_kind="feature",
        source_uri="waypoint://workspace/ws-1/feature/b",
        external_resource_id=ids[("rcsb", "1RBL")],
        relationship="has_structure",
        evidence="asserted",
    )
    rows = s.list_external_resource_bindings(workspace_id="ws-1")
    assert len(rows) == 2
    assert {r["source_kind"] for r in rows} == {"sequence", "feature"}
    s.close()


def test_xref_two_source_providers_create_separate_rows(tmp_path):
    """The xref UNIQUE tuple includes source_provider so independent assertions
    of the same biology edge by different providers are preserved separately —
    UniProt asserting P00875→1RBL and PDBe asserting the same edge is two rows,
    not one. A regression that collapses them would silently lose evidence."""
    s = _store(tmp_path)
    ids = _all_resources(s)
    a = s.upsert_external_resource_xref(
        from_resource_id=ids[("uniprot", "P00875")],
        to_resource_id=ids[("rcsb", "1RBL")],
        xref_type="has_structure",
        evidence="asserted",
        source_provider="uniprot",
        confidence=1.0,
    )
    b = s.upsert_external_resource_xref(
        from_resource_id=ids[("uniprot", "P00875")],
        to_resource_id=ids[("rcsb", "1RBL")],
        xref_type="has_structure",
        evidence="asserted",
        source_provider="pdbe",
        confidence=0.95,
    )
    assert a != b
    rows = s.list_external_resource_xrefs(from_resource_id=ids[("uniprot", "P00875")])
    providers = {
        r["source_provider"]
        for r in rows
        if r["to_resource_id"] == ids[("rcsb", "1RBL")]
    }
    assert providers == {"uniprot", "pdbe"}
    s.close()


def test_external_resource_reupsert_with_nulls_preserves_prior_values(tmp_path):
    """COALESCE in the UPSERT clause is load-bearing: a refetch that doesn't
    re-supply etag/license/external_url must NOT wipe the previously stored
    values. A regression replacing COALESCE with `excluded.X` would erase
    license metadata on every refresh — a Legal/licensing compliance break."""
    s = _store(tmp_path)
    rid = s.upsert_external_resource(
        provider="uniprot",
        external_id="P00875",
        metadata={"name": "RuBisCO"},
        etag='W/"abc"',
        license="CC-BY-4.0",
        attribution="UniProt Consortium",
        external_url="https://www.uniprot.org/uniprotkb/P00875/entry",
    )
    s.upsert_external_resource(
        provider="uniprot",
        external_id="P00875",
        metadata={"name": "RuBisCO", "refresh": True},
    )
    row = s.get_external_resource(rid)
    assert row is not None
    assert row["etag"] == 'W/"abc"'
    assert row["license"] == "CC-BY-4.0"
    assert row["attribution"] == "UniProt Consortium"
    assert row["external_url"] == "https://www.uniprot.org/uniprotkb/P00875/entry"
    assert row["metadata_json"]["refresh"] is True
    s.close()


def test_amortized_refetch_creates_zero_new_rows(tmp_path):
    """Plan budget says agent fetches are ~4 inserts amortized — i.e., a second
    fetch of the same content is a no-op. Test pins that contract: a repeat of
    the same provider fetch must add zero new rows across all four tables."""
    s = _store(tmp_path)
    raw = sqlite3.connect(s.db_path)

    def total() -> int:
        return sum(
            raw.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            for t in (
                "data_file",
                "external_resource",
                "external_resource_xref",
                "external_fetch_log",
            )
        )

    sha = "f" * 64

    def fetch() -> None:
        s.upsert_data_file(sha256=sha, byte_size=1024, source_provider="rcsb")
        rid_uniprot = s.upsert_external_resource(
            provider="uniprot",
            external_id="P00875",
            metadata={"name": "RuBisCO"},
        )
        rid_pdb = s.upsert_external_resource(
            provider="rcsb",
            external_id="1RBL",
            metadata={"title": "RuBisCO crystal"},
            data_file_id=sha,
        )
        s.upsert_external_resource_xref(
            from_resource_id=rid_uniprot,
            to_resource_id=rid_pdb,
            xref_type="has_structure",
            evidence="asserted",
            source_provider="uniprot",
        )

    fetch()
    cold = total()
    fetch()
    warm = total()
    raw.close()
    assert (
        warm - cold == 0
    ), "amortized re-fetch must add zero rows (UPSERT idempotency)"
    s.close()
