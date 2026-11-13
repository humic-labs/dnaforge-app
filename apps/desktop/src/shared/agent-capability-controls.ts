import type { AgentTransport } from './agent-authority';

export type AgentCapabilityKind =
  | 'command'
  | 'custom-command'
  | 'skill'
  | 'plugin'
  | 'memory'
  | 'attachment-input'
  | 'attachment-output'
  | 'structured-output'
  | 'account';

export type AgentCapabilityScope =
  | 'account'
  | 'installation'
  | 'workspace'
  | 'conversation'
  | 'session'
  | 'turn';

export type AgentCapabilityEffect =
  | 'instructions'
  | 'filesystem-read'
  | 'filesystem-write'
  | 'process'
  | 'network'
  | 'external-account'
  | 'session-state';

export type AgentCapabilityAvailabilityState =
  | 'supported'
  | 'unsupported'
  | 'disabled-by-policy'
  | 'requires-auth'
  | 'requires-restart'
  | 'unknown';

export interface AgentCapabilityAvailability {
  state: AgentCapabilityAvailabilityState;
  reason?: string;
}

export interface AgentCapabilityStages {
  advertised: boolean;
  discoverable: boolean;
  invocable: boolean;
  visible: boolean;
  deterministic: boolean;
  liveQualified: boolean;
}

export interface AgentProviderPluginManagement {
  installed: boolean;
  enabled?: boolean;
  updateAvailable: boolean;
  updatable?: boolean;
  installable: boolean;
  removable: boolean;
  toggleable?: boolean;
  scope?: 'user' | 'project' | 'local';
  marketplace: string;
}

export type AgentCapabilityStage = keyof AgentCapabilityStages;

export interface AgentCapabilityControl {
  id: string;
  provider: AgentTransport;
  nativeId: string;
  kind: AgentCapabilityKind;
  label: string;
  description: string;
  scope: AgentCapabilityScope;
  effects: AgentCapabilityEffect[];
  availability: AgentCapabilityAvailability;
  stages: AgentCapabilityStages;
  source?: string;
  sourceVersion?: string;
  providerPlugin?: AgentProviderPluginManagement;
  dnaforgePolicy?: {
    enabled: boolean;
    scope: 'installation' | 'workspace';
  };
}

export interface AgentCapabilitySnapshot {
  schemaVersion: 1;
  snapshotId: string;
  provider: AgentTransport;
  providerVersion: string | null;
  accountFingerprint: string | null;
  workspaceFingerprint: string | null;
  capturedAt: number;
  controls: AgentCapabilityControl[];
}

export interface AgentCapabilityDiscoveryRequest {
  provider: AgentTransport;
  workspacePath: string | null;
  conversationId?: string | null;
  forceRefresh?: boolean;
}

export interface AgentCapabilitySelection {
  snapshotId: string;
  provider: AgentTransport;
  capabilityId: string;
}

export interface AgentConversationForkRequest {
  conversationId: string;
}

export type AgentConversationForkResult =
  | { ok: true; conversationId: string; parentConversationId: string }
  | { ok: false; error: string };

export type AgentManagedProvider = AgentTransport | 'all';
export type AgentManagedCommandScope = 'global' | 'workspace';
export type AgentManagedMemoryScope = 'global' | 'workspace' | 'conversation';
export type AgentManagedSkillScope = 'global' | 'workspace';
export type AgentManagedSkillOrigin = 'local' | 'catalog';

export interface AgentSkillAdditionalLicense {
  key: string;
  label: string;
  value: string;
}

export interface AgentManagedSkillSource {
  packId: string;
  packName: string;
  publisher: string;
  repositoryUrl: string;
  skillPath: string;
  revision: string;
  version: string | null;
  license: string;
  additionalLicenses: AgentSkillAdditionalLicense[];
  compatibility: string | null;
}

export interface AgentManagedCommand {
  id: string;
  name: string;
  description: string;
  instructions: string;
  provider: AgentManagedProvider;
  scope: AgentManagedCommandScope;
  workspacePath: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AgentManagedMemory {
  id: string;
  name: string;
  content: string;
  provider: AgentManagedProvider;
  scope: AgentManagedMemoryScope;
  workspacePath: string | null;
  conversationId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AgentManagedSkill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  provider: AgentManagedProvider;
  scope: AgentManagedSkillScope;
  workspacePath: string | null;
  directoryPath: string;
  enabled: boolean;
  hasSupportingFiles: boolean;
  origin: AgentManagedSkillOrigin;
  source: AgentManagedSkillSource | null;
  contentDigest: string | null;
  createdAt: number;
  updatedAt: number;
}

export function selectManagedSkills(
  skills: readonly AgentManagedSkill[],
  provider: AgentTransport,
  workspacePath?: string | null
): AgentManagedSkill[] {
  const selected = new Map<string, AgentManagedSkill>();
  const rank = (skill: AgentManagedSkill) =>
    (skill.scope === 'workspace' ? 2 : 0) + (skill.provider === provider ? 1 : 0);
  for (const skill of skills) {
    if (skill.provider !== 'all' && skill.provider !== provider) continue;
    if (
      skill.scope === 'workspace' &&
      workspacePath !== undefined &&
      skill.workspacePath !== workspacePath
    )
      continue;
    const name = skill.name
      .trim()
      .toLowerCase()
      .replace(/^[$/]+/u, '');
    const current = selected.get(name);
    if (
      !current ||
      rank(skill) > rank(current) ||
      (rank(skill) === rank(current) &&
        (skill.updatedAt > current.updatedAt ||
          (skill.updatedAt === current.updatedAt && skill.id.localeCompare(current.id) < 0)))
    ) {
      selected.set(name, skill);
    }
  }
  return [...selected.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  );
}

export function managedSkillLocator(
  skill: AgentManagedSkill,
  context: { provider: AgentTransport; snapshotId: string },
  relativePath = 'SKILL.md'
): string {
  const selection = new URLSearchParams({
    host: context.provider,
    snapshot: context.snapshotId,
    updated: String(skill.updatedAt),
  });
  return `skill://${skill.provider}/${skill.name}/${relativePath}?${selection}`;
}

export interface AgentManagedExtensionsListRequest {
  workspacePath: string | null;
  conversationId: string | null;
}

export interface AgentManagedExtensionsSnapshot {
  commands: AgentManagedCommand[];
  skills: AgentManagedSkill[];
  memory: AgentManagedMemory[];
}

export type AgentManagedCommandSaveRequest = Omit<
  AgentManagedCommand,
  'id' | 'createdAt' | 'updatedAt'
> & { id?: string };

export type AgentManagedMemorySaveRequest = Omit<
  AgentManagedMemory,
  'id' | 'createdAt' | 'updatedAt'
> & { id?: string };

export type AgentManagedSkillSaveRequest = Omit<
  AgentManagedSkill,
  | 'id'
  | 'directoryPath'
  | 'hasSupportingFiles'
  | 'origin'
  | 'source'
  | 'contentDigest'
  | 'createdAt'
  | 'updatedAt'
> & { id?: string };

export interface AgentManagedSkillImportRequest {
  sourcePath: string;
  provider: AgentManagedProvider;
  scope: AgentManagedSkillScope;
  workspacePath: string | null;
}

export interface AgentManagedSkillEnabledRequest {
  id: string;
  enabled: boolean;
}

export type AgentProviderSkillPolicyScope = 'global' | 'workspace';

export type AgentProviderSkillEnabledRequest =
  | {
      selection: AgentCapabilitySelection;
      enabled: boolean;
      inheritGlobal?: false;
      scope: AgentProviderSkillPolicyScope;
      workspacePath: string | null;
    }
  | {
      selection: AgentCapabilitySelection;
      inheritGlobal: true;
      scope: 'workspace';
      workspacePath: string;
    };

export type AgentSkillPackDelivery = 'dnaforge' | 'provider-native';

export interface AgentSkillPackSummary {
  id: string;
  name: string;
  publisher: string;
  description: string;
  repositoryUrl: string;
  delivery: AgentSkillPackDelivery;
  provider: AgentTransport | null;
  trust: 'publisher' | 'community';
  repositoryLicense: string | null;
  licenseNotice: string | null;
}

export interface AgentSkillCatalogEntry {
  id: string;
  name: string;
  fileCount: number;
  byteCount: number;
  hasScripts: boolean;
}

export interface AgentSkillFileSummary {
  path: string;
  byteCount: number;
}

export interface AgentSkillDocument {
  document: string;
  sourcePath: string | null;
  files: AgentSkillFileSummary[];
}

export interface AgentSkillCatalogSnapshot {
  schemaVersion: 1;
  snapshotId: string;
  packId: string;
  revision: string;
  capturedAt: number;
  skills: AgentSkillCatalogEntry[];
}

export interface AgentSkillCatalogReview {
  packId: string;
  packName: string;
  publisher: string;
  repositoryUrl: string;
  skillId: string;
  name: string;
  description: string;
  revision: string;
  version: string | null;
  license: string | null;
  additionalLicenses: AgentSkillAdditionalLicense[];
  compatibility: string | null;
  allowedTools: string | null;
  fileCount: number;
  byteCount: number;
  hasScripts: boolean;
  installable: boolean;
  installBlockReason: 'provider-native' | 'missing-license' | null;
  delivery: AgentSkillPackDelivery;
  provider: AgentTransport | null;
  document: string;
  files: AgentSkillFileSummary[];
}

export type AgentSkillCatalogReviewResult =
  | { ok: true; reviewToken: string; skill: AgentSkillCatalogReview }
  | { ok: false; error: string };

export interface AgentSkillCatalogBrowseRequest {
  packId: string;
  forceRefresh?: boolean;
}

export type AgentSkillCatalogBrowseResult =
  | { ok: true; snapshot: AgentSkillCatalogSnapshot }
  | { ok: false; error: string };

export interface AgentSkillCatalogReviewRequest {
  snapshotId: string;
  skillId: string;
}

export interface AgentSkillInspectionRequest {
  selection: AgentCapabilitySelection;
}

export type AgentSkillInspectionResult =
  | { ok: true; skill: AgentSkillDocument }
  | { ok: false; error: string };

export interface AgentSkillCatalogInstallRequest {
  reviewToken: string;
  provider: AgentManagedProvider;
  scope: AgentManagedSkillScope;
  workspacePath: string | null;
}

export type AgentSkillCatalogInstallResult =
  | { ok: true; skillId: string; cleanupIncomplete?: true }
  | {
      ok: false;
      error: string;
      stage?: 'review' | 'staging' | 'download' | 'commit';
      cleanupIncomplete?: true;
    };

export type AgentCapabilityMutationResult = { ok: true } | { ok: false; error: string };

export interface AgentCapabilityRecordRemovalRequest {
  id: string;
}

export interface AgentProviderMemoryResetRequest {
  provider: AgentTransport;
  workspacePath?: string | null;
}

export interface AgentProviderPluginRemovalRequest {
  selection: AgentCapabilitySelection;
  workspacePath?: string | null;
  action?: 'disable' | 'uninstall';
}

export interface AgentProviderPluginManagementRequest {
  selection: AgentCapabilitySelection;
  workspacePath: string | null;
}

export interface AgentProviderPluginInspection {
  id: string;
  name: string;
  description: string;
  installed: boolean;
  currentVersion: string | null;
  availableVersion: string | null;
  updateAvailable: boolean;
  installable: boolean;
  authPolicy: 'ON_INSTALL' | 'ON_USE' | null;
  skills: string[];
  commands?: string[];
  agents?: string[];
  apps: string[];
  mcpServers: string[];
  hooks: string[];
  scheduledTasks: string[];
  errors?: string[];
}

export type AgentProviderPluginInspectionResult =
  | { ok: true; plugin: AgentProviderPluginInspection }
  | { ok: false; error: string };

export type AgentCapabilitySelectionResult =
  | { ok: true; control: AgentCapabilityControl }
  | {
      ok: false;
      reason: 'stale-snapshot' | 'provider-mismatch' | 'unknown-capability' | 'unavailable';
    };

const nonEmpty = (value: string): boolean => value.trim().length > 0;

export function validateAgentCapabilitySnapshot(
  snapshot: AgentCapabilitySnapshot
): AgentCapabilitySnapshot {
  if (snapshot.schemaVersion !== 1) throw new Error('Unsupported capability snapshot schema.');
  if (!nonEmpty(snapshot.snapshotId)) throw new Error('Capability snapshot requires an id.');
  if (!Number.isFinite(snapshot.capturedAt) || snapshot.capturedAt < 0) {
    throw new Error('Capability snapshot requires a valid capture time.');
  }

  const seen = new Set<string>();
  for (const control of snapshot.controls) {
    if (control.provider !== snapshot.provider) {
      throw new Error(`Capability ${control.id || '(missing id)'} has the wrong provider.`);
    }
    if (!nonEmpty(control.id) || !control.id.startsWith(`${snapshot.provider}:`)) {
      throw new Error('Capability id must be namespaced by its provider.');
    }
    if (seen.has(control.id)) throw new Error(`Duplicate capability id: ${control.id}`);
    seen.add(control.id);
    if (!nonEmpty(control.nativeId) || !nonEmpty(control.label) || !nonEmpty(control.description)) {
      throw new Error(`Capability ${control.id} has incomplete display identity.`);
    }
    if (
      control.availability.state !== 'supported' &&
      !nonEmpty(control.availability.reason ?? '')
    ) {
      throw new Error(`Unavailable capability ${control.id} requires a reason.`);
    }
    if (control.stages.liveQualified && !control.stages.deterministic) {
      throw new Error(`Live-qualified capability ${control.id} lacks deterministic proof.`);
    }
  }
  return snapshot;
}

export function capabilityHasStage(
  control: AgentCapabilityControl,
  stage: AgentCapabilityStage
): boolean {
  return control.stages[stage];
}

export function resolveCapabilitySelection(
  snapshot: AgentCapabilitySnapshot,
  selection: AgentCapabilitySelection
): AgentCapabilitySelectionResult {
  if (selection.snapshotId !== snapshot.snapshotId) {
    return { ok: false, reason: 'stale-snapshot' };
  }
  if (selection.provider !== snapshot.provider) {
    return { ok: false, reason: 'provider-mismatch' };
  }
  const control = snapshot.controls.find((candidate) => candidate.id === selection.capabilityId);
  if (!control) return { ok: false, reason: 'unknown-capability' };
  if (control.availability.state !== 'supported' || !control.stages.invocable) {
    return { ok: false, reason: 'unavailable' };
  }
  return { ok: true, control };
}
