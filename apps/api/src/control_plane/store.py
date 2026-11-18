"""SQLite-backed Action + Authorization + Audit primitive.

This is the Phase 1 sidecar control plane from /. The sidecar owns
agent-action and audit metadata here; renderer-owned application data remains in
the existing desktop database.
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Literal, overload

from ..agent_workspace_authority import snapshot_workspace_roots
from .managed_operation_rows import ManagedOperationRow, managed_operation_row

MAX_MANAGED_OPERATION_ACTIONS_PER_OPERATION = 256
PENDING_MANAGED_DOCUMENT_ACTION_OUTCOMES = (
    "document_admitted",
    "document_writing",
    "document_outcome_unresolved",
)


@dataclass(frozen=True)
class ManagedDocumentActionAdmission:
    status: Literal[
        "admitted", "existing", "conflict", "busy", "full", "not_found", "unavailable"
    ]
    record: dict[str, Any] | None = None


def utc_now() -> str:
    """Return an ISO-8601 UTC timestamp."""
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def new_uuid7() -> str:
    """Generate a UUIDv7-compatible identifier using stdlib primitives."""
    timestamp_ms = int(time.time() * 1000) & ((1 << 48) - 1)
    rand_a = secrets.randbits(12)
    rand_b = secrets.randbits(62)
    value = timestamp_ms << 80
    value |= 0x7 << 76
    value |= rand_a << 64
    value |= 0b10 << 62
    value |= rand_b
    return str(uuid.UUID(int=value))


def default_db_path() -> Path:
    override = os.environ.get("DNAFORGE_SIDECAR_DB_PATH")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".dnaforge" / "sidecar-control-plane.sqlite3"


SCHEMA_SQL = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agent_identity (
  id                       TEXT PRIMARY KEY,
  parent_human_identity_id TEXT NOT NULL,
  scope_json               TEXT NOT NULL,
  expires_at               TEXT,
  revoked                  INTEGER NOT NULL DEFAULT 0,
  label                    TEXT,
  kind                     TEXT,
  api_key_hash             TEXT,
  created_at               TEXT,
  revoked_at               TEXT,
  origin                   TEXT,
  environment_id           TEXT,
  created_by               TEXT,
  client_name              TEXT,
  client_version           TEXT,
  bound_workspace_id       TEXT,
  bound_workspace_label    TEXT,
  bound_workspace_roots_json TEXT
);

CREATE TABLE IF NOT EXISTS plugin_identity (
  id                        TEXT PRIMARY KEY,
  name                      TEXT NOT NULL,
  version                   TEXT NOT NULL,
  manifest_signature        TEXT NOT NULL,
  author_identity           TEXT NOT NULL,
  declared_scopes_json      TEXT NOT NULL,
  install_approved_by       TEXT,
  install_approved_at       TEXT,
  install_scope_grants_json TEXT NOT NULL,
  is_first_party            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS agent_action (
  id                    TEXT PRIMARY KEY,
  agent_identity_id     TEXT NOT NULL REFERENCES agent_identity(id),
  tool_name             TEXT NOT NULL,
  parameters_json       TEXT NOT NULL,
  authorized_scope_json TEXT NOT NULL DEFAULT '[]',
  requested_at          TEXT NOT NULL,
  authorization_state   TEXT NOT NULL CHECK (authorization_state IN
                          ('pending','granted','denied','approval_required','approved','rejected')),
  parent_action_id    TEXT REFERENCES agent_action(id),
  root_action_id      TEXT NOT NULL REFERENCES agent_action(id),
  job_pool             TEXT,
  job_cancelable       INTEGER,
  job_duration         TEXT,
  job_turn_id          TEXT,
  idempotency_key_hash TEXT,
  idempotency_body_hash TEXT,
  terminal_expires_at  REAL,
  result_json         TEXT,
  error_json          TEXT,
  completed_at        TEXT,
  managed_operation_id TEXT REFERENCES managed_operation(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS agent_action_root ON agent_action(root_action_id);
CREATE INDEX IF NOT EXISTS agent_action_parent ON agent_action(parent_action_id);
CREATE INDEX IF NOT EXISTS agent_action_agent
  ON agent_action(agent_identity_id, requested_at DESC);
CREATE TABLE IF NOT EXISTS agent_design_authority (
  design_id TEXT PRIMARY KEY,
  agent_identity_id TEXT NOT NULL REFERENCES agent_identity(id),
  create_action_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_artifact (
  id                  TEXT PRIMARY KEY,
  agent_identity_id   TEXT NOT NULL REFERENCES agent_identity(id),
  action_id           TEXT REFERENCES agent_action(id),
  kind                TEXT NOT NULL CHECK (kind IN ('file','directory','url','external')),
  name                TEXT NOT NULL,
  description         TEXT,
  path                TEXT,
  source_uri          TEXT,
  resource_uri        TEXT NOT NULL UNIQUE,
  mime_type           TEXT,
  size_bytes          INTEGER,
  sha256              TEXT,
  metadata_json       TEXT NOT NULL,
  provenance_json     TEXT NOT NULL,
  tags_json           TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_artifact_agent
  ON agent_artifact(agent_identity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_artifact_action
  ON agent_artifact(action_id);
-- : idempotency on agent retry — same (action_id, name) within a
-- single agent_action MUST resolve to one artifact, not multiple. Combined
-- with the DAO's INSERT OR IGNORE path, a retried external.fetch from the
-- same agent_action no longer double-writes the audit row. Partial-NULL
-- semantics: SQLite treats NULL as distinct, so artifacts without an
-- action_id (legacy direct sidecar inserts) don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS agent_artifact_action_name_unique
  ON agent_artifact(action_id, name) WHERE action_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_analysis_run (
  id                  TEXT PRIMARY KEY,
  agent_identity_id   TEXT NOT NULL REFERENCES agent_identity(id),
  action_id           TEXT REFERENCES agent_action(id),
  name                TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN
                        ('planned','running','completed','failed','canceled')),
  resource_uri        TEXT NOT NULL UNIQUE,
  command_json        TEXT NOT NULL,
  cwd                 TEXT,
  inputs_json         TEXT NOT NULL,
  outputs_json        TEXT NOT NULL,
  metrics_json        TEXT NOT NULL,
  metadata_json       TEXT NOT NULL,
  started_at          TEXT,
  completed_at        TEXT,
  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_analysis_run_agent
  ON agent_analysis_run(agent_identity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_analysis_run_action
  ON agent_analysis_run(action_id);
CREATE INDEX IF NOT EXISTS agent_analysis_run_status
  ON agent_analysis_run(status, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_resource_link (
  id                  TEXT PRIMARY KEY,
  agent_identity_id   TEXT NOT NULL REFERENCES agent_identity(id),
  action_id           TEXT REFERENCES agent_action(id),
  source_uri          TEXT NOT NULL,
  target_uri          TEXT NOT NULL,
  relationship        TEXT NOT NULL,
  resource_uri        TEXT NOT NULL UNIQUE,
  metadata_json       TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_resource_link_agent
  ON agent_resource_link(agent_identity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_resource_link_source
  ON agent_resource_link(source_uri);
CREATE INDEX IF NOT EXISTS agent_resource_link_target
  ON agent_resource_link(target_uri);

CREATE TABLE IF NOT EXISTS audit_record (
  id                    TEXT PRIMARY KEY,
  action_id             TEXT NOT NULL REFERENCES agent_action(id),
  actor_kind            TEXT NOT NULL CHECK (actor_kind IN ('agent','renderer','plugin')),
  actor_identity        TEXT NOT NULL,
  actor_scope_json      TEXT NOT NULL,
  before_state_json     TEXT,
  after_state_json      TEXT,
  side_effects_json     TEXT NOT NULL,
  capability_check_json TEXT NOT NULL,
  plugin_identity_id    TEXT REFERENCES plugin_identity(id),
  recorded_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_record_action ON audit_record(action_id);
CREATE INDEX IF NOT EXISTS audit_record_recorded ON audit_record(recorded_at DESC);

-- ────────────────────────────────────────────────────────────────────
--  / Phase 1a1 — bioinformatics DB substrate (external resources)
--
-- Plan: tools/devops/plans/2026-05-02-bioinformatics-db-substrate.md
-- Concurrency spec: src/control_plane/EXTERNAL_RESOURCES_CONCURRENCY.md
--
-- Five tables that turn DNAForge into the local cross-reference graph
-- for biology. system fetches log to external_fetch_log (NOT audit_record);
-- agent-driven fetches still go through 's audit_record.
-- ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS data_file (
  -- Content-addressed: sha256 IS the primary key.
  -- Disk layout convention: <data_root>/<sha256[:2]>/<sha256[2:4]>/<sha256>
  -- Atomic writes: temp file in same dir + rename(). LRU eviction on last_used_at.
  -- length(sha256)=64 enforces the hex-digest shape so a truncated or malformed
  -- key cannot accidentally alias unrelated content under a single cache row.
  sha256          TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  byte_size       INTEGER NOT NULL CHECK (byte_size >= 0),
  mime_type       TEXT,
  source_url      TEXT,
  source_provider TEXT,
  license         TEXT,
  attribution     TEXT,
  fetched_at      TEXT NOT NULL,
  last_used_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS data_file_provider ON data_file(source_provider, fetched_at DESC);
CREATE INDEX IF NOT EXISTS data_file_lru ON data_file(last_used_at);

CREATE TABLE IF NOT EXISTS external_resource (
  -- Globally scoped per provider (UniProt P0AD86 is the same row across all workspaces).
  -- Per-workspace privacy lives on external_resource_binding via workspace_id.
  -- metadata_json is provider-derived ONLY: it must contain exclusively data the
  -- provider published (UniProt entry fields, PDB header, AlphaFold pLDDT, etc.).
  -- Workspace-private user content (annotations, lab notes, internal accessions)
  -- belongs in external_resource_binding.metadata_json instead — that table is
  -- workspace-scoped and never visible to other workspaces.
  id                  TEXT PRIMARY KEY,
  provider            TEXT NOT NULL,
  external_id         TEXT NOT NULL,
  external_url        TEXT,
  data_file_id        TEXT REFERENCES data_file(sha256) ON DELETE SET NULL,
  version_identifier  TEXT,
  etag                TEXT,
  license             TEXT,
  attribution         TEXT,
  metadata_json       TEXT NOT NULL,
  fetched_at          TEXT NOT NULL,
  last_checked        TEXT NOT NULL,
  UNIQUE(provider, external_id)
);
CREATE INDEX IF NOT EXISTS external_resource_provider
  ON external_resource(provider, fetched_at DESC);
CREATE INDEX IF NOT EXISTS external_resource_data_file
  ON external_resource(data_file_id);

CREATE TABLE IF NOT EXISTS external_resource_xref (
  -- First-class biology metadata (codex 6, 7) — evidence/confidence/identity/coverage
  -- are columns, not buried in JSON.
  id                    TEXT PRIMARY KEY,
  from_resource_id      TEXT NOT NULL REFERENCES external_resource(id) ON DELETE CASCADE,
  to_resource_id        TEXT NOT NULL REFERENCES external_resource(id) ON DELETE CASCADE,
  xref_type             TEXT NOT NULL,
  evidence              TEXT NOT NULL CHECK (evidence IN ('asserted','inferred','predicted')),
  confidence            REAL CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
  source_provider       TEXT NOT NULL,
  version               TEXT,
  identity              REAL CHECK (identity IS NULL OR (identity >= 0.0 AND identity <= 1.0)),
  coverage              REAL CHECK (coverage IS NULL OR (coverage >= 0.0 AND coverage <= 1.0)),
  alignment_coords_json TEXT,
  metadata_json         TEXT NOT NULL,
  recorded_at           TEXT NOT NULL,
  UNIQUE(from_resource_id, to_resource_id, xref_type, source_provider)
);
CREATE INDEX IF NOT EXISTS external_resource_xref_from
  ON external_resource_xref(from_resource_id, xref_type);
CREATE INDEX IF NOT EXISTS external_resource_xref_to
  ON external_resource_xref(to_resource_id, xref_type);

CREATE TABLE IF NOT EXISTS external_resource_binding (
  -- Workspace-scoped biology edge (D4 B revert from D1: domain-specific, NOT collapsed
  -- into agent_resource_link). NO action_id FK — biology edges are facts about provider
  -- data, not agent actions.
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  source_kind           TEXT NOT NULL CHECK (source_kind IN ('sequence','feature','project','paper')),
  source_uri            TEXT NOT NULL,
  external_resource_id  TEXT NOT NULL REFERENCES external_resource(id) ON DELETE CASCADE,
  relationship          TEXT NOT NULL,
  evidence              TEXT NOT NULL CHECK (evidence IN ('asserted','inferred','predicted')),
  confidence            REAL CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
  alignment_coords_json TEXT,
  metadata_json         TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  UNIQUE(workspace_id, source_uri, external_resource_id, relationship)
);
CREATE INDEX IF NOT EXISTS external_resource_binding_workspace
  ON external_resource_binding(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS external_resource_binding_source
  ON external_resource_binding(source_uri);
CREATE INDEX IF NOT EXISTS external_resource_binding_resource
  ON external_resource_binding(external_resource_id);

CREATE TABLE IF NOT EXISTS external_fetch_log (
  -- System fetch provenance (Option X — NOT in 's audit_record). Agent-driven
  -- fetches still write to audit_record via . SET NULL on resource delete so the
  -- log row survives as a forensic trail.
  --
  -- endpoint MAY contain query strings or signed URLs and is workspace-scoped via
  -- workspace_id. Cross-workspace listing (workspace_id IS NULL filter) is meant
  -- exclusively for sidecar-internal observability — never expose this surface to
  -- untrusted callers.
  --
  -- CHECK constraints reject nonsensical metric values that would corrupt
  -- operational dashboards (negative latency, negative bytes, status codes outside
  -- the HTTP range, cache_hit values other than 0/1).
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT,
  provider              TEXT NOT NULL,
  endpoint              TEXT NOT NULL,
  method                TEXT NOT NULL,
  status_code           INTEGER CHECK (status_code IS NULL OR (status_code >= 100 AND status_code <= 599)),
  latency_ms            INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  bytes_received        INTEGER CHECK (bytes_received IS NULL OR bytes_received >= 0),
  cache_hit             INTEGER NOT NULL DEFAULT 0 CHECK (cache_hit IN (0, 1)),
  external_resource_id  TEXT REFERENCES external_resource(id) ON DELETE SET NULL,
  failure_kind          TEXT,
  capability_check_json TEXT NOT NULL,
  recorded_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS external_fetch_log_provider
  ON external_fetch_log(provider, recorded_at DESC);
CREATE INDEX IF NOT EXISTS external_fetch_log_workspace
  ON external_fetch_log(workspace_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS external_fetch_log_resource
  ON external_fetch_log(external_resource_id);

CREATE TABLE IF NOT EXISTS managed_operation_owner (
  runtime_scope     TEXT PRIMARY KEY,
  owner_instance_id TEXT NOT NULL,
  acquired_at       REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS managed_operation (
  id                      TEXT PRIMARY KEY,
  runtime_scope           TEXT NOT NULL,
  scope_id                 TEXT NOT NULL,
  kind                     TEXT NOT NULL,
  kind_contract_version    INTEGER NOT NULL DEFAULT 1 CHECK (kind_contract_version >= 1),
  origin                   TEXT NOT NULL DEFAULT 'managed' CHECK (origin IN ('managed','recorded')),
  reported_run_id          TEXT,
  subject_id               TEXT NOT NULL,
  input_revision           TEXT NOT NULL,
  accepted_workspace_input_json TEXT,
  input_retention_state    TEXT NOT NULL DEFAULT 'none' CHECK (input_retention_state IN
                            ('none','retain_pending','held','release_pending','released')),
  submission_key           TEXT NOT NULL,
  submission_payload_hash  TEXT NOT NULL,
  actor_kind               TEXT NOT NULL CHECK (actor_kind IN ('human','agent')),
  actor_id                 TEXT NOT NULL,
  channel                  TEXT NOT NULL CHECK (channel IN ('desktop_ui','hosted_browser','managed_cli','agent')),
  cancellation_mode        TEXT NOT NULL CHECK (cancellation_mode IN ('queued_only','cooperative')),
  owner_instance_id        TEXT NOT NULL,
  version                  INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                    TEXT NOT NULL CHECK (state IN
                            ('queued','running','stopping','succeeded','failed','canceled','interrupted')),
  created_at               REAL NOT NULL,
  updated_at               REAL NOT NULL,
  started_at               REAL,
  settled_at               REAL,
  cancel_requested_at      REAL,
  result_expires_at        REAL,
  history_expires_at       REAL,
  result_status            TEXT NOT NULL DEFAULT 'none' CHECK (result_status IN
                            ('none','available','released','expired')),
  result_reservation_bytes INTEGER NOT NULL DEFAULT 0 CHECK (result_reservation_bytes >= 0),
  provenance_json           TEXT,
  action_omitted_count      INTEGER NOT NULL DEFAULT 0 CHECK (action_omitted_count >= 0),
  error_json               TEXT,
  UNIQUE(runtime_scope, scope_id, actor_kind, actor_id, submission_key)
);
CREATE INDEX IF NOT EXISTS managed_operation_scope_updated
  ON managed_operation(runtime_scope, scope_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS managed_operation_owner_state
  ON managed_operation(runtime_scope, owner_instance_id, state);
CREATE INDEX IF NOT EXISTS managed_operation_active_identity
  ON managed_operation(runtime_scope, scope_id, kind, subject_id, input_revision, created_at);
CREATE INDEX IF NOT EXISTS managed_operation_history_expiry
  ON managed_operation(history_expires_at);

CREATE TABLE IF NOT EXISTS managed_operation_submission (
  runtime_scope          TEXT NOT NULL,
  scope_id               TEXT NOT NULL,
  actor_kind             TEXT NOT NULL CHECK (actor_kind IN ('human','agent')),
  actor_id               TEXT NOT NULL,
  submission_key         TEXT NOT NULL,
  submission_payload_hash TEXT NOT NULL,
  operation_id           TEXT NOT NULL REFERENCES managed_operation(id) ON DELETE CASCADE,
  submitted_at           REAL NOT NULL,
  PRIMARY KEY(runtime_scope, scope_id, actor_kind, actor_id, submission_key)
);
CREATE INDEX IF NOT EXISTS managed_operation_submission_operation
  ON managed_operation_submission(operation_id, submitted_at);
INSERT OR IGNORE INTO managed_operation_submission (
  runtime_scope, scope_id, actor_kind, actor_id, submission_key,
  submission_payload_hash, operation_id, submitted_at
)
SELECT runtime_scope, scope_id, actor_kind, actor_id, submission_key,
       submission_payload_hash, id, created_at
FROM managed_operation;

CREATE TABLE IF NOT EXISTS managed_operation_result (
  operation_id         TEXT PRIMARY KEY REFERENCES managed_operation(id) ON DELETE CASCADE,
  payload_json         TEXT NOT NULL,
  size_bytes           INTEGER NOT NULL CHECK (size_bytes > 0),
  result_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (result_schema_version >= 1)
);

CREATE TABLE IF NOT EXISTS managed_operation_action (
  id             TEXT PRIMARY KEY,
  operation_id   TEXT NOT NULL REFERENCES managed_operation(id) ON DELETE CASCADE,
  action         TEXT NOT NULL,
  actor_kind     TEXT NOT NULL CHECK (actor_kind IN ('human','agent','system')),
  actor_id       TEXT NOT NULL,
  channel        TEXT NOT NULL CHECK (channel IN ('desktop_ui','hosted_browser','managed_cli','agent','runtime')),
  outcome        TEXT NOT NULL,
  details_json   TEXT NOT NULL DEFAULT '{}',
  recorded_at    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS managed_operation_action_operation
  ON managed_operation_action(operation_id, recorded_at);
"""


ROLLBACK_SQL = """
DROP INDEX IF EXISTS external_fetch_log_archive_workspace;
DROP INDEX IF EXISTS external_fetch_log_archive_provider;
DROP TABLE IF EXISTS external_fetch_log_archive;
DROP INDEX IF EXISTS external_fetch_log_resource;
DROP INDEX IF EXISTS external_fetch_log_workspace;
DROP INDEX IF EXISTS external_fetch_log_provider;
DROP TABLE IF EXISTS external_fetch_log;
DROP INDEX IF EXISTS external_resource_binding_resource;
DROP INDEX IF EXISTS external_resource_binding_source;
DROP INDEX IF EXISTS external_resource_binding_workspace;
DROP TABLE IF EXISTS external_resource_binding;
DROP INDEX IF EXISTS external_resource_xref_to;
DROP INDEX IF EXISTS external_resource_xref_from;
DROP TABLE IF EXISTS external_resource_xref;
DROP INDEX IF EXISTS external_resource_data_file;
DROP INDEX IF EXISTS external_resource_provider;
DROP TABLE IF EXISTS external_resource;
DROP INDEX IF EXISTS data_file_lru;
DROP INDEX IF EXISTS data_file_provider;
DROP TABLE IF EXISTS data_file;
DROP TABLE IF EXISTS audit_record;
DROP INDEX IF EXISTS audit_record_action;
DROP INDEX IF EXISTS audit_record_recorded;
DROP INDEX IF EXISTS agent_artifact_action_name_unique;
DROP TABLE IF EXISTS agent_artifact;
DROP INDEX IF EXISTS agent_artifact_agent;
DROP INDEX IF EXISTS agent_artifact_action;
DROP TABLE IF EXISTS agent_analysis_run;
DROP INDEX IF EXISTS agent_analysis_run_agent;
DROP INDEX IF EXISTS agent_analysis_run_action;
DROP INDEX IF EXISTS agent_analysis_run_status;
DROP TABLE IF EXISTS agent_resource_link;
DROP INDEX IF EXISTS agent_resource_link_agent;
DROP INDEX IF EXISTS agent_resource_link_source;
DROP INDEX IF EXISTS agent_resource_link_target;
DROP TABLE IF EXISTS agent_action;
DROP INDEX IF EXISTS agent_action_root;
DROP INDEX IF EXISTS agent_action_parent;
DROP INDEX IF EXISTS agent_action_agent;
DROP INDEX IF EXISTS agent_action_idempotency;
DROP INDEX IF EXISTS agent_action_managed_operation;
DROP INDEX IF EXISTS managed_operation_action_operation;
DROP TABLE IF EXISTS managed_operation_action;
DROP INDEX IF EXISTS managed_operation_result_expiry;
DROP TABLE IF EXISTS managed_operation_result;
DROP INDEX IF EXISTS managed_operation_submission_operation;
DROP TABLE IF EXISTS managed_operation_submission;
DROP INDEX IF EXISTS managed_operation_recorded_run;
DROP INDEX IF EXISTS managed_operation_history_expiry;
DROP INDEX IF EXISTS managed_operation_owner_state;
DROP INDEX IF EXISTS managed_operation_scope_updated;
DROP TABLE IF EXISTS managed_operation;
DROP TABLE IF EXISTS managed_operation_owner;
DROP TABLE IF EXISTS plugin_identity;
DROP TABLE IF EXISTS agent_identity;
"""


@dataclass(frozen=True)
class AgentIdentityInput:
    id: str
    parent_human_identity_id: str = "local-human"
    scope: list[str] | None = None
    expires_at: str | None = None
    revoked: bool = False
    label: str | None = None
    kind: str | None = None
    api_key_hash: str | None = None
    created_at: str | None = None
    revoked_at: str | None = None


@dataclass(frozen=True)
class AgentActionInput:
    id: str
    agent_identity_id: str
    tool_name: str
    parameters: dict[str, Any]
    authorization_state: str = "granted"
    parent_action_id: str | None = None
    root_action_id: str | None = None


@dataclass(frozen=True)
class AuditRecordInput:
    id: str
    action_id: str
    actor_kind: str
    actor_identity: str
    actor_scope: list[str]
    side_effects: list[dict[str, Any]]
    capability_check: dict[str, Any]
    before_state: dict[str, Any] | None = None
    after_state: dict[str, Any] | None = None
    plugin_identity_id: str | None = None


@dataclass(frozen=True)
class DataFileInput:
    sha256: str
    byte_size: int
    mime_type: str | None = None
    source_url: str | None = None
    source_provider: str | None = None
    license: str | None = None
    attribution: str | None = None


@dataclass(frozen=True)
class ExternalResourceInput:
    provider: str
    external_id: str
    metadata: dict[str, Any]
    external_url: str | None = None
    data_file_id: str | None = None
    version_identifier: str | None = None
    etag: str | None = None
    license: str | None = None
    attribution: str | None = None


@dataclass(frozen=True)
class ExternalResourceXrefInput:
    from_resource_id: str
    to_resource_id: str
    xref_type: str
    evidence: str
    source_provider: str
    confidence: float | None = None
    version: str | None = None
    identity: float | None = None
    coverage: float | None = None
    alignment_coords: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True)
class ExternalResourceBindingInput:
    workspace_id: str
    source_kind: str
    source_uri: str
    external_resource_id: str
    relationship: str
    evidence: str
    confidence: float | None = None
    alignment_coords: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True)
class ExternalFetchLogInput:
    provider: str
    endpoint: str
    method: str
    capability_check: dict[str, Any]
    workspace_id: str | None = None
    status_code: int | None = None
    latency_ms: int | None = None
    bytes_received: int | None = None
    cache_hit: bool = False
    external_resource_id: str | None = None
    failure_kind: str | None = None


_ACTIVE_SETTINGS_AGENT_IDENTITIES_CTE = """
WITH request(managed_identity_id) AS (VALUES (?)),
identities_with_usage AS (
  SELECT
    ai.*,
    usage.last_used_at,
    latest.tool_name AS last_tool_name,
    CASE
      WHEN latest.id IS NULL THEN NULL
      WHEN latest.authorization_state IN ('denied', 'rejected') THEN 'refused'
      WHEN latest.error_json IS NOT NULL THEN 'failed'
      WHEN latest.completed_at IS NOT NULL THEN 'completed'
      ELSE 'pending'
    END AS last_call_status,
    COALESCE(ai.created_at, '') AS sort_at,
    CASE
      WHEN request.managed_identity_id IS NOT NULL
        AND ai.id = request.managed_identity_id THEN 'in-app'
      WHEN ai.kind IN ('in-app', 'stdio-mcp', 'http-api-key') THEN ai.kind
      WHEN substr(ai.id, 1, 11) = 'agent_http_' THEN 'http-api-key'
      ELSE 'stdio-mcp'
    END AS effective_kind
  FROM agent_identity ai
  CROSS JOIN request
  LEFT JOIN (
    SELECT agent_identity_id, MAX(requested_at) AS last_used_at
    FROM agent_action
    GROUP BY agent_identity_id
  ) usage ON usage.agent_identity_id = ai.id
  LEFT JOIN agent_action latest ON latest.id = (
    SELECT action.id
    FROM agent_action action
    WHERE action.agent_identity_id = ai.id
    ORDER BY action.requested_at DESC, action.id DESC
    LIMIT 1
  )
),
classified AS (
  SELECT
    identities_with_usage.*,
    CASE
      WHEN origin IN ('app', 'tool-key', 'local-mcp', 'dev-test') THEN origin
      WHEN effective_kind = 'in-app' THEN 'app'
      WHEN effective_kind = 'http-api-key' THEN 'tool-key'
      WHEN (
        lower(id) IN ('local-agent', 'test-agent', 'smoke-agent')
        OR lower(trim(COALESCE(label, ''))) IN (
          'local-agent', 'test-agent', 'smoke-agent'
        )
        OR lower(id) LIKE 'dna82-%'
        OR lower(id) LIKE 'dna114-%'
        OR lower(id) LIKE 'harness-%'
        OR lower(id) LIKE 'smoke-%'
        OR lower(id) LIKE 'test-%'
        OR lower(trim(COALESCE(label, ''))) LIKE 'dna82-%'
        OR lower(trim(COALESCE(label, ''))) LIKE 'dna114-%'
        OR lower(trim(COALESCE(label, ''))) LIKE 'harness-%'
        OR lower(trim(COALESCE(label, ''))) LIKE 'smoke-%'
        OR lower(trim(COALESCE(label, ''))) LIKE 'test-%'
        OR lower(id) LIKE '%e2e%'
        OR lower(id) LIKE '%harness%'
        OR lower(id) LIKE '%smoke%'
        OR lower(trim(COALESCE(label, ''))) LIKE '%e2e%'
        OR lower(trim(COALESCE(label, ''))) LIKE '%harness%'
        OR lower(trim(COALESCE(label, ''))) LIKE '%smoke%'
      ) THEN 'dev-test'
      ELSE 'local-mcp'
    END AS effective_origin
  FROM identities_with_usage
)
"""


class ControlPlaneStore:
    """Tiny SQLite DAO for 's Phase 1 audit/job tables."""

    def __init__(self, db_path: Path | str | None = None):
        self.db_path = Path(db_path) if db_path is not None else default_db_path()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row

        self._conn.execute("PRAGMA journal_mode = WAL")
        self._conn.execute("PRAGMA busy_timeout = 5000")
        self._conn.execute("PRAGMA synchronous = NORMAL")
        self._conn.execute("PRAGMA foreign_keys = ON")

        self._conn.execute("PRAGMA cache_size = -2048")

        self._tx_lock = threading.RLock()
        self._tx_depth = 0
        from .organization_inventory_claim_policy import OrganizationInventoryClaimPolicyStore

        self.organization_inventory_claims = OrganizationInventoryClaimPolicyStore(
            self._conn, self.transaction
        )

    def _commit(self) -> None:
        """DAO-internal commit. No-op while an explicit transaction is open
        on ANY thread (the lock guarantees only one outer tx at a time, and
        the depth counter survives nested re-entry on the same thread)."""
        if self._tx_depth > 0:
            return
        self._conn.commit()

    @contextmanager
    def transaction(self) -> Iterator[None]:
        """BEGIN IMMEDIATE … COMMIT / ROLLBACK around a block of DAO calls.

        Public service-layer hook for batching multiple DAO writes into one
        atomic transaction. The DAO is commit-each by design  chose
        the worst-case shape for the load test); callers that need atomicity
        across multiple DAO calls wrap them in `with store.transaction():`.

        BEGIN IMMEDIATE specifically (not DEFERRED) because under WAL with
        concurrent writers, DEFERRED can surface SQLITE_BUSY mid-transaction
        during the writer-lock upgrade. See
        `src/control_plane/EXTERNAL_RESOURCES_CONCURRENCY.md` § Transaction
        boundaries.

        Concurrency contract :
        - The RLock serializes concurrent transaction entry across threads.
          Outer-most acquirer issues BEGIN IMMEDIATE; siblings block on the
          lock until the outer block COMMITs/ROLLBACKs.
        - Re-entry on the SAME thread (helper that itself wraps in
          transaction()) is supported via the depth counter. Inner blocks
          don't issue BEGIN/COMMIT; only the outer block does.
        - `_commit()` returns early while depth > 0 so per-method commits
          don't break the outer atomicity envelope.
        """
        with self._tx_lock:
            is_outer = self._tx_depth == 0
            if is_outer:
                self._conn.execute("BEGIN IMMEDIATE")
            self._tx_depth += 1
            try:
                yield
                if is_outer:
                    self._conn.execute("COMMIT")
            except Exception:
                if is_outer:
                    try:
                        self._conn.execute("ROLLBACK")
                    except sqlite3.OperationalError as rollback_exc:

                        if "no transaction is active" not in str(rollback_exc):
                            logging.getLogger(__name__).warning(
                                "ROLLBACK failed during store.transaction()",
                                exc_info=True,
                            )
                raise
            finally:
                self._tx_depth -= 1

    @contextmanager
    def durable_transaction(self) -> Iterator[None]:
        """Commit a native write intent before its external file mutation."""
        with self._tx_lock:
            if self._tx_depth or self._conn.in_transaction:
                raise RuntimeError("A durable write must own the outermost transaction")
            if self._conn.execute("PRAGMA journal_mode").fetchone()[0] != "wal":
                raise RuntimeError("Durable document write intents require WAL mode")
            previous = int(self._conn.execute("PRAGMA synchronous").fetchone()[0])
            try:
                self._conn.execute(f"PRAGMA synchronous = {max(previous, 2)}")
                with self.transaction():
                    yield
            finally:
                if not self._conn.in_transaction:
                    self._conn.execute(f"PRAGMA synchronous = {previous}")

    def upsert_external_resource_stub(
        self,
        *,
        provider: str,
        external_id: str,
    ) -> str:
        """Idempotent stub-row insert for an xref target whose metadata isn't
        known yet.

        Distinct from `upsert_external_resource` because the latter overwrites
        `metadata_json` on conflict — calling that with `metadata={"_stub":True}`
        on a row that's already been fully fetched would silently destroy the
        real metadata. This method uses INSERT … ON CONFLICT DO NOTHING so an
        existing row is preserved untouched.

        Returns the canonical id whether the row was newly inserted or already
        existed. Used by the service-layer xref persistence path.
        """
        now = utc_now()
        stub_id = new_uuid7()
        row = self._conn.execute(
            """
            INSERT INTO external_resource (
              id, provider, external_id, external_url, data_file_id,
              version_identifier, etag, license, attribution, metadata_json,
              fetched_at, last_checked
            )
            VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)
            ON CONFLICT(provider, external_id) DO NOTHING
            RETURNING id
            """,
            (
                stub_id,
                provider,
                external_id,
                json.dumps({"_stub": True}, sort_keys=True),
                now,
                now,
            ),
        ).fetchone()
        self._commit()
        if row is not None:
            return row["id"]

        existing = self._conn.execute(
            "SELECT id FROM external_resource WHERE provider = ? AND external_id = ?",
            (provider, external_id),
        ).fetchone()
        if existing is None:

            return stub_id
        return existing["id"]

    def initialize(self) -> None:
        self._conn.executescript(SCHEMA_SQL)
        self.organization_inventory_claims.initialize()
        self._ensure_external_resource_binding_paper_source_kind()
        self._ensure_agent_action_authorized_scope_column()
        self._ensure_agent_action_job_columns()
        self._ensure_agent_action_operation_column()
        self._ensure_managed_operation_cancellation_mode_column()
        self._ensure_managed_operation_accepted_input_column()
        self._ensure_managed_operation_retention_schema()
        self._ensure_managed_operation_version_schema()
        self._ensure_managed_operation_recording_schema()
        self._ensure_managed_operation_action_retention_schema()
        self._ensure_agent_identity_management_columns()
        self._commit()

    def _ensure_external_resource_binding_paper_source_kind(self) -> None:
        """Add ``paper`` to the binding source-kind CHECK on existing databases.

        SQLite cannot alter a CHECK constraint in place. Rebuild the one table
        transactionally, preserving every row and index. Fresh databases already
        contain the new constraint and take the no-op path.
        """
        row = self._conn.execute("""
            SELECT sql FROM sqlite_master
            WHERE type = 'table' AND name = 'external_resource_binding'
            """).fetchone()
        if row is None or "'paper'" in (row["sql"] or ""):
            return

        with self.transaction():
            self._conn.execute(
                "DROP INDEX IF EXISTS external_resource_binding_resource"
            )
            self._conn.execute("DROP INDEX IF EXISTS external_resource_binding_source")
            self._conn.execute(
                "DROP INDEX IF EXISTS external_resource_binding_workspace"
            )
            self._conn.execute(
                "ALTER TABLE external_resource_binding RENAME TO external_resource_binding_legacy"
            )
            self._conn.execute("""
                CREATE TABLE external_resource_binding (
                  id                    TEXT PRIMARY KEY,
                  workspace_id          TEXT NOT NULL,
                  source_kind           TEXT NOT NULL CHECK (source_kind IN ('sequence','feature','project','paper')),
                  source_uri            TEXT NOT NULL,
                  external_resource_id  TEXT NOT NULL REFERENCES external_resource(id) ON DELETE CASCADE,
                  relationship          TEXT NOT NULL,
                  evidence              TEXT NOT NULL CHECK (evidence IN ('asserted','inferred','predicted')),
                  confidence            REAL CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
                  alignment_coords_json TEXT,
                  metadata_json         TEXT NOT NULL,
                  created_at            TEXT NOT NULL,
                  UNIQUE(workspace_id, source_uri, external_resource_id, relationship)
                )
                """)
            self._conn.execute("""
                INSERT INTO external_resource_binding (
                  id, workspace_id, source_kind, source_uri, external_resource_id,
                  relationship, evidence, confidence, alignment_coords_json,
                  metadata_json, created_at
                )
                SELECT
                  id, workspace_id, source_kind, source_uri, external_resource_id,
                  relationship, evidence, confidence, alignment_coords_json,
                  metadata_json, created_at
                FROM external_resource_binding_legacy
                """)
            self._conn.execute("DROP TABLE external_resource_binding_legacy")
            self._conn.execute("""
                CREATE INDEX external_resource_binding_workspace
                  ON external_resource_binding(workspace_id, created_at DESC)
                """)
            self._conn.execute("""
                CREATE INDEX external_resource_binding_source
                  ON external_resource_binding(source_uri)
                """)
            self._conn.execute("""
                CREATE INDEX external_resource_binding_resource
                  ON external_resource_binding(external_resource_id)
                """)

    def _ensure_agent_action_authorized_scope_column(self) -> None:
        columns = {
            row["name"]
            for row in self._conn.execute("PRAGMA table_info(agent_action)").fetchall()
        }
        if "authorized_scope_json" in columns:
            return
        self._conn.execute(
            "ALTER TABLE agent_action ADD COLUMN authorized_scope_json TEXT NOT NULL DEFAULT '[]'"
        )

    def _ensure_agent_action_job_columns(self) -> None:
        """Add bounded job-replay metadata to existing control-plane databases."""

        columns = {
            row["name"]
            for row in self._conn.execute("PRAGMA table_info(agent_action)").fetchall()
        }
        for column_name, column_type in {
            "job_pool": "TEXT",
            "job_cancelable": "INTEGER",
            "job_duration": "TEXT",
            "job_turn_id": "TEXT",
            "idempotency_key_hash": "TEXT",
            "idempotency_body_hash": "TEXT",
            "terminal_expires_at": "REAL",
        }.items():
            if column_name not in columns:
                self._conn.execute(
                    f"ALTER TABLE agent_action ADD COLUMN {column_name} {column_type}"
                )
        index_columns = [
            row["name"]
            for row in self._conn.execute(
                "PRAGMA index_info(agent_action_idempotency)"
            ).fetchall()
        ]
        expected_index_columns = [
            "agent_identity_id",
            "idempotency_key_hash",
            "requested_at",
        ]
        if index_columns != expected_index_columns:
            self._conn.execute("DROP INDEX IF EXISTS agent_action_idempotency")
            self._conn.execute("""
                CREATE INDEX agent_action_idempotency
                  ON agent_action(agent_identity_id, idempotency_key_hash, requested_at DESC)
                """)
        self._conn.execute("""
            CREATE INDEX IF NOT EXISTS agent_action_visible_jobs
              ON agent_action(job_duration, requested_at DESC)
              WHERE job_duration IN ('long-running','streaming')
            """)

    def _ensure_agent_action_operation_column(self) -> None:
        columns = {
            row["name"]
            for row in self._conn.execute("PRAGMA table_info(agent_action)").fetchall()
        }
        if "managed_operation_id" not in columns:
            self._conn.execute(
                "ALTER TABLE agent_action ADD COLUMN managed_operation_id "
                "TEXT REFERENCES managed_operation(id) ON DELETE SET NULL"
            )
        self._conn.execute("""
            CREATE INDEX IF NOT EXISTS agent_action_managed_operation
              ON agent_action(managed_operation_id)
            """)

    def _ensure_managed_operation_cancellation_mode_column(self) -> None:
        columns = {
            row["name"]
            for row in self._conn.execute(
                "PRAGMA table_info(managed_operation)"
            ).fetchall()
        }
        if "cancellation_mode" not in columns:
            self._conn.execute(
                "ALTER TABLE managed_operation ADD COLUMN cancellation_mode "
                "TEXT NOT NULL DEFAULT 'queued_only' "
                "CHECK (cancellation_mode IN ('queued_only','cooperative'))"
            )

    def _ensure_managed_operation_accepted_input_column(self) -> None:
        columns = {
            row["name"]
            for row in self._conn.execute("PRAGMA table_info(managed_operation)")
        }
        if "accepted_workspace_input_json" not in columns:
            self._conn.execute(
                "ALTER TABLE managed_operation ADD COLUMN accepted_workspace_input_json TEXT"
            )
        if "input_retention_state" not in columns:
            self._conn.execute(
                "ALTER TABLE managed_operation ADD COLUMN input_retention_state "
                "TEXT NOT NULL DEFAULT 'none' CHECK (input_retention_state IN "
                "('none','retain_pending','held','release_pending','released'))"
            )

    def _ensure_managed_operation_retention_schema(self) -> None:
        operation_columns = {
            row["name"]
            for row in self._conn.execute(
                "PRAGMA table_info(managed_operation)"
            ).fetchall()
        }
        if "result_status" not in operation_columns:
            self._conn.execute(
                "ALTER TABLE managed_operation ADD COLUMN result_status "
                "TEXT NOT NULL DEFAULT 'none' "
                "CHECK (result_status IN ('none','available','released','expired'))"
            )
        if "result_reservation_bytes" not in operation_columns:
            self._conn.execute(
                "ALTER TABLE managed_operation ADD COLUMN result_reservation_bytes "
                "INTEGER NOT NULL DEFAULT 0 CHECK (result_reservation_bytes >= 0)"
            )

        result_columns = {
            row["name"]
            for row in self._conn.execute(
                "PRAGMA table_info(managed_operation_result)"
            ).fetchall()
        }
        if "expires_at" in result_columns:
            with self.transaction():
                self._conn.execute(
                    "DROP INDEX IF EXISTS managed_operation_result_expiry"
                )
                self._conn.execute(
                    "ALTER TABLE managed_operation_result "
                    "RENAME TO managed_operation_result_with_expiry"
                )
                self._conn.execute("""
                    CREATE TABLE managed_operation_result (
                      operation_id TEXT PRIMARY KEY REFERENCES managed_operation(id) ON DELETE CASCADE,
                      payload_json TEXT NOT NULL,
                      size_bytes   INTEGER NOT NULL CHECK (size_bytes > 0)
                    )
                    """)
                self._conn.execute("""
                    INSERT INTO managed_operation_result (operation_id, payload_json, size_bytes)
                    SELECT operation_id, payload_json,
                           CASE WHEN size_bytes > 0 THEN size_bytes
                                ELSE length(CAST(payload_json AS BLOB)) END
                    FROM managed_operation_result_with_expiry
                    """)
                self._conn.execute("DROP TABLE managed_operation_result_with_expiry")

        self._conn.execute("""
            UPDATE managed_operation
            SET result_status = 'available'
            WHERE EXISTS (
              SELECT 1 FROM managed_operation_result
              WHERE managed_operation_result.operation_id = managed_operation.id
            )
            """)
        self._conn.execute("""
            UPDATE managed_operation
            SET result_status = 'expired'
            WHERE result_status = 'none' AND result_expires_at IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM managed_operation_result
                WHERE managed_operation_result.operation_id = managed_operation.id
              )
            """)

    def _ensure_managed_operation_recording_schema(self) -> None:
        columns = {
            row["name"]
            for row in self._conn.execute(
                "PRAGMA table_info(managed_operation)"
            ).fetchall()
        }
        for column_name, column_type in {
            "origin": "TEXT NOT NULL DEFAULT 'managed' CHECK (origin IN ('managed','recorded'))",
            "reported_run_id": "TEXT",
            "provenance_json": "TEXT",
        }.items():
            if column_name not in columns:
                self._conn.execute(
                    f"ALTER TABLE managed_operation ADD COLUMN {column_name} {column_type}"
                )
        self._conn.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS managed_operation_recorded_run
              ON managed_operation(reported_run_id) WHERE origin = 'recorded'
            """)

    def _ensure_managed_operation_version_schema(self) -> None:
        operation_columns = {
            row["name"]
            for row in self._conn.execute(
                "PRAGMA table_info(managed_operation)"
            ).fetchall()
        }
        if "kind_contract_version" not in operation_columns:
            self._conn.execute(
                "ALTER TABLE managed_operation ADD COLUMN kind_contract_version "
                "INTEGER NOT NULL DEFAULT 1 CHECK (kind_contract_version >= 1)"
            )

        result_columns = {
            row["name"]
            for row in self._conn.execute(
                "PRAGMA table_info(managed_operation_result)"
            ).fetchall()
        }
        if "result_schema_version" not in result_columns:
            self._conn.execute(
                "ALTER TABLE managed_operation_result ADD COLUMN result_schema_version "
                "INTEGER NOT NULL DEFAULT 1 CHECK (result_schema_version >= 1)"
            )

    def _ensure_managed_operation_action_retention_schema(self) -> None:
        columns = {
            row["name"]
            for row in self._conn.execute(
                "PRAGMA table_info(managed_operation)"
            ).fetchall()
        }
        if "action_omitted_count" not in columns:
            self._conn.execute(
                "ALTER TABLE managed_operation ADD COLUMN action_omitted_count "
                "INTEGER NOT NULL DEFAULT 0 CHECK (action_omitted_count >= 0)"
            )
        operation_rows = self._conn.execute(
            """
            SELECT operation_id
            FROM managed_operation_action
            GROUP BY operation_id
            HAVING COUNT(*) > ?
            """,
            (MAX_MANAGED_OPERATION_ACTIONS_PER_OPERATION,),
        ).fetchall()
        for row in operation_rows:
            self._compact_managed_operation_actions(row["operation_id"])

    def _ensure_agent_identity_management_columns(self) -> None:
        columns = {
            row["name"]
            for row in self._conn.execute(
                "PRAGMA table_info(agent_identity)"
            ).fetchall()
        }
        for column_name, column_type in {
            "label": "TEXT",
            "kind": "TEXT",
            "api_key_hash": "TEXT",
            "created_at": "TEXT",
            "revoked_at": "TEXT",
            "origin": "TEXT",
            "environment_id": "TEXT",
            "created_by": "TEXT",
            "client_name": "TEXT",
            "client_version": "TEXT",
            "bound_workspace_id": "TEXT",
            "bound_workspace_label": "TEXT",
            "bound_workspace_roots_json": "TEXT",
        }.items():
            if column_name not in columns:
                self._conn.execute(
                    f"ALTER TABLE agent_identity ADD COLUMN {column_name} {column_type}"
                )
        now = utc_now()
        self._conn.execute(
            """
            UPDATE agent_identity
            SET
              kind = COALESCE(kind, 'stdio-mcp'),
              created_at = COALESCE(created_at, ?),
              revoked_at = CASE
                WHEN revoked = 1 THEN COALESCE(revoked_at, ?)
                ELSE revoked_at
              END
            """,
            (now, now),
        )
        self._conn.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS agent_identity_api_key_hash
              ON agent_identity(api_key_hash) WHERE api_key_hash IS NOT NULL
            """)
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS agent_identity_kind ON agent_identity(kind)"
        )
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS agent_identity_origin ON agent_identity(origin)"
        )
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS agent_identity_environment ON agent_identity(environment_id)"
        )

    def rollback(self) -> None:
        self._conn.executescript(ROLLBACK_SQL)
        self._commit()

    def close(self) -> None:
        self._conn.close()

    def claim_managed_operation_owner(
        self, runtime_scope: str, owner_instance_id: str, *, now: float | None = None
    ) -> str | None:
        """Record a scope owner after its caller acquires the kernel lease.

        The SQLite row is diagnostic state, not the liveness proof. Callers must
        hold ``RuntimeScopeLease`` before replacing it.
        """

        previous = self._conn.execute(
            "SELECT owner_instance_id FROM managed_operation_owner WHERE runtime_scope = ?",
            (runtime_scope,),
        ).fetchone()
        self._conn.execute(
            """
            INSERT INTO managed_operation_owner (runtime_scope, owner_instance_id, acquired_at)
            VALUES (?, ?, ?)
            ON CONFLICT(runtime_scope) DO UPDATE SET
              owner_instance_id = excluded.owner_instance_id,
              acquired_at = excluded.acquired_at
            """,
            (runtime_scope, owner_instance_id, time.time() if now is None else now),
        )
        self._commit()
        return previous["owner_instance_id"] if previous is not None else None

    def release_managed_operation_owner(
        self, runtime_scope: str, owner_instance_id: str
    ) -> bool:
        cursor = self._conn.execute(
            "DELETE FROM managed_operation_owner WHERE runtime_scope = ? AND owner_instance_id = ?",
            (runtime_scope, owner_instance_id),
        )
        self._commit()
        return bool(cursor.rowcount)

    def insert_managed_operation(
        self,
        *,
        runtime_scope: str,
        scope_id: str,
        kind: str,
        subject_id: str,
        input_revision: str,
        submission_key: str,
        submission_payload_hash: str,
        actor_kind: str,
        actor_id: str,
        channel: str,
        owner_instance_id: str,
        now: float,
        cancellation_mode: str = "queued_only",
        result_reservation_bytes: int = 0,
        kind_contract_version: int = 1,
        operation_id: str | None = None,
        accepted_workspace_input: dict[str, Any] | None = None,
        retain_input: bool = False,
    ) -> str:
        operation_id = operation_id or new_uuid7()
        with self.transaction():
            self._conn.execute(
                """
                INSERT INTO managed_operation (
                  id, runtime_scope, scope_id, kind, kind_contract_version,
                  subject_id, input_revision, submission_key,
                  submission_payload_hash, actor_kind, actor_id, channel,
                  cancellation_mode, owner_instance_id, version, state,
                  created_at, updated_at, result_reservation_bytes, accepted_workspace_input_json,
                  input_retention_state
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'queued', ?, ?, ?, ?, ?)
                """,
                (
                    operation_id,
                    runtime_scope,
                    scope_id,
                    kind,
                    kind_contract_version,
                    subject_id,
                    input_revision,
                    submission_key,
                    submission_payload_hash,
                    actor_kind,
                    actor_id,
                    channel,
                    cancellation_mode,
                    owner_instance_id,
                    now,
                    now,
                    result_reservation_bytes,
                    (
                        json.dumps(
                            accepted_workspace_input,
                            sort_keys=True,
                            separators=(",", ":"),
                        )
                        if accepted_workspace_input is not None
                        else None
                    ),
                    "retain_pending" if retain_input else "none",
                ),
            )
            self.insert_managed_operation_submission(
                runtime_scope=runtime_scope,
                scope_id=scope_id,
                actor_kind=actor_kind,
                actor_id=actor_id,
                submission_key=submission_key,
                submission_payload_hash=submission_payload_hash,
                operation_id=operation_id,
                submitted_at=now,
            )
        return operation_id

    def get_managed_operation(self, operation_id: str) -> ManagedOperationRow | None:
        row = self._conn.execute(
            "SELECT * FROM managed_operation WHERE id = ?", (operation_id,)
        ).fetchone()
        return _managed_operation_row(row)

    def require_managed_operation_inputs(self, runtime_scope: str) -> None:
        """Backfill existing accepted inputs before a hosted owner starts serving."""
        self._conn.execute(
            """
            UPDATE managed_operation SET input_retention_state = 'retain_pending'
            WHERE runtime_scope = ? AND accepted_workspace_input_json IS NOT NULL
              AND input_retention_state = 'none'
              AND (state IN ('queued','running','stopping') OR result_status = 'available')
            """,
            (runtime_scope,),
        )
        self._commit()

    def prepare_managed_input_releases(self, runtime_scope: str) -> None:
        self._conn.execute(
            """
            UPDATE managed_operation SET input_retention_state = 'release_pending'
            WHERE runtime_scope = ? AND input_retention_state IN ('retain_pending','held')
              AND state IN ('succeeded','failed','canceled','interrupted')
              AND result_status != 'available'
            """,
            (runtime_scope,),
        )
        self._commit()

    def list_managed_input_retentions(
        self, runtime_scope: str, state: str
    ) -> list[ManagedOperationRow]:
        return [
            _managed_operation_row(row)
            for row in self._conn.execute(
                "SELECT * FROM managed_operation WHERE runtime_scope = ? AND input_retention_state = ? "
                "ORDER BY created_at, id",
                (runtime_scope, state),
            )
        ]

    def mark_managed_input_retention(
        self, operation_id: str, *, expected: str, state: str
    ) -> None:
        cursor = self._conn.execute(
            "UPDATE managed_operation SET input_retention_state = ? "
            "WHERE id = ? AND input_retention_state = ?",
            (state, operation_id, expected),
        )
        self._commit()
        if cursor.rowcount != 1:
            raise RuntimeError(
                "Operation input retention changed during reconciliation"
            )

    def pending_managed_input_release_count(self) -> int:
        return self._conn.execute(
            "SELECT count(*) FROM managed_operation WHERE input_retention_state "
            "IN ('retain_pending','held','release_pending') "
            "AND state IN ('succeeded','failed','canceled','interrupted') AND result_status != 'available'"
        ).fetchone()[0]

    def insert_recorded_managed_operation(
        self,
        *,
        runtime_scope: str,
        scope_id: str,
        kind: str,
        reported_run_id: str,
        subject_id: str,
        input_revision: str,
        submission_payload_hash: str,
        actor_kind: str,
        actor_id: str,
        channel: str,
        owner_instance_id: str,
        provenance: dict[str, Any],
        now: float,
        kind_contract_version: int = 1,
        operation_id: str | None = None,
    ) -> str:
        operation_id = operation_id or new_uuid7()
        submission_key = f"recorded:{reported_run_id}"
        with self.transaction():
            self._conn.execute(
                """
                INSERT INTO managed_operation (
                  id, runtime_scope, scope_id, kind, kind_contract_version,
                  origin, reported_run_id, subject_id, input_revision, submission_key,
                  submission_payload_hash, actor_kind, actor_id, channel,
                  cancellation_mode, owner_instance_id, version, state,
                  created_at, updated_at, settled_at, result_status,
                  result_reservation_bytes, provenance_json
                ) VALUES (
                  ?, ?, ?, ?, ?, 'recorded', ?, ?, ?, ?, ?, ?, ?, ?,
                  'queued_only', ?, 1, 'succeeded', ?, ?, ?, 'available', 0, ?
                )
                """,
                (
                    operation_id,
                    runtime_scope,
                    scope_id,
                    kind,
                    kind_contract_version,
                    reported_run_id,
                    subject_id,
                    input_revision,
                    submission_key,
                    submission_payload_hash,
                    actor_kind,
                    actor_id,
                    channel,
                    owner_instance_id,
                    now,
                    now,
                    now,
                    json.dumps(provenance, sort_keys=True, separators=(",", ":")),
                ),
            )
            self.insert_managed_operation_submission(
                runtime_scope=runtime_scope,
                scope_id=scope_id,
                actor_kind=actor_kind,
                actor_id=actor_id,
                submission_key=submission_key,
                submission_payload_hash=submission_payload_hash,
                operation_id=operation_id,
                submitted_at=now,
            )
        return operation_id

    def get_recorded_managed_operation(
        self, reported_run_id: str
    ) -> ManagedOperationRow | None:
        row = self._conn.execute(
            """
            SELECT * FROM managed_operation
            WHERE origin = 'recorded' AND reported_run_id = ?
            """,
            (reported_run_id,),
        ).fetchone()
        return _managed_operation_row(row)

    def get_managed_operation_by_submission(
        self,
        *,
        runtime_scope: str,
        scope_id: str,
        actor_kind: str,
        actor_id: str,
        submission_key: str,
    ) -> ManagedOperationRow | None:
        row = self._conn.execute(
            """
            SELECT operation.*,
                   submission.submission_payload_hash AS matched_submission_payload_hash
            FROM managed_operation_submission AS submission
            JOIN managed_operation AS operation ON operation.id = submission.operation_id
            WHERE submission.runtime_scope = ? AND submission.scope_id = ?
              AND submission.actor_kind = ? AND submission.actor_id = ?
              AND submission.submission_key = ?
            """,
            (runtime_scope, scope_id, actor_kind, actor_id, submission_key),
        ).fetchone()
        return _managed_operation_row(row)

    def insert_managed_operation_submission(
        self,
        *,
        runtime_scope: str,
        scope_id: str,
        actor_kind: str,
        actor_id: str,
        submission_key: str,
        submission_payload_hash: str,
        operation_id: str,
        submitted_at: float,
    ) -> None:
        self._conn.execute(
            """
            INSERT INTO managed_operation_submission (
              runtime_scope, scope_id, actor_kind, actor_id, submission_key,
              submission_payload_hash, operation_id, submitted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                runtime_scope,
                scope_id,
                actor_kind,
                actor_id,
                submission_key,
                submission_payload_hash,
                operation_id,
                submitted_at,
            ),
        )
        self._commit()

    def get_active_managed_operation_by_identity(
        self,
        *,
        runtime_scope: str,
        scope_id: str,
        kind: str,
        subject_id: str,
        input_revision: str,
        actor_kind: str | None = None,
        actor_id: str | None = None,
    ) -> ManagedOperationRow | None:
        if (actor_kind is None) != (actor_id is None):
            raise ValueError("actor_kind and actor_id must be provided together")
        clauses = [
            "runtime_scope = ?",
            "scope_id = ?",
            "kind = ?",
            "subject_id = ?",
            "input_revision = ?",
            "state IN ('queued', 'running', 'stopping')",
        ]
        parameters: list[Any] = [
            runtime_scope,
            scope_id,
            kind,
            subject_id,
            input_revision,
        ]
        if actor_kind is not None and actor_id is not None:
            clauses.extend(["actor_kind = ?", "actor_id = ?"])
            parameters.extend([actor_kind, actor_id])
        row = self._conn.execute(
            f"""
            SELECT * FROM managed_operation
            WHERE {" AND ".join(clauses)}
            ORDER BY created_at ASC, id ASC
            LIMIT 1
            """,
            parameters,
        ).fetchone()
        return _managed_operation_row(row)

    def list_managed_operations(
        self,
        *,
        runtime_scope: str,
        scope_id: str,
        subject_id: str | None = None,
        actor_kind: str | None = None,
        actor_id: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[ManagedOperationRow]:
        rows, _total, _next_offset = self.page_managed_operations(
            runtime_scope=runtime_scope,
            scope_id=scope_id,
            subject_id=subject_id,
            actor_kind=actor_kind,
            actor_id=actor_id,
            limit=limit,
            offset=offset,
        )
        return rows

    def page_managed_operations(
        self,
        *,
        runtime_scope: str,
        scope_id: str,
        subject_id: str | None = None,
        actor_kind: str | None = None,
        actor_id: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[ManagedOperationRow], int, int | None]:
        if (actor_kind is None) != (actor_id is None):
            raise ValueError("actor_kind and actor_id must be provided together")
        safe_limit = max(1, min(limit, 500))
        safe_offset = max(0, offset)
        clauses = ["runtime_scope = ?", "scope_id = ?"]
        parameters: list[Any] = [runtime_scope, scope_id]
        if subject_id is not None:
            clauses.append("subject_id = ?")
            parameters.append(subject_id)
        if actor_kind is not None and actor_id is not None:
            clauses.extend(["actor_kind = ?", "actor_id = ?"])
            parameters.extend([actor_kind, actor_id])
        predicate = " AND ".join(clauses)
        with self.transaction():
            count_row = self._conn.execute(
                f"SELECT COUNT(*) AS count FROM managed_operation WHERE {predicate}",
                parameters,
            ).fetchone()
            rows = self._conn.execute(
                f"""
                SELECT * FROM managed_operation
                WHERE {predicate}
                ORDER BY created_at DESC, id DESC
                LIMIT ? OFFSET ?
                """,
                (*parameters, safe_limit + 1, safe_offset),
            ).fetchall()
        total = int(count_row["count"] if count_row is not None else 0)
        has_more = len(rows) > safe_limit
        values = [
            _managed_operation_row(row) for row in rows[:safe_limit] if row is not None
        ]
        next_offset = safe_offset + len(values) if has_more else None
        return values, total, next_offset

    def managed_operation_initial_collection(
        self,
        *,
        runtime_scope: str,
        scope_id: str,
        terminal_limit: int,
        actor_kind: str | None = None,
        actor_id: str | None = None,
    ) -> tuple[list[ManagedOperationRow], int, int]:
        if (actor_kind is None) != (actor_id is None):
            raise ValueError("actor_kind and actor_id must be provided together")
        clauses = ["runtime_scope = ?", "scope_id = ?"]
        parameters: list[Any] = [runtime_scope, scope_id]
        if actor_kind is not None and actor_id is not None:
            clauses.extend(["actor_kind = ?", "actor_id = ?"])
            parameters.extend([actor_kind, actor_id])
        predicate = " AND ".join(clauses)
        with self.transaction():
            active = self._conn.execute(
                f"""
                SELECT * FROM managed_operation
                WHERE {predicate}
                  AND state IN ('queued','running','stopping')
                ORDER BY created_at DESC, id DESC
                """,
                parameters,
            ).fetchall()
            terminal_count_row = self._conn.execute(
                f"""
                SELECT COUNT(*) AS count FROM managed_operation
                WHERE {predicate}
                  AND state IN ('succeeded','failed','canceled','interrupted')
                """,
                parameters,
            ).fetchone()
            terminal = self._conn.execute(
                f"""
                SELECT * FROM managed_operation
                WHERE {predicate}
                  AND state IN ('succeeded','failed','canceled','interrupted')
                ORDER BY created_at DESC, id DESC
                LIMIT ?
                """,
                (*parameters, max(1, terminal_limit)),
            ).fetchall()
        values = [
            _managed_operation_row(row)
            for row in (*active, *terminal)
            if row is not None
        ]
        values.sort(key=lambda row: (row["created_at"], row["id"]), reverse=True)
        terminal_count = int(
            terminal_count_row["count"] if terminal_count_row is not None else 0
        )
        return values, len(active), terminal_count

    def managed_operation_counts(
        self,
        *,
        runtime_scope: str,
        scope_id: str,
        actor_kind: str | None = None,
        actor_id: str | None = None,
    ) -> tuple[int, int]:
        if (actor_kind is None) != (actor_id is None):
            raise ValueError("actor_kind and actor_id must be provided together")
        clauses = ["runtime_scope = ?", "scope_id = ?"]
        parameters: list[Any] = [runtime_scope, scope_id]
        if actor_kind is not None and actor_id is not None:
            clauses.extend(["actor_kind = ?", "actor_id = ?"])
            parameters.extend([actor_kind, actor_id])
        row = self._conn.execute(
            f"""
            SELECT
              SUM(CASE WHEN state IN ('queued','running','stopping') THEN 1 ELSE 0 END)
                AS active_count,
              SUM(CASE WHEN state IN ('succeeded','failed','canceled','interrupted') THEN 1 ELSE 0 END)
                AS terminal_count
            FROM managed_operation
            WHERE {" AND ".join(clauses)}
            """,
            parameters,
        ).fetchone()
        return (
            int(row["active_count"] or 0) if row is not None else 0,
            int(row["terminal_count"] or 0) if row is not None else 0,
        )

    def list_managed_operations_by_states(
        self,
        *,
        runtime_scope: str,
        owner_instance_id: str,
        states: set[str] | frozenset[str],
    ) -> list[ManagedOperationRow]:
        if not states:
            return []
        placeholders = ",".join("?" for _ in states)
        rows = self._conn.execute(
            f"""
            SELECT * FROM managed_operation
            WHERE runtime_scope = ? AND owner_instance_id = ?
              AND state IN ({placeholders})
            ORDER BY created_at, id
            """,
            (runtime_scope, owner_instance_id, *sorted(states)),
        ).fetchall()
        return [_managed_operation_row(row) for row in rows if row is not None]

    def count_managed_operations_in_state(
        self, *, runtime_scope: str, state: str
    ) -> int:
        row = self._conn.execute(
            "SELECT COUNT(*) AS count FROM managed_operation WHERE runtime_scope = ? AND state = ?",
            (runtime_scope, state),
        ).fetchone()
        return int(row["count"] if row is not None else 0)

    def managed_operation_storage_usage(self) -> dict[str, int]:
        row = self._conn.execute("""
            SELECT
              COALESCE((SELECT SUM(size_bytes) FROM managed_operation_result), 0)
                AS retained_bytes,
              COALESCE((SELECT SUM(result_reservation_bytes) FROM managed_operation), 0)
                AS reserved_bytes,
              (SELECT COUNT(*) FROM managed_operation_result) AS retained_count,
              (SELECT COUNT(*) FROM managed_operation
               WHERE result_reservation_bytes > 0) AS reserved_count
            """).fetchone()
        return {
            "retained_bytes": int(row["retained_bytes"] if row is not None else 0),
            "reserved_bytes": int(row["reserved_bytes"] if row is not None else 0),
            "retained_count": int(row["retained_count"] if row is not None else 0),
            "reserved_count": int(row["reserved_count"] if row is not None else 0),
        }

    def transition_managed_operation(
        self,
        operation_id: str,
        *,
        expected_states: set[str] | frozenset[str],
        state: str,
        owner_instance_id: str,
        now: float,
        history_expires_at: float | None = None,
        result_expires_at: float | None = None,
        result_status: str | None = None,
        clear_result_reservation: bool = False,
        error: dict[str, object] | None = None,
        mark_started: bool = False,
        mark_cancel_requested: bool = False,
        mark_settled: bool = False,
    ) -> ManagedOperationRow | None:
        if not expected_states:
            return None
        placeholders = ",".join("?" for _ in expected_states)
        values: list[Any] = [
            state,
            owner_instance_id,
            now,
            now if mark_started else None,
            now if mark_cancel_requested else None,
            now if mark_settled else None,
            history_expires_at,
            result_expires_at,
            result_status,
            1 if clear_result_reservation else 0,
            json.dumps(error, sort_keys=True) if error is not None else None,
            operation_id,
            owner_instance_id,
            *sorted(expected_states),
        ]
        cursor = self._conn.execute(
            f"""
            UPDATE managed_operation
            SET state = ?, owner_instance_id = ?, version = version + 1,
                updated_at = ?,
                started_at = COALESCE(started_at, ?),
                cancel_requested_at = COALESCE(cancel_requested_at, ?),
                settled_at = COALESCE(settled_at, ?),
                history_expires_at = COALESCE(?, history_expires_at),
                result_expires_at = COALESCE(?, result_expires_at),
                result_status = COALESCE(?, result_status),
                result_reservation_bytes = CASE WHEN ? THEN 0 ELSE result_reservation_bytes END,
                error_json = ?
            WHERE id = ? AND owner_instance_id = ? AND state IN ({placeholders})
            """,
            values,
        )
        self._commit()
        if not cursor.rowcount:
            return None
        return self.get_managed_operation(operation_id)

    def interrupt_managed_operations(
        self,
        *,
        runtime_scope: str,
        previous_owner_instance_id: str,
        new_owner_instance_id: str,
        now: float,
    ) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            """
            SELECT id FROM managed_operation
            WHERE runtime_scope = ? AND owner_instance_id = ?
              AND state IN ('queued','running','stopping')
            """,
            (runtime_scope, previous_owner_instance_id),
        ).fetchall()
        recovered: list[dict[str, Any]] = []
        error = {
            "code": "OWNER_INTERRUPTED",
            "message": "The managed runtime stopped before this operation settled.",
        }
        for row in rows:
            operation_id = row["id"]
            updated = self._conn.execute(
                """
                UPDATE managed_operation
                SET state = 'interrupted', owner_instance_id = ?,
                    version = version + 1, updated_at = ?, settled_at = ?,
                    result_reservation_bytes = 0, error_json = ?
                WHERE id = ? AND owner_instance_id = ?
                  AND state IN ('queued','running','stopping')
                """,
                (
                    new_owner_instance_id,
                    now,
                    now,
                    json.dumps(error, sort_keys=True),
                    operation_id,
                    previous_owner_instance_id,
                ),
            )
            if updated.rowcount:
                self.insert_managed_operation_action(
                    operation_id=operation_id,
                    action="owner_reconciled",
                    actor_kind="system",
                    actor_id=new_owner_instance_id,
                    channel="runtime",
                    outcome="interrupted",
                    recorded_at=now,
                )
                value = self.get_managed_operation(operation_id)
                if value is not None:
                    recovered.append(value)
        self._commit()
        return recovered

    def put_managed_operation_result(
        self,
        operation_id: str,
        *,
        payload: dict[str, Any],
        size_bytes: int,
        result_schema_version: int = 1,
    ) -> None:
        self._conn.execute(
            """
            INSERT INTO managed_operation_result (
              operation_id, payload_json, size_bytes, result_schema_version
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT(operation_id) DO UPDATE SET
              payload_json = excluded.payload_json,
              size_bytes = excluded.size_bytes,
              result_schema_version = excluded.result_schema_version
            """,
            (
                operation_id,
                json.dumps(payload, sort_keys=True, separators=(",", ":")),
                size_bytes,
                result_schema_version,
            ),
        )
        self._commit()

    def get_managed_operation_result(self, operation_id: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM managed_operation_result WHERE operation_id = ?",
            (operation_id,),
        ).fetchone()
        return _row_to_dict(row)

    def delete_managed_operation_result(self, operation_id: str) -> bool:
        cursor = self._conn.execute(
            "DELETE FROM managed_operation_result WHERE operation_id = ?",
            (operation_id,),
        )
        self._commit()
        return bool(cursor.rowcount)

    def mark_managed_operation_result_released(
        self, operation_id: str, *, runtime_scope: str, now: float
    ) -> ManagedOperationRow | None:
        cursor = self._conn.execute(
            """
            UPDATE managed_operation
            SET result_status = 'released', version = version + 1, updated_at = ?
            WHERE id = ? AND runtime_scope = ? AND state = 'succeeded'
              AND result_status = 'available'
            """,
            (now, operation_id, runtime_scope),
        )
        self._commit()
        if not cursor.rowcount:
            return None
        return self.get_managed_operation(operation_id)

    def admit_managed_document_action(
        self,
        *,
        operation_id: str,
        runtime_scope: str,
        action_id: str,
        actor_kind: str,
        actor_id: str,
        channel: str,
        target_document_id: str,
        native_owner_instance_id: str,
        request_sha256: str,
        recorded_at: float,
        max_pending: int,
    ) -> ManagedDocumentActionAdmission:
        """Bound admission after the service has authenticated its caller."""
        if (
            not isinstance(max_pending, int)
            or isinstance(max_pending, bool)
            or max_pending < 1
        ):
            raise ValueError("Pending document action capacity must be positive")
        if (actor_kind, channel) not in {
            ("human", "desktop_ui"),
            ("human", "managed_cli"),
            ("agent", "agent"),
        }:
            raise ValueError("Document action actor and channel are inconsistent")
        if any(
            not value.strip()
            for value in (
                action_id,
                actor_id,
                target_document_id,
                native_owner_instance_id,
            )
        ):
            raise ValueError("Document action identities must not be empty")
        if (
            len(action_id) > 128
            or len(actor_id) > 256
            or len(target_document_id) > 1024
            or len(native_owner_instance_id) > 128
            or not request_sha256.startswith("sha256:")
            or len(request_sha256) != 71
            or any(value not in "0123456789abcdef" for value in request_sha256[7:])
        ):
            raise ValueError("Document action identity or request digest is invalid")
        with self.transaction():
            operation = self.get_managed_operation(operation_id)
            if operation is None or operation["runtime_scope"] != runtime_scope:
                return ManagedDocumentActionAdmission("not_found")
            existing = _row_to_dict(
                self._conn.execute(
                    "SELECT * FROM managed_operation_action WHERE id = ?", (action_id,)
                ).fetchone()
            )
            if existing is not None:
                details = existing["details_json"]
                matches = (
                    isinstance(details, dict)
                    and existing["operation_id"] == operation_id
                    and existing["action"] == "apply_to_document"
                    and existing["actor_kind"] == actor_kind
                    and existing["actor_id"] == actor_id
                    and existing["channel"] == channel
                    and details.get("target_document_id") == target_document_id
                    and details.get("request_sha256") == request_sha256
                )
                return ManagedDocumentActionAdmission(
                    "existing" if matches else "conflict", existing if matches else None
                )
            if operation["subject_id"] != target_document_id:
                return ManagedDocumentActionAdmission("conflict")
            if (
                operation["state"] != "succeeded"
                or operation["result_status"] != "available"
                or self.get_managed_operation_result(operation_id) is None
            ):
                return ManagedDocumentActionAdmission("unavailable")
            if self.has_pending_managed_document_action(operation_id):
                return ManagedDocumentActionAdmission("busy")
            pending = self._conn.execute(
                """
                SELECT COUNT(*) FROM managed_operation_action action
                JOIN managed_operation operation ON operation.id = action.operation_id
                WHERE operation.runtime_scope = ? AND action.outcome IN (?, ?, ?)
                """,
                (runtime_scope, *PENDING_MANAGED_DOCUMENT_ACTION_OUTCOMES),
            ).fetchone()[0]
            if pending >= max_pending:
                return ManagedDocumentActionAdmission("full")
            self.insert_managed_operation_action(
                operation_id=operation_id,
                action="apply_to_document",
                actor_kind=actor_kind,
                actor_id=actor_id,
                channel=channel,
                outcome="document_admitted",
                recorded_at=recorded_at,
                action_id=action_id,
                details={
                    "target_document_id": target_document_id,
                    "native_owner_instance_id": native_owner_instance_id,
                    "request_sha256": request_sha256,
                    "admitted_at": recorded_at,
                },
            )
            record = _row_to_dict(
                self._conn.execute(
                    "SELECT * FROM managed_operation_action WHERE id = ?", (action_id,)
                ).fetchone()
            )
            return ManagedDocumentActionAdmission("admitted", record)

    def has_pending_managed_document_action(self, operation_id: str) -> bool:
        row = self._conn.execute(
            """
            SELECT 1 FROM managed_operation_action
            WHERE operation_id = ? AND outcome IN (?, ?, ?)
            LIMIT 1
            """,
            (operation_id, *PENDING_MANAGED_DOCUMENT_ACTION_OUTCOMES),
        ).fetchone()
        return row is not None

    def get_managed_operation_action(self, action_id: str) -> dict[str, Any] | None:
        return _row_to_dict(
            self._conn.execute(
                "SELECT * FROM managed_operation_action WHERE id = ?", (action_id,)
            ).fetchone()
        )

    def page_pending_managed_document_actions(
        self,
        *,
        runtime_scope: str,
        limit: int = 32,
        after_action_id: str | None = None,
    ) -> tuple[list[dict[str, Any]], str | None]:
        if (
            isinstance(limit, bool)
            or not isinstance(limit, int)
            or not 1 <= limit <= 32
        ):
            raise ValueError("Pending document pages must contain 1 to 32 actions")
        if after_action_id is not None and (
            not isinstance(after_action_id, str) or not 1 <= len(after_action_id) <= 128
        ):
            raise ValueError("The pending action cursor is invalid")
        rows = self._conn.execute(
            """
            SELECT action.*, operation.kind AS operation_kind
            FROM managed_operation_action action
            JOIN managed_operation operation ON operation.id = action.operation_id
            WHERE operation.runtime_scope = ? AND action.action = 'apply_to_document'
              AND action.outcome IN (?, ?, ?) AND action.id > ?
            ORDER BY action.id LIMIT ?
            """,
            (
                runtime_scope,
                *PENDING_MANAGED_DOCUMENT_ACTION_OUTCOMES,
                after_action_id or "",
                limit + 1,
            ),
        ).fetchall()
        next_action_id = rows[limit - 1]["id"] if len(rows) > limit else None
        return [_row_to_dict(row) for row in rows[:limit]], next_action_id

    def transition_managed_document_action(
        self,
        *,
        action_id: str,
        expected_outcome: str,
        outcome: str,
        details: dict[str, Any],
    ) -> dict[str, Any] | None:
        with self.transaction():
            cursor = self._conn.execute(
                """
                UPDATE managed_operation_action SET outcome = ?, details_json = ?
                WHERE id = ? AND action = 'apply_to_document' AND outcome = ?
                """,
                (
                    outcome,
                    json.dumps(details, sort_keys=True),
                    action_id,
                    expected_outcome,
                ),
            )
            if not cursor.rowcount:
                return None
            return self.get_managed_operation_action(action_id)

    def insert_managed_operation_action(
        self,
        *,
        operation_id: str,
        action: str,
        actor_kind: str,
        actor_id: str,
        channel: str,
        outcome: str,
        recorded_at: float,
        details: dict[str, Any] | None = None,
        action_id: str | None = None,
    ) -> str:
        action_id = action_id or new_uuid7()
        with self.transaction():
            self._conn.execute(
                """
                INSERT INTO managed_operation_action (
                  id, operation_id, action, actor_kind, actor_id, channel,
                  outcome, details_json, recorded_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    action_id,
                    operation_id,
                    action,
                    actor_kind,
                    actor_id,
                    channel,
                    outcome,
                    json.dumps(details or {}, sort_keys=True),
                    recorded_at,
                ),
            )
            self._compact_managed_operation_actions(operation_id)
        return action_id

    def _compact_managed_operation_actions(self, operation_id: str) -> int:
        creator = self._conn.execute(
            """
            SELECT id
            FROM managed_operation_action
            WHERE operation_id = ?
            ORDER BY
              CASE
                WHEN action = 'submit' AND outcome = 'accepted' THEN 0
                WHEN action = 'import_recorded' AND outcome = 'imported' THEN 0
                ELSE 1
              END,
              recorded_at,
              id
            LIMIT 1
            """,
            (operation_id,),
        ).fetchone()
        if creator is None:
            return 0
        obsolete = self._conn.execute(
            """
            SELECT id
            FROM managed_operation_action
            WHERE operation_id = ? AND id <> ?
              AND outcome NOT IN (?, ?, ?)
            ORDER BY recorded_at DESC, id DESC
            LIMIT -1 OFFSET ?
            """,
            (
                operation_id,
                creator["id"],
                *PENDING_MANAGED_DOCUMENT_ACTION_OUTCOMES,
                MAX_MANAGED_OPERATION_ACTIONS_PER_OPERATION - 1,
            ),
        ).fetchall()
        if not obsolete:
            return 0
        self._conn.executemany(
            "DELETE FROM managed_operation_action WHERE id = ?",
            [(row["id"],) for row in obsolete],
        )
        self._conn.execute(
            """
            UPDATE managed_operation
            SET action_omitted_count = action_omitted_count + ?
            WHERE id = ?
            """,
            (len(obsolete), operation_id),
        )
        return len(obsolete)

    def list_managed_operation_actions(
        self, operation_id: str, *, limit: int = 200
    ) -> list[dict[str, Any]]:
        rows, _total, _next_offset, _omitted_count = (
            self.page_managed_operation_actions(operation_id, limit=limit, offset=0)
        )
        return rows

    def page_managed_operation_actions(
        self,
        operation_id: str,
        *,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[dict[str, Any]], int, int | None, int]:
        safe_limit = max(1, min(limit, 200))
        safe_offset = max(0, offset)
        with self.transaction():
            count_row = self._conn.execute(
                """
                SELECT
                  (SELECT COUNT(*) FROM managed_operation_action
                   WHERE operation_id = ?) AS count,
                  COALESCE(
                    (SELECT action_omitted_count FROM managed_operation WHERE id = ?),
                    0
                  ) AS omitted_count
                """,
                (operation_id, operation_id),
            ).fetchone()
            rows = self._conn.execute(
                """
                SELECT * FROM managed_operation_action
                WHERE operation_id = ?
                ORDER BY recorded_at, id
                LIMIT ? OFFSET ?
                """,
                (operation_id, safe_limit + 1, safe_offset),
            ).fetchall()
        total = int(count_row["count"] if count_row is not None else 0)
        omitted_count = int(count_row["omitted_count"] if count_row is not None else 0)
        has_more = len(rows) > safe_limit
        values = [_row_to_dict(row) for row in rows[:safe_limit] if row is not None]
        next_offset = safe_offset + len(values) if has_more else None
        return values, total, next_offset, omitted_count

    def link_agent_action_to_managed_operation(
        self, action_id: str, operation_id: str
    ) -> bool:
        cursor = self._conn.execute(
            "UPDATE agent_action SET managed_operation_id = ? WHERE id = ?",
            (operation_id, action_id),
        )
        self._commit()
        return bool(cursor.rowcount)

    def link_agent_action_operation(self, action_id: str, operation_id: str) -> bool:
        return self.link_agent_action_to_managed_operation(action_id, operation_id)

    def prune_managed_operations(
        self,
        *,
        runtime_scope: str,
        now: float,
        max_terminal_history: int,
    ) -> list[str]:
        with self.transaction():
            del now
            retained = self._conn.execute(
                """
                SELECT id FROM managed_operation
                WHERE runtime_scope = ?
                  AND state IN ('succeeded','failed','canceled','interrupted')
                  AND input_retention_state IN ('none','released')
                  AND NOT EXISTS (
                    SELECT 1 FROM managed_operation_result
                    WHERE managed_operation_result.operation_id = managed_operation.id
                  )
                ORDER BY settled_at DESC, id DESC
                LIMIT -1 OFFSET ?
                """,
                (runtime_scope, max(1, max_terminal_history)),
            ).fetchall()
            if retained:
                self._conn.executemany(
                    "DELETE FROM managed_operation WHERE id = ?",
                    [(row["id"],) for row in retained],
                )
        return [str(row["id"]) for row in retained]

    def ensure_agent_identity(
        self,
        identity_id: str,
        *,
        parent_human_identity_id: str = "local-human",
        scope: list[str] | None = None,
        expires_at: str | None = None,
        revoked: bool = False,
        label: str | None = None,
        kind: str | None = None,
        api_key_hash: str | None = None,
        created_at: str | None = None,
        revoked_at: str | None = None,
        origin: str | None = None,
        environment_id: str | None = None,
        created_by: str | None = None,
    ) -> None:
        scope_json = json.dumps(scope or [], sort_keys=True)
        created_at = created_at or utc_now()
        revoked_at = revoked_at or (utc_now() if revoked else None)
        self._conn.execute(
            """
            INSERT INTO agent_identity (
              id, parent_human_identity_id, scope_json, expires_at, revoked,
              label, kind, api_key_hash, created_at, revoked_at,
              origin, environment_id, created_by
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO NOTHING
            """,
            (
                identity_id,
                parent_human_identity_id,
                scope_json,
                expires_at,
                1 if revoked else 0,
                label,
                kind,
                api_key_hash,
                created_at,
                revoked_at,
                origin,
                environment_id,
                created_by,
            ),
        )
        self._commit()

    def widen_managed_agent_identity_scope(
        self,
        identity_id: str,
        *,
        capabilities: list[str],
        environment_id: str | None = None,
    ) -> bool:
        """Add capabilities to an active product-owned in-app identity.

        This deliberately cannot revive a revoked identity or modify an API-key
        identity. It exists for product-managed grants whose shipped default
        catalog grows over time; user-created external grants remain exactly as
        narrow as the user requested.
        """
        row = self._conn.execute(
            """
            SELECT scope_json
            FROM agent_identity
            WHERE id = ?
              AND revoked = 0
              AND api_key_hash IS NULL
              AND (kind IS NULL OR kind = 'in-app')
              AND (origin IS NULL OR origin = 'app')
            """,
            (identity_id,),
        ).fetchone()
        if row is None:
            return False

        existing_scope = json.loads(row["scope_json"] or "[]")
        widened_scope = sorted({*existing_scope, *capabilities})
        self._conn.execute(
            """
            UPDATE agent_identity
            SET scope_json = ?,
                label = COALESCE(label, 'In-app Strider'),
                kind = 'in-app',
                origin = 'app',
                environment_id = COALESCE(environment_id, ?)
            WHERE id = ?
              AND revoked = 0
              AND api_key_hash IS NULL
              AND (kind IS NULL OR kind = 'in-app')
              AND (origin IS NULL OR origin = 'app')
            """,
            (
                json.dumps(widened_scope, sort_keys=True),
                environment_id,
                identity_id,
            ),
        )
        self._commit()
        return True

    def authorize_local_mcp_discovery(
        self, identity_id: str, *, environment_id: str
    ) -> bool:
        """Record explicit owner approval for one local client's discovery access.

        This management operation is never called by agent authentication or
        dispatch. It preserves the existing key and workspace binding, cannot
        revive a revoked grant, and cannot change other grant classes or profiles.
        """
        with self.transaction():
            row = self._conn.execute(
                """
                SELECT scope_json FROM agent_identity
                WHERE id = ? AND environment_id = ? AND revoked = 0
                  AND kind = 'stdio-mcp' AND origin = 'local-mcp'
                  AND created_by = 'app-owned-mcp-bootstrap'
                  AND api_key_hash IS NOT NULL
                """,
                (identity_id, environment_id),
            ).fetchone()
            if row is None:
                return False
            scopes = json.loads(row["scope_json"] or "[]")
            if not isinstance(scopes, list) or not all(
                isinstance(scope, str) for scope in scopes
            ):
                return False
            scopes = sorted({*scopes, "external-compute:discover"})
            cursor = self._conn.execute(
                """
                UPDATE agent_identity SET scope_json = ?, expires_at = NULL
                WHERE id = ? AND environment_id = ? AND revoked = 0
                  AND kind = 'stdio-mcp' AND origin = 'local-mcp'
                  AND created_by = 'app-owned-mcp-bootstrap'
                  AND api_key_hash IS NOT NULL
                """,
                (json.dumps(scopes, sort_keys=True), identity_id, environment_id),
            )
            return cursor.rowcount == 1

    def get_agent_identity(self, identity_id: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM agent_identity WHERE id = ?", (identity_id,)
        ).fetchone()
        return _row_to_dict(row)

    def get_agent_identity_by_api_key_hash(
        self, api_key_hash: str
    ) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM agent_identity WHERE api_key_hash = ?",
            (api_key_hash,),
        ).fetchone()
        return _row_to_dict(row)

    def update_agent_identity_client(
        self, identity_id: str, *, client_name: str, client_version: str
    ) -> bool:
        cursor = self._conn.execute(
            """
            UPDATE agent_identity
            SET client_name = ?, client_version = ?
            WHERE id = ? AND revoked = 0
            """,
            (client_name, client_version, identity_id),
        )
        self._commit()
        return cursor.rowcount == 1

    def bind_local_mcp_workspace(
        self, identity_id: str, *, workspace_id: str, workspace_label: str
    ) -> bool:
        cursor = self._conn.execute(
            """
            UPDATE agent_identity
            SET bound_workspace_roots_json = CASE
                  WHEN bound_workspace_id = ? AND bound_workspace_roots_json IS NOT NULL
                  THEN bound_workspace_roots_json ELSE ? END,
                bound_workspace_id = ?, bound_workspace_label = ?
            WHERE id = ? AND kind = 'stdio-mcp' AND origin = 'local-mcp'
              AND revoked = 0
              AND (expires_at IS NULL OR julianday(expires_at) >= julianday('now'))
            """,
            (
                workspace_id,
                json.dumps(snapshot_workspace_roots(workspace_id)),
                workspace_id,
                workspace_label,
                identity_id,
            ),
        )
        self._commit()
        return cursor.rowcount == 1

    def create_agent_identity(
        self,
        *,
        identity_id: str,
        parent_human_identity_id: str = "local-human",
        scope: list[str] | None = None,
        expires_at: str | None = None,
        label: str | None = None,
        kind: str | None = None,
        api_key_hash: str | None = None,
        created_at: str | None = None,
        origin: str | None = None,
        environment_id: str | None = None,
        created_by: str | None = None,
    ) -> None:
        scope_json = json.dumps(scope or [], sort_keys=True)
        self._conn.execute(
            """
            INSERT INTO agent_identity (
              id, parent_human_identity_id, scope_json, expires_at, revoked,
              label, kind, api_key_hash, created_at, revoked_at,
              origin, environment_id, created_by
            )
            VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, NULL, ?, ?, ?)
            """,
            (
                identity_id,
                parent_human_identity_id,
                scope_json,
                expires_at,
                label,
                kind,
                api_key_hash,
                created_at or utc_now(),
                origin,
                environment_id,
                created_by,
            ),
        )
        self._commit()

    def list_agent_identities(
        self, *, include_revoked: bool = False, limit: int = 200
    ) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            """
            SELECT
              ai.*,
              usage.last_used_at
            FROM agent_identity ai
            LEFT JOIN (
              SELECT agent_identity_id, MAX(requested_at) AS last_used_at
              FROM agent_action
              GROUP BY agent_identity_id
            ) usage ON usage.agent_identity_id = ai.id
            WHERE (? = 1 OR ai.revoked = 0)
            ORDER BY
              COALESCE(usage.last_used_at, ai.created_at, '') DESC,
              ai.id ASC
            LIMIT ?
            """,
            (1 if include_revoked else 0, limit),
        ).fetchall()
        return [_row_to_dict(row) for row in rows if row is not None]

    def list_active_agent_identities_for_settings(
        self,
        *,
        include_development: bool,
        managed_identity_id: str | None,
        limit: int,
        after: tuple[str, str] | None = None,
    ) -> list[dict[str, Any]]:
        if limit < 1 or limit > 201:
            raise ValueError("settings grant page limit must be between 1 and 201")
        rows = self._conn.execute(
            _ACTIVE_SETTINGS_AGENT_IDENTITIES_CTE + """
            SELECT *
            FROM classified
            WHERE revoked = 0
              AND (
                expires_at IS NULL
                OR (
                  julianday(expires_at) IS NOT NULL
                  AND julianday(expires_at) >= julianday('now')
                )
              )
              AND (? = 1 OR effective_origin != 'dev-test')
              AND (? IS NULL OR sort_at < ? OR (sort_at = ? AND id > ?))
            ORDER BY sort_at DESC, id ASC
            LIMIT ?
            """,
            (
                managed_identity_id,
                1 if include_development else 0,
                after[0] if after else None,
                after[0] if after else None,
                after[0] if after else None,
                after[1] if after else None,
                limit,
            ),
        ).fetchall()
        return [_row_to_dict(row) for row in rows if row is not None]

    def count_active_development_agent_identities(
        self, *, managed_identity_id: str | None
    ) -> int:
        row = self._conn.execute(
            _ACTIVE_SETTINGS_AGENT_IDENTITIES_CTE + """
            SELECT COUNT(*) AS grant_count
            FROM classified
            WHERE revoked = 0
              AND effective_origin = 'dev-test'
              AND (
                expires_at IS NULL
                OR (
                  julianday(expires_at) IS NOT NULL
                  AND julianday(expires_at) >= julianday('now')
                )
              )
            """,
            (managed_identity_id,),
        ).fetchone()
        return int(row["grant_count"] if row is not None else 0)

    def revoke_agent_identity(self, identity_id: str) -> bool:
        row = self._conn.execute(
            "SELECT id FROM agent_identity WHERE id = ?", (identity_id,)
        ).fetchone()
        if row is None:
            return False
        self._conn.execute(
            """
            UPDATE agent_identity
            SET revoked = 1, revoked_at = COALESCE(revoked_at, ?)
            WHERE id = ?
            """,
            (utc_now(), identity_id),
        )
        self._commit()
        return True

    def insert_agent_action(
        self,
        *,
        agent_identity_id: str,
        tool_name: str,
        parameters: dict[str, Any],
        authorized_scope: list[str] | None = None,
        action_id: str | None = None,
        authorization_state: str = "granted",
        parent_action_id: str | None = None,
        root_action_id: str | None = None,
        job_pool: str | None = None,
        job_cancelable: bool | None = None,
        job_duration: str | None = None,
        job_turn_id: str | None = None,
        idempotency_key_hash: str | None = None,
        idempotency_body_hash: str | None = None,
    ) -> str:
        action_id = action_id or new_uuid7()
        root_action_id = root_action_id or action_id
        if authorized_scope is None:
            identity = self.get_agent_identity(agent_identity_id)
            identity_scope = identity.get("scope_json") if identity else []
            authorized_scope = (
                identity_scope if isinstance(identity_scope, list) else []
            )
        self._conn.execute(
            """
            INSERT INTO agent_action (
              id, agent_identity_id, tool_name, parameters_json, authorized_scope_json,
              requested_at, authorization_state, parent_action_id, root_action_id,
              job_pool, job_cancelable, job_duration, job_turn_id,
              idempotency_key_hash, idempotency_body_hash
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                action_id,
                agent_identity_id,
                tool_name,
                json.dumps(parameters, sort_keys=True),
                json.dumps(authorized_scope, sort_keys=True),
                utc_now(),
                authorization_state,
                parent_action_id,
                root_action_id,
                job_pool,
                None if job_cancelable is None else int(job_cancelable),
                job_duration,
                job_turn_id,
                idempotency_key_hash,
                idempotency_body_hash,
            ),
        )
        self._commit()
        return action_id

    def complete_agent_action(
        self,
        action_id: str,
        *,
        result: dict[str, Any] | None = None,
        error: dict[str, Any] | None = None,
        terminal_expires_at: float | None = None,
    ) -> None:
        self._conn.execute(
            """
            UPDATE agent_action
            SET result_json = ?, error_json = ?, completed_at = ?, terminal_expires_at = ?
            WHERE id = ?
            """,
            (
                json.dumps(result, sort_keys=True) if result is not None else None,
                json.dumps(error, sort_keys=True) if error is not None else None,
                utc_now(),
                terminal_expires_at,
                action_id,
            ),
        )
        if error is None and isinstance(result, dict) and result.get("ok") is True:
            payload = result.get("result")
            action = self.get_agent_action(action_id)
            if (
                action
                and action["tool_name"] == "create_design"
                and action["authorization_state"] in {"granted", "approved"}
                and isinstance(payload, dict)
                and isinstance(payload.get("designId"), str)
                and payload["designId"]
            ):
                self._conn.execute(
                    "INSERT OR IGNORE INTO agent_design_authority VALUES (?, ?, ?)",
                    (payload["designId"], action["agent_identity_id"], action_id),
                )
        self._commit()

    def agent_design_owner(self, design_id: str) -> str | None:
        row = self._conn.execute(
            "SELECT agent_identity_id FROM agent_design_authority WHERE design_id = ?",
            (design_id,),
        ).fetchone()
        if row:
            return str(row["agent_identity_id"])
        rows = self._conn.execute(
            """SELECT agent_identity_id, MIN(id) AS create_action_id FROM agent_action
               WHERE tool_name = 'create_design' AND completed_at IS NOT NULL
                 AND error_json IS NULL AND authorization_state IN ('granted', 'approved')
                 AND json_extract(result_json, '$.ok') = 1
                 AND json_extract(result_json, '$.result.designId') = ?
               GROUP BY agent_identity_id LIMIT 2""",
            (design_id,),
        ).fetchall()
        if len(rows) != 1:
            return None
        owner = str(rows[0]["agent_identity_id"])
        self._conn.execute(
            "INSERT OR IGNORE INTO agent_design_authority VALUES (?, ?, ?)",
            (design_id, owner, rows[0]["create_action_id"]),
        )
        self._commit()
        return owner

    def agent_has_new_design_preview(
        self, agent_identity_id: str, design_id: str, version: int, fingerprint: str
    ) -> bool:
        row = self._conn.execute(
            """SELECT 1 FROM agent_action
               WHERE agent_identity_id = ? AND tool_name = 'preview_finalize_design_assembly'
                 AND completed_at IS NOT NULL AND error_json IS NULL
                 AND authorization_state IN ('granted', 'approved')
                 AND json_extract(result_json, '$.ok') = 1
                 AND json_extract(result_json, '$.result.canFinalize') = 1
                 AND json_extract(result_json, '$.result.createsNewConstruct') = 1
                 AND json_extract(result_json, '$.result.designId') = ?
                 AND json_extract(result_json, '$.result.expectedDesignVersion') = ?
                 AND json_extract(result_json, '$.result.previewFingerprint') = ?
               LIMIT 1""",
            (agent_identity_id, design_id, version, fingerprint),
        ).fetchone()
        return row is not None

    def reconcile_interrupted_agent_action(
        self,
        action_id: str,
        *,
        error: dict[str, Any],
        terminal_expires_at: float,
    ) -> dict[str, Any] | None:
        """Retain one ownerless action without overwriting a later real outcome.

        A second sidecar can observe an unfinished row after the process that
        admitted it disappeared. The conditional update makes that recovery
        safe against a terminal write that wins the race. An already unresolved
        row may renew its result-lookup window while preserving the same action
        identity.
        """

        self._conn.execute(
            """
            UPDATE agent_action
            SET result_json = NULL, error_json = ?, completed_at = ?, terminal_expires_at = ?
            WHERE id = ?
              AND (completed_at IS NULL
                OR json_extract(error_json, '$.code') = 'OUTCOME_UNRESOLVED')
            """,
            (
                json.dumps(error, sort_keys=True),
                utc_now(),
                terminal_expires_at,
                action_id,
            ),
        )
        self._commit()
        return self.get_agent_action(action_id)

    def get_retained_agent_action_by_idempotency_hash(
        self,
        agent_identity_id: str,
        key_hash: str,
        *,
        now: float,
        include_unresolved: bool = False,
    ) -> dict[str, Any] | None:
        row = self._conn.execute(
            """
            SELECT * FROM agent_action
            WHERE agent_identity_id = ?
              AND idempotency_key_hash = ?
              AND ((terminal_expires_at > ? AND completed_at IS NOT NULL)
                OR (? AND (completed_at IS NULL
                  OR json_extract(error_json, '$.code') = 'OUTCOME_UNRESOLVED')))
            ORDER BY requested_at DESC
            LIMIT 1
            """,
            (agent_identity_id, key_hash, now, include_unresolved),
        ).fetchone()
        return _row_to_dict(row)

    def insert_audit_record(
        self,
        *,
        action_id: str,
        actor_kind: str,
        actor_identity: str,
        actor_scope: list[str] | None = None,
        side_effects: list[dict[str, Any]] | None = None,
        capability_check: dict[str, Any] | None = None,
        before_state: dict[str, Any] | None = None,
        after_state: dict[str, Any] | None = None,
        plugin_identity_id: str | None = None,
        audit_id: str | None = None,
    ) -> str:
        audit_id = audit_id or new_uuid7()
        self._conn.execute(
            """
            INSERT INTO audit_record (
              id, action_id, actor_kind, actor_identity, actor_scope_json,
              before_state_json, after_state_json, side_effects_json,
              capability_check_json, plugin_identity_id, recorded_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                audit_id,
                action_id,
                actor_kind,
                actor_identity,
                json.dumps(actor_scope or [], sort_keys=True),
                (
                    json.dumps(before_state, sort_keys=True)
                    if before_state is not None
                    else None
                ),
                (
                    json.dumps(after_state, sort_keys=True)
                    if after_state is not None
                    else None
                ),
                json.dumps(side_effects or [], sort_keys=True),
                json.dumps(capability_check or {}, sort_keys=True),
                plugin_identity_id,
                utc_now(),
            ),
        )
        self._commit()
        return audit_id

    def insert_agent_artifact(
        self,
        *,
        agent_identity_id: str,
        kind: str,
        name: str,
        action_id: str | None = None,
        description: str | None = None,
        path: str | None = None,
        source_uri: str | None = None,
        resource_uri: str | None = None,
        mime_type: str | None = None,
        size_bytes: int | None = None,
        sha256: str | None = None,
        metadata: dict[str, Any] | None = None,
        provenance: dict[str, Any] | None = None,
        tags: list[str] | None = None,
        artifact_id: str | None = None,
    ) -> str:
        artifact_id = artifact_id or new_uuid7()
        resource_uri = resource_uri or f"waypoint://artifact/{artifact_id}"
        self._conn.execute(
            """
            INSERT INTO agent_artifact (
              id, agent_identity_id, action_id, kind, name, description, path,
              source_uri, resource_uri, mime_type, size_bytes, sha256,
              metadata_json, provenance_json, tags_json, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                artifact_id,
                agent_identity_id,
                action_id,
                kind,
                name,
                description,
                path,
                source_uri,
                resource_uri,
                mime_type,
                size_bytes,
                sha256,
                json.dumps(metadata or {}, sort_keys=True),
                json.dumps(provenance or {}, sort_keys=True),
                json.dumps(tags or [], sort_keys=True),
                utc_now(),
            ),
        )
        self._commit()
        return artifact_id

    def upsert_agent_artifact_for_action(
        self,
        *,
        agent_identity_id: str,
        action_id: str,
        kind: str,
        name: str,
        description: str | None = None,
        path: str | None = None,
        source_uri: str | None = None,
        mime_type: str | None = None,
        size_bytes: int | None = None,
        sha256: str | None = None,
        metadata: dict[str, Any] | None = None,
        provenance: dict[str, Any] | None = None,
        tags: list[str] | None = None,
    ) -> str:
        """— idempotent agent_artifact insert keyed on (action_id, name).

        Retries of the same external.fetch (transient network blip, sidecar
        restart) MUST resolve to one artifact row, not many. Backed by the
        partial UNIQUE index `agent_artifact_action_name_unique` which is
        defined `WHERE action_id IS NOT NULL` — so this method REQUIRES a
        non-null action_id. Callers needing action-less artifacts must use
        `insert_agent_artifact` instead.

        Returns the resolved artifact id (the existing row's id on conflict,
        or the freshly-minted id on first insert).
        """
        if not action_id:

            raise ValueError(
                "upsert_agent_artifact_for_action requires a non-null action_id; "
                "use insert_agent_artifact for action-less artifacts."
            )
        artifact_id = new_uuid7()
        resource_uri = f"waypoint://artifact/{artifact_id}"
        cursor = self._conn.execute(
            """
            INSERT INTO agent_artifact (
              id, agent_identity_id, action_id, kind, name, description, path,
              source_uri, resource_uri, mime_type, size_bytes, sha256,
              metadata_json, provenance_json, tags_json, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(action_id, name) WHERE action_id IS NOT NULL
            DO NOTHING
            RETURNING id
            """,
            (
                artifact_id,
                agent_identity_id,
                action_id,
                kind,
                name,
                description,
                path,
                source_uri,
                resource_uri,
                mime_type,
                size_bytes,
                sha256,
                json.dumps(metadata or {}, sort_keys=True),
                json.dumps(provenance or {}, sort_keys=True),
                json.dumps(tags or [], sort_keys=True),
                utc_now(),
            ),
        )
        row = cursor.fetchone()
        if row is not None:
            self._commit()
            return row["id"]

        existing = self._conn.execute(
            "SELECT id FROM agent_artifact WHERE action_id = ? AND name = ?",
            (action_id, name),
        ).fetchone()
        if existing is None:

            raise RuntimeError(
                f"agent_artifact upsert produced no id for (action_id={action_id!r}, name={name!r})"
            )
        return existing["id"]

    def insert_agent_analysis_run(
        self,
        *,
        agent_identity_id: str,
        name: str,
        status: str,
        command: dict[str, Any],
        action_id: str | None = None,
        resource_uri: str | None = None,
        cwd: str | None = None,
        inputs: list[dict[str, Any]] | None = None,
        outputs: list[dict[str, Any]] | None = None,
        metrics: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        started_at: str | None = None,
        completed_at: str | None = None,
        analysis_run_id: str | None = None,
    ) -> str:
        analysis_run_id = analysis_run_id or new_uuid7()
        resource_uri = resource_uri or f"waypoint://analysis-run/{analysis_run_id}"
        self._conn.execute(
            """
            INSERT INTO agent_analysis_run (
              id, agent_identity_id, action_id, name, status, resource_uri,
              command_json, cwd, inputs_json, outputs_json, metrics_json,
              metadata_json, started_at, completed_at, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                analysis_run_id,
                agent_identity_id,
                action_id,
                name,
                status,
                resource_uri,
                json.dumps(command, sort_keys=True),
                cwd,
                json.dumps(inputs or [], sort_keys=True),
                json.dumps(outputs or [], sort_keys=True),
                json.dumps(metrics or {}, sort_keys=True),
                json.dumps(metadata or {}, sort_keys=True),
                started_at,
                completed_at,
                utc_now(),
            ),
        )
        self._commit()
        return analysis_run_id

    def insert_agent_resource_link(
        self,
        *,
        agent_identity_id: str,
        source_uri: str,
        target_uri: str,
        relationship: str,
        action_id: str | None = None,
        resource_uri: str | None = None,
        metadata: dict[str, Any] | None = None,
        resource_link_id: str | None = None,
    ) -> str:
        resource_link_id = resource_link_id or new_uuid7()
        resource_uri = resource_uri or f"waypoint://resource-link/{resource_link_id}"
        self._conn.execute(
            """
            INSERT INTO agent_resource_link (
              id, agent_identity_id, action_id, source_uri, target_uri,
              relationship, resource_uri, metadata_json, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                resource_link_id,
                agent_identity_id,
                action_id,
                source_uri,
                target_uri,
                relationship,
                resource_uri,
                json.dumps(metadata or {}, sort_keys=True),
                utc_now(),
            ),
        )
        self._commit()
        return resource_link_id

    def get_agent_action(self, action_id: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM agent_action WHERE id = ?", (action_id,)
        ).fetchone()
        return _row_to_dict(row)

    def page_visible_agent_jobs(
        self,
        *,
        parent_human_identity_id: str,
        environment_id: str,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[dict[str, Any]], int, int, int, int | None]:
        """Return bounded, payload-free agent jobs owned by one human runtime."""

        safe_limit = max(1, min(limit, 200))
        safe_offset = max(0, offset)
        filters = """
            identity.parent_human_identity_id = ?
            AND identity.environment_id = ?
            AND action.job_duration IN ('long-running','streaming')
            AND action.managed_operation_id IS NULL
        """
        with self.transaction():
            count_row = self._conn.execute(
                f"""
                SELECT
                  COUNT(*) AS count,
                  COUNT(*) FILTER (WHERE action.completed_at IS NULL) AS active_count
                FROM agent_action action
                JOIN agent_identity identity ON identity.id = action.agent_identity_id
                WHERE {filters}
                """,
                (parent_human_identity_id, environment_id),
            ).fetchone()
            rows = self._conn.execute(
                f"""
                SELECT
                  action.id,
                  action.agent_identity_id,
                  action.tool_name,
                  action.requested_at,
                  action.job_pool,
                  action.job_cancelable,
                  action.job_duration,
                  action.error_json,
                  action.completed_at,
                  identity.label AS agent_label,
                  identity.kind AS agent_kind
                FROM agent_action action
                JOIN agent_identity identity ON identity.id = action.agent_identity_id
                WHERE {filters}
                ORDER BY
                  action.completed_at IS NOT NULL ASC,
                  action.requested_at DESC,
                  action.id DESC
                LIMIT ? OFFSET ?
                """,
                (
                    parent_human_identity_id,
                    environment_id,
                    safe_limit + 1,
                    safe_offset,
                ),
            ).fetchall()
        total = int(count_row["count"] if count_row is not None else 0)
        active_count = int(count_row["active_count"] if count_row is not None else 0)
        terminal_count = total - active_count
        has_more = len(rows) > safe_limit
        values = [_row_to_dict(row) for row in rows[:safe_limit] if row is not None]
        next_offset = safe_offset + len(values) if has_more else None
        return values, total, active_count, terminal_count, next_offset

    def get_visible_agent_job(
        self,
        action_id: str,
        *,
        parent_human_identity_id: str,
        environment_id: str,
    ) -> dict[str, Any] | None:
        row = self._conn.execute(
            """
            SELECT
              action.id,
              action.agent_identity_id,
              action.tool_name,
              action.requested_at,
              action.job_pool,
              action.job_cancelable,
              action.job_duration,
              action.error_json,
              action.completed_at,
              identity.label AS agent_label,
              identity.kind AS agent_kind
            FROM agent_action action
            JOIN agent_identity identity ON identity.id = action.agent_identity_id
            WHERE action.id = ?
              AND identity.parent_human_identity_id = ?
              AND identity.environment_id = ?
              AND action.job_duration IN ('long-running','streaming')
              AND action.managed_operation_id IS NULL
            """,
            (action_id, parent_human_identity_id, environment_id),
        ).fetchone()
        return _row_to_dict(row)

    def list_incomplete_agent_actions(self) -> list[dict[str, Any]]:
        rows = self._conn.execute("""
            SELECT * FROM agent_action
            WHERE completed_at IS NULL
            ORDER BY requested_at ASC, id ASC
            """).fetchall()
        return [_row_to_dict(row) for row in rows]

    def get_agent_artifact(self, artifact_id: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM agent_artifact WHERE id = ?", (artifact_id,)
        ).fetchone()
        return _row_to_dict(row)

    def get_agent_analysis_run(self, analysis_run_id: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM agent_analysis_run WHERE id = ?", (analysis_run_id,)
        ).fetchone()
        return _row_to_dict(row)

    def get_agent_resource_link(self, resource_link_id: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM agent_resource_link WHERE id = ?", (resource_link_id,)
        ).fetchone()
        return _row_to_dict(row)

    def list_agent_artifacts(
        self,
        limit: int = 100,
        *,
        agent_identity_id: str | None = None,
    ) -> list[dict[str, Any]]:
        safe_limit = max(1, min(limit, 500))
        if agent_identity_id is None:
            rows = self._conn.execute(
                """
                SELECT * FROM agent_artifact
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (safe_limit,),
            ).fetchall()
        else:
            rows = self._conn.execute(
                """
                SELECT * FROM agent_artifact
                WHERE agent_identity_id = ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (agent_identity_id, safe_limit),
            ).fetchall()
        return [_row_to_dict(row) for row in rows if row is not None]

    def list_agent_analysis_runs(
        self,
        limit: int = 100,
        *,
        agent_identity_id: str | None = None,
    ) -> list[dict[str, Any]]:
        safe_limit = max(1, min(limit, 500))
        if agent_identity_id is None:
            rows = self._conn.execute(
                """
                SELECT * FROM agent_analysis_run
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (safe_limit,),
            ).fetchall()
        else:
            rows = self._conn.execute(
                """
                SELECT * FROM agent_analysis_run
                WHERE agent_identity_id = ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (agent_identity_id, safe_limit),
            ).fetchall()
        return [_row_to_dict(row) for row in rows if row is not None]

    def list_agent_resource_links(
        self,
        limit: int = 100,
        *,
        agent_identity_id: str | None = None,
    ) -> list[dict[str, Any]]:
        safe_limit = max(1, min(limit, 500))
        if agent_identity_id is None:
            rows = self._conn.execute(
                """
                SELECT * FROM agent_resource_link
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (safe_limit,),
            ).fetchall()
        else:
            rows = self._conn.execute(
                """
                SELECT * FROM agent_resource_link
                WHERE agent_identity_id = ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (agent_identity_id, safe_limit),
            ).fetchall()
        return [_row_to_dict(row) for row in rows if row is not None]

    def get_audit_records_for_action(self, action_id: str) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT * FROM audit_record WHERE action_id = ? ORDER BY recorded_at",
            (action_id,),
        ).fetchall()
        return [_row_to_dict(row) for row in rows if row is not None]

    def get_actions_for_root(self, root_action_id: str) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT * FROM agent_action WHERE root_action_id = ? ORDER BY requested_at",
            (root_action_id,),
        ).fetchall()
        return [_row_to_dict(row) for row in rows if row is not None]

    def trace_action_chain(self, action_id: str) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            """
            WITH RECURSIVE chain AS (
              SELECT * FROM agent_action WHERE id = ?
              UNION ALL
              SELECT a.* FROM agent_action a JOIN chain c ON a.id = c.parent_action_id
            )
            SELECT * FROM chain
            """,
            (action_id,),
        ).fetchall()
        return [_row_to_dict(row) for row in rows if row is not None]

    def upsert_data_file(
        self,
        *,
        sha256: str,
        byte_size: int,
        mime_type: str | None = None,
        source_url: str | None = None,
        source_provider: str | None = None,
        license: str | None = None,
        attribution: str | None = None,
    ) -> str:
        """Insert a data_file row, or bump last_used_at if it already exists.

        Content-addressed: same sha256 → same row. Re-fetching identical bytes
        is a cheap LRU touch, not a row replacement.
        """
        now = utc_now()
        self._conn.execute(
            """
            INSERT INTO data_file (
              sha256, byte_size, mime_type, source_url, source_provider,
              license, attribution, fetched_at, last_used_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(sha256) DO UPDATE SET
              last_used_at = excluded.last_used_at
            """,
            (
                sha256,
                byte_size,
                mime_type,
                source_url,
                source_provider,
                license,
                attribution,
                now,
                now,
            ),
        )
        self._commit()
        return sha256

    def get_data_file(self, sha256: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM data_file WHERE sha256 = ?", (sha256,)
        ).fetchone()
        return _row_to_dict(row)

    def touch_data_file(self, sha256: str) -> None:
        """Bump last_used_at without otherwise modifying the row (LRU touch)."""
        self._conn.execute(
            "UPDATE data_file SET last_used_at = ? WHERE sha256 = ?",
            (utc_now(), sha256),
        )
        self._commit()

    def list_data_files_by_lru(self, limit: int = 100) -> list[dict[str, Any]]:
        """Oldest-touched first — LRU eviction candidates."""
        safe_limit = max(1, min(limit, 500))
        rows = self._conn.execute(
            "SELECT * FROM data_file ORDER BY last_used_at ASC LIMIT ?",
            (safe_limit,),
        ).fetchall()
        return [_row_to_dict(row) for row in rows if row is not None]

    def upsert_external_resource(
        self,
        *,
        provider: str,
        external_id: str,
        metadata: dict[str, Any],
        external_url: str | None = None,
        data_file_id: str | None = None,
        version_identifier: str | None = None,
        etag: str | None = None,
        license: str | None = None,
        attribution: str | None = None,
        resource_id: str | None = None,
    ) -> str:
        """Idempotent on (provider, external_id) — re-fetching refreshes the row.

        Returns the canonical id (existing or new). Updates fetched_at + last_checked
        on every call so freshness signals propagate even when the provider returned
        the same payload.
        """
        now = utc_now()
        resource_id = resource_id or new_uuid7()

        row = self._conn.execute(
            """
            INSERT INTO external_resource (
              id, provider, external_id, external_url, data_file_id,
              version_identifier, etag, license, attribution, metadata_json,
              fetched_at, last_checked
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(provider, external_id) DO UPDATE SET
              external_url       = COALESCE(excluded.external_url, external_resource.external_url),
              data_file_id       = COALESCE(excluded.data_file_id, external_resource.data_file_id),
              version_identifier = COALESCE(excluded.version_identifier, external_resource.version_identifier),
              etag               = COALESCE(excluded.etag, external_resource.etag),
              license            = COALESCE(excluded.license, external_resource.license),
              attribution        = COALESCE(excluded.attribution, external_resource.attribution),
              metadata_json      = excluded.metadata_json,
              fetched_at         = excluded.fetched_at,
              last_checked       = excluded.last_checked
            RETURNING id
            """,
            (
                resource_id,
                provider,
                external_id,
                external_url,
                data_file_id,
                version_identifier,
                etag,
                license,
                attribution,
                json.dumps(metadata, sort_keys=True),
                now,
                now,
            ),
        ).fetchone()
        self._commit()
        return row["id"]

    def get_external_resource(self, resource_id: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM external_resource WHERE id = ?", (resource_id,)
        ).fetchone()
        return _row_to_dict(row)

    def get_external_resource_by_external_id(
        self, provider: str, external_id: str
    ) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM external_resource WHERE provider = ? AND external_id = ?",
            (provider, external_id),
        ).fetchone()
        return _row_to_dict(row)

    def list_external_resources(
        self, provider: str | None = None, limit: int = 100
    ) -> list[dict[str, Any]]:
        safe_limit = max(1, min(limit, 500))
        if provider:
            rows = self._conn.execute(
                """
                SELECT * FROM external_resource
                WHERE provider = ?
                ORDER BY fetched_at DESC
                LIMIT ?
                """,
                (provider, safe_limit),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM external_resource ORDER BY fetched_at DESC LIMIT ?",
                (safe_limit,),
            ).fetchall()
        return [_row_to_dict(row) for row in rows if row is not None]

    def upsert_external_resource_xref(
        self,
        *,
        from_resource_id: str,
        to_resource_id: str,
        xref_type: str,
        evidence: str,
        source_provider: str,
        confidence: float | None = None,
        version: str | None = None,
        identity: float | None = None,
        coverage: float | None = None,
        alignment_coords: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        xref_id: str | None = None,
    ) -> str:
        """Idempotent on (from, to, xref_type, source_provider).

        Re-asserting the same xref refreshes confidence/identity/coverage —
        the latest assertion from a given source wins. Different sources can
        co-exist (UniProt → 1RBL via UniProt vs the same edge via PDBe).
        """
        now = utc_now()
        xref_id = xref_id or new_uuid7()
        row = self._conn.execute(
            """
            INSERT INTO external_resource_xref (
              id, from_resource_id, to_resource_id, xref_type, evidence,
              confidence, source_provider, version, identity, coverage,
              alignment_coords_json, metadata_json, recorded_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(from_resource_id, to_resource_id, xref_type, source_provider)
            DO UPDATE SET
              evidence              = excluded.evidence,
              confidence            = excluded.confidence,
              version               = excluded.version,
              identity              = excluded.identity,
              coverage              = excluded.coverage,
              alignment_coords_json = excluded.alignment_coords_json,
              metadata_json         = excluded.metadata_json,
              recorded_at           = excluded.recorded_at
            RETURNING id
            """,
            (
                xref_id,
                from_resource_id,
                to_resource_id,
                xref_type,
                evidence,
                confidence,
                source_provider,
                version,
                identity,
                coverage,
                (
                    json.dumps(alignment_coords, sort_keys=True)
                    if alignment_coords is not None
                    else None
                ),
                json.dumps(metadata or {}, sort_keys=True),
                now,
            ),
        ).fetchone()
        self._commit()
        return row["id"]

    def list_external_resource_xrefs(
        self,
        from_resource_id: str | None = None,
        to_resource_id: str | None = None,
        xref_type: str | None = None,
        target_provider: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:

        safe_limit = max(1, min(limit, 500))
        clauses: list[str] = []
        params: list[Any] = []
        if from_resource_id is not None:
            clauses.append("x.from_resource_id = ?")
            params.append(from_resource_id)
        if to_resource_id is not None:
            clauses.append("x.to_resource_id = ?")
            params.append(to_resource_id)
        if xref_type is not None:
            clauses.append("x.xref_type = ?")
            params.append(xref_type)
        if target_provider is not None:
            clauses.append("r.provider = ?")
            params.append(target_provider)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        params.append(safe_limit)
        rows = self._conn.execute(
            f"""
            SELECT x.* FROM external_resource_xref AS x
            JOIN external_resource AS r ON r.id = x.to_resource_id
            {where}
            ORDER BY x.recorded_at DESC
            LIMIT ?
            """,
            tuple(params),
        ).fetchall()
        return [_row_to_dict(row) for row in rows if row is not None]

    def upsert_external_resource_binding(
        self,
        *,
        workspace_id: str,
        source_kind: str,
        source_uri: str,
        external_resource_id: str,
        relationship: str,
        evidence: str,
        confidence: float | None = None,
        alignment_coords: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        binding_id: str | None = None,
    ) -> str:
        """Idempotent on (workspace_id, source_uri, external_resource_id, relationship)."""
        now = utc_now()
        binding_id = binding_id or new_uuid7()
        row = self._conn.execute(
            """
            INSERT INTO external_resource_binding (
              id, workspace_id, source_kind, source_uri, external_resource_id,
              relationship, evidence, confidence, alignment_coords_json,
              metadata_json, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(workspace_id, source_uri, external_resource_id, relationship)
            DO UPDATE SET
              evidence              = excluded.evidence,
              confidence            = excluded.confidence,
              alignment_coords_json = excluded.alignment_coords_json,
              metadata_json         = excluded.metadata_json
            RETURNING id
            """,
            (
                binding_id,
                workspace_id,
                source_kind,
                source_uri,
                external_resource_id,
                relationship,
                evidence,
                confidence,
                (
                    json.dumps(alignment_coords, sort_keys=True)
                    if alignment_coords is not None
                    else None
                ),
                json.dumps(metadata or {}, sort_keys=True),
                now,
            ),
        ).fetchone()
        self._commit()
        return row["id"]

    def list_external_resource_bindings(
        self,
        workspace_id: str,
        source_uri: str | None = None,
        external_resource_id: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """Workspace-scoped — required for per-workspace privacy.

        Callers MUST pass workspace_id (no global cross-workspace listing).
        """
        safe_limit = max(1, min(limit, 500))
        clauses = ["workspace_id = ?"]
        params: list[Any] = [workspace_id]
        if source_uri is not None:
            clauses.append("source_uri = ?")
            params.append(source_uri)
        if external_resource_id is not None:
            clauses.append("external_resource_id = ?")
            params.append(external_resource_id)
        params.append(safe_limit)
        rows = self._conn.execute(
            f"""
            SELECT * FROM external_resource_binding
            WHERE {" AND ".join(clauses)}
            ORDER BY created_at DESC
            LIMIT ?
            """,
            tuple(params),
        ).fetchall()
        return [_row_to_dict(row) for row in rows if row is not None]

    def insert_external_fetch_log(
        self,
        *,
        provider: str,
        endpoint: str,
        method: str,
        capability_check: dict[str, Any],
        workspace_id: str | None = None,
        status_code: int | None = None,
        latency_ms: int | None = None,
        bytes_received: int | None = None,
        cache_hit: bool = False,
        external_resource_id: str | None = None,
        failure_kind: str | None = None,
        log_id: str | None = None,
    ) -> str:
        """Append-only system fetch log. Agent-driven fetches go to  audit_record."""
        log_id = log_id or new_uuid7()
        self._conn.execute(
            """
            INSERT INTO external_fetch_log (
              id, workspace_id, provider, endpoint, method, status_code,
              latency_ms, bytes_received, cache_hit, external_resource_id,
              failure_kind, capability_check_json, recorded_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                log_id,
                workspace_id,
                provider,
                endpoint,
                method,
                status_code,
                latency_ms,
                bytes_received,
                1 if cache_hit else 0,
                external_resource_id,
                failure_kind,
                json.dumps(capability_check, sort_keys=True),
                utc_now(),
            ),
        )
        self._commit()
        return log_id

    def list_external_fetch_log(
        self,
        provider: str | None = None,
        workspace_id: str | None = None,
        since: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:

        safe_limit = max(1, min(limit, 1000))
        clauses: list[str] = []
        params: list[Any] = []
        if provider is not None:
            clauses.append("provider = ?")
            params.append(provider)
        if workspace_id is not None:
            clauses.append("workspace_id = ?")
            params.append(workspace_id)
        if since is not None:
            clauses.append("recorded_at >= ?")
            params.append(since)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        params.append(safe_limit)
        rows = self._conn.execute(
            f"""
            SELECT * FROM external_fetch_log
            {where}
            ORDER BY recorded_at DESC
            LIMIT ?
            """,
            tuple(params),
        ).fetchall()
        return [_row_to_dict(row) for row in rows if row is not None]

    def ensure_external_fetch_log_archive_schema(self) -> None:
        """Create `external_fetch_log_archive` + indexes if missing. Idempotent."""
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS external_fetch_log_archive (
              id                    TEXT PRIMARY KEY,
              workspace_id          TEXT,
              provider              TEXT NOT NULL,
              endpoint              TEXT NOT NULL,
              method                TEXT NOT NULL,
              status_code           INTEGER,
              latency_ms            INTEGER,
              bytes_received        INTEGER,
              cache_hit             INTEGER NOT NULL DEFAULT 0,
              external_resource_id  TEXT,
              failure_kind          TEXT,
              capability_check_json TEXT NOT NULL,
              recorded_at           TEXT NOT NULL,
              archived_at           TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS external_fetch_log_archive_provider
              ON external_fetch_log_archive(provider, recorded_at DESC);
            CREATE INDEX IF NOT EXISTS external_fetch_log_archive_workspace
              ON external_fetch_log_archive(workspace_id, recorded_at DESC);
            """)
        self._commit()

    def archive_external_fetch_log_older_than(self, threshold_iso: str) -> int:
        """Move rows with `recorded_at < threshold_iso` to the archive table.

        Atomic: archive insert + log delete commit together. Returns the row
        count moved. Caller is responsible for picking the threshold (see
        `external/log.py` for the standard 6-month retention).
        """
        self.ensure_external_fetch_log_archive_schema()
        archived_at = utc_now()
        with self.transaction():

            self._conn.execute(
                """
                INSERT OR IGNORE INTO external_fetch_log_archive (
                  id, workspace_id, provider, endpoint, method, status_code,
                  latency_ms, bytes_received, cache_hit, external_resource_id,
                  failure_kind, capability_check_json, recorded_at, archived_at
                )
                SELECT
                  id, workspace_id, provider, endpoint, method, status_code,
                  latency_ms, bytes_received, cache_hit, external_resource_id,
                  failure_kind, capability_check_json, recorded_at, ?
                FROM external_fetch_log
                WHERE recorded_at < ?
                """,
                (archived_at, threshold_iso),
            )
            cursor = self._conn.execute(
                "DELETE FROM external_fetch_log WHERE recorded_at < ?",
                (threshold_iso,),
            )
            return cursor.rowcount or 0

    def vacuum(self) -> None:
        """Reclaim free SQLite pages. SQLite rejects VACUUM inside a
        transaction, so this method serializes against `transaction()` via
        `_tx_lock` and explicitly raises if called while an explicit
        transaction is open on the same thread (depth > 0). Without these
        guards, a concurrent retention-pass + agent-fetch could collide
        with `cannot VACUUM from within a transaction`."""
        with self._tx_lock:
            if self._tx_depth > 0:
                raise RuntimeError(
                    "vacuum() cannot run inside an explicit store.transaction(); "
                    "release the outer block first or run rotation in a separate "
                    "process."
                )
            self._conn.execute("VACUUM")


def _row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    """Convert a sqlite3.Row to a plain dict, decoding `*_json` columns into Python.

    Convention: any column whose name ends with `_json` is JSON-encoded TEXT in
    the database and gets `json.loads`-ed on read. New JSON columns added to the
    schema are picked up automatically — the previous explicit allowlist drifted
    every time a table grew a JSON column.
    """
    if row is None:
        return None
    result = dict(row)
    for key, value in list(result.items()):
        if key.endswith("_json") and value is not None:
            result[key] = json.loads(value)
    if "cache_hit" in result and result["cache_hit"] is not None:
        result["cache_hit"] = bool(result["cache_hit"])
    return result


@overload
def _managed_operation_row(row: sqlite3.Row) -> ManagedOperationRow: ...


@overload
def _managed_operation_row(row: None) -> None: ...


def _managed_operation_row(row: sqlite3.Row | None) -> ManagedOperationRow | None:
    if row is None:
        return None
    return managed_operation_row.validate_python(_row_to_dict(row), strict=True)


_STORE: ControlPlaneStore | None = None


def get_control_plane_store() -> ControlPlaneStore:
    global _STORE
    if _STORE is None:
        _STORE = ControlPlaneStore()
        _STORE.initialize()
    return _STORE


def initialize_control_plane(db_path: Path | str | None = None) -> ControlPlaneStore:
    """Initialize the global store, optionally replacing its database path."""
    global _STORE
    if _STORE is not None:
        _STORE.close()
    _STORE = ControlPlaneStore(db_path)
    _STORE.initialize()
    return _STORE
