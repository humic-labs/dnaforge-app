"""Security boundaries for the sidecar process."""

from .local_access import (
    ALLOWED_CORS_HEADERS,
    ALLOWED_CORS_METHODS,
    ALLOWED_CORS_ORIGIN_REGEX,
    ALLOWED_ORIGINS_ENV,
    DELEGATED_AGENT_AUTH_ROUTES,
    EXPOSED_CORS_HEADERS,
    PUBLIC_PATHS,
    PUBLIC_STARTUP_ROUTES,
    LocalAccessMiddleware,
    configured_allowed_origins,
    is_delegated_agent_request,
    is_public,
)

__all__ = [
    "ALLOWED_CORS_HEADERS",
    "ALLOWED_CORS_METHODS",
    "ALLOWED_CORS_ORIGIN_REGEX",
    "ALLOWED_ORIGINS_ENV",
    "DELEGATED_AGENT_AUTH_ROUTES",
    "EXPOSED_CORS_HEADERS",
    "PUBLIC_PATHS",
    "PUBLIC_STARTUP_ROUTES",
    "LocalAccessMiddleware",
    "configured_allowed_origins",
    "is_delegated_agent_request",
    "is_public",
]
