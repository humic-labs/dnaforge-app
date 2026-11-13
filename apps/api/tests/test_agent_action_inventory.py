import json

from src.agent_action_inventory import build_builtin_action_inventory, inventory_path
from src.concurrency.tool_registry import agent_tool_registry


def test_generated_inventory_is_the_actual_builtin_catalog(monkeypatch):
    monkeypatch.setattr(agent_tool_registry, "_tools", {})
    inventory = build_builtin_action_inventory()
    assert json.loads(inventory_path().read_text()) == inventory
    names = [tool["name"] for tool in inventory["tools"]]
    assert len(names) == len(set(names))
    for name in (
        "file_document",
        "search_workspace",
        "project_history",
        "import_review",
        "administration",
    ):
        assert (
            next(tool for tool in inventory["tools"] if tool["name"] == name)["home"]
            == "native"
        )
