import type {
  ConsentPolicyDecision,
  AnalyticsRuntimeConfig,
  AnalyticsGrantOptions,
  AnalyticsIdentityContext,
  AnalyticsIdentitySyncResult,
  RendererWorkflowTelemetryRequest,
} from '../analytics-types';
import type { TableNotebookReceiptMutation } from '../table-notebook-observation';
import { defineGroup, event, invoke } from './contract';

export const analyticsContract = defineGroup('analytics', {
  onBetaAttributionUpdated: event<[]>().channel('analytics:beta-attribution-updated'),
  getConsentPolicy: invoke<[], ConsentPolicyDecision>(),
  writeTableNotebookReceipt: invoke<[request: TableNotebookReceiptMutation], boolean>(),
  enqueueWorkflowEvent: invoke<[request: RendererWorkflowTelemetryRequest], boolean>(),
  getRuntimeConfig: invoke<[], AnalyticsRuntimeConfig | null>(),
  getOptIn: invoke<[], boolean>(),
  persistConsent: invoke<[enabled: boolean], void>(),
  grantConsent: invoke<[options?: AnalyticsGrantOptions], boolean>(),
  revokeConsent: invoke<[], void>(),
  syncContext: invoke<[context: AnalyticsIdentityContext], AnalyticsIdentitySyncResult>(),
  setConsent: invoke<[enabled: boolean], void>(),
});
