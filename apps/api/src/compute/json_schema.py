"""Small, non-executable JSON-Schema subset shared by manifest drivers."""

from __future__ import annotations

import re
from typing import Any, Mapping

_SAFE_SIMPLE_PATTERN = re.compile(
    r"^\^\[[^\]\r\n]{1,80}\](?:[+*?]|\{\d{1,4}(?:,\d{0,4})?\})?\$$"
)


def _is_type(value: Any, expected: str) -> bool:
    if expected == "object":
        return isinstance(value, Mapping)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "null":
        return value is None
    return True


def schema_problems(
    value: Any, schema: Mapping[str, Any], *, path: str = "settings"
) -> list[str]:
    """Validate the safe JSON-Schema subset accepted in compute manifests."""
    problems: list[str] = []
    expected = schema.get("type")
    if isinstance(expected, str) and not _is_type(value, expected):
        return [f"{path}: must be {expected}"]
    enum = schema.get("enum")
    if isinstance(enum, list) and value not in enum:
        problems.append(f"{path}: must be one of {', '.join(map(str, enum))}")
    if isinstance(value, str):
        minimum = schema.get("minLength")
        if isinstance(minimum, int) and len(value) < minimum:
            problems.append(f"{path}: must contain at least {minimum} characters")
        maximum = schema.get("maxLength")
        if isinstance(maximum, int) and len(value) > maximum:
            problems.append(f"{path}: must contain at most {maximum} characters")
        pattern = schema.get("pattern")
        if isinstance(pattern, str):
            matches = (
                _SAFE_SIMPLE_PATTERN.fullmatch(pattern) is not None
                and re.fullmatch(pattern, value) is not None
            )
            if not matches:
                message = schema.get("patternMessage")
                problems.append(
                    f"{path}: {message if isinstance(message, str) else 'does not match the required format'}"
                )
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        minimum = schema.get("minimum")
        if isinstance(minimum, (int, float)) and value < minimum:
            problems.append(f"{path}: must be at least {minimum}")
        maximum = schema.get("maximum")
        if isinstance(maximum, (int, float)) and value > maximum:
            problems.append(f"{path}: must be at most {maximum}")
    if isinstance(value, list):
        minimum = schema.get("minItems")
        if isinstance(minimum, int) and len(value) < minimum:
            problems.append(f"{path}: requires at least {minimum} items")
        maximum = schema.get("maxItems")
        if isinstance(maximum, int) and len(value) > maximum:
            problems.append(f"{path}: allows at most {maximum} items")
        item_schema = schema.get("items")
        if isinstance(item_schema, Mapping):
            for index, item in enumerate(value):
                problems.extend(
                    schema_problems(item, item_schema, path=f"{path}[{index}]")
                )
    if isinstance(value, Mapping):
        required = schema.get("required")
        if isinstance(required, list):
            for field in required:
                if isinstance(field, str) and (
                    field not in value or value[field] in ("", None, [])
                ):
                    problems.append(f"{path}.{field}: required")
        properties = schema.get("properties")
        if isinstance(properties, Mapping):
            for field, field_schema in properties.items():
                if field in value and isinstance(field_schema, Mapping):
                    problems.extend(
                        schema_problems(
                            value[field], field_schema, path=f"{path}.{field}"
                        )
                    )
            if schema.get("additionalProperties") is False:
                for field in value.keys() - properties.keys():
                    problems.append(f"{path}.{field}: is not an allowed field")
    return problems


__all__ = ["schema_problems"]
