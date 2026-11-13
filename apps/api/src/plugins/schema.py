"""Plugin manifest schema — defines the contract for external services."""

import re
from typing import Any

from pydantic import BaseModel, field_validator


class PluginManifest(BaseModel):
    """Schema for plugin manifest.json files.

    External plugins implement three HTTP endpoints:
    - GET /health — returns 200 when ready
    - GET /manifest — returns this schema as JSON
    - POST /execute — takes JSON input, returns JSON output
    """

    name: str
    description: str
    version: str
    input_types: dict[str, dict[str, Any]]
    return_types: dict[str, dict[str, Any]]
    port: int | None = None

    @field_validator("name")
    @classmethod
    def name_must_be_identifier(cls, v: str) -> str:
        if not re.match(r"^[a-z][a-z0-9_]*$", v):
            raise ValueError("Plugin name must be a snake_case identifier")
        return v
