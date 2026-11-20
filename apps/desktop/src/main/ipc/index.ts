import { registerEntityDiscoveryHandlers } from './entity-discovery';
import { recoverComputeResult } from '../workspace-git/compute-result-recovery';
import { configContract } from '../../shared/ipc/config.contract';
import { registerGoogleSheetsHandlers } from './google-sheets';
import { registerTrackViewIpcHandlers } from './track-views';
import { registerSequenceDataLayerIpcHandlers } from './sequence-data-layers';
import { registerContactSourceIpcHandlers } from './contact-sources';
import { registerComparisonSourceIpcHandlers } from './comparison-sources';
import { registerMolecularDocumentIpcHandlers } from './molecular-documents';
import { handleGroup, mainIpc } from '../../shared/ipc-contract';
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getDb, registerDatabaseHandlers } from './database';
import { registerFilesystemHandlers } from './filesystem';
import { registerScientificDocumentHandlers } from './scientific-documents';
import { registerWorkTaskHandlers } from './work-tasks';
import { requestEntityNavigation } from '../features/entity-navigation';
import { registerScientificObjectHandlers } from './scientific-objects';
import { registerPdfExtractionHandlers } from '../pdf-extraction';
import { registerDialogHandlers } from './dialog';
import { registerWindowHandlers } from './window';
import { registerShellHandlers } from './shell';
import { registerKeyringHandlers } from './keyring';
import { registerTerminalIpc } from '../terminal/ipc';
import {
  agentToolsBridge,
  nativeDocuments,
  registerMainFeatureIpc,
  workspaceSync,
} from '../features';
import { registerRemoteGenomicsIpcHandlers } from './remote-genomics';
import { registerComputeHandlers } from '../compute/ipc';
import { registerGenomeSourceCredentialHandlers } from '../genome-source-credentials';
import { ComputeJobRegistry } from '../compute/jobs';
import { MolecularCatalogService } from '../molecular-catalog/service';
import { registerMolecularCatalogHandlers } from '../molecular-catalog/ipc';
import { MolecularDataService } from '../molecular-data/service';
import { registerMolecularDataHandlers } from '../molecular-data/ipc';
import { computeUserManifestsDir } from '../compute/manifest-paths';
import type { ComputeJobTerminalEvent } from '../../shared/compute-jobs-ipc';
import { readComputeCredential } from '../compute/credentials';
import { sidecarFetch, sidecarSessionAuthority } from '../sidecar-session-runtime';
import { DEFAULT_MCP_GRANT_CAPABILITIES } from '../sidecar-capabilities';
import { registerFeedbackHandlers } from './feedback';
import { registerAgentFeedbackHandlers } from './agent-feedback';
import { registerInternalFixtureHandlers } from './internal-fixtures';
import { registerTracingHandlers } from './tracing';
import { registerGenomeDataHandlers } from './genome-data';
import { registerSampleWorkspaceHandlers } from './sample-workspaces';
import { registerWorkspaceGitHandlers } from './workspace-git';
import { registerWorkspaceRelocateHandlers } from './workspace-relocate';
import { registerWorkspaceBrowserHandlers } from './workspace-browser';
import { registerAgentSdkHandlers } from '../agent-sdk';
import { registerAgentCapabilityHandlers } from '../agent-capabilities/ipc';
import { registerAgentAttachmentHandlers } from '../agent-capabilities/attachment-ipc';
import { registerAgentSessionHandlers } from '../agent-session';
import { registerLimsIpcHandlers } from '../lims';
import { registerConversationLedgerHandlers } from '../conversation-ledger/ipc';
import { registerCloudSyncHandlers } from './cloud-sync';
import { registerDeepShareHandlers } from './deep-share';
import { registerHostedAiGatewayHandlers } from './hosted-ai-gateway';
import { registerInlineReferenceTargetHandlers } from './inline-reference-target';
import { registerWorkspaceSyncHandlers } from './workspace-sync';
import { getApiUrl, ensureApiPort } from '../config';
import {
  getLastSidecarStatus,
  getSidecarSourceFingerprint,
  refreshSidecarStatus,
  restartSidecar,
  getSidecarProcessPid,
} from '../sidecar';

import {
  registerAnalyticsHandlers,
  captureFeedbackTelemetryOrigin,
  recordFeedbackTelemetry,
  trackComputeJobObserved,
} from '../analytics';
import { getAuthState } from '../auth/controller';
import { reconcileUpdateInstallTelemetryReceipt } from '../update-install-telemetry';
import { ASSEMBLY_OVERVIEW_CACHE_CONTRACT_TOKEN } from './assembly-overview-texture-cache';
import { registerDiagnosticsHandlers } from './diagnostics';
import { RELEASE_BUILD_IDENTITY } from '../release-stamp';
import { APP_BUILD } from '../../lib/app-build';
import { resolveReferenceAssetRootLayout } from '../reference-assets/reference-asset-cache-root';
import type { RuntimeProvenance } from '../../shared/runtime-profile';
import { pathContract } from '../../shared/ipc/path.contract';

const mainProcessStartedAtMs = Date.now();

function findRepoRoot(start: string): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(resolve(dir, 'Cargo.toml'))) return dir;
    if (existsSync(resolve(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export interface RegisterAllIpcHandlersDeps {
  googleSheetsTrustedRendererUrl?: () => string | null;
  terminalTrustedRendererUrl?: () => string | null;
  terminalIsPrimaryOwner?: (id: number) => boolean;
  terminalWindowPreload?: () => { preload?: string; additionalArguments?: string[] };

  sendComputeJobTerminal?: (event: ComputeJobTerminalEvent) => void;
}

export function registerAllIpcHandlers(deps: RegisterAllIpcHandlersDeps = {}): void {
  handleGroup(pathContract, {
    appDataDir: () => app.getPath('userData'),
    referenceAssetCacheRoot: () => {
      return resolveReferenceAssetRootLayout({
        appDataRoot: app.getPath('appData'),
        userDataRoot: app.getPath('userData'),
        env: process.env,
      }).cacheRoot;
    },
    referenceAssetPublicationRoot: () => {
      return resolveReferenceAssetRootLayout({
        appDataRoot: app.getPath('appData'),
        userDataRoot: app.getPath('userData'),
        env: process.env,
      }).publicationRoot;
    },
    projectRoot: () => {
      if (app.isPackaged) return null;
      return findRepoRoot(process.cwd()) ?? findRepoRoot(app.getAppPath());
    },
  });

  mainIpc.handle('runtime:getProvenance', async (): Promise<RuntimeProvenance> => {
    await ensureApiPort();
    const sidecarSourceFingerprint = await getSidecarSourceFingerprint();
    const projectRoot = app.isPackaged
      ? null
      : (findRepoRoot(process.cwd()) ?? findRepoRoot(app.getAppPath()));

    return {
      kind: 'electron-main',
      appName: app.getName(),
      appVersion: APP_BUILD.version ?? 'unknown',
      isPackaged: app.isPackaged,
      isReleaseBuild: RELEASE_BUILD_IDENTITY.isReleaseBuild,
      appPath: app.getAppPath(),
      execPath: process.execPath,
      cwd: process.cwd(),
      userDataPath: app.getPath('userData'),
      projectRoot,
      apiUrl: getApiUrl(),
      pid: process.pid,
      sidecarPid: getSidecarProcessPid(),
      startedAtMs: mainProcessStartedAtMs,
      desktopDevPort: process.env.DESKTOP_DEV_PORT ?? null,
      desktopHmrPort: process.env.DESKTOP_HMR_PORT ?? null,
      nodeEnv: process.env.NODE_ENV ?? null,
      waypointTest: process.env.WAYPOINT_TEST ?? null,
      cacheContractToken: ASSEMBLY_OVERVIEW_CACHE_CONTRACT_TOKEN,
      buildSourceFingerprint: __WAYPOINT_BUILD_SOURCE_FINGERPRINT__,
      sidecarSourceFingerprint,
    };
  });

  handleGroup(configContract, {
    getApiUrl: async () => {
      await ensureApiPort();
      return getApiUrl();
    },
    getSidecarStatus: () => refreshSidecarStatus(),
    restartSidecar: () => {
      void restartSidecar().catch((err) => {
        console.error('[IPC] Failed to restart sidecar:', err);
      });
      return getLastSidecarStatus();
    },
  });

  registerDatabaseHandlers();
  registerEntityDiscoveryHandlers();
  registerFilesystemHandlers();
  registerScientificDocumentHandlers();
  registerScientificObjectHandlers();
  registerWorkTaskHandlers(nativeDocuments.notebookDocuments, requestEntityNavigation, getDb);
  registerInlineReferenceTargetHandlers();
  registerPdfExtractionHandlers();
  registerDialogHandlers();
  registerWindowHandlers();
  registerShellHandlers();
  registerKeyringHandlers();
  registerRemoteGenomicsIpcHandlers();
  registerMainFeatureIpc();
  registerTerminalIpc(
    deps.terminalTrustedRendererUrl ?? (() => null),
    deps.terminalIsPrimaryOwner ?? (() => false),
    deps.terminalWindowPreload ?? (() => ({})),
    nativeDocuments.workspaces
  );
  registerGenomeSourceCredentialHandlers({
    sidecarFetch: async (pathOrUrl, init) => {
      await sidecarSessionAuthority.waitForReadySnapshot(30_000);
      return sidecarFetch(pathOrUrl, init);
    },
  });

  const recoverLegacyComputeResult = async (
    job: import('../../shared/compute-jobs-ipc').ComputeJobRecord,
    assertJobCurrent: () => void = () => {}
  ) => {
    if (!job.workspaceRoot || !job.remoteId)
      throw new Error('The compute result has no native project or provider identity.');
    const db = getDb();
    const root = job.workspaceRoot;
    const assertWorkspace = nativeDocuments.workspaces.capture(root);
    const assertCurrent = () => {
      assertJobCurrent();
      if (getDb() !== db)
        throw new Error('The application profile changed during result conversion.');
      assertWorkspace();
    };
    await nativeDocuments.flushDirtyDocumentClients();
    assertCurrent();
    return nativeDocuments.fileDocuments.withCleanPaths(
      [resolve(root, 'compute', job.provider, job.remoteId)],
      () =>
        recoverComputeResult(
          db,
          { workspaceRoot: root, provider: job.provider, remoteId: job.remoteId! },
          { assertCurrent }
        )
    );
  };
  const computeJobs = new ComputeJobRegistry({
    db: getDb,
    sidecarFetch,
    readCredential: readComputeCredential,
    grantedCapabilities: () => [...DEFAULT_MCP_GRANT_CAPABILITIES],
    notifyTerminal: deps.sendComputeJobTerminal,
    observeLifecycle: trackComputeJobObserved,
    recoverLegacyResult: recoverLegacyComputeResult,
  });
  registerComputeHandlers({
    sidecarFetch: async (pathOrUrl, init) => {
      await sidecarSessionAuthority.waitForReadySnapshot(30_000);
      return sidecarFetch(pathOrUrl, init);
    },
    grantedCapabilities: () => [...DEFAULT_MCP_GRANT_CAPABILITIES],
    jobs: computeJobs,
    recoverLegacyResult: recoverLegacyComputeResult,
    userManifestsDir: computeUserManifestsDir(app.getPath('userData')),
    restartSidecar,
  });

  registerMolecularCatalogHandlers(new MolecularCatalogService(getDb, computeJobs));
  registerMolecularDataHandlers(new MolecularDataService(getDb));
  nativeDocuments.onLegacyDraftMigrationCompleted(() => computeJobs.retryLegacyResultMigrations());
  computeJobs.start();
  const recoverFeedbackTelemetry = registerFeedbackHandlers({
    captureOrigin: captureFeedbackTelemetryOrigin,
    record: recordFeedbackTelemetry,
  });
  registerAgentFeedbackHandlers();
  registerInternalFixtureHandlers();
  registerAnalyticsHandlers(getAuthState, () => {
    try {
      reconcileUpdateInstallTelemetryReceipt(getDb());
    } finally {
      recoverFeedbackTelemetry();
    }
  });
  registerDiagnosticsHandlers();
  registerTracingHandlers();
  registerGenomeDataHandlers();
  registerSampleWorkspaceHandlers();
  registerWorkspaceGitHandlers();
  registerWorkspaceRelocateHandlers();
  registerWorkspaceBrowserHandlers();
  registerAgentSdkHandlers();
  registerAgentCapabilityHandlers();
  registerAgentAttachmentHandlers();
  registerAgentSessionHandlers();
  registerLimsIpcHandlers();
  registerGoogleSheetsHandlers({
    trustedRendererUrl: deps.googleSheetsTrustedRendererUrl ?? (() => null),
  });
  registerConversationLedgerHandlers();
  registerCloudSyncHandlers();
  registerHostedAiGatewayHandlers({ getAgentToolsBridge: () => agentToolsBridge.current() });
  const workspaceSyncDependencies = workspaceSync.ipcDependencies();
  registerWorkspaceSyncHandlers(workspaceSyncDependencies);
  registerDeepShareHandlers({
    getDb,
    forceSync:
      workspaceSyncDependencies?.actions?.forceSync ??
      (async () => ({ ok: false, message: 'Project sync is not available.' })),
    appVersion: app.getVersion(),
  });
  registerTrackViewIpcHandlers();
  registerSequenceDataLayerIpcHandlers();
  registerContactSourceIpcHandlers();
  registerComparisonSourceIpcHandlers();
  registerMolecularDocumentIpcHandlers();
}
