"""One JSON Schema boundary for registered tool inputs and successful outputs."""

from __future__ import annotations

import json
import re
from functools import lru_cache
from itertools import islice
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.validators import validator_for
from referencing import Registry
from referencing.exceptions import NoSuchResource

from .tool_errors import ToolExecutionFailure


def _no_remote_schema(uri: str):

    raise NoSuchResource(ref=uri)


@lru_cache(maxsize=512)
def _validator(encoded: str):
    schema = json.loads(encoded)
    cls = validator_for(schema, default=Draft202012Validator)
    cls.check_schema(schema)
    return cls(schema, registry=Registry(retrieve=_no_remote_schema))


def schema_validator(schema: dict[str, Any]):
    return _validator(json.dumps(schema, sort_keys=True, separators=(",", ":")))


class ToolInputValidationError(ValueError):
    def __init__(self, issues: list[dict[str, str]]):
        super().__init__("Arguments do not match the tool input schema.")
        self.issues = issues


def _validation_issues(errors):
    seen = set()
    for error in errors:
        paths = [list(error.absolute_path)]
        if error.validator == "required" and isinstance(error.instance, dict):
            paths = [
                [*error.absolute_path, name]
                for name in error.validator_value
                if name not in error.instance
            ]
        elif (
            error.validator == "additionalProperties"
            and error.validator_value is False
            and isinstance(error.instance, dict)
        ):
            paths = [
                [*error.absolute_path, name]
                for name in error.instance
                if name not in error.schema.get("properties", {})
                and not any(
                    re.search(pattern, name)
                    for pattern in error.schema.get("patternProperties", {})
                )
            ]
        for parts in paths:
            path = "/" + "/".join(
                str(part).replace("~", "~0").replace("/", "~1") for part in parts
            )
            identity = (path, str(error.validator))
            if identity not in seen:
                seen.add(identity)
                yield {"path": path, "rule": str(error.validator)}


def validate_tool_value(
    value: Any, schema: dict[str, Any], *, output: bool = False
) -> None:
    issues = list(
        islice(_validation_issues(schema_validator(schema).iter_errors(value)), 8)
    )
    if not issues:
        return

    if output:
        raise ToolExecutionFailure(
            code="INVALID_TOOL_OUTPUT",
            message="The tool returned a result that does not match its advertised schema. Recover the original action before retrying.",
            retriable=False,
            details={"issues": issues, "stateMayHaveChanged": True},
        )
    raise ToolInputValidationError(issues)
