import { trackViewCommandsContract } from '../shared/ipc/track-view-commands.contract';
import { notebookContract } from '../shared/ipc/notebook.contract';
import { inventoryContract } from '../shared/ipc/inventory.contract';
import { importReviewContract } from '../shared/ipc/import-review.contract';
import { administrationContract } from '../shared/ipc/administration.contract';
import { primerArtifactContract } from '../shared/ipc/primer-artifact.contract';
import { sequenceAlignmentHistoryContract } from '../shared/ipc/sequence-alignment-history.contract';
import { originalProjectContract } from '../shared/ipc/original-project.contract';
import { organizationRegistryContract } from '../shared/ipc/organization-registry.contract';

import { molecularDataContract } from '../shared/ipc/molecular-data.contract';
import { analyticsContract } from '../shared/ipc/analytics.contract';
import { scientificObjectsContract } from '../shared/ipc/scientific-objects.contract';
import { scientificRecoveryContract } from '../shared/ipc/scientific-recovery.contract';
import { computeContract } from '../shared/ipc/compute.contract';
import { feedbackContract } from '../shared/ipc/feedback.contract';
import { molecularCatalogContract } from '../shared/ipc/molecular-catalog.contract';
import { configContract } from '../shared/ipc/config.contract';
import { startupContract } from '../shared/ipc/startup.contract';
import { updateContract } from '../shared/ipc/update.contract';
import { keyringContract } from '../shared/ipc/keyring.contract';
import { limsContract } from '../shared/ipc/lims.contract';
import { scientificDocumentsContract } from '../shared/ipc/scientific-documents.contract';
import { terminalContract } from '../shared/ipc/terminal.contract';
import { looseSequenceFilesContract } from '../shared/ipc/loose-sequence-files.contract';
import { thirdPartyNoticesContract } from '../shared/ipc/third-party-notices.contract';
import { remoteHostsContract } from '../shared/ipc/remote-hosts.contract';
import { agentFeedbackContract } from '../shared/ipc/agent-feedback.contract';
import { windowContract } from '../shared/ipc/window.contract';
import type {
  RemoteGenomicsRuntimeStatusEventV1,
  RemoteGenomicsRuntimeStatusV1,
  RemoteGenomicsStatusDeliveryV1,
  RemoteGenomicsStatusSubscriptionV1,
} from '../shared/remote-genomics-ipc';
import { createWorkspaceMutationEvents } from './workspace-mutation-events';
import {
  createClient,
  rendererIpc,
  type GenericMainSendChannel,
  type MainSendArguments,
} from '../shared/ipc-contract';
import { contextBridge, webUtils } from 'electron';
import { hostedAllowanceContract } from '../shared/ipc/hosted-allowance.contract';
import type { RuntimeProfile, RuntimeProvenance } from '../shared/runtime-profile';
import { createElectronRuntimeProfile } from '../shared/scenario-mutation';
import type { AgentHelperLifecycleSnapshot } from '../shared/agent-helper-lifecycle';
import type { ExternalMcpRegistrationSnapshot } from '../shared/external-mcp-registration';
import type {
  AgentAuthOptionsShape,
  AgentAuthResultShape,
  AgentCancelQueryResultShape,
  AgentCliPathOverridesShape,
  AgentMcpServerLaunchShape,
  AgentProviderProbeShape,
  AgentQueryOptionsShape,
  AgentQueryResultShape,
  AgentSdkDetectionShape,
  AgentTransport,
} from '../shared/agent-runtime-ipc';
import type {
  RendererResourceReadResponseShape,
  RendererToolCallResponseShape,
} from '../shared/agent-tools-ipc';
import type { PackageScratchLeaseSet } from '../shared/package-scratch-capability';
import {
  agentConfirmResponseChannel,
  agentUserInputResponseChannel,
  type AgentUserInputResponse,
  type DestructiveFileConfirmResponse,
} from '../shared/agent-confirm-types';
import {
  largeFileImportDialogResponseChannel,
  type LargeFileImportDialogResponse,
} from '../shared/large-file-import-dialog';
import {
  HOSTED_AI_GATEWAY_GET_WORKFLOW_AUTHORITY_CHANNEL,
  HOSTED_AI_GATEWAY_GET_ROUTE_AVAILABILITY_CHANNEL,
  HOSTED_AI_GATEWAY_REQUEST_RAW_TRACE_DELETION_CHANNEL,
  HOSTED_AI_GATEWAY_START_STREAM_CHANNEL,
  HOSTED_AI_GATEWAY_CANCEL_STREAM_CHANNEL,
  HOSTED_AI_GATEWAY_STREAM_EVENT_CHANNEL,
  HOSTED_AI_GATEWAY_PREPARE_CONTRIBUTION_CHANNEL,
  HOSTED_AI_GATEWAY_VALIDATE_TURN_BINDING_CHANNEL,
  HOSTED_AI_GATEWAY_RELEASE_TURN_BINDING_CHANNEL,
  HOSTED_AI_GATEWAY_RECORD_TOOL_OBSERVATION_CHANNEL,
  HOSTED_AI_GATEWAY_CLAIM_TOOL_CHANNEL,
  HOSTED_AI_GATEWAY_COMPLETE_TOOL_CLAIM_CHANNEL,
  HOSTED_AI_GATEWAY_CANCEL_TOOL_CLAIM_CHANNEL,
  HOSTED_AI_GATEWAY_CANCEL_WORKFLOW_CHANNEL,
  HOSTED_AI_GATEWAY_EXECUTE_NATIVE_TOOL_CHANNEL,
  HOSTED_AI_GATEWAY_CANCEL_NATIVE_TOOL_CHANNEL,
  type HostedAiRawTraceDeletionResult,
  type HostedAiRouteAvailabilityResult,
  type HostedAiWorkflowAuthorityResult,
  type HostedAiStreamStartRequest,
  type HostedAiStreamStartResult,
  type HostedAiStreamCancelResult,
  type HostedAiStreamEventEnvelope,
  type HostedAiContributionGateRequest,
  type HostedAiContributionGateResult,
  type HostedAiTurnBindingRequest,
  type HostedAiTurnBindingResult,
  type HostedAiTurnBindingReleaseResult,
  type HostedAiToolObservationRequest,
  type HostedAiToolObservationResult,
  type HostedAiToolClaimRequest,
  type HostedAiToolClaimCompleteRequest,
  type HostedAiToolClaimCancelRequest,
  type HostedAiToolClaimResult,
  type HostedAiWorkflowTerminalRequest,
  type HostedAiWorkflowTerminalResult,
  type HostedAiNativeToolRequest,
  type HostedAiNativeToolResult,
  type HostedAiNativeToolCancelResult,
} from '../shared/hosted-ai-gateway-ipc';
import type { SqliteIpcValue } from '../shared/sqlite-ipc';
import type { UpdateSimulationArguments } from '../shared/update-ipc';
import { createIndexedGenomeIpc } from './indexed-genome-ipc';
import { trackStorePreloadBridge } from './track-store';
import { trackViewsPreloadBridge } from './track-views';
import { referenceAssetsPreloadBridge } from './reference-assets';
import type {
  CommitChatTurnTerminalStateRequest,
  CommitChatTurnTerminalStateResult,
  CreateChatTurnWithUserMessageRequest,
} from '../shared/chat-turn-ipc';
import type {
  WorkspaceBinaryFileAtomicWriteInput,
  WorkspaceTextFileAtomicWriteInput,
  WorkspaceTextFileAtomicWriteResult,
  WorkspaceTextFileAtomicWriteResponse,
} from '../shared/workspace-file-atomic';
import { unwrapWorkspaceTextFileAtomicWriteResponse } from '../shared/workspace-file-atomic';
import type {
  MigrateNotebookPackageAtPathInput,
  PrepareNotebookPackageRenameInput,
  PublishNotebookPackageResult,
  RecoverNotebookPackageRenameInput,
  SerializablePublishNotebookPackageInput,
} from '../shared/notebook-package-ipc';
import type {
  WorkspaceSyncHistoryOptions,
  WorkspaceSyncReplicaDeliveryAck,
  WorkspaceSyncReplicaLifecycleEvent,
  WorkspaceSyncStatusEvent,
} from '../shared/workspace-sync-ipc';
import {
  BENCHLING_MIGRATION_SUBSCRIBE_PROGRESS_CHANNEL,
  BENCHLING_MIGRATION_UNSUBSCRIBE_PROGRESS_CHANNEL,
  BENCHLING_MIGRATION_PROGRESS_CHANGED_CHANNEL,
  type BenchlingMigrationProgressEvent,
  type BenchlingMigrationProgressSubscriptionStatus,
} from '../shared/benchling-migration-ipc';
import {
  BENCHLING_MIGRATION_RENDER_VALIDATION_REQUEST_CHANNEL,
  migrationRenderValidationResponseChannel,
  BENCHLING_MIGRATION_RENDER_VALIDATION_READY_CHANNEL,
  type MigrationRenderValidationRequest,
  type MigrationRenderValidationResponse,
} from '../shared/benchling-migration-render-validation';
import { genomeCredentialsContract } from '../shared/ipc/genome-credentials.contract';
import { pathContract } from '../shared/ipc/path.contract';
import { entityNavigationContract } from '../shared/ipc/entity-navigation.contract';
import { dialogContract } from '../shared/ipc/dialog.contract';
import { googleSheetsContract } from '../shared/ipc/google-sheets.contract';
import { clipboardContract } from '../shared/ipc/clipboard.contract';
import { agentCapabilitiesContract } from '../shared/ipc/agent-capabilities.contract';
import { agentAttachmentsContract } from '../shared/ipc/agent-attachments.contract';
import { conversationLedgerContract } from '../shared/ipc/conversation-ledger.contract';
import { remoteGenomicsContract } from '../shared/ipc/remote-genomics.contract';
import { fileAssociationsContract } from '../shared/ipc/file-associations.contract';
import { agentSessionContract } from '../shared/ipc/agent-session.contract';
import { dbContract } from '../shared/ipc/db.contract';
import { shellContract } from '../shared/ipc/shell.contract';
import { cloudSyncBackupContract } from '../shared/ipc/cloud-sync-backup.contract';
import { cloudSyncContract } from '../shared/ipc/cloud-sync.contract';
import { cloudSyncDeepShareContract } from '../shared/ipc/cloud-sync-deep-share.contract';
import { fsContract } from '../shared/ipc/fs.contract';
import { fsInlineReferenceTargetContract } from '../shared/ipc/fs-inline-reference-target.contract';
import { workspaceSamplesContract } from '../shared/ipc/workspace-samples.contract';
import { workspaceContract } from '../shared/ipc/workspace.contract';
import { workspaceRelocateContract } from '../shared/ipc/workspace-relocate.contract';
import { workspaceBrowserContract } from '../shared/ipc/workspace-browser.contract';
import { authContract } from '../shared/ipc/auth.contract';
import { tracingContract } from '../shared/ipc/tracing.contract';
import { proteinExperimentWorkersContract } from '../shared/ipc/protein-experiment-workers.contract';
import { agentToolsContract } from '../shared/ipc/agent-tools.contract';
import { agentSdkContract } from '../shared/ipc/agent-sdk.contract';
import { runtimeContract } from '../shared/ipc/runtime.contract';
import { appDirtyStateContract } from '../shared/ipc/app-dirty-state.contract';
import { runtimeMemoryPressureOverrideContract } from '../shared/ipc/runtime-memory-pressure-override.contract';
import { pdfContract } from '../shared/ipc/pdf.contract';
import { sequenceWheelContract } from '../shared/ipc/sequence-wheel.contract';
import { benchlingMigrationContract } from '../shared/ipc/benchling-migration.contract';
import { agentConfirmContract } from '../shared/ipc/agent-confirm.contract';
import { largeFileImportDialogContract } from '../shared/ipc/large-file-import-dialog.contract';
import { hostedCodexContract } from '../shared/ipc/hosted-codex.contract';
import { molecularDocumentsContract } from '../shared/ipc/molecular-documents.contract';
import { internalFixturesContract } from '../shared/ipc/internal-fixtures.contract';
import { workspaceNativeDocumentsContract } from '../shared/ipc/workspace-native-documents.contract';
import { agentSdkMcpHttpListenerContract } from '../shared/ipc/agent-sdk-mcp-http-listener.contract';

const runtimeProfile: RuntimeProfile = Object.freeze(
  createElectronRuntimeProfile(process.argv, process.env)
);
const hasDisposableE2eScenarioProfile =
  runtimeProfile.isE2e && runtimeProfile.scenarioMutationAllowed;

let workspaceSyncSubscriptionSeq = 0;
let benchlingMigrationSubscriptionSeq = 0;
let remoteGenomicsSubscriptionSeq = 0;

function nextWorkspaceSyncSubscriptionId(): string {
  workspaceSyncSubscriptionSeq += 1;
  return `workspace-sync-sub-${Date.now()}-${workspaceSyncSubscriptionSeq}`;
}

function nextBenchlingMigrationSubscriptionId(): string {
  benchlingMigrationSubscriptionSeq += 1;
  return `benchling-migration-sub-${Date.now()}-${benchlingMigrationSubscriptionSeq}`;
}

function nextRemoteGenomicsSubscriptionId(): string {
  remoteGenomicsSubscriptionSeq += 1;
  const randomId = globalThis.crypto?.randomUUID?.();
  return `remote-genomics-sub-${randomId ?? `${Date.now()}-${remoteGenomicsSubscriptionSeq}`}`;
}

function initialRemoteStatusEvent(
  status: RemoteGenomicsRuntimeStatusV1
): RemoteGenomicsRuntimeStatusEventV1 {
  return {
    sequence: 0,
    reason:
      status.state === 'online'
        ? 'connected'
        : status.state === 'blocked'
          ? 'blocked'
          : status.state === 'retrying' || status.state === 'needs-authentication'
            ? 'retrying'
            : 'created',
    status,
  };
}

function unsubscribeRemoteGenomicsStatus(subscriptionId: string): Promise<void> {
  return rendererIpc.invoke('remoteGenomics:unsubscribeStatus', subscriptionId);
}

function sendReplicaAck(
  event: WorkspaceSyncReplicaLifecycleEvent,
  status: WorkspaceSyncReplicaDeliveryAck['status'],
  error?: unknown
): void {
  if (event.phase === 'aborted') return;
  const message =
    error instanceof Error ? error.message : error === undefined ? null : String(error);
  const ack: WorkspaceSyncReplicaDeliveryAck = {
    deliveryId: event.deliveryId,
    phase: event.phase,
    status,
    ...(message ? { error: message.slice(0, 500) } : {}),
  };
  rendererIpc.send('cloudSync:replicaAppliedAck', ack);
}

const nativeWheelMetadata = process.argv.includes('--dnaforge-native-wheel-metadata=1');

const api = {
  terminal: {
    ...createClient(terminalContract),
    focus: (id: string | null): Promise<void> => rendererIpc.invoke('terminal:focus', id),
    paste: (id: string, warnMultiline: boolean): Promise<string> => {
      const navigator: unknown = Reflect.get(globalThis, 'navigator');
      const activation =
        typeof navigator === 'object' && navigator !== null && 'userActivation' in navigator
          ? navigator.userActivation
          : null;
      if (
        typeof activation !== 'object' ||
        activation === null ||
        !('isActive' in activation) ||
        activation.isActive !== true
      )
        return Promise.reject(new Error('Terminal paste requires a user gesture.'));
      return rendererIpc.invoke('terminal:paste', id, warnMultiline);
    },
  },
  sequenceWheel: {
    ...createClient(sequenceWheelContract),
    nativeWheelMetadata,
  },
  platform: process.platform,
  runtime: {
    ...createClient(runtimeContract),
    ...createClient(runtimeMemoryPressureOverrideContract),
    getProfile: (): RuntimeProfile => runtimeProfile,
    getProvenance: (): Promise<RuntimeProvenance> => rendererIpc.invoke('runtime:getProvenance'),
  },
  molecularCatalog: createClient(molecularCatalogContract),
  molecularData: createClient(molecularDataContract),
  scientificDocuments: {
    ...createClient(scientificDocumentsContract),
  },
  entityNavigation: createClient(entityNavigationContract),
  scientificObjects: createClient(scientificObjectsContract),
  fileAssociations: createClient(fileAssociationsContract),

  reportRendererError: (payload: {
    errorClass: string;
    source: 'error' | 'unhandledrejection';
  }): void => rendererIpc.send('diagnostics:renderer-error', payload),

  sendBreadcrumbs: (lines: string[]): void => rendererIpc.send('diagnostics:breadcrumbs', lines),

  db: {
    ...createClient(dbContract),
    select: <T>(sql: string, params?: SqliteIpcValue[]): Promise<T> =>
      rendererIpc.invoke('db:select', sql, params) as Promise<T>,
    createChatTurnWithUserMessage: (input: CreateChatTurnWithUserMessageRequest): Promise<void> =>
      rendererIpc.invoke('db:createChatTurnWithUserMessage', input),
    commitChatTurnTerminalState: (
      input: CommitChatTurnTerminalStateRequest
    ): Promise<CommitChatTurnTerminalStateResult> =>
      rendererIpc.invoke('db:commitChatTurnTerminalState', input),
    deleteConversation: (id: string): Promise<void> =>
      rendererIpc.invoke('db:deleteConversation', id),
    deleteMessage: (id: string): Promise<void> => rendererIpc.invoke('db:deleteMessage', id),
  },

  inventory: createClient(inventoryContract),
  importReview: createClient(importReviewContract),
  notebook: createClient(notebookContract),
  administration: createClient(administrationContract),
  lims: { ...createClient(limsContract), ...createClient(primerArtifactContract) },

  fs: {
    ...createClient(sequenceAlignmentHistoryContract),
    ...createClient(fsContract),
    ...createClient(fsInlineReferenceTargetContract),
    writeWorkspaceBinaryFileAtomic: (
      input: WorkspaceBinaryFileAtomicWriteInput
    ): Promise<WorkspaceTextFileAtomicWriteResult> =>
      rendererIpc
        .invoke('fs:writeWorkspaceBinaryFileAtomic', input)
        .then((response: WorkspaceTextFileAtomicWriteResponse) =>
          unwrapWorkspaceTextFileAtomicWriteResponse(response)
        ),
    writeWorkspaceTextFileAtomic: (
      input: WorkspaceTextFileAtomicWriteInput
    ): Promise<WorkspaceTextFileAtomicWriteResult> =>
      rendererIpc
        .invoke('fs:writeWorkspaceTextFileAtomic', input)
        .then((response: WorkspaceTextFileAtomicWriteResponse) =>
          unwrapWorkspaceTextFileAtomicWriteResponse(response)
        ),
    publishNotebookPackageV2InMain: (
      input: SerializablePublishNotebookPackageInput
    ): Promise<PublishNotebookPackageResult> =>
      rendererIpc.invoke('fs:publishNotebookPackageV2', input),
    migrateNotebookPackageAtPathInMain: (
      input: MigrateNotebookPackageAtPathInput
    ): Promise<PublishNotebookPackageResult | null> =>
      rendererIpc.invoke('fs:migrateNotebookPackageAtPath', input),
    prepareNotebookPackageRenameInMain: (
      input: Omit<PrepareNotebookPackageRenameInput, 'now'>
    ): Promise<void> => rendererIpc.invoke('fs:prepareNotebookPackageRename', input),
    recoverNotebookPackageRenameIfNeededInMain: (
      input: RecoverNotebookPackageRenameInput
    ): Promise<PublishNotebookPackageResult | null> =>
      rendererIpc.invoke('fs:recoverNotebookPackageRenameIfNeeded', input),
    packageSequenceFile: (
      filePath: string,
      options?: { overwritePackageRoot?: string; requireConverted?: boolean }
    ): Promise<{
      productPath: string;
      packageRoots: string[];
      converted: boolean;
      skippedReason: string | null;
    }> => rendererIpc.invoke('fs:packageSequenceFile', filePath, options),
    createPackageScratch: (
      packageRoot: string,
      mutationToken?: string
    ): Promise<PackageScratchLeaseSet> =>
      rendererIpc.invoke('fs:createPackageScratch', packageRoot, mutationToken),
    removePackageScratch: (cleanupToken: string): Promise<void> =>
      rendererIpc.invoke('fs:removePackageScratch', cleanupToken),
    renamePackageScratchMember: (
      cleanupToken: string,
      oldPath: string,
      newPath: string
    ): Promise<void> =>
      rendererIpc.invoke('fs:renamePackageScratchMember', cleanupToken, oldPath, newPath),
  },

  pdf: createClient(pdfContract),

  dialog: createClient(dialogContract),

  remoteHosts: createClient(remoteHostsContract),
  looseSequenceFiles: createClient(looseSequenceFilesContract),
  thirdPartyNotices: createClient(thirdPartyNoticesContract),
  remoteGenomics: {
    ...createClient(remoteGenomicsContract),
    subscribeStatus: (
      callback: (event: RemoteGenomicsRuntimeStatusEventV1) => void
    ): (() => void) => {
      const subscriptionId = nextRemoteGenomicsSubscriptionId();
      let initialized = false;
      let active = true;
      const pending: RemoteGenomicsRuntimeStatusEventV1[] = [];
      const subscription = (
        _event: Electron.IpcRendererEvent,
        delivery: RemoteGenomicsStatusDeliveryV1
      ) => {
        if (delivery.subscriptionId !== subscriptionId) return;
        if (!initialized) pending.push(delivery.event);
        else callback(delivery.event);
      };
      rendererIpc.on('remoteGenomics:statusChanged', subscription);
      void rendererIpc
        .invoke('remoteGenomics:subscribeStatus', subscriptionId)
        .then((result: RemoteGenomicsStatusSubscriptionV1) => {
          if (!active) {
            void unsubscribeRemoteGenomicsStatus(subscriptionId);
            return;
          }
          for (const status of result.statuses) callback(initialRemoteStatusEvent(status));
          initialized = true;
          for (const event of pending.splice(0)) callback(event);
        })
        .catch((error) => {
          console.error('[remoteGenomics] status subscription failed:', error);
          rendererIpc.removeListener('remoteGenomics:statusChanged', subscription);
        });
      return () => {
        active = false;
        rendererIpc.removeListener('remoteGenomics:statusChanged', subscription);
        void unsubscribeRemoteGenomicsStatus(subscriptionId);
      };
    },
  },

  path: createClient(pathContract),

  trackViewCommands: createClient(trackViewCommandsContract),
  trackViews: trackViewsPreloadBridge,
  molecularDocuments: createClient(molecularDocumentsContract),
  trackStore: trackStorePreloadBridge,
  referenceAssets: referenceAssetsPreloadBridge,

  workspace: {
    ...createClient(originalProjectContract),
    ...createClient(workspaceNativeDocumentsContract),
    ...createClient(workspaceSamplesContract),
    ...createClient(workspaceContract),
    ...createClient(workspaceRelocateContract),
    ...createClient(workspaceBrowserContract),
    getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  },

  tracing: createClient(tracingContract),

  shell: {
    ...createClient(shellContract),
    getGitReadLifecycleSnapshot: () => rendererIpc.invoke('shell:getGitReadLifecycleSnapshot'),
  },

  clipboard: createClient(clipboardContract),
  googleSheets: createClient(googleSheetsContract),

  genome: createIndexedGenomeIpc(),

  window: createClient(windowContract),

  on: <C extends GenericMainSendChannel>(
    channel: C,
    callback: (...args: MainSendArguments<C>) => void
  ) => {
    const allowedChannels = new Set<GenericMainSendChannel>([
      'sidecar:status',
      'menu:settings',
      'menu:organizations',
      'menu:new-chat',
      'menu:explorer',
      'menu:search',
      'window:resize',
      'window:frame-tab-navigation',
      'window:move',
      'file-changed',
      'workspace:set-path',
      'update:available',
      'update:downloaded',
      'update:progress',
      'update:error',
      'update:no-update',
      'menu:check-for-updates',
      'menu:close-tab',
      'menu:reopen-closed-tab',
      'menu:redo',
      'menu:import-files',
      'menu:import-folder',
      'menu:import-registry-records',
      'menu:undo',
      'app:saveAll',
      'genome:sessionUpdated',
      'compute:jobTerminal',
    ]);
    if (!allowedChannels.has(channel)) {
      throw new Error(`IPC channel not allowed: ${channel}`);
    }
    const subscription = (_event: Electron.IpcRendererEvent, ...args: MainSendArguments<C>) =>
      callback(...args);
    rendererIpc.on(channel, subscription);
    if (channel === 'workspace:set-path') {
      rendererIpc.send('workspace:set-path-listener-ready');
    }
    return () => rendererIpc.removeListener(channel, subscription);
  },

  proteinExperimentWorkers: {
    ...createClient(proteinExperimentWorkersContract),
  },

  agentTools: {
    ...createClient(agentToolsContract),
    respond: (requestId: string, response: RendererToolCallResponseShape): void => {
      rendererIpc.send(`agent-tools:response:${requestId}`, response);
    },
    respondResource: (requestId: string, response: RendererResourceReadResponseShape): void => {
      rendererIpc.send(`agent-tools:resource-response:${requestId}`, response);
    },
  },

  agentConfirm: {
    ...createClient(agentConfirmContract),
    respond: (requestId: string, response: DestructiveFileConfirmResponse): void => {
      rendererIpc.send(agentConfirmResponseChannel(requestId), response);
    },
    respondUserInput: (requestId: string, response: AgentUserInputResponse): void => {
      rendererIpc.send(agentUserInputResponseChannel(requestId), response);
    },
  },

  largeFileImportDialog: {
    ...createClient(largeFileImportDialogContract),
    respond: (requestId: string, response: LargeFileImportDialogResponse): void => {
      rendererIpc.send(largeFileImportDialogResponseChannel(requestId), response);
    },
  },

  startup: createClient(startupContract),
  app: {
    ...createClient(appDirtyStateContract),
    saveAllDone: (requestId: string): void => {
      rendererIpc.send('app:saveAllDone', requestId);
    },
  },

  agentCapabilities: createClient(agentCapabilitiesContract),

  agentAttachments: createClient(agentAttachmentsContract),

  agentSdk: {
    ...createClient(agentSdkMcpHttpListenerContract),
    ...createClient(agentSdkContract),
    detect: (pathOverrides?: AgentCliPathOverridesShape): Promise<AgentSdkDetectionShape> =>
      rendererIpc.invoke('agentSdk:detect', pathOverrides),
    getHelperLifecycleSnapshot: (): Promise<AgentHelperLifecycleSnapshot> =>
      rendererIpc.invoke('agentSdk:getHelperLifecycleSnapshot'),
    getExternalMcpRegistration: (): Promise<ExternalMcpRegistrationSnapshot> =>
      rendererIpc.invoke('agentSdk:getExternalMcpRegistration'),
    refreshExternalMcpRegistration: (): Promise<ExternalMcpRegistrationSnapshot> =>
      rendererIpc.invoke('agentSdk:refreshExternalMcpRegistration'),
    probeMatrix: (): Promise<AgentProviderProbeShape[]> =>
      rendererIpc.invoke('agentSdk:probeMatrix'),
    cancelQuery: (queryId: string): Promise<AgentCancelQueryResultShape> =>
      rendererIpc.invoke('agentSdk:cancelQuery', queryId),
    authenticate: (
      transport: AgentTransport,
      options?: AgentAuthOptionsShape
    ): Promise<AgentAuthResultShape> =>
      rendererIpc.invoke('agentSdk:authenticate', transport, options),
    query: (
      transport: AgentTransport,
      prompt: string,
      options?: AgentQueryOptionsShape
    ): Promise<AgentQueryResultShape> =>
      rendererIpc.invoke('agentSdk:query', transport, prompt, options),
    ...(hasDisposableE2eScenarioProfile
      ? {
          getMcpBridgeLaunchForTest: (): Promise<AgentMcpServerLaunchShape> =>
            rendererIpc.invoke('agentSdk:getMcpBridgeLaunchForTest'),
        }
      : {}),
  },

  agentSession: createClient(agentSessionContract),

  conversationLedger: createClient(conversationLedgerContract),

  keyring: {
    ...createClient(keyringContract),
  },

  genomeCredentials: createClient(genomeCredentialsContract),

  compute: createClient(computeContract),

  auth: createClient(authContract),

  hostedAi: {
    ...createClient(hostedAllowanceContract),
    prepareContribution: (
      request: HostedAiContributionGateRequest
    ): Promise<HostedAiContributionGateResult> =>
      rendererIpc.invoke(HOSTED_AI_GATEWAY_PREPARE_CONTRIBUTION_CHANNEL, request),
    validateTurnBinding: (
      request: HostedAiTurnBindingRequest
    ): Promise<HostedAiTurnBindingResult> =>
      rendererIpc.invoke(HOSTED_AI_GATEWAY_VALIDATE_TURN_BINDING_CHANNEL, request),
    releaseTurnBinding: (
      request: HostedAiTurnBindingRequest
    ): Promise<HostedAiTurnBindingReleaseResult> =>
      rendererIpc.invoke(HOSTED_AI_GATEWAY_RELEASE_TURN_BINDING_CHANNEL, request),
    startStream: (request: HostedAiStreamStartRequest): Promise<HostedAiStreamStartResult> =>
      rendererIpc.invoke(HOSTED_AI_GATEWAY_START_STREAM_CHANNEL, request),
    cancelStream: (clientRequestId: string): Promise<HostedAiStreamCancelResult> =>
      rendererIpc.invoke(HOSTED_AI_GATEWAY_CANCEL_STREAM_CHANNEL, clientRequestId),
    onStreamEvent: (callback: (envelope: HostedAiStreamEventEnvelope) => void): (() => void) => {
      const subscription = (
        _event: Electron.IpcRendererEvent,
        envelope: HostedAiStreamEventEnvelope
      ) => callback(envelope);
      rendererIpc.on(HOSTED_AI_GATEWAY_STREAM_EVENT_CHANNEL, subscription);
      return () => rendererIpc.removeListener(HOSTED_AI_GATEWAY_STREAM_EVENT_CHANNEL, subscription);
    },
    recordToolObservation: (
      request: HostedAiToolObservationRequest
    ): Promise<HostedAiToolObservationResult> =>
      rendererIpc.invoke(HOSTED_AI_GATEWAY_RECORD_TOOL_OBSERVATION_CHANNEL, request),
    claimTool: (request: HostedAiToolClaimRequest): Promise<HostedAiToolClaimResult> =>
      rendererIpc.invoke(HOSTED_AI_GATEWAY_CLAIM_TOOL_CHANNEL, request),
    completeToolClaim: (
      request: HostedAiToolClaimCompleteRequest
    ): Promise<HostedAiToolClaimResult> =>
      rendererIpc.invoke(HOSTED_AI_GATEWAY_COMPLETE_TOOL_CLAIM_CHANNEL, request),
    cancelToolClaim: (request: HostedAiToolClaimCancelRequest): Promise<HostedAiToolClaimResult> =>
      rendererIpc.invoke(HOSTED_AI_GATEWAY_CANCEL_TOOL_CLAIM_CHANNEL, request),
    cancelWorkflow: (
      request: HostedAiWorkflowTerminalRequest
    ): Promise<HostedAiWorkflowTerminalResult> =>
      rendererIpc.invoke(HOSTED_AI_GATEWAY_CANCEL_WORKFLOW_CHANNEL, request),
    executeNativeTool: (request: HostedAiNativeToolRequest): Promise<HostedAiNativeToolResult> =>
      rendererIpc.invoke(HOSTED_AI_GATEWAY_EXECUTE_NATIVE_TOOL_CHANNEL, request),
    cancelNativeTool: (operationId: string): Promise<HostedAiNativeToolCancelResult> =>
      rendererIpc.invoke(HOSTED_AI_GATEWAY_CANCEL_NATIVE_TOOL_CHANNEL, operationId),
    getWorkflowAuthority: (): Promise<HostedAiWorkflowAuthorityResult> =>
      rendererIpc.invoke(HOSTED_AI_GATEWAY_GET_WORKFLOW_AUTHORITY_CHANNEL),
    getRouteAvailability: (): Promise<HostedAiRouteAvailabilityResult> =>
      rendererIpc.invoke(HOSTED_AI_GATEWAY_GET_ROUTE_AVAILABILITY_CHANNEL),
    requestRawTraceDeletion: (): Promise<HostedAiRawTraceDeletionResult> =>
      rendererIpc.invoke(HOSTED_AI_GATEWAY_REQUEST_RAW_TRACE_DELETION_CHANNEL),
  },

  hostedCodex: createClient(hostedCodexContract),

  workspaceMutations: createWorkspaceMutationEvents(),
  cloudSync: {
    ...createClient(organizationRegistryContract),
    ...createClient(scientificRecoveryContract),
    ...createClient(cloudSyncBackupContract),
    ...createClient(cloudSyncContract),
    ...createClient(cloudSyncDeepShareContract),
    subscribeStatus: (
      workspaceUuid: string,
      callback: (event: WorkspaceSyncStatusEvent) => void
    ): (() => void) => {
      const subscriptionId = nextWorkspaceSyncSubscriptionId();
      const subscription = (
        _event: Electron.IpcRendererEvent,
        payload: WorkspaceSyncStatusEvent
      ) => {
        if (payload.workspaceUuid === workspaceUuid) callback(payload);
      };
      rendererIpc.on('cloudSync:statusChanged', subscription);
      void rendererIpc
        .invoke('cloudSync:subscribeStatus', { workspaceUuid, subscriptionId })
        .catch((error) => {
          console.error('[cloudSync] status subscription failed:', error);
          rendererIpc.removeListener('cloudSync:statusChanged', subscription);
        });
      return () => {
        rendererIpc.removeListener('cloudSync:statusChanged', subscription);
        void rendererIpc.invoke('cloudSync:unsubscribeStatus', subscriptionId);
      };
    },
    onReplicaLifecycle: (
      callback: (event: WorkspaceSyncReplicaLifecycleEvent) => void | Promise<void>
    ): (() => void) => {
      const subscription = (
        _event: Electron.IpcRendererEvent,
        payload: WorkspaceSyncReplicaLifecycleEvent
      ) => {
        void Promise.resolve()
          .then(() => callback(payload))
          .then(
            () => sendReplicaAck(payload, 'ok'),
            (error: unknown) => {
              console.error(`[cloudSync] replica ${payload.phase} failed:`, error);
              sendReplicaAck(payload, 'failed', error);
            }
          );
      };
      rendererIpc.on('cloudSync:replicaApplied', subscription);
      return () => rendererIpc.removeListener('cloudSync:replicaApplied', subscription);
    },
    listWorkspaceHistory: (
      remoteWorkspaceId: string,
      options?: WorkspaceSyncHistoryOptions
    ): Promise<unknown> =>
      rendererIpc.invoke('cloudSync:listWorkspaceHistory', remoteWorkspaceId, options),
  },

  benchlingMigration: {
    ...createClient(benchlingMigrationContract),
    subscribeProgress: (
      runId: string,
      callback: (event: BenchlingMigrationProgressEvent) => void,
      onStatus?: (status: BenchlingMigrationProgressSubscriptionStatus) => void
    ): (() => void) => {
      const subscriptionId = nextBenchlingMigrationSubscriptionId();
      let active = true;
      const subscription = (
        _event: Electron.IpcRendererEvent,
        payload: BenchlingMigrationProgressEvent
      ) => {
        if (payload.runId === runId) callback(payload);
      };
      rendererIpc.on(BENCHLING_MIGRATION_PROGRESS_CHANGED_CHANNEL, subscription);
      void rendererIpc
        .invoke(BENCHLING_MIGRATION_SUBSCRIBE_PROGRESS_CHANNEL, {
          runId,
          subscriptionId,
        })
        .then((_registration: { ok: true; subscriptionId: string }) => {
          if (active) {
            onStatus?.('ready');
            return;
          }
          void rendererIpc
            .invoke(BENCHLING_MIGRATION_UNSUBSCRIBE_PROGRESS_CHANNEL, subscriptionId)
            .then((_result: { ok: true }) => undefined);
        })
        .catch((error) => {
          console.error('[benchlingMigration] progress subscription failed:', error);
          rendererIpc.removeListener(BENCHLING_MIGRATION_PROGRESS_CHANGED_CHANNEL, subscription);
          if (active) onStatus?.('failed');
        });
      return () => {
        active = false;
        rendererIpc.removeListener(BENCHLING_MIGRATION_PROGRESS_CHANGED_CHANNEL, subscription);
        void rendererIpc
          .invoke(BENCHLING_MIGRATION_UNSUBSCRIBE_PROGRESS_CHANNEL, subscriptionId)
          .then((_result: { ok: true }) => undefined);
      };
    },
    onRenderValidationRequest: (
      callback: (request: MigrationRenderValidationRequest) => void
    ): (() => void) => {
      const subscription = (
        _event: Electron.IpcRendererEvent,
        request: MigrationRenderValidationRequest
      ) => callback(request);
      rendererIpc.on(BENCHLING_MIGRATION_RENDER_VALIDATION_REQUEST_CHANNEL, subscription);
      rendererIpc.send(BENCHLING_MIGRATION_RENDER_VALIDATION_READY_CHANNEL, true);
      return () => {
        rendererIpc.send(BENCHLING_MIGRATION_RENDER_VALIDATION_READY_CHANNEL, false);
        rendererIpc.removeListener(
          BENCHLING_MIGRATION_RENDER_VALIDATION_REQUEST_CHANNEL,
          subscription
        );
      };
    },
    respondRenderValidation: (
      requestId: string,
      response: MigrationRenderValidationResponse
    ): void => {
      rendererIpc.send(migrationRenderValidationResponseChannel(requestId), response);
    },
  },

  update: {
    ...createClient(updateContract),

    simulate: (...args: UpdateSimulationArguments): Promise<void> =>
      rendererIpc.invoke('update:simulate', ...args),
  },

  config: {
    ...createClient(configContract),
  },

  feedback: {
    ...createClient(feedbackContract),
    ...createClient(agentFeedbackContract),
  },

  internalFixtures: createClient(internalFixturesContract),

  analytics: {
    ...createClient(analyticsContract),
  },

  convertFileSrc: (filePath: string): Promise<string> =>
    rendererIpc.invoke('fs:convertFileSrc', filePath),

  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
};

export type PreloadElectronApi = typeof api;

contextBridge.exposeInMainWorld('electronAPI', api);
