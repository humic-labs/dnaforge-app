import type { PlatformBridge } from './types';
import { userMessage } from '@waypoint/user-messages';
import { googleSheetsUnavailable } from './google-sheets-unavailable';
import { unavailableMemoryPressure } from '../shared/memory-pressure-unavailable';
import { createHostedRuntimeProfile } from '../shared/runtime-profile';
import { HostedCapabilityError } from '../hosted/errors';
import type { RelocateEntityFileInput } from '../shared/workspace-relocate-types';
import { createHostedFileRelocator } from '../hosted/file-relocation';
import {
  createHostedAgentAttachments,
  createHostedAgentCapabilities,
  createHostedAgentSdk,
  createHostedAgentSession,
} from '../hosted/agent';
import {
  hostedAgentConfirm,
  hostedGenome,
  hostedLims,
  hostedReferenceAssets,
} from '../hosted/bridges';
import { withHostedReferenceMount } from '../hosted/reference-genomes/hosted-reference-genomes';
import { createHostedMemoryDb } from '../hosted/memory-db';
import { createHostedDurableChatDb, isHostedChatSql } from '../hosted/durable-chat-db';
import { hostedWorkspaceSessionController } from '../hosted/controller';
import { withDurableBrowserSettings } from './durable-browser-settings';
import { createMemoryNotebookPageCommands } from './memory-notebook-pages';
import { subscribeHostedFileChanged } from '../hosted/events';
import { createHostedVirtualFs } from '../hosted/virtual-fs';
import { createHostedProjectionSourceCommands } from '../hosted/entity-projection-source';
import { openHostedFileDialog } from '../hosted/open-file-dialog';
import { createHostedFeedback } from '../hosted/feedback';

const HOSTED_PROFILE = createHostedRuntimeProfile();
const hostedFs = withHostedReferenceMount(createHostedVirtualFs());
const hostedDb = createHostedMemoryDb(undefined, {
  getCatalogSource: () => {
    const state = hostedWorkspaceSessionController.getState();
    const snapshot = hostedFs.getCatalogSourceSnapshot();
    if (!snapshot) return null;
    const workspace = state.workspaces.find(
      (workspace) => workspace.workspaceId === snapshot.workspaceId
    );
    return { snapshot, displayName: workspace?.displayName };
  },
});
const hostedChatDb = createHostedDurableChatDb({
  getAccountId: () => hostedWorkspaceSessionController.getState().principal?.id ?? null,
});
const hostedNotebookCommands = createMemoryNotebookPageCommands(hostedDb, hostedFs);
type HostedCatalogFileRebinder = (
  input: Pick<RelocateEntityFileInput, 'oldPath' | 'newPath' | 'workspaceRoot' | 'actor'>
) => Promise<{ updated: number }>;
let hostedCatalogFileRebinder: HostedCatalogFileRebinder | null = null;

export { HostedCapabilityError };

export function configureHostedCatalogFileRebinder(
  rebinder: HostedCatalogFileRebinder | null
): void {
  hostedCatalogFileRebinder = rebinder;
}

function unavailable(capability: string): never {
  throw new HostedCapabilityError(capability);
}

function failClosed(capability: string): unknown {
  const fn = (..._args: unknown[]) => unavailable(capability);
  return new Proxy(fn, {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      if (typeof prop === 'symbol') return Reflect.get(fn, prop);
      return failClosed(`${capability}.${String(prop)}`);
    },
    apply() {
      unavailable(capability);
    },
  });
}

function hostedSectionTarget<T extends object>(implemented: Partial<T>): T {
  return Object.assign(Object.create(null) as T, implemented);
}

const hostedFsTarget = hostedSectionTarget<PlatformBridge['fs']>(hostedFs);
hostedFsTarget.appendProjectMemoryEvent = undefined;
const hostedWorkspaceTarget = hostedSectionTarget<PlatformBridge['workspace']>({
  getOriginalDefaultProject: async () => ({
    status: 'unresolved',
    reason: 'project-unavailable',
    message: userMessage('hosted.unavailable'),
  }),
  listChildren: hostedFs.listChildren,
  onImportProgress: () => () => undefined,
  relocateEntityFile: createHostedFileRelocator({
    rename: hostedFs.rename,
    rebindCatalogFiles: (input) => {
      if (!hostedCatalogFileRebinder)
        throw new Error('Hosted catalog relocation is not configured.');
      return hostedCatalogFileRebinder(input);
    },
  }),
});

const hostedImplemented: Partial<PlatformBridge> = {
  googleSheets: googleSheetsUnavailable,
  hostedAi: {
    readIncludedAllowance: async () => ({ status: 'unavailable', code: 'not_configured' }),
  },
  runtime: {
    ...unavailableMemoryPressure,
    getProfile: () => HOSTED_PROFILE,
    getProvenance: async () => ({
      kind: 'hosted-browser',
      appName: 'DNAForge',
      appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'hosted',
      isPackaged: import.meta.env.PROD,
      isReleaseBuild: import.meta.env.PROD,
      appPath: null,
      execPath: null,
      cwd: null,
      userDataPath: null,
      projectRoot: null,
      apiUrl: window.location.origin,
      pid: null,
      sidecarPid: null,
      startedAtMs: Date.now(),
      desktopDevPort: null,
      desktopHmrPort: null,
      nodeEnv: import.meta.env.MODE,
      waypointTest: null,
      cacheContractToken: null,
      buildSourceFingerprint:
        typeof __WAYPOINT_BUILD_SOURCE_FINGERPRINT__ === 'string'
          ? __WAYPOINT_BUILD_SOURCE_FINGERPRINT__
          : null,
      sidecarSourceFingerprint: null,
    }),
  },
  startup: {
    getState: async () => ({ loadId: 'hosted-browser', pageLoaded: true, shellReady: false }),
    isErrorReportingEnabled: async () => false,
    acknowledge: async () => true,
  },
  config: {
    getApiUrl: async () => window.location.origin,
    getSidecarStatus: async () => 'unavailable',
    restartSidecar: async () => 'unavailable',
  },
  on: (channel, callback) => {
    if (channel === 'file-changed') {
      return subscribeHostedFileChanged((path) => {
        callback(path);
      });
    }
    return () => undefined;
  },
  dialog: {
    open: openHostedFileDialog,
    authorizeLocalIndexedTrack: async () => unavailable('dialog.authorizeLocalIndexedTrack'),
    save: async () => null,
  },
  path: {
    appDataDir: async () => '/hosted',
    referenceAssetCacheRoot: async () => '/hosted/reference-cache',
    referenceAssetPublicationRoot: async () => '/hosted/reference-publication',
    projectRoot: async () => null,
  },
  app: {
    reportDirtyState: () => undefined,
    saveAllDone: () => undefined,
  },
  update: {
    install: async () => ({
      status: 'failed',
      message: 'Automatic updates are only available in the desktop app.',
    }),
    retry: async () => undefined,
    checkManual: async () => undefined,
    simulate: async () => undefined,
  },
  keyring: {
    hasPassword: async () => false,
    getPassword: async () => null,
    setPassword: async () => unavailable('keyring.setPassword'),
    deletePassword: async () => undefined,
  },
  genomeCredentials: {
    save: async () => unavailable('genomeCredentials.save'),
    status: async (authRef) => ({ authRef, connected: false }),
    prepare: async () => unavailable('genomeCredentials.prepare'),
    remove: async (authRef) => ({ authRef, removed: false }),
  },
  workspaceMutations: { onLifecycle: () => () => undefined },
  fileAssociations: {
    takePendingActivations: async () => [],
    materializeQuickLookPackage: async () =>
      unavailable('fileAssociations.materializeQuickLookPackage'),
    prepareQuickLookPackage: async () => false,
    promoteQuickLookPackage: async () => unavailable('fileAssociations.promoteQuickLookPackage'),
    onOpenFiles: () => () => undefined,
    queryHandlers: async () => [],
    requestDefault: async () => unavailable('fileAssociations.requestDefault'),
  },
  db: withDurableBrowserSettings({
    health: async () => unavailable('db.health'),
    assertCanonicalSequenceSource: async () => {
      throw new Error(
        'FASTA_KIND_UNSUPPORTED: Canonical FASTA source authority requires Electron.'
      );
    },
    getFastaKindReadAuthority: async () => {
      throw new Error('FASTA_KIND_UNSUPPORTED: Native FASTA kind authority requires Electron.');
    },
    getFastaKindAuthority: async () => {
      throw new Error('FASTA_KIND_UNSUPPORTED: Native FASTA kind inspection requires Electron.');
    },
    classifyFasta: async () => {
      throw new Error('FASTA_KIND_UNSUPPORTED: Native FASTA classification requires Electron.');
    },
    createEntityReference: hostedChatDb.createEntityReference,
    updateEntityReference: hostedChatDb.updateEntityReference,
    deleteEntityReference: hostedChatDb.deleteEntityReference,
    setEntityReferenceWorkspaceRootPathIfMissing:
      hostedChatDb.setEntityReferenceWorkspaceRootPathIfMissing,
    recordEntityReferenceRevision: hostedChatDb.recordEntityReferenceRevision,
    linkCatalogEntities: (input) => hostedDb.linkCatalogEntities(input),
    recordCatalogEvent: (input) => hostedDb.recordCatalogEvent(input),
    updateCatalogEntityPresentation: (input) => hostedDb.updateCatalogEntityPresentation(input),
    writeCatalogWorkspacePlacement: async () => unavailable('db.writeCatalogWorkspacePlacement'),
    removeCatalogWorkspacePlacement: async () => unavailable('db.removeCatalogWorkspacePlacement'),
    restoreCatalogProviderBinding: async () => unavailable('db.restoreCatalogProviderBinding'),
    archiveSupersededNotebookCatalog: async () =>
      unavailable('db.archiveSupersededNotebookCatalog'),

    ensureSequenceIndex: async () => unavailable('db.ensureSequenceIndex'),
    ensureWorkspaceOwner: (root, access, discovery) =>
      hostedDb.ensureWorkspaceOwner(root, access, discovery),
    setCatalogFileState: async () => unavailable('db.setCatalogFileState'),
    refreshCatalogFileFingerprints: async () => unavailable('db.refreshCatalogFileFingerprints'),
    releaseMissingCatalogFilePath: async () => unavailable('db.releaseMissingCatalogFilePath'),
    registerWorkspaceFile: (input) => hostedDb.registerWorkspaceFile(input),
    rebindCatalogFiles: (input) => hostedDb.rebindCatalogFiles(input),
    clearCatalogProjection: async () => unavailable('db.clearCatalogProjection'),
    deleteCatalogEntityIfUnbound: async () => unavailable('db.deleteCatalogEntityIfUnbound'),
    deleteCatalogEntityWithExactBinding: async () =>
      unavailable('db.deleteCatalogEntityWithExactBinding'),
    registerCatalogEntity: (input) => hostedDb.registerCatalogEntity(input),
    bindCatalogEntityFile: (input) => hostedDb.bindCatalogEntityFile(input),
    execute: (sql, params) =>
      (isHostedChatSql(sql) ? hostedChatDb : hostedDb).execute(sql, params as never),
    select: (sql, params) =>
      (isHostedChatSql(sql) ? hostedChatDb : hostedDb).select(sql, params as never),
    readMountedCatalogSearchRows: hostedDb.readMountedCatalogSearchRows,
    createChatTurnWithUserMessage: hostedChatDb.createChatTurnWithUserMessage,
    commitChatTurnTerminalState: hostedChatDb.commitChatTurnTerminalState,
    deleteConversation: hostedChatDb.deleteConversation,
    deleteMessage: hostedChatDb.deleteMessage,
    allocatePrimerCatalogNumber: (workspaceId) => hostedDb.allocatePrimerCatalogNumber(workspaceId),
    replacePrimerProjection: (input) => hostedDb.replacePrimerProjection(input),
    ...hostedNotebookCommands,
    ...createHostedProjectionSourceCommands({
      db: hostedDb,
      fs: hostedFs,
      lims: hostedLims,
      settleNotebook: hostedNotebookCommands.settleEntityProjectionSource,
    }),
    deleteNotebookPage: async () => unavailable('db.deleteNotebookPage'),
  }),
  importReview: {
    call: async () => {
      throw new Error('Native import review is unavailable in this runtime.');
    },
    snapshot: async () => {
      throw new Error('Native import review is unavailable in this runtime.');
    },
    onChanged: () => () => {},
  },
  notebook: {
    migrateLegacyProjectFiles: async () => unavailable('notebook.migrateLegacyProjectFiles'),
    create: async () => unavailable('notebook.create'),
    completeLegacyDraftMigration: async () => unavailable('notebook.completeLegacyDraftMigration'),
    execute: async () => unavailable('notebook.execute'),
    onChanged: () => () => undefined,
  },
  administration: {
    execute: async () => ({
      kind: 'failed',
      code: 'ADMINISTRATION_UNAVAILABLE',
      message: 'Native administration is unavailable in this runtime.',
      stateChanged: false,
    }),
    onChanged: () => () => {},
  },
  lims: hostedLims,
  genome: hostedGenome,
  referenceAssets: hostedReferenceAssets,
  trackViews: {
    locations: async () => unavailable('platform.trackViews.locations'),
    list: async () => unavailable('platform.trackViews.list'),
    read: async () => unavailable('platform.trackViews.read'),
    save: async () => unavailable('platform.trackViews.save'),
    command: async () => unavailable('platform.trackViews.command'),
  },
  remoteGenomics: undefined,
  clipboard: {
    writeText: async (text) => {
      await navigator.clipboard.writeText(text);
    },
  },
  window: {
    showMenu: async () => unavailable('window.showMenu'),
    setTitleBarTheme: async () => undefined,
    minimize: async () => undefined,
    maximize: async () => undefined,
    unmaximize: async () => undefined,
    close: async () => undefined,
    isMaximized: async () => false,
    setSize: async () => undefined,
    setPosition: async () => undefined,
    getSize: async () => ({ width: window.innerWidth, height: window.innerHeight }),
    getPosition: async () => ({ x: 0, y: 0 }),
    getDisplayColorSpace: async () => null,
    setZoomLevel: async () => ({ status: 'unavailable' }),
  },
  shell: {
    projectHistory: async () => unavailable('shell.projectHistory'),
    onProjectHistoryChanged: () => () => undefined,
    revealItemInDir: async () => unavailable('shell.revealItemInDir'),
    fileTrash: async () => unavailable('shell.fileTrash'),
    trashItem: async (path) => {
      await hostedFs.removeFile(path, { atomic: true });
    },
    execute: async () => unavailable('shell.execute'),
    readGitHead: async () => null,
    cancelGitRead: async () => false,
  },
  molecularData: {
    retain: async () => unavailable('molecularData.retain'),
    load: async () => unavailable('molecularData.load'),
  },
  molecularCatalog: {
    register: async () => {
      throw new Error('The shared structure catalog requires the desktop app.');
    },
    list: async () => [],
    load: async () => {
      throw new Error('The shared structure catalog requires the desktop app.');
    },
  },
  compute: {
    recoverLegacyResult: async () => {
      throw new Error('Compute recovery is only available in the desktop app.');
    },
    listProviders: async () => [],
    installManifest: async () => ({
      ok: false,
      kind: 'sidecar_unavailable',
      message: 'Custom compute endpoints are only available in the desktop app.',
    }),
    removeCustomProvider: async () => ({
      ok: false,
      kind: 'not_found',
      message: 'Custom compute endpoints are only available in the desktop app.',
    }),
    connect: async () => ({
      ok: false,
      kind: 'sidecar_unavailable',
      message: 'Local compute providers are only available in the desktop app.',
    }),
    test: async () => ({
      ok: false,
      kind: 'sidecar_unavailable',
      message: 'Local compute providers are only available in the desktop app.',
    }),
    disconnect: async (providerId) => ({ ok: true, providerId, removed: false }),
    recordJobIntent: async () => unavailable('compute.recordJobIntent'),
    markJobSubmitted: async () => null,
    markJobFailed: async () => null,
    markJobSubmissionUnknown: async () => null,
    markJobCanceled: async () => null,
    markJobImported: async () => null,
    listJobs: async () => [],
    listJobsSnapshot: async () => unavailable('compute.listJobsSnapshot'),
    findJob: async () => null,
  },
  cloudSync: new Proxy({} as PlatformBridge['cloudSync'], {
    get(_target, prop) {
      if (
        prop === 'onReplicaLifecycle' ||
        prop === 'subscribeStatus' ||
        prop === 'onOrganizationRegistryChanged'
      ) {
        return () => () => undefined;
      }
      if (prop === 'listSyncedProjects') return async () => [];
      return failClosed(`cloudSync.${String(prop)}`);
    },
  }),
  analytics: {
    getRuntimeConfig: async () => null,
    writeTableNotebookReceipt: async () => false,
    getOptIn: async () => false,
    persistConsent: async () => undefined,
    syncContext: async () => ({
      accepted: false,
      authority: {
        actorKind: 'unknown',
        executionMode: 'interactive',
        impersonated: false,
      },
    }),
    setConsent: async () => undefined,
  },
  feedback: {
    ...createHostedFeedback(),
    report: async () => ({
      ok: false,
      code: 'FEEDBACK_UNAVAILABLE',
      error: 'Agent reporting requires the DNAForge desktop app.',
      retriable: false,
      stateChanged: false,
      partialEffects: [],
    }),
  },
  agentTools: {
    onCall: () => () => undefined,
    onCancel: () => () => undefined,
    respond: () => undefined,
  },
  agentConfirm: hostedAgentConfirm,
  agentCapabilities: createHostedAgentCapabilities(),
  agentAttachments: createHostedAgentAttachments(),
  agentSdk: createHostedAgentSdk(),
  agentSession: createHostedAgentSession(),
  conversationLedger: {
    appendEvent: async () => ({ ok: false, event: null }),
    unlinkConversation: async () => ({ ok: true }),
  },
  largeFileImportDialog: {
    onRequest: () => () => undefined,
    onCancel: () => () => undefined,
    respond: () => undefined,
  },
  convertFileSrc: async (filePath) => filePath,
  fs: new Proxy(hostedFsTarget, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (typeof prop === 'string' && prop.endsWith('InMain')) return undefined;
      return failClosed(`fs.${String(prop)}`);
    },
  }),
  workspace: new Proxy(hostedWorkspaceTarget, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
      if (prop in target) return Reflect.get(target, prop, receiver);
      return failClosed(`workspace.${String(prop)}`);
    },
  }),
};

export const hostedBrowserBridge: PlatformBridge = new Proxy(hostedImplemented as PlatformBridge, {
  get(target, prop, receiver) {
    if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
    if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined;
    if (prop in target) return Reflect.get(target, prop, receiver);
    return failClosed(`platform.${String(prop)}`);
  },
});
