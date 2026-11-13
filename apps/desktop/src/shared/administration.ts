import { z } from 'zod';
import type {
  DeepSharePublishResult,
  DeepShareReview,
  DeepShareSelectionRequest,
} from './deep-share-ipc';
import type { BenchlingMigrationRunView } from './benchling-migration-ipc';
import { MAX_WINDOW_ZOOM_FACTOR, MIN_WINDOW_ZOOM_FACTOR } from './window-zoom';
import type { WindowZoomResult } from './window-zoom';
import { DEFAULT_MOLECULAR_AGENT_INSTRUCTIONS } from './agent-presentation-instructions';

export const administrationSettingsSchema = z
  .object({
    theme: z.enum(['light', 'dark', 'system']),
    displayZoom: z.number().min(MIN_WINDOW_ZOOM_FACTOR).max(MAX_WINDOW_ZOOM_FACTOR),
    assemblyColorScheme: z.enum([
      'tailwind',
      'radix',
      'carbon',
      'category10',
      'observable',
      'material',
      'okabeIto',
    ]),
    webglPerformance: z.enum(['auto', 'quality', 'stability']),
    molecularAgentInstructions: z.string().max(16_000).optional(),
    rememberedAgentPreferences: z.string().max(16_000).optional(),
  })
  .strict();
export type AdministrationSettings = z.infer<typeof administrationSettingsSchema>;
export const ADMINISTRATION_SETTINGS_DEFAULTS: AdministrationSettings = {
  theme: 'light',
  displayZoom: 1,
  assemblyColorScheme: 'tailwind',
  webglPerformance: 'auto',
  molecularAgentInstructions: DEFAULT_MOLECULAR_AGENT_INSTRUCTIONS,
  rememberedAgentPreferences: '',
};
export const administrationSettingsPatchSchema = administrationSettingsSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0);
const id = z.string().min(1).max(500);
const revision = z.string().min(1).max(200);
const selection = z
  .object({
    workspaceUuid: id,
    rootArtifactId: id,
    selectedArtifactIds: z.array(id).max(2000).optional(),
    selectedConversationIds: z.array(id).max(2000).default([]),
  })
  .strict();
export const administrationHandoffSchema = z.discriminatedUnion('purpose', [
  z.object({ purpose: z.literal('sign-in') }).strict(),
  z.object({ purpose: z.literal('provider-setup'), providerId: id }).strict(),
  z.object({ purpose: z.literal('agent-access'), agentIdentityId: id }).strict(),
]);
export type AdministrationHandoff = z.infer<typeof administrationHandoffSchema>;
const publicOperations = [
  z.object({ kind: z.literal('inspect-settings') }).strict(),
  z
    .object({
      kind: z.literal('update-settings'),
      expectedRevision: revision,
      patch: administrationSettingsPatchSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('retry-settings'),
      expectedRevision: revision,
      keys: z.array(administrationSettingsSchema.keyof()).min(1).max(6).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('inspect-account') }).strict(),
  z.object({ kind: z.literal('prepare-share'), selection }).strict(),
  z
    .object({
      kind: z.literal('prepare-share-import'),
      sourceUrl: z
        .string()
        .min(1)
        .max(2048)
        .describe(
          'User-provided native Deep Share import link. It contains a capability; never repeat it in output.'
        ),
    })
    .strict(),
  z.object({ kind: z.literal('inspect-migration'), runId: id.optional() }).strict(),
  z
    .object({
      kind: z.literal('prepare-migration'),
      runId: id,
      action: z.enum(['start', 'pause', 'resume', 'unlock']),
    })
    .strict(),
  z.object({ kind: z.literal('prepare-handoff'), target: administrationHandoffSchema }).strict(),
  z.object({ kind: z.literal('inspect-action'), actionId: z.string().uuid() }).strict(),
  z
    .object({
      kind: z.literal('execute-action'),
      actionId: z.string().uuid(),
      expectedRevision: revision,
    })
    .strict(),
  z
    .object({
      kind: z.literal('cancel-action'),
      actionId: z.string().uuid(),
      expectedRevision: revision,
    })
    .strict(),
] as const;
export const administrationAgentOperationSchema = z.discriminatedUnion('kind', publicOperations);
export const administrationOperationSchema = z.discriminatedUnion('kind', [
  ...publicOperations,
  z
    .object({ kind: z.literal('adopt-settings'), patch: administrationSettingsPatchSchema })
    .strict(),
]);
export const administrationRequestSchema = z
  .object({ operation: administrationOperationSchema })
  .strict();
export type AdministrationRequest = z.input<typeof administrationRequestSchema>;
export interface AdministrationSettingsSnapshot {
  ownerId: string;
  generation: number;
  revision: string;
  values: AdministrationSettings;
  adopted: Array<keyof AdministrationSettings>;
  persistence: 'saved' | 'unsaved';
  unsavedKeys: Array<keyof AdministrationSettings>;
  zoom?: WindowZoomResult;
  message?: string;
}
export interface AdministrationAccount {
  accountId: string;
  desktopSessionId: string;
  email?: string;
}
export interface AdministrationAgentAuthority {
  identityId: string;
  capabilities: string[];
}
export type AdministrationActionTarget =
  | { kind: 'share'; selection: DeepShareSelectionRequest; review: DeepShareReview }
  | { kind: 'share-import'; review: AdministrationShareImportReview }
  | {
      kind: 'migration';
      runId: string;
      runRevision: string;
      action: 'start' | 'pause' | 'resume' | 'unlock';
    }
  | { kind: 'handoff'; target: AdministrationHandoff };
export interface AdministrationShareImportReview {
  source: {
    shareId: string;
    shortId: string;
    bundleSha256: string;
    artifactName: string;
    fileCount: number;
    conversationCount: number;
    totalBytes: number;
  };
  destination: {
    kind: 'new-private-project';
    workspaceUuid: string;
    displayName: string;
    repoPath: string;
  };
}
export interface AdministrationShareImportResult {
  workspaceUuid: string;
  displayName: string;
  repoPath: string;
  warnings: string[];
}
export interface AdministrationAction {
  id: string;
  revision: string;
  createdAt: string;
  expiresAt: string;
  account: AdministrationAccount | null;
  originAgent: AdministrationAgentAuthority | null;
  target: AdministrationActionTarget;
  state:
    | 'prepared'
    | 'awaiting-human'
    | 'executing'
    | 'completed'
    | 'cancelled'
    | 'stale'
    | 'unresolved';
  effects: string[];
  message?: string;
  result?:
    | DeepSharePublishResult
    | AdministrationShareImportResult
    | BenchlingMigrationRunView
    | { completed: boolean; message: string };
}
export type AdministrationResult =
  | { kind: 'settings'; snapshot: AdministrationSettingsSnapshot; stateChanged: boolean }
  | { kind: 'account'; account: AdministrationAccount | null }
  | { kind: 'action'; action: AdministrationAction }
  | { kind: 'migration'; run: BenchlingMigrationRunView | null; revision: string | null }
  | {
      kind: 'failed';
      code: string;
      message: string;
      stateChanged: boolean | 'unknown';
      action?: AdministrationAction;
    };
export type AdministrationEvent =
  | { kind: 'settings'; snapshot: AdministrationSettingsSnapshot }
  | { kind: 'action'; action: Pick<AdministrationAction, 'id' | 'revision' | 'state'> }
  | { kind: 'handoff'; target: AdministrationHandoff };
