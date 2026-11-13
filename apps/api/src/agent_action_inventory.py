import hashlib
import json
from pathlib import Path
from typing import Any

from .agent_manifest_paths import agent_tool_manifest_path
from .concurrency.builtins import register_builtin_agent_tools
from .concurrency.tool_registry import agent_tool_registry


def build_builtin_action_inventory() -> dict[str, Any]:
    manifest_path = agent_tool_manifest_path("renderer-tool-manifest.json")
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    shared = {tool["name"] for tool in manifest["tools"]}
    aliases = {
        alias: canonical
        for canonical, alias in manifest.get("providerToolNames", {}).items()
    }
    register_builtin_agent_tools()
    tools = []
    for registered in sorted(
        agent_tool_registry.list(), key=lambda item: item.spec.name
    ):
        spec = registered.spec
        if spec.name in aliases:
            continue
        row = {
            "name": spec.name,
            "handlerRef": spec.handler_ref,
            "home": spec.home,
            "runtime": spec.runtime,
            "handlerRegistered": registered.handler is not None,
            "effects": [str(effect) for effect in spec.category.effects],
            "requiredCapabilities": spec.required_capabilities,
            "conditionalCapabilities": spec.conditional_required_capabilities,
            "requiresWorkspace": spec.requires_workspace,
            "conditionallyRequiresWorkspace": spec.conditionally_requires_workspace,
            "replayPolicy": registered.replay_policy.value,
        }
        if spec.name in shared:
            row["contractRef"] = (
                f"packages/core/agent-tools/renderer-tool-manifest.json#tools/{spec.name}"
            )
        else:
            row.update({"description": spec.description, "inputSchema": spec.inputs})
        tools.append(row)
    return {
        "schemaVersion": 1,
        "scope": "Built-in registered actions and canonical aliases. Runtime-installed provider manifests are discovered through their existing provider registry.",
        "source": "apps/api/src/concurrency/builtins.py#register_builtin_agent_tools",
        "sharedCatalogSha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "tools": tools,
    }


def inventory_path() -> Path:
    return (
        Path(__file__).resolve().parents[3]
        / ".ci"
        / "builtin-agent-actions.generated.json"
    )
