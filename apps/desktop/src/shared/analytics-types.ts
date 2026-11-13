import type {
  AnalyticsIdentityContext,
  ConsentPolicyDecision,
  TelemetryActor,
} from '@waypoint/analytics-policy';

export type { AnalyticsIdentityContext, ConsentPolicyDecision };

export interface AnalyticsGrantOptions {
  basis?: 'explicit';
}

export type MeaningfulActivityActorKind = 'external' | 'internal' | 'test' | 'unknown';
export type MeaningfulActivityExecutionMode = 'interactive' | 'automated' | 'synthetic';

export interface MeaningfulActivityAuthority {
  actorKind: MeaningfulActivityActorKind;
  executionMode: MeaningfulActivityExecutionMode;
  impersonated: boolean;
}

export interface AnalyticsIdentitySyncResult {
  accepted: boolean;
  authority: MeaningfulActivityAuthority;
  optionalOrigin?: OptionalTelemetryOrigin | null;
}

export type OptionalTelemetryOrigin = Readonly<{
  consentScope: string;
  contextId: string;
  processId: string;
  classification: 'synthetic' | 'private' | 'unknown' | 'eligible_release';
}>;

export interface RendererWorkflowTelemetryRequest {
  origin: OptionalTelemetryOrigin;
  context: AnalyticsIdentityContext;
  eventId: string;
  eventName: 'workflow_action_observed' | 'meaningful_activity_completed';
  capturedAtMs: number;
  properties: Readonly<Record<string, unknown>>;
}

export interface AnalyticsRuntimeConfig {
  apiKey: string;
  host: string;
  appVersion: string;
  platformFamily: string;
  environment: string;
  releaseChannel: string;
  buildTag?: string;
  pseudonymousInstallId?: string;
  isSynthetic: boolean;
  telemetryCanaryId?: string;
  telemetryActor: TelemetryActor;
  ciRunId?: string;
  canaryProxyToken?: string;
}

export interface AnalyticsConsentState {
  consent: string | null;
  version: string | null;
  basis?: string | null;
}
