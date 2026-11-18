import { notebookContract } from './notebook.contract';
import { trackViewCommandsContract } from './track-view-commands.contract';
import { importReviewContract } from './import-review.contract';
import { administrationContract } from './administration.contract';
import { primerArtifactContract } from './primer-artifact.contract';
import { sequenceAlignmentHistoryContract } from './sequence-alignment-history.contract';
import { originalProjectContract } from './original-project.contract';
import { organizationRegistryContract } from './organization-registry.contract';

import { scientificRecoveryContract } from './scientific-recovery.contract';
import { workTasksContract } from './work-tasks.contract';
import { scientificObjectsContract } from './scientific-objects.contract';
import type { AssertTrue, DisjointGroups } from './contract';
import { analyticsContract } from './analytics.contract';
import { computeContract } from './compute.contract';
import { feedbackContract } from './feedback.contract';
import { scientificDocumentsContract } from './scientific-documents.contract';
import { terminalContract } from './terminal.contract';
import { limsContract } from './lims.contract';
import { keyringContract } from './keyring.contract';
import { updateContract } from './update.contract';
import { startupContract } from './startup.contract';
import { configContract } from './config.contract';
import { molecularCatalogContract } from './molecular-catalog.contract';
import { molecularDataContract } from './molecular-data.contract';
import { looseSequenceFilesContract } from './loose-sequence-files.contract';
import { thirdPartyNoticesContract } from './third-party-notices.contract';
import { remoteHostsContract } from './remote-hosts.contract';
import { agentFeedbackContract } from './agent-feedback.contract';
import { windowContract } from './window.contract';
import { genomeCredentialsContract } from './genome-credentials.contract';
import { pathContract } from './path.contract';
import { entityNavigationContract } from './entity-navigation.contract';
import { dialogContract } from './dialog.contract';
import { googleSheetsContract } from './google-sheets.contract';
import { clipboardContract } from './clipboard.contract';
import { agentCapabilitiesContract } from './agent-capabilities.contract';
import { agentAttachmentsContract } from './agent-attachments.contract';
import { conversationLedgerContract } from './conversation-ledger.contract';
import { remoteGenomicsContract } from './remote-genomics.contract';
import { fileAssociationsContract } from './file-associations.contract';
import { agentSessionContract } from './agent-session.contract';
import { dbContract } from './db.contract';
import { shellContract } from './shell.contract';
import { cloudSyncBackupContract } from './cloud-sync-backup.contract';
import { cloudSyncContract } from './cloud-sync.contract';
import { cloudSyncDeepShareContract } from './cloud-sync-deep-share.contract';
import { hostedAllowanceContract } from './hosted-allowance.contract';
import { fsContract } from './fs.contract';
import { fsInlineReferenceTargetContract } from './fs-inline-reference-target.contract';
import { workspaceSamplesContract } from './workspace-samples.contract';
import { workspaceContract } from './workspace.contract';
import { workspaceRelocateContract } from './workspace-relocate.contract';
import { workspaceBrowserContract } from './workspace-browser.contract';
import { authContract } from './auth.contract';
import { tracingContract } from './tracing.contract';
import { proteinExperimentWorkersContract } from './protein-experiment-workers.contract';
import { agentToolsContract } from './agent-tools.contract';
import { agentSdkContract } from './agent-sdk.contract';
import { runtimeContract } from './runtime.contract';
import { runtimeMemoryPressureOverrideContract } from './runtime-memory-pressure-override.contract';
import { pdfContract } from './pdf.contract';
import { appDirtyStateContract } from './app-dirty-state.contract';
import { sequenceWheelContract } from './sequence-wheel.contract';
import { benchlingMigrationContract } from './benchling-migration.contract';
import { agentConfirmContract } from './agent-confirm.contract';
import { largeFileImportDialogContract } from './large-file-import-dialog.contract';
import { hostedCodexContract } from './hosted-codex.contract';
import { molecularDocumentsContract } from './molecular-documents.contract';
import { internalFixturesContract } from './internal-fixtures.contract';
import { workspaceNativeDocumentsContract } from './workspace-native-documents.contract';
import { agentSdkMcpHttpListenerContract } from './agent-sdk-mcp-http-listener.contract';

export const ipcContracts = [
  trackViewCommandsContract,
  notebookContract,
  administrationContract,
  importReviewContract,
  primerArtifactContract,
  organizationRegistryContract,
  originalProjectContract,
  sequenceAlignmentHistoryContract,

  scientificRecoveryContract,
  remoteHostsContract,
  thirdPartyNoticesContract,
  looseSequenceFilesContract,
  agentFeedbackContract,
  analyticsContract,
  workTasksContract,
  scientificObjectsContract,
  computeContract,
  feedbackContract,
  windowContract,
  scientificDocumentsContract,
  limsContract,
  keyringContract,
  updateContract,
  startupContract,
  configContract,
  molecularCatalogContract,
  molecularDataContract,
  genomeCredentialsContract,
  pathContract,
  entityNavigationContract,
  dialogContract,
  clipboardContract,
  googleSheetsContract,
  agentCapabilitiesContract,
  agentAttachmentsContract,
  conversationLedgerContract,
  terminalContract,
  remoteGenomicsContract,
  fileAssociationsContract,
  agentSessionContract,
  dbContract,
  shellContract,
  cloudSyncBackupContract,
  cloudSyncContract,
  cloudSyncDeepShareContract,
  hostedAllowanceContract,
  fsContract,
  fsInlineReferenceTargetContract,
  workspaceSamplesContract,
  workspaceContract,
  workspaceRelocateContract,
  workspaceBrowserContract,
  authContract,
  tracingContract,
  proteinExperimentWorkersContract,
  agentToolsContract,
  agentSdkContract,
  runtimeContract,
  sequenceWheelContract,
  benchlingMigrationContract,
  agentConfirmContract,
  largeFileImportDialogContract,
  hostedCodexContract,
  molecularDocumentsContract,
  internalFixturesContract,
  workspaceNativeDocumentsContract,
  agentSdkMcpHttpListenerContract,
  runtimeMemoryPressureOverrideContract,
  pdfContract,
  appDirtyStateContract,
] as const;
export {
  notebookContract,
  administrationContract,
  importReviewContract,
  analyticsContract,
  computeContract,
  feedbackContract,
  scientificDocumentsContract,
  limsContract,
  keyringContract,
  updateContract,
  startupContract,
  configContract,
  molecularCatalogContract,
  looseSequenceFilesContract,
  remoteHostsContract,
  thirdPartyNoticesContract,
  windowContract,
  genomeCredentialsContract,
  pathContract,
  dialogContract,
  clipboardContract,
  googleSheetsContract,
  agentCapabilitiesContract,
  agentAttachmentsContract,
  conversationLedgerContract,
  terminalContract,
  remoteGenomicsContract,
  fileAssociationsContract,
  agentSessionContract,
  dbContract,
  shellContract,
  cloudSyncBackupContract,
  cloudSyncContract,
  cloudSyncDeepShareContract,
  hostedAllowanceContract,
  fsContract,
  fsInlineReferenceTargetContract,
  workspaceSamplesContract,
  workspaceContract,
  workspaceRelocateContract,
  workspaceBrowserContract,
  authContract,
  tracingContract,
  proteinExperimentWorkersContract,
  agentToolsContract,
  agentSdkContract,
  runtimeContract,
  runtimeMemoryPressureOverrideContract,
  pdfContract,
  sequenceWheelContract,
  benchlingMigrationContract,
  agentConfirmContract,
  largeFileImportDialogContract,
  hostedCodexContract,
  molecularDocumentsContract,
  internalFixturesContract,
  workspaceNativeDocumentsContract,
  agentSdkMcpHttpListenerContract,
  appDirtyStateContract,
};
export type IpcContracts = typeof ipcContracts;
export type IpcContractsDeclareDisjointMethods = AssertTrue<DisjointGroups<IpcContracts>>;
