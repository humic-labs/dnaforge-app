"""Service registry for discovery and execution.

STABILITY: This module's public API is frozen by contract tests in
tests/test_registry_contract.py (assertions A-1 through A-6).
Any change to get(), register(), list_services(), or list_schemas()
must pass those tests. See PLAN.md for the architecture hardening context.
"""

from typing import Type

from .base import ServiceDefinition


class ServiceRegistry:
    """Registry for service discovery and instantiation."""

    def __init__(self):
        self._services: dict[str, ServiceDefinition] = {}

    def register(self, service_class: Type[ServiceDefinition]) -> None:
        """Register a service class."""
        instance = service_class()
        self._services[instance.name] = instance

    def get(self, name: str) -> ServiceDefinition | None:
        """Get a service instance by name."""
        return self._services.get(name)

    def list_services(self) -> list[str]:
        """List all registered service names."""
        return list(self._services.keys())

    def list_schemas(self) -> list[dict]:
        """List schemas for all registered services."""
        return [service.get_schema() for service in self._services.values()]


registry = ServiceRegistry()
