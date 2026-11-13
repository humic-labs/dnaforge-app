from src.routes.agent_grants import DEFAULT_LOCAL_MCP_SCOPES


def test_default_local_authoring_grant_can_refine_and_finish_its_assembly():
    assert {
        "create-entity",
        "edit-assembly",
        "read-workspace",
        "read-sequences",
        "write-workspace",
        "finalize-assembly",
    } <= DEFAULT_LOCAL_MCP_SCOPES
