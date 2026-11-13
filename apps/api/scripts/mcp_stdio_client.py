"""Compatibility wrapper for shared MCP stdio helpers."""

from src.agent_workflow_harness.stdio_client import (
    MCPClientFailure,
    MCPStdioClient,
    read_stdio_message,
    start_mcp_companion,
    write_stdio_message,
)

__all__ = [
    "MCPClientFailure",
    "MCPStdioClient",
    "read_stdio_message",
    "start_mcp_companion",
    "write_stdio_message",
]
