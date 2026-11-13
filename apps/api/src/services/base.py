"""Base class for built-in service definitions.

A built-in service owns its wire contract as Pydantic request/result models on
an explicit typed route (see ``routes/annotation.py``). This base only
describes the service for the ``/services/`` discovery listing. Built-in
services derive that description from the same models with
``describe_model_fields`` so the listing cannot drift from the contract.
"""

import re
from typing import Any

from pydantic import BaseModel


def _inline_definitions(
    node: Any, definitions: dict[str, Any], seen: frozenset[str] = frozenset()
) -> Any:
    """Replace ``$ref`` pointers with their definitions and drop schema titles.

    Only a schema object's own ``title`` is dropped; the keys of a
    ``properties`` map are field names and are kept even when a field is
    literally named ``title``. A definition that refers back to itself is
    inlined once; the recursive reference stays a ``$ref`` so a self-referential
    model cannot loop at import time.
    """
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/$defs/"):
            name = ref.removeprefix("#/$defs/")
            if name in seen or name not in definitions:
                return dict(node)
            merged = {
                **definitions[name],
                **{k: v for k, v in node.items() if k != "$ref"},
            }
            return _inline_definitions(merged, definitions, seen | {name})
        inlined: dict[str, Any] = {}
        for key, value in node.items():
            if key == "title":
                continue
            if key == "properties" and isinstance(value, dict):
                inlined[key] = {
                    field: _inline_definitions(schema, definitions, seen)
                    for field, schema in value.items()
                }
            else:
                inlined[key] = _inline_definitions(value, definitions, seen)
        return inlined
    if isinstance(node, list):
        return [_inline_definitions(item, definitions, seen) for item in node]
    return node


def describe_model_fields(model: type[BaseModel]) -> dict[str, dict[str, Any]]:
    """Describe a model's fields in the discovery listing shape.

    Plugin manifests describe inputs and outputs as
    ``{field: {"type": ..., "description": ..., "required": ...}}``. Built-in
    services list the same shape, computed from the model's own JSON Schema so
    each field is defined exactly once. An optional ``X | None`` field is
    listed with the concrete type ``X``.
    """
    schema = model.model_json_schema()
    definitions = schema.get("$defs", {})
    required = set(schema.get("required", []))
    described: dict[str, dict[str, Any]] = {}
    for name, prop in schema.get("properties", {}).items():
        spec = _inline_definitions(prop, definitions)
        alternatives = spec.pop("anyOf", None)
        if alternatives:
            concrete = [alt for alt in alternatives if alt.get("type") != "null"]
            if len(concrete) == 1:
                spec = {**concrete[0], **spec}
            else:
                spec["anyOf"] = alternatives
        spec["required"] = name in required
        described[name] = spec
    return described


class ServiceDefinition:
    """
    Discovery description of a built-in service.

    Subclasses define:
    - INPUT_TYPES: dict mapping input names to type specs
    - RETURN_TYPES: dict mapping output names to type specs

    Built-in services compute both with ``describe_model_fields`` from the
    Pydantic models that their typed route validates.
    """

    INPUT_TYPES: dict[str, dict[str, Any]] = {}
    RETURN_TYPES: dict[str, dict[str, Any]] = {}

    @property
    def name(self) -> str:
        """Service name derived from class name in snake_case."""
        class_name = self.__class__.__name__
        s1 = re.sub(r"(.)([A-Z][a-z]+)", r"\1_\2", class_name)
        return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s1).lower()

    def get_schema(self) -> dict[str, Any]:
        """Return full schema for service discovery."""
        return {
            "name": self.name,
            "description": self.__class__.__doc__ or "",
            "input_types": self.INPUT_TYPES,
            "return_types": self.RETURN_TYPES,
        }
