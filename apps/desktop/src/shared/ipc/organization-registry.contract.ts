import type {
  OrganizationRegistryCachedOrganizationsResult,
  OrganizationRegistryChangedEvent,
  OrganizationRegistryClaimPreparationRequest,
  OrganizationRegistryClaimPreparationResult,
  OrganizationRegistryClaimRequest,
  OrganizationRegistryClaimResult,
  OrganizationRegistryRecordDetailsRequest,
  OrganizationRegistryRecordDetailsResult,
  OrganizationRegistryRecordSyncStatusResult,
  OrganizationRegistrySavedRecordResolutionRequest,
  OrganizationRegistrySavedRecordResolutionResult,
  OrganizationRegistrySavedRecordReviewResult,
} from '../org-registry-sync';
import { defineGroup, event, invoke } from './contract';

export const organizationRegistryContract = defineGroup('cloudSync', {
  prepareOrganizationRegistryClaim: invoke<
    [orgId: string, request: OrganizationRegistryClaimPreparationRequest],
    OrganizationRegistryClaimPreparationResult
  >(),
  claimOrganizationRegistryEntity: invoke<
    [orgId: string, request: OrganizationRegistryClaimRequest],
    OrganizationRegistryClaimResult
  >(),
  getOrganizationRegistryRecordSyncStatus: invoke<
    [entityId: string],
    OrganizationRegistryRecordSyncStatusResult
  >(),
  getOrganizationRegistrySavedRecordReview: invoke<
    [orgId: string, entityId: string],
    OrganizationRegistrySavedRecordReviewResult
  >(),
  resolveOrganizationRegistrySavedRecord: invoke<
    [orgId: string, request: OrganizationRegistrySavedRecordResolutionRequest],
    OrganizationRegistrySavedRecordResolutionResult
  >(),
  getOrganizationRegistryRecordDetails: invoke<
    [orgId: string, request: OrganizationRegistryRecordDetailsRequest],
    OrganizationRegistryRecordDetailsResult
  >(),
  listCachedOrganizationRegistries: invoke<[], OrganizationRegistryCachedOrganizationsResult>(),
  onOrganizationRegistryChanged: event<[event: OrganizationRegistryChangedEvent]>().channel(
    'cloudSync:organizationRegistryChanged'
  ),
});
