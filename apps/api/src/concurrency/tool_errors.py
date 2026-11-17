"""Typed failures raised by tool handlers."""

from __future__ import annotations

from typing import Any

from ..action_completion import ActionCompletionOwner


class ToolExecutionFailure(RuntimeError):
    """A tool ran and returned a structured failure."""

    def __init__(
        self,
        *,
        code: str,
        message: str,
        retriable: bool,
        details: dict[str, Any] | None = None,
        completion_owner: ActionCompletionOwner = "job",
    ):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retriable = retriable
        self.details = details
        self.completion_owner = completion_owner

    def to_error(self) -> dict[str, Any]:
        error: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "retriable": self.retriable,
        }
        if self.details:
            error["details"] = self.details
        return error
