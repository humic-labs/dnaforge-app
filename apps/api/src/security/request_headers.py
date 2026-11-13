"""Raw ASGI credential-header parsing shared by public and protected routes."""

from __future__ import annotations

from starlette.types import Scope


def read_ascii_header_values(scope: Scope, name: bytes) -> tuple[list[str], bool]:
    """Return every ASCII value for ``name`` and flag malformed raw bytes."""

    values: list[str] = []
    for header_name, raw_value in scope.get("headers", []):
        if header_name.lower() != name:
            continue
        try:
            values.append(raw_value.decode("ascii"))
        except UnicodeDecodeError:
            return [], True
    return values, False
