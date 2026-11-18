export const DATA_STORE_CLASSIFICATIONS = [
  'AUTHORITATIVE',
  'PROJECTION',
  'CACHE',
  'STUB_UNUSED',
] as const;

export type DataStoreClassification = (typeof DATA_STORE_CLASSIFICATIONS)[number];

export interface DataStoreManifestEntry {
  id: string;
  label: string;
  kind: 'sqlite-table' | 'workspace-file' | 'waypoint-directory' | 'retired-sqlite-table';
  classification: DataStoreClassification;
  sourceOfTruth: string;
  rebuildPath: string;
  notes?: string;
}

export interface SqliteTableDataStoreEntry extends DataStoreManifestEntry {
  kind: 'sqlite-table';
  table: string;
}

export const SQLITE_TABLE_DATA_STORES = {
  administration_actions: {
    id: 'sqlite.administration_actions',
    label: 'Retained native administration actions',
    kind: 'sqlite-table',
    table: 'administration_actions',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'Native prepared identities, revisions, originating authority and actual outcomes.',
    rebuildPath:
      'Past human decisions and uncertain external effects cannot be reconstructed. Preserve this table and inspect existing actions before any retry.',
  },
  administration_preferences: {
    id: 'sqlite.administration_preferences',
    label: 'Native device preferences',
    kind: 'sqlite-table',
    table: 'administration_preferences',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The native administration settings owner.',
    rebuildPath:
      'Adopt existing compatible preferences once; accepted native preferences require explicit user or authorized agent changes.',
  },

  scientific_work_commands: {
    id: 'sqlite.scientific_work_commands',
    label: 'Prepared project task commands',
    kind: 'sqlite-table',
    table: 'scientific_work_commands',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'The originating actor, exact accepted submission inputs and notebook placement receipts recorded by the native task owner.',
    rebuildPath:
      'Restore the originating profile backup to recover prepared and interrupted requests. Accepted task documents live in scientific revision history.',
  },
  scientific_work_consent: {
    id: 'sqlite.scientific_work_consent',
    label: 'Local reminder preferences',
    kind: 'sqlite-table',
    table: 'scientific_work_consent',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The selected local profile’s explicit delivery choices for this project.',
    rebuildPath: 'Restore the profile backup or ask the recipient to choose their channels again.',
  },
  scientific_work_dispatch: {
    id: 'sqlite.scientific_work_dispatch',
    label: 'Local reminder dispatch authority',
    kind: 'sqlite-table',
    table: 'scientific_work_dispatch',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'The originating installation, authority epoch and durable transfer fence accepted by the native scheduler.',
    rebuildPath: 'Recover the original authority and transfer receipt before resuming delivery.',
  },
  scientific_work_effects: {
    id: 'sqlite.scientific_work_effects',
    label: 'Local reminder inbox and delivery ledger',
    kind: 'sqlite-table',
    table: 'scientific_work_effects',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'The native scheduler’s materialized occurrences, user inbox decisions and recorded notification attempts.',
    rebuildPath:
      'Restore the profile backup. An uncertain delivery remains uncertain until the original receipt is available.',
  },
  scientific_work_reminder_receipts: {
    id: 'sqlite.scientific_work_reminder_receipts',
    label: 'Reminder request receipts',
    kind: 'sqlite-table',
    table: 'scientific_work_reminder_receipts',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'The native command owner’s scoped decisions and saved acknowledgments for retryable local or hosted commands.',
    rebuildPath:
      'Restore the profile backup and recover interrupted commands using their original request identity.',
  },
  scientific_work_rules: {
    id: 'sqlite.scientific_work_rules',
    label: 'Local task reminder rules',
    kind: 'sqlite-table',
    table: 'scientific_work_rules',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'The local recipient’s chosen timing, channels and retained scheduling position.',
    rebuildPath: 'Restore the profile backup or explicitly configure a new reminder rule.',
  },
  scientific_workspace_identities: {
    id: 'sqlite.scientific-workspace-identities',
    label: 'Stable scientific workspace identity',
    kind: 'sqlite-table',
    table: 'scientific_workspace_identities',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'The logical scientific namespace and confirmed cloud binding accepted by the native workspace owner.',
    rebuildPath:
      'Restore the original identity from a verified complete scientific history; never derive it from a new local path or numeric workspace id.',
  },
  scientific_revision_records: {
    id: 'sqlite.scientific-revision-records',
    label: 'Accepted scientific revisions and receipts',
    kind: 'sqlite-table',
    table: 'scientific_revision_records',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'Immutable canonical revision records accepted by the scientific command service.',
    rebuildPath:
      'Restore a verified canonical workspace history; current files alone cannot reconstruct accepted history.',
  },
  scientific_revision_refs: {
    id: 'sqlite.scientific-revision-refs',
    label: 'Accepted scientific workspace pointers',
    kind: 'sqlite-table',
    table: 'scientific_revision_refs',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'The accepted workspace pointer committed with its revision records and receipt.',
    rebuildPath:
      'Restore from a verified accepted-history export; never infer acceptance from a filesystem save.',
  },
  scientific_revision_blobs: {
    id: 'sqlite.scientific-revision-blobs',
    label: 'Immutable scientific payload bytes',
    kind: 'sqlite-table',
    table: 'scientific_revision_blobs',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'Exact hash-verified payload bytes retained for current and historical scientific revisions.',
    rebuildPath:
      'Restore matching verified blobs from an accepted-history export; current files may have newer working edits.',
  },
  scientific_materialization_jobs: {
    id: 'sqlite.scientific-materialization-jobs',
    label: 'Accepted scientific file completion',
    kind: 'sqlite-table',
    table: 'scientific_materialization_jobs',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'The durable file completion manifest committed in the scientific acceptance transaction.',
    rebuildPath:
      'Resume the exact retained manifest against its accepted version and expected file digests.',
  },
  graph_nodes: {
    id: 'sqlite.graph_nodes',
    label: 'Adjacency graph nodes',
    kind: 'sqlite-table',
    table: 'graph_nodes',
    classification: 'STUB_UNUSED',
    sourceOfTruth: 'No current producer; retained as an unused schema stub.',
    rebuildPath: 'No rebuild path; the current adjacency graph is held in the feature state.',
  },
  graph_edges: {
    id: 'sqlite.graph_edges',
    label: 'Adjacency graph edges',
    kind: 'sqlite-table',
    table: 'graph_edges',
    classification: 'STUB_UNUSED',
    sourceOfTruth: 'No current producer; retained as an unused schema stub.',
    rebuildPath: 'No rebuild path; the current adjacency graph is held in the feature state.',
  },
  entity_projection_sources: {
    id: 'sqlite.entity_projection_sources',
    label: 'File and application synchronization bases',
    kind: 'sqlite-table',
    table: 'entity_projection_sources',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The retained local receipt of equal canonical file and application content.',
    rebuildPath:
      'A past base cannot be reconstructed from divergent current versions. Matching current file/application content establishes a new base; a mismatch without a retained base remains a conflict.',
    notes:
      'Never infer this base from timestamps or repurpose the catalog SHA256 content hash. Loss of the base cannot choose a winner.',
  },
  settings: {
    id: 'sqlite.settings',
    label: 'Desktop settings',
    kind: 'sqlite-table',
    table: 'settings',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The settings row itself.',
    rebuildPath: 'No automatic rebuild; values are user/app preferences.',
  },
  remote_endpoint_profiles: {
    id: 'sqlite.remote-endpoint-profiles',
    label: 'Remote endpoint profiles',
    kind: 'sqlite-table',
    table: 'remote_endpoint_profiles',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The local record of a successfully authenticated OpenSSH endpoint.',
    rebuildPath: 'Reconnect with the same SSH target; remote scientific files remain untouched.',
    notes: 'Contains no credentials, session tokens, tunnel URLs, or SSH command arguments.',
  },
  workspaces: {
    id: 'sqlite.workspaces',
    label: 'Known project registry',
    kind: 'sqlite-table',
    table: 'workspaces',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The local desktop project registry row.',
    rebuildPath: 'User re-selects/reopens projects; project contents remain filesystem data.',
  },
  workspace_sync_device: {
    id: 'sqlite.workspace_sync_device',
    label: 'Desktop sync device identity',
    kind: 'sqlite-table',
    table: 'workspace_sync_device',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The local install device id row.',
    rebuildPath: 'Generate a new device id only if the local database is recreated.',
    notes: 'Contains no account token; it only gives queue locks a stable per-install owner.',
  },
  workspace_sync_bindings: {
    id: 'sqlite.workspace_sync_bindings',
    label: 'Desktop sync project bindings',
    kind: 'sqlite-table',
    table: 'workspace_sync_bindings',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The local decision to bind a managed workspace to a cloud workspace.',
    rebuildPath:
      'Reclaim through the desktop-sync project claim API using the managed project UUID and signed-in account.',
  },
  workspace_sync_queue: {
    id: 'sqlite.workspace_sync_queue',
    label: 'Desktop sync durable queue',
    kind: 'sqlite-table',
    table: 'workspace_sync_queue',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The local outbox row created by the main-process sync engine.',
    rebuildPath:
      'Recompute pending upload work from managed git HEAD and the latest acknowledged binding state.',
  },
  workspace_sync_renderer_deliveries: {
    id: 'sqlite.workspace_sync_renderer_deliveries',
    label: 'Committed workspace screen deliveries',
    kind: 'sqlite-table',
    table: 'workspace_sync_renderer_deliveries',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'Exact replay instructions committed with the applied remote version.',
    rebuildPath:
      'Replay the retained notice through the workspace renderer publisher; settle only its matching acknowledgement.',
    notes:
      'Unfinished delivery blocks upload and workspace replacement. Never clear it with ordinary queue errors.',
  },
  workspace_sync_upload_snapshots: {
    id: 'sqlite.workspace_sync_upload_snapshots',
    label: 'Desktop sync immutable upload snapshots',
    kind: 'sqlite-table',
    table: 'workspace_sync_upload_snapshots',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'The exact serialized bundle captured for a durable upload queue job and its idempotency key.',
    rebuildPath:
      'Do not reconstruct an existing job from mutable project bytes; fail that job and enqueue a fresh snapshot under a new idempotency key.',
    notes: 'Rows cascade away when their queue jobs reach terminal settlement.',
  },
  workspace_sync_versions: {
    id: 'sqlite.workspace_sync_versions',
    label: 'Desktop sync remote version cache',
    kind: 'sqlite-table',
    table: 'workspace_sync_versions',
    classification: 'PROJECTION',
    sourceOfTruth: 'The desktop-sync web API and Supabase workspace_sync_version rows.',
    rebuildPath: 'Refresh latest/list state from the desktop-sync web API.',
  },
  workspace_sync_merge_conflicts: {
    id: 'sqlite.workspace_sync_merge_conflicts',
    label: 'Desktop sync unresolved merge conflicts ',
    kind: 'sqlite-table',
    table: 'workspace_sync_merge_conflicts',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'The local record of a reconciliation that could not compose: both input bundles and the chosen resolution live in its JSON columns.',
    rebuildPath:
      'No automatic rebuild. A lost row loses the per-item choice; the base, local, and remote versions remain recoverable from the sync version cache and the workspace.',
  },
  workspace_sync_restore_locks: {
    id: 'sqlite.workspace_sync_restore_locks',
    label: 'Desktop sync restore locks',
    kind: 'sqlite-table',
    table: 'workspace_sync_restore_locks',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The local restore operation currently mutating a managed workspace.',
    rebuildPath: 'Expired locks are reclaimed by the main-process sync engine on startup.',
  },
  org_registry_sync_state: {
    id: 'sqlite.org-registry-sync-state',
    label: 'Organization Registry synchronization cursor',
    kind: 'sqlite-table',
    table: 'org_registry_sync_state',
    classification: 'CACHE',
    sourceOfTruth: 'The organization Registry event cursor returned by the desktop-sync API.',
    rebuildPath: 'Fetch a fresh authorized Registry snapshot and resume its event stream.',
    notes: 'Scoped by both organization and signed-in account to prevent cross-account disclosure.',
  },
  org_registry_cache: {
    id: 'sqlite.org-registry-cache',
    label: 'Organization Registry local cache',
    kind: 'sqlite-table',
    table: 'org_registry_cache',
    classification: 'CACHE',
    sourceOfTruth: 'The canonical organization Registry in Supabase.',
    rebuildPath: 'Replace atomically from an authorized snapshot, then replay subsequent events.',
    notes:
      'Project files remain authoritative for artifact contents; this cache holds organization identities and placements.',
  },
  org_registry_snapshot_transfer: {
    id: 'sqlite.org-registry-snapshot-transfer',
    label: 'Organization Registry snapshot transfer progress',
    kind: 'sqlite-table',
    table: 'org_registry_snapshot_transfer',
    classification: 'CACHE',
    sourceOfTruth: 'The immutable, account-bound snapshot exported by the organization Registry.',
    rebuildPath:
      'Resume the same authorized export from the saved page, or start a fresh export after expiry.',
    notes: 'Incomplete transfers never replace the last complete Registry cache.',
  },
  org_registry_snapshot_record: {
    id: 'sqlite.org-registry-snapshot-record',
    label: 'Organization Registry staged snapshot records',
    kind: 'sqlite-table',
    table: 'org_registry_snapshot_record',
    classification: 'CACHE',
    sourceOfTruth: 'The immutable, account-bound snapshot exported by the organization Registry.',
    rebuildPath:
      'Download the authorized export again; promote staging only after all records are durably saved.',
    notes: 'Staged records are scoped by both organization and signed-in account.',
  },
  org_registry_outbox: {
    id: 'sqlite.org-registry-outbox',
    label: 'Organization Registry durable mutation outbox',
    kind: 'sqlite-table',
    table: 'org_registry_outbox',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'The exact local mutation intent and immutable mutation id captured before network delivery.',
    rebuildPath:
      'No automatic rebuild; replay the retained request under the same mutation id until acknowledged or conflicted.',
  },
  org_registry_mutation_receipts: {
    id: 'sqlite.org-registry-mutation-receipts',
    label: 'Organization Registry mutation acknowledgments',
    kind: 'sqlite-table',
    table: 'org_registry_mutation_receipts',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'The validated server response retained atomically with acknowledgment of the exact local request.',
    rebuildPath:
      'No snapshot rebuild; current Registry records cannot establish which local mutation was acknowledged.',
    notes: 'Reading a retained receipt still requires current account and organization access.',
  },
  org_registry_local_records: {
    id: 'sqlite.org-registry-local-records',
    label: 'Organization Registry local record enrollment',
    kind: 'sqlite-table',
    table: 'org_registry_local_records',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'The explicit Claim binding between the saved entity, its home project, signed-in account and organization.',
    rebuildPath:
      'No automatic rebuild from discovery or file location; enrollment and acknowledgment history must be retained.',
  },
  org_registry_record_publications: {
    id: 'sqlite.org-registry-record-publications',
    label: 'Organization Registry saved record publications',
    kind: 'sqlite-table',
    table: 'org_registry_record_publications',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'The ordered local publication intent, captured saved-content digest and exact mutation identity.',
    rebuildPath:
      'Resume retained publications in local event order; newer file contents cannot reconstruct an earlier saved intent.',
  },
  org_registry_record_resolutions: {
    id: 'sqlite.org-registry-record-resolutions',
    label: 'Organization Registry reviewed record resolutions',
    kind: 'sqlite-table',
    table: 'org_registry_record_resolutions',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'The approved conflict choice, reviewed versions and publication operation retained before changing saved content.',
    rebuildPath:
      'Resume the exact retained resolution; loss cannot infer approval or select a winner from current versions.',
  },
  org_registry_record_publication_supersessions: {
    id: 'sqlite.org-registry-record-publication-supersessions',
    label: 'Organization Registry superseded publications',
    kind: 'sqlite-table',
    table: 'org_registry_record_publication_supersessions',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'The durable association between an earlier publication and the reviewed resolution that superseded it.',
    rebuildPath:
      'No automatic rebuild from current content; retain these associations so superseded mutations are not delivered again.',
  },
  org_registry_conflicts: {
    id: 'sqlite.org-registry-conflicts',
    label: 'Organization Registry unresolved conflicts',
    kind: 'sqlite-table',
    table: 'org_registry_conflicts',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The exact rejected local mutation plus the server conflict response.',
    rebuildPath:
      'No automatic rebuild; a user must discard or rebase the local intent against current Registry state.',
  },
  hosted_contribution_local_declines: {
    id: 'sqlite.hosted-contribution-local-declines',
    label: 'Research Contribution Not-now receipts',
    kind: 'sqlite-table',
    table: 'hosted_contribution_local_declines',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The explicit local Not-now receipt recorded by Electron main.',
    rebuildPath: 'No automatic rebuild; loss causes the current chooser to be shown again.',
    notes:
      'Local only. Stores a SHA-256 account-subject hash and exact policy/legal bindings; it grants no Hosted AI authority.',
  },
  agent_state_capsules: {
    id: 'sqlite.agent-state-capsules',
    label: 'Hosted Codex AgentStateCapsules',
    kind: 'sqlite-table',
    table: 'agent_state_capsules',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'The machine-generated capsule chain Electron main writes at each safe continuation point.',
    rebuildPath:
      'No automatic rebuild. Losing the chain forces the affected run into explicit reconciliation rather than a guessed resume.',
    notes:
      'Local only. Activation is two-stage and chained by digest, so a partial write can never become the state a turn resumes from.',
  },
  indexed_files: {
    id: 'sqlite.indexed_files',
    label: 'Project file index',
    kind: 'sqlite-table',
    table: 'indexed_files',
    classification: 'CACHE',
    sourceOfTruth: 'Workspace filesystem files.',
    rebuildPath: 'Re-scan project folders and refresh file metadata.',
  },
  sequences: {
    id: 'sqlite.sequences',
    label: 'Sequence FK index',
    kind: 'sqlite-table',
    table: 'sequences',
    classification: 'PROJECTION',
    sourceOfTruth:
      'Workspace sequence files (.gb/.fasta). The sequence column is not populated in production.',
    rebuildPath:
      'Lazy recreation via ensureSequenceIdentity() when a sequence file is opened or bound.',
    notes: 'Exists to give primer_bindings a stable local FK target, not to store bases.',
  },
  pages: {
    id: 'sqlite.pages',
    label: 'Notebook pages',
    kind: 'sqlite-table',
    table: 'pages',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'Mixed store: published notebooks project the canonical <Name>/<Name>.md document and .forge/blocks payloads; database-only pages retain durable user content until a package is successfully written.',
    rebuildPath:
      'reconcileWorkspaceEntities() recreates supported published notebooks from validated packages. Database-only or failed-publication content cannot be reconstructed solely from project files and must be preserved.',
    notes:
      'Notebook creation keeps the durable page open when package writing fails. A published .forge/notebook.json is versioned identity/package metadata only; it must not contain TipTap content or declare SQLite authority.',
  },
  conversations: {
    id: 'sqlite.conversations',
    label: 'AI conversations',
    kind: 'sqlite-table',
    table: 'conversations',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The local conversation row.',
    rebuildPath: 'No automatic rebuild.',
  },
  messages: {
    id: 'sqlite.messages',
    label: 'AI messages',
    kind: 'sqlite-table',
    table: 'messages',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The local message row.',
    rebuildPath: 'No automatic rebuild.',
  },
  entity_references: {
    id: 'sqlite.entity_references',
    label: 'Chat entity references',
    kind: 'sqlite-table',
    table: 'entity_references',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The local entity reference row created by user/AI actions.',
    rebuildPath: 'No automatic rebuild.',
  },
  entity_reference_revisions: {
    id: 'sqlite.entity_reference_revisions',
    label: 'Entity reference revision history',
    kind: 'sqlite-table',
    table: 'entity_reference_revisions',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The local revision row.',
    rebuildPath: 'No automatic rebuild.',
  },
  message_references: {
    id: 'sqlite.message_references',
    label: 'Message/reference join rows',
    kind: 'sqlite-table',
    table: 'message_references',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The local join row linking messages to entity references.',
    rebuildPath: 'No automatic rebuild.',
  },
  message_attachments: {
    id: 'sqlite.message_attachments',
    label: 'Message attachment manifests',
    kind: 'sqlite-table',
    table: 'message_attachments',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The immutable hash manifest joined to the local user message.',
    rebuildPath: 'No automatic rebuild; snapshot bytes are stored in agent-attachments.',
  },
  primers: {
    id: 'sqlite.primers',
    label: 'Primer library',
    kind: 'sqlite-table',
    table: 'primers',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'Transitional mixed store: imported/historical rows remain authoritative; rows whose origin_details.authority is primer_artifact are compatibility projections of project *.primer.json files.',
    rebuildPath:
      'reconcileWorkspaceRoot() discovers primer artifacts and rebuilds artifact-backed rows; imported/historical rows have no automatic rebuild.',
    notes:
      'New drag-selection primer creation is file-authoritative as of . Full legacy migration remains separate work.',
  },
  primer_bindings: {
    id: 'sqlite.primer_bindings',
    label: 'Primer binding placements',
    kind: 'sqlite-table',
    table: 'primer_bindings',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'Transitional mixed store: legacy bindings remain authoritative; bindings for artifact-backed primers project typed binds_to_sequence relationships from project *.primer.json files.',
    rebuildPath:
      'reconcileWorkspaceRoot() discovers primer artifacts and rebuilds artifact-backed relationship rows; legacy bindings have no automatic rebuild.',
    notes: 'Primer bindings are relationships to sequence identities, never sequence annotations.',
  },
  catalog_entities: {
    id: 'sqlite.catalog_entities',
    label: 'Project catalog identities and projected records',
    kind: 'sqlite-table',
    table: 'catalog_entities',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'Mixed store: native .forge/catalog.json records and recognized files supply projected content; retained local identities, legacy metadata, and database-only catalog records belong to this table.',
    rebuildPath:
      'Workspace reconciliation recreates supported file/native records. There is no integrated automatic recovery for all local catalog identities and legacy metadata.',
    notes:
      'rebuildWorkspaceCatalogProjection() is a separately tested JSONL replay helper with no production caller; it is not the catalog startup recovery path.',
  },
  catalog_entity_name_fts: {
    id: 'sqlite.catalog_entity_name_fts',
    label: 'Catalog name trigram search index',
    kind: 'sqlite-table',
    table: 'catalog_entity_name_fts',
    classification: 'CACHE',
    sourceOfTruth: 'Retained catalog_entities names and row identities.',
    rebuildPath:
      'createCatalogNameSearchIndex() rebuilds this derived trigram index from catalog_entities when absent or incomplete.',
    notes:
      'SQLite maintains this table as part of catalog_entity_name_fts; it has no independent authority.',
  },
  catalog_entity_name_fts_config: {
    id: 'sqlite.catalog_entity_name_fts_config',
    label: 'Catalog name search index configuration',
    kind: 'sqlite-table',
    table: 'catalog_entity_name_fts_config',
    classification: 'CACHE',
    sourceOfTruth: 'Retained catalog_entities names and row identities.',
    rebuildPath:
      'createCatalogNameSearchIndex() rebuilds this derived trigram index from catalog_entities when absent or incomplete.',
    notes:
      'SQLite maintains this table as part of catalog_entity_name_fts; it has no independent authority.',
  },
  catalog_entity_name_fts_data: {
    id: 'sqlite.catalog_entity_name_fts_data',
    label: 'Catalog name search index data',
    kind: 'sqlite-table',
    table: 'catalog_entity_name_fts_data',
    classification: 'CACHE',
    sourceOfTruth: 'Retained catalog_entities names and row identities.',
    rebuildPath:
      'createCatalogNameSearchIndex() rebuilds this derived trigram index from catalog_entities when absent or incomplete.',
    notes:
      'SQLite maintains this table as part of catalog_entity_name_fts; it has no independent authority.',
  },
  catalog_entity_name_fts_docsize: {
    id: 'sqlite.catalog_entity_name_fts_docsize',
    label: 'Catalog name search index document sizes',
    kind: 'sqlite-table',
    table: 'catalog_entity_name_fts_docsize',
    classification: 'CACHE',
    sourceOfTruth: 'Retained catalog_entities names and row identities.',
    rebuildPath:
      'createCatalogNameSearchIndex() rebuilds this derived trigram index from catalog_entities when absent or incomplete.',
    notes:
      'SQLite maintains this table as part of catalog_entity_name_fts; it has no independent authority.',
  },
  catalog_entity_name_fts_idx: {
    id: 'sqlite.catalog_entity_name_fts_idx',
    label: 'Catalog name search index segment index',
    kind: 'sqlite-table',
    table: 'catalog_entity_name_fts_idx',
    classification: 'CACHE',
    sourceOfTruth: 'Retained catalog_entities names and row identities.',
    rebuildPath:
      'createCatalogNameSearchIndex() rebuilds this derived trigram index from catalog_entities when absent or incomplete.',
    notes:
      'SQLite maintains this table as part of catalog_entity_name_fts; it has no independent authority.',
  },
  catalog_entity_files: {
    id: 'sqlite.catalog_entity_files',
    label: 'Project catalog current file bindings',
    kind: 'sqlite-table',
    table: 'catalog_entity_files',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'The retained local choice of current physical location and binding history. Project files and native manifests identify the portable artifacts at those locations.',
    rebuildPath:
      'Workspace scans can recreate supported current bindings; they cannot reproduce every historical or missing binding. Preserve current bindings when repairing Registry projections.',
    notes:
      'Project-memory files.jsonl may retain selected placements, but its replay helper is not wired into production recovery.',
  },
  catalog_provider_bindings: {
    id: 'sqlite.catalog_provider_bindings',
    label: 'Provider identity to catalog entity bindings',
    kind: 'sqlite-table',
    table: 'catalog_provider_bindings',
    classification: 'PROJECTION',
    sourceOfTruth:
      'The `sourceIdentities` array on each entity in the project .forge/catalog.json manifest.',
    rebuildPath: 'reconcileNativeWorkspaceManifest() replays sourceIdentities into this table.',
    notes:
      'Deliberately NOT in the per-run .dnaforge/migration store, which normal unlock deletes.',
  },
  catalog_workspace_placements: {
    id: 'sqlite.catalog_workspace_placements',
    label: 'Project catalog virtual placements projection',
    kind: 'sqlite-table',
    table: 'catalog_workspace_placements',
    classification: 'PROJECTION',
    sourceOfTruth:
      'The catalog-record placement on each entity in the project .forge/catalog.json v2 manifest.',
    rebuildPath:
      'reconcileNativeWorkspaceManifest() replays catalog-record placements into this table.',
    notes:
      'The normalized sibling name is derived from the portable display name; the project record supplies local ownership.',
  },
  native_catalog_publication_outbox: {
    id: 'sqlite.native_catalog_publication_outbox',
    label: 'Pending native catalog publication',
    kind: 'sqlite-table',
    table: 'native_catalog_publication_outbox',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The operation registered in the same transaction as the local record edit.',
    rebuildPath:
      'Resume manifest publication for the durable operation before accepting another edit.',
  },
  meaningful_activity_pending: {
    id: 'sqlite.meaningful_activity_pending',
    label: 'Pending meaningful activity receipts',
    kind: 'sqlite-table',
    table: 'meaningful_activity_pending',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'The content-free qualifying-action receipt committed before delayed identity binding.',
    rebuildPath:
      'No automatic rebuild; bind only by same-session proof or an explicit historical binding action.',
    notes:
      'Contains bounded action facts and no user content, path, name, object id, or provider payload.',
  },
  analytics_event_outbox: {
    id: 'sqlite.analytics_event_outbox',
    label: 'Pending operational analytics events',
    kind: 'sqlite-table',
    table: 'analytics_event_outbox',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'A content-free terminal receipt or disposition record registered by the main process.',
    rebuildPath:
      'Benchling terminal events are recovered from immutable project migration receipts; AI events are committed with their terminal source.',
    notes:
      'Local recovery references never enter PostHog. Event properties are scalar and registry-bounded.',
  },
  catalog_entity_links: {
    id: 'sqlite.catalog_entity_links',
    label: 'Project catalog relationships',
    kind: 'sqlite-table',
    table: 'catalog_entity_links',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'Mixed store: native manifests and typed file relationships supply supported projections; remaining locally recorded catalog links belong to this table.',
    rebuildPath:
      'Reconcile supported native/file relationships. No integrated full recovery exists for legacy links; project-memory JSONL replay is a separate helper.',
  },
  catalog_entity_events: {
    id: 'sqlite.catalog_entity_events',
    label: 'Project catalog event history',
    kind: 'sqlite-table',
    table: 'catalog_entity_events',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'Local catalog event rows. Some artifact operations also record portable events in project-memory events.jsonl; this is not a complete mirror of the table.',
    rebuildPath:
      'No integrated full recovery. The separate JSONL helper recreates exported events with replay identities, not the original complete event table.',
  },
  lims_schema: {
    id: 'sqlite.lims_schema',
    label: 'LIMS schema definitions',
    kind: 'sqlite-table',
    table: 'lims_schema',
    classification: 'PROJECTION',
    sourceOfTruth:
      'Built-in schema data, immutable schema snapshots embedded in file/native records, and retained lims_audit schema events for local schema edits.',
    rebuildPath:
      'Seed built-ins and reconcile exact file/native schema snapshots; verified audit replay is a separate recovery primitive.',
    notes:
      'File reconstruction must retain its exact revision and reject identity collisions; recovery must not overwrite unrelated current schema definitions.',
  },
  lims_schema_revision: {
    id: 'sqlite.lims_schema_revision',
    label: 'LIMS immutable schema revisions',
    kind: 'sqlite-table',
    table: 'lims_schema_revision',
    classification: 'PROJECTION',
    sourceOfTruth:
      'Immutable schema snapshots from authoritative artifacts/native manifests or retained lims_audit schema events.',
    rebuildPath:
      'Materialize a missing exact revision during record reconciliation or verified audit recovery; existing revision identities are immutable.',
  },
  lims_entity: {
    id: 'sqlite.lims_entity',
    label: 'LIMS entities',
    kind: 'sqlite-table',
    table: 'lims_entity',
    classification: 'PROJECTION',
    sourceOfTruth:
      'Per representation: managed sequence packages, generic *.entity.json files, notebook packages, and native catalog records supply content; audit-only local records derive state from lims_audit. Current catalog bindings supply runtime file locations.',
    rebuildPath:
      'Reconcile authoritative project records. Runtime audit repair verifies history and hydrates only a missing entity, resolving current locations without replacing unrelated projections.',
    notes:
      'Local Registry lifecycle overlays remain in history where the representation does not store them on disk. Historical absolute paths are not authority for current file locations.',
  },
  lims_link: {
    id: 'sqlite.lims_link',
    label: 'LIMS entity links',
    kind: 'sqlite-table',
    table: 'lims_link',
    classification: 'PROJECTION',
    sourceOfTruth:
      'Typed artifact/native relationships for file-backed records; lims_audit link events for local audit-only relationships.',
    rebuildPath:
      'Reconcile supported relationship projections or perform verified audit recovery; preserve endpoint identities and existing unrelated links.',
  },
  lims_audit: {
    id: 'sqlite.lims_audit',
    label: 'LIMS audit log',
    kind: 'sqlite-table',
    table: 'lims_audit',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'The append-only local Registry event history and state for audit-only records. File-backed content and current runtime locations retain their separate authorities.',
    rebuildPath:
      'No history reconstruction from projections. Preserve event envelopes and hashes; verify retained history before applying audit recovery.',
  },
  lims_event_sequence: {
    id: 'sqlite.lims_event_sequence',
    label: 'LIMS event sequence allocator',
    kind: 'sqlite-table',
    table: 'lims_event_sequence',
    classification: 'PROJECTION',
    sourceOfTruth: 'lims_audit.event_seq high-water mark.',
    rebuildPath: 'Initialized from MAX(lims_audit.event_seq)+1 by schema migration/runtime guard.',
  },
  lims_id_scheme: {
    id: 'sqlite.lims_id_scheme',
    label: 'LIMS registry ID schemes',
    kind: 'sqlite-table',
    table: 'lims_id_scheme',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The per-entity-kind registry ID prefix/pad/sequence config row.',
    rebuildPath:
      'No automatic rebuild in slice 1; defaults are re-seeded lazily and registry_id values persist on lims_entity.',
    notes: 'Agent-configurable : prefix, pad width, next sequence, enabled per kind.',
  },
  lims_safety_quarantine: {
    id: 'sqlite.lims_safety_quarantine',
    label: 'Legacy LIMS safety quarantine receipt',
    kind: 'sqlite-table',
    table: 'lims_safety_quarantine',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The durable result of the schema-v26 legacy restore safety audit.',
    rebuildPath:
      'No automatic rebuild; preserve the receipt until a reviewed repair explicitly resolves it.',
  },
  lims_safety_legacy_scan_candidates: {
    id: 'sqlite.lims_safety_legacy_scan_candidates',
    label: 'Legacy LIMS safety scan candidates',
    kind: 'sqlite-table',
    table: 'lims_safety_legacy_scan_candidates',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'The schema-v26 migration snapshot plus project IDs retained in historical LIMS audit data.',
    rebuildPath:
      'Reconcile each candidate against retained project restore/share evidence; unresolved rows stay fail-closed.',
  },
  lims_safety_legacy_scan_state: {
    id: 'sqlite.lims_safety_legacy_scan_state',
    label: 'Legacy LIMS safety scan completion receipt',
    kind: 'sqlite-table',
    table: 'lims_safety_legacy_scan_state',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The durable completion state of the one-time schema-v26 legacy safety audit.',
    rebuildPath:
      'No automatic rebuild; a missing or pending receipt requires the fail-closed reconciliation pass.',
  },
  agent_sessions: {
    id: 'sqlite.agent_sessions',
    label: 'Agent session ledger',
    kind: 'sqlite-table',
    table: 'agent_sessions',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The local agent session row.',
    rebuildPath: 'No automatic rebuild.',
  },
  agent_provider_session_bindings: {
    id: 'sqlite.agent_provider_session_bindings',
    label: 'Imported provider session bindings',
    kind: 'sqlite-table',
    table: 'agent_provider_session_bindings',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'The explicit local binding between a DNAForge conversation and provider session.',
    rebuildPath: 'Re-import the provider session after verifying the active provider account.',
  },
  conversation_lineage: {
    id: 'sqlite.conversation_lineage',
    label: 'Conversation fork lineage',
    kind: 'sqlite-table',
    table: 'conversation_lineage',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The immutable parent relation written when a DNAForge conversation is forked.',
    rebuildPath: 'No automatic rebuild.',
  },
  agent_capability_invocations: {
    id: 'sqlite.agent_capability_invocations',
    label: 'Agent capability invocation receipts',
    kind: 'sqlite-table',
    table: 'agent_capability_invocations',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The main-validated capability selected for an exact durable chat turn.',
    rebuildPath: 'No automatic rebuild.',
  },
  agent_structured_outputs: {
    id: 'sqlite.agent_structured_outputs',
    label: 'Validated structured agent outputs',
    kind: 'sqlite-table',
    table: 'agent_structured_outputs',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The exact provider result, schema, validation status, and content identity.',
    rebuildPath: 'No automatic rebuild.',
  },
  agent_trace_events: {
    id: 'sqlite.agent_trace_events',
    label: 'Agent trace events',
    kind: 'sqlite-table',
    table: 'agent_trace_events',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The local trace event row.',
    rebuildPath: 'No automatic rebuild.',
  },
  agent_output_artifacts: {
    id: 'sqlite.agent_output_artifacts',
    label: 'Agent output artifact ledger',
    kind: 'sqlite-table',
    table: 'agent_output_artifacts',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The local artifact-attribution row. File bytes live at the recorded path.',
    rebuildPath: 'No automatic rebuild of attribution rows.',
  },
  molecular_catalog_molecules: {
    id: 'sqlite.molecular_catalog_molecules',
    label: 'Full typed encoded molecule identities',
    kind: 'sqlite-table',
    table: 'molecular_catalog_molecules',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'Atomic native molecular catalog registration.',
    rebuildPath:
      'Preserve catalog backup; imports and verified compute runs may be registered again from their original coordinates.',
  },
  molecular_catalog_coordinates: {
    id: 'sqlite.molecular_catalog_coordinates',
    label: 'Immutable original coordinate bytes',
    kind: 'sqlite-table',
    table: 'molecular_catalog_coordinates',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'Atomic native molecular catalog registration.',
    rebuildPath:
      'Preserve catalog backup; imports and verified compute runs may be registered again from their original coordinates.',
  },
  molecular_catalog_observations: {
    id: 'sqlite.molecular_catalog_observations',
    label: 'Structure import and prediction run observations',
    kind: 'sqlite-table',
    table: 'molecular_catalog_observations',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'Atomic native molecular catalog registration.',
    rebuildPath:
      'Preserve catalog backup; imports and verified compute runs may be registered again from their original coordinates.',
  },
  molecular_catalog_prediction_requests: {
    id: 'sqlite.molecular_catalog_prediction_requests',
    label: 'Immutable complete prediction request receipts',
    kind: 'sqlite-table',
    table: 'molecular_catalog_prediction_requests',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'Verified client and provider request receipts retained atomically by the native molecular catalog.',
    rebuildPath:
      'Preserve catalog backup and original verified request receipts; missing provider defaults cannot be reconstructed from coordinates.',
  },
  molecular_catalog_chains: {
    id: 'sqlite.molecular_catalog_chains',
    label: 'Versioned native chain inventories',
    kind: 'sqlite-table',
    table: 'molecular_catalog_chains',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'Atomic native molecular catalog registration.',
    rebuildPath:
      'Preserve catalog backup; imports and verified compute runs may be registered again from their original coordinates.',
  },
  molecular_catalog_mappings: {
    id: 'sqlite.molecular_catalog_mappings',
    label: 'Versioned molecule to coordinate mappings',
    kind: 'sqlite-table',
    table: 'molecular_catalog_mappings',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'Atomic native molecular catalog registration.',
    rebuildPath:
      'Preserve catalog backup; imports and verified compute runs may be registered again from their original coordinates.',
  },
  compute_jobs: {
    id: 'sqlite.compute_jobs',
    label: 'Compute jobs on hosted providers ',
    kind: 'sqlite-table',
    table: 'compute_jobs',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'The local intent-before-submit row for a job sent to a user-connected compute provider; the provider holds the job itself.',
    rebuildPath:
      'Non-terminal rows are re-polled on startup. A lost row cannot be rebuilt from the provider automatically; the job remains visible in the provider UI.',
  },
  chat_turns: {
    id: 'sqlite.chat_turns',
    label: 'Chat turn route attribution',
    kind: 'sqlite-table',
    table: 'chat_turns',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The immutable local chat-turn route snapshot row.',
    rebuildPath: 'No automatic rebuild.',
  },
} as const satisfies Record<string, SqliteTableDataStoreEntry>;

export const NON_SQLITE_DATA_STORES = {
  workspace_sequence_packages: {
    id: 'workspace.sequence-packages',
    label: 'Managed project sequence packages',
    kind: 'workspace-file',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'The validated sequence-package marker, its immutable schema snapshot, primary sequence bytes, and declared managed members.',
    rebuildPath:
      'Sequence-package reconciliation recreates its catalog and Registry projections; current catalog bindings locate the owned package on this installation.',
  },
  workspace_native_catalog: {
    id: 'workspace.native-catalog',
    label: 'Portable native project catalog',
    kind: 'workspace-file',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: 'The validated project .forge/catalog.json manifest.',
    rebuildPath:
      'reconcileNativeCatalogRecordsFromFile() verifies the observed file digest and reconstructs native record/sequence placements, schemas, and relationships transactionally.',
  },
  workspace_entity_artifacts: {
    id: 'workspace.entity-artifacts',
    label: 'Generic project record artifacts',
    kind: 'workspace-file',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: '*.entity.json files owned by real projects.',
    rebuildPath:
      'reconcileWorkspaceEntities() uses the generic entity adapter to reconstruct Registry record content and typed relationships.',
  },
  workspace_notebook_packages: {
    id: 'workspace.notebook-packages',
    label: 'Project notebook packages',
    kind: 'workspace-file',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'The package Markdown document and referenced .forge/blocks payloads; .forge/notebook.json carries portable identity and package metadata.',
    rebuildPath:
      'Notebook reconciliation recreates pages content and refreshes owned Registry name/path metadata while retaining Registry lifecycle state.',
  },
  workspace_sequence_files: {
    id: 'workspace.sequence-files',
    label: 'Project sequence files',
    kind: 'workspace-file',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: '.gb/.fasta files in git-tracked projects.',
    rebuildPath: 'Not rebuilt from SQLite; SQLite indexes are derived from these files.',
  },
  workspace_primer_artifacts: {
    id: 'workspace.primer-artifacts',
    label: 'Project primer artifacts',
    kind: 'workspace-file',
    classification: 'AUTHORITATIVE',
    sourceOfTruth: '*.primer.json files selected inside git-tracked projects.',
    rebuildPath:
      'Not rebuilt from SQLite; reconcileWorkspaceRoot() discovers and projects each artifact into LIMS, primers, and primer_bindings.',
    notes:
      'dnaforge.primer/v1 records metadata, registry identity, and typed binds_to_sequence relationships without modifying the target sequence file.',
  },
  project_memory_jsonl: {
    id: 'waypoint.project-memory-jsonl',
    label: 'Project memory JSONL',
    kind: 'waypoint-directory',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'Portable receipts written by participating artifact operations to .waypoint/project-memory/*.jsonl.',
    rebuildPath:
      'Preserve these receipts. rebuildWorkspaceCatalogProjection() is an explicitly invoked, tested replay helper with no production startup/recovery integration.',
    notes:
      'This is not a complete catalog mirror and does not replace native manifests, authoritative files, or retained local current bindings.',
  },
  agent_attachment_snapshots: {
    id: 'waypoint.agent-attachment-snapshots',
    label: 'Immutable AI attachment snapshots',
    kind: 'waypoint-directory',
    classification: 'AUTHORITATIVE',
    sourceOfTruth:
      'Content-addressed bytes under the desktop userData agent-attachments directory.',
    rebuildPath: 'Reattach the original file if the immutable snapshot is lost.',
  },
  retired_features_table: {
    id: 'sqlite.features.retired',
    label: 'Retired features table',
    kind: 'retired-sqlite-table',
    classification: 'STUB_UNUSED',
    sourceOfTruth: 'None. GenBank/FASTA annotations are parsed from project sequence files.',
    rebuildPath: 'No rebuild. Schema v8 drops the writer-less table.',
    notes: 'Retired by  because it had SELECT helpers but zero production writers.',
  },
} as const satisfies Record<string, DataStoreManifestEntry>;
