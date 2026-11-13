import type {
  AgentCapabilityDiscoveryRequest,
  AgentCapabilityMutationResult,
  AgentCapabilityRecordRemovalRequest,
  AgentCapabilitySelection,
  AgentCapabilitySelectionResult,
  AgentCapabilitySnapshot,
  AgentConversationForkRequest,
  AgentConversationForkResult,
  AgentManagedCommandSaveRequest,
  AgentManagedExtensionsListRequest,
  AgentManagedExtensionsSnapshot,
  AgentManagedMemorySaveRequest,
  AgentManagedSkillEnabledRequest,
  AgentManagedSkillImportRequest,
  AgentManagedSkillSaveRequest,
  AgentProviderMemoryResetRequest,
  AgentProviderPluginInspectionResult,
  AgentProviderPluginManagementRequest,
  AgentProviderPluginRemovalRequest,
  AgentProviderSkillEnabledRequest,
  AgentSkillCatalogBrowseRequest,
  AgentSkillCatalogBrowseResult,
  AgentSkillCatalogInstallRequest,
  AgentSkillCatalogInstallResult,
  AgentSkillCatalogReviewRequest,
  AgentSkillCatalogReviewResult,
  AgentSkillInspectionRequest,
  AgentSkillInspectionResult,
  AgentSkillPackSummary,
} from '../agent-capability-controls';
import { defineGroup, invoke } from './contract';

export const agentCapabilitiesContract = defineGroup('agentCapabilities', {
  discover: invoke<[request: AgentCapabilityDiscoveryRequest], AgentCapabilitySnapshot>(),
  resolve: invoke<[selection: AgentCapabilitySelection], AgentCapabilitySelectionResult>(),
  inspectSkill: invoke<[request: AgentSkillInspectionRequest], AgentSkillInspectionResult>(),
  forkConversation: invoke<[request: AgentConversationForkRequest], AgentConversationForkResult>(),
  listManaged: invoke<
    [request: AgentManagedExtensionsListRequest],
    AgentManagedExtensionsSnapshot
  >(),
  saveCommand: invoke<[request: AgentManagedCommandSaveRequest], AgentCapabilityMutationResult>(),
  saveSkill: invoke<[request: AgentManagedSkillSaveRequest], AgentCapabilityMutationResult>(),
  importSkill: invoke<[request: AgentManagedSkillImportRequest], AgentCapabilityMutationResult>(),
  setSkillEnabled: invoke<
    [request: AgentManagedSkillEnabledRequest],
    AgentCapabilityMutationResult
  >(),
  setProviderSkillEnabled: invoke<
    [request: AgentProviderSkillEnabledRequest],
    AgentCapabilityMutationResult
  >(),
  listSkillPacks: invoke<[], AgentSkillPackSummary[]>(),
  browseSkillPack: invoke<
    [request: AgentSkillCatalogBrowseRequest],
    AgentSkillCatalogBrowseResult
  >(),
  reviewCatalogSkill: invoke<
    [request: AgentSkillCatalogReviewRequest],
    AgentSkillCatalogReviewResult
  >(),
  installCatalogSkill: invoke<
    [request: AgentSkillCatalogInstallRequest],
    AgentSkillCatalogInstallResult
  >(),
  removeSkill: invoke<
    [request: AgentCapabilityRecordRemovalRequest],
    AgentCapabilityMutationResult
  >(),
  removeCommand: invoke<
    [request: AgentCapabilityRecordRemovalRequest],
    AgentCapabilityMutationResult
  >(),
  saveMemory: invoke<[request: AgentManagedMemorySaveRequest], AgentCapabilityMutationResult>(),
  removeMemory: invoke<
    [request: AgentCapabilityRecordRemovalRequest],
    AgentCapabilityMutationResult
  >(),
  resetProviderMemory: invoke<
    [request: AgentProviderMemoryResetRequest],
    AgentCapabilityMutationResult
  >(),
  inspectProviderPlugin: invoke<
    [request: AgentProviderPluginManagementRequest],
    AgentProviderPluginInspectionResult
  >(),
  installProviderPlugin: invoke<
    [request: AgentProviderPluginManagementRequest],
    AgentCapabilityMutationResult
  >(),
  removeProviderPlugin: invoke<
    [request: AgentProviderPluginRemovalRequest],
    AgentCapabilityMutationResult
  >(),
});
