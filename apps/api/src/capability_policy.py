"""Shared capability implication rules for agent authorization."""

from __future__ import annotations

import json
from types import MappingProxyType

from .agent_manifest_paths import agent_tool_manifest_path

MANAGED_OPERATION_CAPABILITIES = frozenset(
    {
        "operations.read",
        "operations.start",
        "operations.import",
        "operations.cancel",
        "operations.release",
    }
)


def _load_capability_policy() -> tuple[str, MappingProxyType]:
    path = agent_tool_manifest_path("capability-policy.json")
    policy = json.loads(path.read_text(encoding="utf-8"))
    if (
        not isinstance(policy, dict)
        or set(policy) != {"schemaVersion", "wildcardCapability", "implications"}
        or type(policy["schemaVersion"]) is not int
        or policy["schemaVersion"] != 1
        or policy["wildcardCapability"] != "*"
        or not isinstance(policy["implications"], dict)
    ):
        raise RuntimeError(f"Invalid shared capability policy: {path}")
    implications = {}
    for capability, implied in policy["implications"].items():
        names = [capability, *(implied if isinstance(implied, list) else [])]
        if not isinstance(implied, list) or any(
            not isinstance(name, str) or not name or name != name.strip() or name == "*"
            for name in names
        ):
            raise RuntimeError(f"Invalid shared capability implications: {path}")
        implications[capability] = frozenset(implied)
    return policy["wildcardCapability"], MappingProxyType(implications)


WILDCARD_CAPABILITY, CAPABILITY_IMPLICATIONS = _load_capability_policy()


def expand_capabilities(provided: list[str]) -> set[str]:
    """Return explicitly granted capabilities plus their narrow implications."""

    expanded = set(provided)
    pending = list(provided)
    while pending:
        capability = pending.pop()
        for implied in CAPABILITY_IMPLICATIONS.get(capability, ()):
            if implied in expanded:
                continue
            expanded.add(implied)
            pending.append(implied)
    return expanded


def has_required_capabilities(provided: list[str], required: list[str]) -> bool:
    """Return whether a caller scope satisfies unconditional requirements."""

    return WILDCARD_CAPABILITY in provided or set(required).issubset(
        expand_capabilities(provided)
    )
