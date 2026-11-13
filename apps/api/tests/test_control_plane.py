"""Tests for the  control-plane tables and DAO helpers."""

import sqlite3

from src.control_plane import ControlPlaneStore, new_uuid7


def test_control_plane_migrates_existing_agent_action_before_creating_job_index(
    tmp_path,
):
    database = tmp_path / "legacy.sqlite3"
    connection = sqlite3.connect(database)
    connection.executescript("""
        CREATE TABLE agent_identity (
          id TEXT PRIMARY KEY,
          parent_human_identity_id TEXT NOT NULL,
          scope_json TEXT NOT NULL,
          expires_at TEXT,
          revoked INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE agent_action (
          id TEXT PRIMARY KEY,
          agent_identity_id TEXT,
          tool_name TEXT,
          parameters_json TEXT,
          authorized_scope_json TEXT,
          requested_at TEXT,
          authorization_state TEXT,
          parent_action_id TEXT,
          root_action_id TEXT,
          result_json TEXT,
          error_json TEXT,
          completed_at TEXT
        );
        """)
    connection.close()

    store = ControlPlaneStore(database)
    store.initialize()
    columns = {
        row[1]
        for row in store._conn.execute("PRAGMA table_info(agent_action)").fetchall()
    }
    indexes = {
        row[1]
        for row in store._conn.execute("PRAGMA index_list(agent_action)").fetchall()
    }
    idempotency_index_columns = [
        row[2]
        for row in store._conn.execute(
            "PRAGMA index_info(agent_action_idempotency)"
        ).fetchall()
    ]
    assert {
        "job_pool",
        "job_cancelable",
        "job_duration",
        "job_turn_id",
        "idempotency_key_hash",
        "idempotency_body_hash",
        "terminal_expires_at",
    } <= columns
    assert "agent_action_idempotency" in indexes
    assert idempotency_index_columns == [
        "agent_identity_id",
        "idempotency_key_hash",
        "requested_at",
    ]

    store._conn.execute("DROP INDEX agent_action_idempotency")
    store._conn.execute(
        "CREATE INDEX agent_action_idempotency "
        "ON agent_action(idempotency_key_hash, requested_at DESC)"
    )
    store.initialize()
    migrated_index_columns = [
        row[2]
        for row in store._conn.execute(
            "PRAGMA index_info(agent_action_idempotency)"
        ).fetchall()
    ]
    assert migrated_index_columns == idempotency_index_columns
    store.close()


def test_visible_agent_jobs_filter_before_limit_and_return_no_payloads(tmp_path):
    store = ControlPlaneStore(tmp_path / "sidecar.sqlite3")
    store.initialize()
    store.ensure_agent_identity(
        "agent-visible",
        parent_human_identity_id="human-a",
        environment_id="runtime-a",
        label="Visible agent",
        kind="cli",
        scope=["debug.echo"],
    )
    store.ensure_agent_identity(
        "agent-foreign-runtime",
        parent_human_identity_id="human-a",
        environment_id="runtime-b",
        label="Foreign runtime",
        scope=["debug.echo"],
    )
    store.ensure_agent_identity(
        "agent-foreign-human",
        parent_human_identity_id="human-b",
        environment_id="runtime-a",
        label="Foreign human",
        scope=["debug.echo"],
    )

    visible = [
        store.insert_agent_action(
            agent_identity_id="agent-visible",
            tool_name=f"long.{index}",
            parameters={"secret": f"value-{index}"},
            job_pool="cpu_slow",
            job_cancelable=True,
            job_duration="long-running",
        )
        for index in range(2)
    ]
    store.complete_agent_action(visible[1], result={"secret_result": "must-not-leak"})
    store.insert_agent_action(
        agent_identity_id="agent-visible",
        tool_name="immediate.hidden",
        parameters={"secret": "immediate"},
        job_pool="cpu_fast",
        job_duration="immediate",
    )
    store.insert_agent_action(
        agent_identity_id="agent-foreign-runtime",
        tool_name="long.foreign-runtime",
        parameters={"secret": "foreign-runtime"},
        job_pool="cpu_slow",
        job_duration="long-running",
    )
    store.insert_agent_action(
        agent_identity_id="agent-foreign-human",
        tool_name="long.foreign-human",
        parameters={"secret": "foreign-human"},
        job_pool="cpu_slow",
        job_duration="long-running",
    )
    linked = store.insert_agent_action(
        agent_identity_id="agent-visible",
        tool_name="operations.annotation.start",
        parameters={"secret": "managed-wrapper"},
        job_pool="cpu_fast",
        job_duration="long-running",
    )
    operation_id = store.insert_managed_operation(
        runtime_scope="runtime-a",
        scope_id="workspace-a",
        kind="annotation",
        subject_id="sequence-a",
        input_revision="sha256:input",
        submission_key="submission-a",
        submission_payload_hash="sha256:payload",
        actor_kind="agent",
        actor_id="agent-visible",
        channel="agent",
        owner_instance_id="owner-a",
        now=1.0,
    )
    assert store.link_agent_action_to_managed_operation(linked, operation_id)

    first, total, active_count, terminal_count, next_offset = (
        store.page_visible_agent_jobs(
            parent_human_identity_id="human-a",
            environment_id="runtime-a",
            limit=1,
            offset=0,
        )
    )
    second, repeated_total, repeated_active, repeated_terminal, final_offset = (
        store.page_visible_agent_jobs(
            parent_human_identity_id="human-a",
            environment_id="runtime-a",
            limit=1,
            offset=next_offset or 0,
        )
    )

    assert total == repeated_total == 2
    assert active_count == repeated_active == 1
    assert terminal_count == repeated_terminal == 1
    assert next_offset == 1
    assert final_offset is None
    assert first[0]["id"] == visible[0]
    assert {first[0]["id"], second[0]["id"]} == set(visible)
    assert first[0]["agent_label"] == "Visible agent"
    assert first[0]["agent_kind"] == "cli"
    assert "parameters_json" not in first[0]
    assert "result_json" not in first[0]
    store.close()


def test_control_plane_creates_phase1_tables(tmp_path):
    store = ControlPlaneStore(tmp_path / "sidecar.sqlite3")
    store.initialize()
    store.ensure_agent_identity("agent-1", scope=["debug.echo"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="echo",
        parameters={"message": "hi"},
    )
    audit_id = store.insert_audit_record(
        action_id=action_id,
        actor_kind="agent",
        actor_identity="agent-1",
        actor_scope=["debug.echo"],
        side_effects=[],
        capability_check={"required": ["debug.echo"], "satisfied": True},
    )
    store.complete_agent_action(action_id, result={"ok": True})
    artifact_id = store.insert_agent_artifact(
        agent_identity_id="agent-1",
        action_id=action_id,
        kind="file",
        name="result.tsv",
        path="/tmp/result.tsv",
        mime_type="text/tab-separated-values",
        metadata={"rows": 3},
        provenance={"command": "make result"},
        tags=["analysis"],
    )
    analysis_run_id = store.insert_agent_analysis_run(
        agent_identity_id="agent-1",
        action_id=action_id,
        name="analysis",
        status="completed",
        command={"line": "make result"},
        outputs=[{"kind": "artifact", "artifactId": artifact_id}],
        metrics={"files": 1},
    )
    resource_link_id = store.insert_agent_resource_link(
        agent_identity_id="agent-1",
        action_id=action_id,
        source_uri=f"waypoint://analysis-run/{analysis_run_id}",
        target_uri="waypoint://workflow/ncbi-derivative-design",
        relationship="implements_workflow",
        metadata={"confidence": "high"},
    )

    action = store.get_agent_action(action_id)
    audits = store.get_audit_records_for_action(action_id)
    artifact = store.get_agent_artifact(artifact_id)
    artifacts = store.list_agent_artifacts()
    analysis_run = store.get_agent_analysis_run(analysis_run_id)
    analysis_runs = store.list_agent_analysis_runs()
    resource_link = store.get_agent_resource_link(resource_link_id)
    resource_links = store.list_agent_resource_links()

    assert action is not None
    assert action["id"] == action_id
    assert action["root_action_id"] == action_id
    assert action["authorized_scope_json"] == ["debug.echo"]
    assert action["result_json"] == {"ok": True}
    assert audits[0]["id"] == audit_id
    assert audits[0]["plugin_identity_id"] is None
    assert artifact is not None
    assert artifact["id"] == artifact_id
    assert artifact["metadata_json"] == {"rows": 3}
    assert artifact["provenance_json"] == {"command": "make result"}
    assert artifact["tags_json"] == ["analysis"]
    assert artifacts[0]["id"] == artifact_id
    assert analysis_run is not None
    assert analysis_run["id"] == analysis_run_id
    assert analysis_run["command_json"] == {"line": "make result"}
    assert analysis_run["outputs_json"] == [
        {"kind": "artifact", "artifactId": artifact_id}
    ]
    assert analysis_runs[0]["id"] == analysis_run_id
    assert resource_link is not None
    assert resource_link["id"] == resource_link_id
    assert resource_link["relationship"] == "implements_workflow"
    assert resource_link["metadata_json"] == {"confidence": "high"}
    assert resource_links[0]["id"] == resource_link_id
    store.close()


def test_interrupted_action_reconciliation_does_not_overwrite_terminal_result(
    tmp_path,
):
    store = ControlPlaneStore(tmp_path / "sidecar.sqlite3")
    store.initialize()
    store.ensure_agent_identity("agent-1", scope=["debug.echo"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="immediate.echo",
        parameters={"value": 1},
    )
    store.complete_agent_action(
        action_id,
        result={"value": 1},
        terminal_expires_at=9_000_000_000.0,
    )

    reconciled = store.reconcile_interrupted_agent_action(
        action_id,
        error={"code": "OUTCOME_UNRESOLVED"},
        terminal_expires_at=10_000_000_000.0,
    )

    assert reconciled is not None
    assert reconciled["result_json"] == {"value": 1}
    assert reconciled["error_json"] is None
    assert reconciled["terminal_expires_at"] == 9_000_000_000.0
    store.close()


def test_recursive_parent_chain_query(tmp_path):
    store = ControlPlaneStore(tmp_path / "sidecar.sqlite3")
    store.initialize()
    store.ensure_agent_identity("agent-1", scope=["debug.echo"])
    root = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="root",
        parameters={},
    )
    child = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="child",
        parameters={},
        parent_action_id=root,
        root_action_id=root,
    )

    chain = store.trace_action_chain(child)

    assert [row["id"] for row in chain] == [child, root]
    store.close()


def test_identity_scoped_resource_queries_filter_before_limit(tmp_path):
    store = ControlPlaneStore(tmp_path / "sidecar.sqlite3")
    store.initialize()
    for identity_id in ("owner", "foreign"):
        store.ensure_agent_identity(identity_id, scope=["read-workspace"])

    owner_action = store.insert_agent_action(
        agent_identity_id="owner",
        tool_name="owner.seed",
        parameters={},
    )
    foreign_action = store.insert_agent_action(
        agent_identity_id="foreign",
        tool_name="foreign.seed",
        parameters={},
    )
    owner_artifact = store.insert_agent_artifact(
        agent_identity_id="owner",
        action_id=owner_action,
        kind="file",
        name="owner.txt",
    )
    owner_run = store.insert_agent_analysis_run(
        agent_identity_id="owner",
        action_id=owner_action,
        name="owner run",
        status="completed",
        command={},
    )
    owner_link = store.insert_agent_resource_link(
        agent_identity_id="owner",
        action_id=owner_action,
        source_uri=f"waypoint://analysis-run/{owner_run}",
        target_uri=f"waypoint://artifact/{owner_artifact}",
        relationship="produced",
    )
    store.insert_agent_artifact(
        agent_identity_id="foreign",
        action_id=foreign_action,
        kind="file",
        name="foreign.txt",
    )
    foreign_run = store.insert_agent_analysis_run(
        agent_identity_id="foreign",
        action_id=foreign_action,
        name="foreign run",
        status="completed",
        command={},
    )
    store.insert_agent_resource_link(
        agent_identity_id="foreign",
        action_id=foreign_action,
        source_uri=f"waypoint://analysis-run/{foreign_run}",
        target_uri="waypoint://artifact/foreign",
        relationship="produced",
    )

    assert [
        row["id"]
        for row in store.list_agent_artifacts(limit=1, agent_identity_id="owner")
    ] == [owner_artifact]
    assert [
        row["id"]
        for row in store.list_agent_analysis_runs(limit=1, agent_identity_id="owner")
    ] == [owner_run]
    assert [
        row["id"]
        for row in store.list_agent_resource_links(limit=1, agent_identity_id="owner")
    ] == [owner_link]
    store.close()


def test_rollback_drops_phase1_tables(tmp_path):
    store = ControlPlaneStore(tmp_path / "sidecar.sqlite3")
    store.initialize()
    store.rollback()

    try:
        store.get_agent_action("missing")
    except Exception as exc:
        assert "no such table" in str(exc)
    else:
        raise AssertionError("agent_action table should be dropped")
    store.close()


def test_uuid7_is_valid_uuid_string():
    value = new_uuid7()
    assert len(value) == 36
    assert value[14] == "7"
