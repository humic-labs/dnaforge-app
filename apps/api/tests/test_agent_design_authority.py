import pytest

from src.agent_design_authority import DESIGN_EDIT_TOOLS, design_authoring_scope
from src.control_plane import initialize_control_plane

SCOPES = ["read-workspace", "read-sequences", "create-entity", "modify-tabs"]


@pytest.fixture
def store(tmp_path):
    current = initialize_control_plane(tmp_path / "control.sqlite3")
    current.ensure_agent_identity("creator", scope=SCOPES)
    current.ensure_agent_identity("other", scope=SCOPES)
    return current


def created(store, *, success=True):
    action = store.insert_agent_action(
        agent_identity_id="creator",
        tool_name="create_design",
        parameters={},
        authorized_scope=SCOPES,
    )
    store.complete_agent_action(
        action, result={"ok": success, "result": {"designId": "design-rad51"}}
    )
    return action


@pytest.mark.parametrize("tool", sorted(DESIGN_EDIT_TOOLS))
def test_only_creator_with_a_current_create_grant_can_refine(store, tool):
    created(store)
    args = {"designId": "design-rad51"}
    assert design_authoring_scope(tool, args, "creator", SCOPES) == [
        *SCOPES,
        "edit-assembly",
    ]
    assert design_authoring_scope(tool, args, "other", SCOPES) == SCOPES
    assert design_authoring_scope(tool, args, "creator", ["read-workspace"]) == [
        "read-workspace"
    ]
    assert (
        design_authoring_scope(tool, {"designId": "another"}, "creator", SCOPES)
        == SCOPES
    )


def test_failed_creation_cannot_establish_ownership(store):
    created(store, success=False)
    assert store.agent_design_owner("design-rad51") is None


def test_existing_completed_creation_is_adopted_and_survives_action_retention(store):
    action = created(store)
    store._conn.execute("DELETE FROM agent_design_authority")
    store._conn.commit()
    assert store.agent_design_owner("design-rad51") == "creator"
    assert (
        store._conn.execute(
            "SELECT create_action_id FROM agent_design_authority WHERE design_id = 'design-rad51'"
        ).fetchone()[0]
        == action
    )
    store._conn.execute(
        "UPDATE agent_action SET result_json = NULL WHERE id = ?", (action,)
    )
    store._conn.commit()
    assert store.agent_design_owner("design-rad51") == "creator"


@pytest.mark.parametrize("new_construct", [False, True])
def test_finalization_requires_the_authors_exact_new_product_preview(
    store, new_construct
):
    created(store)
    args = {
        "designId": "design-rad51",
        "expectedDesignVersion": 3,
        "previewFingerprint": "sha256:preview",
    }
    assert (
        design_authoring_scope("finalize_design_assembly", args, "creator", SCOPES)
        == SCOPES
    )
    action = store.insert_agent_action(
        agent_identity_id="creator",
        tool_name="preview_finalize_design_assembly",
        parameters=args,
        authorized_scope=SCOPES,
    )
    store.complete_agent_action(
        action,
        result={
            "ok": True,
            "result": {
                **args,
                "canFinalize": True,
                "createsNewConstruct": new_construct,
            },
        },
    )
    expected = (
        [*SCOPES, "write-workspace", "finalize-assembly"] if new_construct else SCOPES
    )
    assert (
        design_authoring_scope("finalize_design_assembly", args, "creator", SCOPES)
        == expected
    )
    assert (
        design_authoring_scope(
            "finalize_design_assembly",
            {**args, "expectedDesignVersion": 4},
            "creator",
            SCOPES,
        )
        == SCOPES
    )
    assert (
        design_authoring_scope("finalize_design_assembly", args, "other", SCOPES)
        == SCOPES
    )
    assert SCOPES == [
        "read-workspace",
        "read-sequences",
        "create-entity",
        "modify-tabs",
    ]
