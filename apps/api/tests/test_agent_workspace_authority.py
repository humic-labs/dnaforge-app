import json
import sqlite3

from src.agent_workspace_authority import artifact_workspace_roots
from src.control_plane import ControlPlaneStore


def test_existing_grants_migrate_without_trusting_mutable_workspace_files(tmp_path):
    database = tmp_path / "control.sqlite3"
    workspace_file = tmp_path / "legacy.waypoint-workspace"
    workspace_file.write_text(json.dumps({"folders": [{"path": str(tmp_path)}]}))
    store = ControlPlaneStore(database)
    store.initialize()
    for identity, binding in (
        ("folder", "folder:" + json.dumps(str(tmp_path))),
        ("file", "file:" + str(workspace_file)),
    ):
        store.create_agent_identity(
            identity_id=identity, kind="stdio-mcp", origin="local-mcp"
        )
        assert store.bind_local_mcp_workspace(
            identity, workspace_id=binding, workspace_label=identity
        )
    store.close()
    with sqlite3.connect(database) as legacy:
        legacy.execute(
            "ALTER TABLE agent_identity DROP COLUMN bound_workspace_roots_json"
        )
    store = ControlPlaneStore(database)
    store.initialize()
    try:
        assert artifact_workspace_roots(store.get_agent_identity("folder")) == [
            tmp_path.resolve()
        ]
        assert artifact_workspace_roots(store.get_agent_identity("file")) == []
        assert store.bind_local_mcp_workspace(
            "file", workspace_id="file:" + str(workspace_file), workspace_label="file"
        )
        assert artifact_workspace_roots(store.get_agent_identity("file")) == [
            tmp_path.resolve()
        ]
    finally:
        store.close()
