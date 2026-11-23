import type { SqliteIpcValue } from '../sqlite-ipc';
import type { PrimerLegacyProjectionInput } from '../primer-projection-ipc';
import { defineGroup, invoke } from './contract';

export interface DatabaseHealth {
  ok: boolean;
  dbPath: string;
  nativeModuleArch: string | null;
  error: string | null;
  connection: {
    journalMode: string;
    foreignKeys: number;
    schemaVersion: number;
  } | null;
}

export const dbContract = defineGroup('db', {
  health: invoke<[], DatabaseHealth>(),
  savedRowRecoveryGenerations: invoke<[],string[]>(),
  listSavedEntityRowVersions: invoke<[query: import('../saved-entity-row-version').SavedEntityRowVersionQuery], import('../saved-entity-row-version').SavedEntityRowVersion[]>(),
  recoverSavedEntityRowVersion: invoke<[request: import('../saved-entity-row-version').SavedRowRecoveryRequest], {path:string} | null>(),
  assertCanonicalSequenceSource: invoke<
    [input: import('../sequence-index-command').SequenceIndexRequest],
    void
  >(),
  getFastaKindReadAuthority: invoke<
    [input: import('../fasta-kind').FastaKindInspection],
    import('../fasta-kind').FastaKindReadAuthority
  >(),
  getFastaKindAuthority: invoke<
    [input: import('../fasta-kind').FastaKindInspection],
    import('../fasta-kind').FastaKindAuthority
  >(),
  classifyFasta: invoke<
    [input: import('../fasta-kind').FastaKindClassification, mutationToken?: string],
    import('../fasta-kind').DeclaredFastaKindAuthority
  >(),
  createEntityReference: invoke<
    [row: import('../chat-turn-ipc').ChatEntityReferenceIpcRow],
    import('../chat-turn-ipc').ChatEntityReferenceIpcRow
  >(),
  updateEntityReference: invoke<
    [id: string, updates: import('../entity-reference-ipc').EntityReferenceUpdates],
    void
  >(),
  deleteEntityReference: invoke<[id: string], void>(),
  setEntityReferenceWorkspaceRootPathIfMissing: invoke<
    [id: string, workspaceRootPath: string],
    string | null
  >(),
  recordEntityReferenceRevision: invoke<
    [input: import('../entity-reference-ipc').EntityReferenceRevisionInput],
    import('../entity-reference-ipc').EntityReferenceRevisionRow
  >(),
  linkCatalogEntities: invoke<
    [input: import('../catalog-associations').CatalogEntityLinkInput],
    import('../catalog-associations').CatalogEntityLinkRow
  >(),
  recordCatalogEvent: invoke<
    [input: import('../catalog-associations').CatalogEventInput],
    import('../catalog-associations').CatalogEventRow
  >(),
  updateCatalogEntityPresentation: invoke<
    [input: import('../catalog-associations').CatalogEntityPresentationInput],
    import('../catalog-registration').CatalogEntityRow | null
  >(),
  writeCatalogWorkspacePlacement: invoke<
    [input: import('../catalog-associations').CatalogWorkspacePlacementInput],
    import('../catalog-associations').CatalogWorkspacePlacementRow
  >(),
  removeCatalogWorkspacePlacement: invoke<[entityId: string, mode: 'hide' | 'delete'], boolean>(),
  restoreCatalogProviderBinding: invoke<
    [input: import('../catalog-associations').RestoreCatalogProviderBindingInput],
    void
  >(),
  archiveSupersededNotebookCatalog: invoke<
    [input: import('../catalog-associations').ArchiveSupersededNotebookCatalogInput],
    void
  >(),

  ensureSequenceIndex: invoke<
    [input: import('../sequence-index-command').SequenceIndexRequest],
    number
  >(),
  ensureWorkspaceOwner: invoke<
    [
      workspaceRoot: string,
      access?: import('../workspace-access').WorkspaceAccess,
      discovery?: import('../workspace-access').WorkspaceOwnerDiscovery,
    ],
    number
  >(),
  setCatalogFileState: invoke<
    [path: string, state: 'missing' | 'historical', reason: string],
    import('../catalog-binding').CatalogFileBindingRow | null
  >(),
  refreshCatalogFileFingerprints: invoke<
    [files: readonly import('../catalog-registration').CatalogFileFingerprint[]],
    void
  >(),
  releaseMissingCatalogFilePath: invoke<
    [file: import('../catalog-binding').CatalogFileBindingRow, replacementEntityId: string],
    void
  >(),
  registerWorkspaceFile: invoke<
    [
      input: import('../catalog-registration').CatalogWorkspaceFileRegistrationRequest,
      mutationToken?: string,
    ],
    import('../catalog-registration').CatalogEntityRow
  >(),
  rebindCatalogFiles: invoke<
    [input: import('../catalog-registration').CatalogFileRebindRequest, mutationToken?: string],
    { updated: number; missingOldPath: boolean }
  >(),
  clearCatalogProjection: invoke<
    [workspaceRoot: string],
    import('../catalog-registration').CatalogProjectionClearResult
  >(),
  deleteCatalogEntityIfUnbound: invoke<[entityId: string], boolean>(),
  deleteCatalogEntityWithExactBinding: invoke<
    [input: import('../catalog-registration').CatalogEntityRollbackRequest],
    boolean
  >(),
  registerCatalogEntity: invoke<
    [input: import('../catalog-registration').CatalogEntityRegistrationRequest],
    import('../catalog-registration').CatalogEntityRow
  >(),
  bindCatalogEntityFile: invoke<
    [input: import('../catalog-binding').CatalogFileBindingRequest, mutationToken?: string],
    import('../catalog-binding').CatalogFileBindingRow
  >(),
  execute: invoke<
    [sql: string, params?: SqliteIpcValue[]],
    { changes: number; lastInsertRowid: number }
  >(),
  allocatePrimerCatalogNumber: invoke<
    [workspaceId?: number, workspaceRoot?: string, mutationToken?: string],
    string
  >(),
  replacePrimerProjection: invoke<
    [input: PrimerLegacyProjectionInput, workspaceRoot?: string, mutationToken?: string],
    void
  >(),
  replaceNotebookProjection: invoke<
    [
      input: import('../notebook-projection').NotebookProjectionFromFileInput,
      mutationToken?: string,
    ],
    import('../notebook-projection').NotebookPageRow
  >(),
  mutateLegacyNotebookPage: invoke<
    [input: import('../notebook-projection').LegacyNotebookPageMutation, mutationToken?: string],
    import('../notebook-projection').NotebookPageRow | null
  >(),
  deleteNotebookPage: invoke<[pageId: string, mutationToken?: string], boolean>(),
  settleEntityProjectionSource: invoke<
    [
      input: import('../entity-projection-source').SettleEntityProjectionSourceInput,
      mutationToken?: string,
    ],
    void
  >(),
});
