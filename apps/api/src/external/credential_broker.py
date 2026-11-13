"""Process-local credential broker for private genomic sources.

Durable track requests carry only an opaque ``authRef``. Electron main keeps
the corresponding long-lived material in the operating-system keyring and
registers it here for the current sidecar generation. This module never
serializes, logs, or returns secret values. Callers receive request headers for
one validated upstream request; range and htsget source grants remain the
short-lived read capabilities exposed outside this boundary.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Callable, Literal, Mapping
from urllib.parse import parse_qsl, quote, urlsplit

CredentialKind = Literal[
    "http-bearer",
    "http-basic",
    "http-header",
    "aws-sigv4",
    "gcs-oauth",
]
CredentialAudience = Literal["http", "htsget", "s3", "gcs"]

_AUTH_REF = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$")
_HEADER_NAME = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
_AWS_ACCESS_KEY = re.compile(r"^[A-Za-z0-9/+=._-]{8,128}$")
_AWS_REGION = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
_FORBIDDEN_CUSTOM_HEADERS = frozenset(
    {
        "connection",
        "content-length",
        "cookie",
        "host",
        "proxy-authorization",
        "range",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "x-dnaforge-session",
        "x-dnaforge-operation-authority",
    }
)


_INVALID = "credential_invalid"
_MISMATCH = "credential_mismatch"
_MISSING = "missing_credential"


class CredentialBrokerError(Exception):
    """A credential reference is missing, malformed, or used for the wrong source."""

    def __init__(self, message: str, *, failure_kind: str) -> None:
        super().__init__(message)
        self.failure_kind = failure_kind


@dataclass(frozen=True)
class CredentialDescriptor:
    auth_ref: str
    kind: CredentialKind


@dataclass(frozen=True, repr=False)
class _HttpBearer:
    token: str = field(repr=False)


@dataclass(frozen=True, repr=False)
class _HttpBasic:
    username: str = field(repr=False)
    password: str = field(repr=False)


@dataclass(frozen=True, repr=False)
class _HttpHeader:
    name: str
    value: str = field(repr=False)


@dataclass(frozen=True, repr=False)
class _AwsSigV4:
    access_key_id: str = field(repr=False)
    secret_access_key: str = field(repr=False)
    session_token: str | None = field(default=None, repr=False)


@dataclass(frozen=True, repr=False)
class _GcsOAuth:
    access_token: str = field(repr=False)


_Credential = _HttpBearer | _HttpBasic | _HttpHeader | _AwsSigV4 | _GcsOAuth


class CredentialBroker:
    """In-memory map from opaque references to validated credential material."""

    def __init__(self, *, now: Callable[[], datetime] | None = None) -> None:
        self._entries: dict[str, tuple[CredentialKind, _Credential]] = {}
        self._now = now or (lambda: datetime.now(UTC))

    def register(
        self,
        *,
        auth_ref: str,
        kind: CredentialKind,
        material: Mapping[str, object],
    ) -> CredentialDescriptor:
        reference = _validate_auth_ref(auth_ref)
        credential = _parse_credential(kind, material)
        self._entries[reference] = (kind, credential)
        return CredentialDescriptor(auth_ref=reference, kind=kind)

    def remove(self, auth_ref: str) -> bool:
        reference = _validate_auth_ref(auth_ref)
        return self._entries.pop(reference, None) is not None

    def clear(self) -> None:
        self._entries.clear()

    def describe(self, auth_ref: str) -> CredentialDescriptor:
        reference = _validate_auth_ref(auth_ref)
        entry = self._entries.get(reference)
        if entry is None:
            raise CredentialBrokerError(
                "The genomic source credential is not connected.",
                failure_kind=_MISSING,
            )
        return CredentialDescriptor(auth_ref=reference, kind=entry[0])

    def authorize(
        self,
        *,
        auth_ref: str,
        audience: CredentialAudience,
        url: str,
        headers: Mapping[str, str] | None = None,
        aws_region: str | None = None,
    ) -> dict[str, str]:
        descriptor = self.describe(auth_ref)
        credential = self._entries[descriptor.auth_ref][1]
        authorized = dict(headers or {})

        if audience in {"http", "htsget"}:
            if isinstance(credential, _HttpBearer):
                authorized["Authorization"] = f"Bearer {credential.token}"
                return authorized
            if isinstance(credential, _HttpBasic):
                payload = f"{credential.username}:{credential.password}".encode("utf-8")
                authorized["Authorization"] = "Basic " + base64.b64encode(
                    payload
                ).decode("ascii")
                return authorized
            if isinstance(credential, _HttpHeader):
                authorized[credential.name] = credential.value
                return authorized
            raise _audience_mismatch(audience)

        if audience == "gcs":
            if not isinstance(credential, _GcsOAuth):
                raise _audience_mismatch(audience)
            authorized["Authorization"] = f"Bearer {credential.access_token}"
            return authorized

        if audience == "s3":
            if not isinstance(credential, _AwsSigV4):
                raise _audience_mismatch(audience)
            region = (aws_region or "us-east-1").strip().lower()
            if not _AWS_REGION.fullmatch(region):
                raise CredentialBrokerError(
                    "The S3 region is invalid.", failure_kind=_INVALID
                )
            return _aws_sigv4_headers(
                credential=credential,
                url=url,
                region=region,
                headers=authorized,
                now=self._now(),
            )

        raise CredentialBrokerError(
            "The genomic source credential audience is unsupported.",
            failure_kind=_MISMATCH,
        )


def _validate_auth_ref(value: object) -> str:
    if not isinstance(value, str) or not _AUTH_REF.fullmatch(value.strip()):
        raise CredentialBrokerError(
            "The genomic source credential reference is invalid.",
            failure_kind=_INVALID,
        )
    return value.strip()


def _parse_credential(kind: object, material: Mapping[str, object]) -> _Credential:
    if kind == "http-bearer":
        _require_exact_fields(material, {"token"})
        return _HttpBearer(token=_secret_text(material.get("token"), "bearer token"))
    if kind == "http-basic":
        _require_exact_fields(material, {"username", "password"})
        return _HttpBasic(
            username=_secret_text(
                material.get("username"), "HTTP username", maximum=512
            ),
            password=_secret_text(material.get("password"), "HTTP password"),
        )
    if kind == "http-header":
        _require_exact_fields(material, {"name", "value"})
        name = _secret_text(material.get("name"), "HTTP header name", maximum=128)
        if (
            not _HEADER_NAME.fullmatch(name)
            or name.casefold() in _FORBIDDEN_CUSTOM_HEADERS
        ):
            raise CredentialBrokerError(
                "The custom HTTP credential header is not allowed.",
                failure_kind=_INVALID,
            )
        return _HttpHeader(
            name=name,
            value=_secret_text(material.get("value"), "HTTP header value"),
        )
    if kind == "aws-sigv4":
        allowed = {"access_key_id", "secret_access_key", "session_token"}
        _require_exact_fields(material, allowed, optional={"session_token"})
        access_key_id = _secret_text(
            material.get("access_key_id"), "AWS access key ID", maximum=128
        )
        if not _AWS_ACCESS_KEY.fullmatch(access_key_id):
            raise CredentialBrokerError(
                "The AWS access key ID is invalid.",
                failure_kind=_INVALID,
            )
        raw_session = material.get("session_token")
        return _AwsSigV4(
            access_key_id=access_key_id,
            secret_access_key=_secret_text(
                material.get("secret_access_key"), "AWS secret access key"
            ),
            session_token=(
                _secret_text(raw_session, "AWS session token")
                if raw_session is not None
                else None
            ),
        )
    if kind == "gcs-oauth":
        _require_exact_fields(material, {"access_token"})
        return _GcsOAuth(
            access_token=_secret_text(material.get("access_token"), "GCS access token")
        )
    raise CredentialBrokerError(
        "The genomic source credential kind is unsupported.",
        failure_kind=_INVALID,
    )


def _require_exact_fields(
    material: Mapping[str, object],
    allowed: set[str],
    *,
    optional: set[str] | None = None,
) -> None:
    actual = set(material)
    required = allowed - (optional or set())
    if not required.issubset(actual) or not actual.issubset(allowed):
        raise CredentialBrokerError(
            "The genomic source credential fields are invalid.",
            failure_kind=_INVALID,
        )


def _secret_text(value: object, label: str, *, maximum: int = 16_384) -> str:
    if not isinstance(value, str):
        raise CredentialBrokerError(f"The {label} is invalid.", failure_kind=_INVALID)
    normalized = value.strip()
    if (
        not normalized
        or len(normalized) > maximum
        or "\r" in normalized
        or "\n" in normalized
    ):
        raise CredentialBrokerError(f"The {label} is invalid.", failure_kind=_INVALID)
    return normalized


def _audience_mismatch(audience: str) -> CredentialBrokerError:
    return CredentialBrokerError(
        f"The connected credential cannot authorize this {audience.upper()} source.",
        failure_kind=_MISMATCH,
    )


def _aws_sigv4_headers(
    *,
    credential: _AwsSigV4,
    url: str,
    region: str,
    headers: Mapping[str, str],
    now: datetime,
) -> dict[str, str]:
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise CredentialBrokerError(
            "Authenticated S3 sources must use HTTPS.",
            failure_kind=_INVALID,
        )
    timestamp = now.astimezone(UTC)
    amz_date = timestamp.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = timestamp.strftime("%Y%m%d")
    host = parsed.hostname.casefold()
    if parsed.port and parsed.port != 443:
        host = f"{host}:{parsed.port}"

    authorized = dict(headers)
    authorized["Host"] = host
    authorized["x-amz-content-sha256"] = "UNSIGNED-PAYLOAD"
    authorized["x-amz-date"] = amz_date
    if credential.session_token:
        authorized["x-amz-security-token"] = credential.session_token

    signed = {
        name: value
        for name, value in authorized.items()
        if name.casefold() == "host"
        or name.casefold() == "range"
        or name.casefold().startswith("x-amz-")
    }
    normalized = {
        name.casefold(): " ".join(value.strip().split())
        for name, value in signed.items()
    }
    signed_names = ";".join(sorted(normalized))
    canonical_headers = "".join(
        f"{name}:{normalized[name]}\n" for name in sorted(normalized)
    )
    canonical_uri = quote(parsed.path or "/", safe="/%-_.~")
    canonical_query = "&".join(
        f"{quote(key, safe='-_.~')}={quote(value, safe='-_.~')}"
        for key, value in sorted(parse_qsl(parsed.query, keep_blank_values=True))
    )
    canonical_request = "\n".join(
        [
            "GET",
            canonical_uri,
            canonical_query,
            canonical_headers,
            signed_names,
            "UNSIGNED-PAYLOAD",
        ]
    )
    scope = f"{date_stamp}/{region}/s3/aws4_request"
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            amz_date,
            scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )
    date_key = hmac.new(
        ("AWS4" + credential.secret_access_key).encode("utf-8"),
        date_stamp.encode("ascii"),
        hashlib.sha256,
    ).digest()
    region_key = hmac.new(date_key, region.encode("ascii"), hashlib.sha256).digest()
    service_key = hmac.new(region_key, b"s3", hashlib.sha256).digest()
    signing_key = hmac.new(service_key, b"aws4_request", hashlib.sha256).digest()
    signature = hmac.new(
        signing_key, string_to_sign.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    authorized["Authorization"] = (
        "AWS4-HMAC-SHA256 "
        f"Credential={credential.access_key_id}/{scope}, "
        f"SignedHeaders={signed_names}, Signature={signature}"
    )
    return authorized
