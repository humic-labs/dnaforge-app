import {
  captureSkillObservation,
  reportSkillOwnerReturn,
  skillRequestObservationContext,
} from './skill-observation';
import type { SkillMutationObservationContext } from './skill-observation-contract';
import { isAbsolute } from 'node:path';

import { handleGroup } from '../../shared/ipc-contract';
import type {
  AgentCapabilityMutationResult,
  AgentManagedCommand,
  AgentManagedCommandSaveRequest,
  AgentManagedExtensionsSnapshot,
  AgentManagedProvider,
  AgentManagedMemory,
  AgentManagedMemorySaveRequest,
  AgentManagedSkill,
  AgentManagedSkillEnabledRequest,
  AgentManagedSkillImportRequest,
  AgentManagedSkillSaveRequest,
  AgentCapabilitySelection,
  AgentCapabilitySelectionResult,
  AgentCapabilitySnapshot,
  AgentConversationForkResult,
  AgentProviderPluginInspection,
  AgentSkillCatalogBrowseResult,
  AgentSkillCatalogInstallRequest,
  AgentSkillCatalogInstallResult,
  AgentSkillCatalogReviewResult,
  AgentSkillCatalogSnapshot,
  AgentSkillInspectionResult,
  AgentSkillPackSummary,
} from '../../shared/agent-capability-controls';
import type { AgentTransport } from '../../shared/agent-runtime-ipc';
import { assertSafePath } from '../ipc/path-allowlist';
import { getDb } from '../ipc/database';
import { forkConversation as forkConversationInDb } from '../agent-session/session-control';
import { getRuntimeAgentCapabilityService } from './runtime-service';
import { getRuntimeAgentCapabilityResources } from './runtime-service';
import type {
  AgentCapabilityInspectionContextResult,
  AgentCapabilitySelectionContextResult,
} from './service';
import {
  inspectClaudePlugin,
  inspectCodexPlugin,
  inspectGrokPlugin,
  installOrUpdateClaudePlugin,
  installOrUpdateCodexPlugin,
  installOrUpdateGrokPlugin,
  removeClaudePlugin,
  removeCodexPlugin,
  removeGrokPlugin,
  resetCodexProviderMemory,
  resetGrokProviderMemory,
  setClaudePluginEnabled,
  setGrokPluginEnabled,
} from './provider-operations';
import { agentCapabilitiesContract } from '../../shared/ipc/agent-capabilities.contract';

interface AgentCapabilityIpcService {
  discover(request: {
    provider: AgentTransport;
    workspacePath: string | null;
    forceRefresh?: boolean;
  }): Promise<AgentCapabilitySnapshot>;
  resolve(selection: AgentCapabilitySelection): AgentCapabilitySelectionResult;
  resolveContext?(selection: AgentCapabilitySelection): AgentCapabilitySelectionContextResult;
  inspectContext?(selection: AgentCapabilitySelection): AgentCapabilityInspectionContextResult;
  inspectSkill?(selection: AgentCapabilitySelection): Promise<AgentSkillInspectionResult>;
  invalidate?(provider?: AgentTransport): void;
}

interface AgentExtensionIpcStore {
  list(input: {
    workspacePath: string | null;
  }): Promise<{ commands: AgentManagedCommand[]; skills: AgentManagedSkill[] }>;
  saveCommand(input: AgentManagedCommandSaveRequest): Promise<AgentManagedCommand>;
  removeCommand(id: string): Promise<void>;
  saveSkill(
    input: AgentManagedSkillSaveRequest,
    observation?: SkillMutationObservationContext | null
  ): Promise<AgentManagedSkill>;
  importSkill(
    input: AgentManagedSkillImportRequest,
    observation?: SkillMutationObservationContext | null
  ): Promise<AgentManagedSkill>;
  setSkillEnabled(
    input: AgentManagedSkillEnabledRequest,
    observation?: SkillMutationObservationContext | null
  ): Promise<AgentManagedSkill>;
  setProviderSkillPolicy(
    input: {
      provider: AgentTransport;
      nativeId: string;
      scope: 'global' | 'workspace';
      workspacePath: string | null;
      enabled: boolean;
    },
    observation?: SkillMutationObservationContext | null
  ): Promise<unknown>;
  removeProviderSkillPolicy(
    input: {
      provider: AgentTransport;
      nativeId: string;
      scope: 'global' | 'workspace';
      workspacePath: string | null;
    },
    observation?: SkillMutationObservationContext | null
  ): Promise<void>;
  removeSkill(id: string, observation?: SkillMutationObservationContext | null): Promise<void>;
}

interface AgentSkillCatalogIpcService {
  listPacks(): AgentSkillPackSummary[];
  browsePack(input: { packId: string; forceRefresh?: boolean }): Promise<AgentSkillCatalogSnapshot>;
  reviewSkill(input: {
    snapshotId: string;
    skillId: string;
  }): Promise<AgentSkillCatalogReviewResult>;
  installSkill(
    input: AgentSkillCatalogInstallRequest,
    observation?: SkillMutationObservationContext | null
  ): Promise<AgentSkillCatalogInstallResult>;
}

interface AgentMemoryIpcStore {
  list(input: {
    workspacePath: string | null;
    conversationId: string | null;
  }): Promise<{ memory: AgentManagedMemory[] }>;
  saveMemory(input: AgentManagedMemorySaveRequest): Promise<AgentManagedMemory>;
  removeMemory(id: string): Promise<void>;
}

export interface RegisterAgentCapabilityHandlersOptions {
  service?: AgentCapabilityIpcService;
  assertWorkspacePath?: (workspacePath: string) => Promise<string>;
  forkConversation?: (conversationId: string) => AgentConversationForkResult;
  extensionStore?: AgentExtensionIpcStore;
  skillCatalog?: AgentSkillCatalogIpcService;
  memoryStore?: AgentMemoryIpcStore;
  resetProviderMemory?: (provider: AgentTransport, workspacePath: string | null) => Promise<void>;
  inspectProviderPlugin?: (
    pluginId: string,
    workspacePath: string | null,
    provider: AgentTransport
  ) => Promise<AgentProviderPluginInspection>;
  installProviderPlugin?: (
    pluginId: string,
    workspacePath: string | null,
    provider: AgentTransport
  ) => Promise<void>;
  removeProviderPlugin?: (
    pluginId: string,
    workspacePath: string | null,
    provider: AgentTransport,
    action: 'disable' | 'uninstall'
  ) => Promise<void>;
}

const PROVIDERS = new Set<AgentTransport>(['claude-agent-sdk', 'codex-sdk', 'grok-acp']);
const SAFE_SELECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._@:/-]{0,255}$/;
const SAFE_PACK_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

function provider(value: unknown): AgentTransport | null {
  return typeof value === 'string' && PROVIDERS.has(value as AgentTransport)
    ? (value as AgentTransport)
    : null;
}

function parseDiscoveryRequest(value: unknown): {
  provider: AgentTransport;
  workspacePath: string | null;
  conversationId: string | null;
  forceRefresh: boolean;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid agent capability discovery request.');
  }
  const request = value as Record<string, unknown>;
  const parsedProvider = provider(request.provider);
  if (!parsedProvider) throw new Error('Invalid agent capability discovery request.');
  if (request.workspacePath !== null && typeof request.workspacePath !== 'string') {
    throw new Error('Invalid agent capability discovery request.');
  }
  if (typeof request.workspacePath === 'string') {
    if (request.workspacePath.length === 0 || request.workspacePath.length > 4096) {
      throw new Error('Invalid agent capability workspace path.');
    }
    if (!isAbsolute(request.workspacePath)) {
      throw new Error('Agent capability workspace path must be absolute.');
    }
  }
  if (request.forceRefresh !== undefined && typeof request.forceRefresh !== 'boolean') {
    throw new Error('Invalid agent capability discovery request.');
  }
  if (
    request.conversationId !== undefined &&
    request.conversationId !== null &&
    (typeof request.conversationId !== 'string' || !SAFE_SELECTION_ID.test(request.conversationId))
  ) {
    throw new Error('Invalid agent capability conversation id.');
  }
  return {
    provider: parsedProvider,
    workspacePath: request.workspacePath as string | null,
    conversationId: typeof request.conversationId === 'string' ? request.conversationId : null,
    forceRefresh: request.forceRefresh === true,
  };
}

function parseSelection(value: unknown): AgentCapabilitySelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid agent capability selection.');
  }
  const selection = value as Record<string, unknown>;
  const parsedProvider = provider(selection.provider);
  if (
    !parsedProvider ||
    typeof selection.snapshotId !== 'string' ||
    !SAFE_SELECTION_ID.test(selection.snapshotId) ||
    typeof selection.capabilityId !== 'string' ||
    !SAFE_SELECTION_ID.test(selection.capabilityId)
  ) {
    throw new Error('Invalid agent capability selection.');
  }
  return {
    snapshotId: selection.snapshotId,
    provider: parsedProvider,
    capabilityId: selection.capabilityId,
  };
}

function managedListRequest(value: unknown): {
  workspacePath: string | null;
  conversationId: string | null;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid managed agent data request.');
  }
  const request = value as Record<string, unknown>;
  const parsed = parseDiscoveryRequest({
    provider: 'codex-sdk',
    workspacePath: request.workspacePath,
    conversationId: request.conversationId,
  });
  return { workspacePath: parsed.workspacePath, conversationId: parsed.conversationId };
}

function recordRemovalId(value: unknown): string {
  const id =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>).id
      : null;
  if (typeof id !== 'string' || !SAFE_SELECTION_ID.test(id)) {
    throw new Error('Invalid managed agent record id.');
  }
  return id;
}

function mutationError(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function mutationResult(error: unknown): AgentCapabilityMutationResult {
  return mutationError(error);
}

function catalogService(
  options: RegisterAgentCapabilityHandlersOptions
): AgentSkillCatalogIpcService {
  return options.skillCatalog ?? getRuntimeAgentCapabilityResources().skillCatalog;
}

export function registerAgentCapabilityHandlers(
  options: RegisterAgentCapabilityHandlersOptions = {}
): void {
  const service = options.service ?? getRuntimeAgentCapabilityService();
  const assertWorkspacePath =
    options.assertWorkspacePath ??
    ((workspacePath: string) =>
      assertSafePath(workspacePath, {
        requireAbsolute: true,
        errorPrefix: 'agentCapabilities:discover',
      }));

  const pluginManagementRequest = async (value: unknown) => {
    const request = value as Record<string, unknown> | null;
    const selection = parseSelection(request?.selection);
    const parsed = parseDiscoveryRequest({
      provider: selection.provider,
      workspacePath: request?.workspacePath ?? null,
      conversationId: null,
    });
    const workspacePath = parsed.workspacePath
      ? await assertWorkspacePath(parsed.workspacePath)
      : null;
    const resolved = service.inspectContext?.(selection);
    if (!resolved?.ok || resolved.control.kind !== 'plugin') {
      throw new Error('The selected provider plugin is stale.');
    }
    return { control: resolved.control, workspacePath };
  };
  handleGroup(agentCapabilitiesContract, {
    discover: async (_event, value: unknown) => {
      const observation = captureSkillObservation();
      let observedContext: ReturnType<typeof skillRequestObservationContext> = { source: 'mixed' };
      try {
        const request = parseDiscoveryRequest(value);
        const workspacePath = request.workspacePath
          ? await assertWorkspacePath(request.workspacePath)
          : null;
        observedContext = {
          host: request.provider,
          scope: workspacePath ? 'current_context' : 'global',
          source: 'mixed',
        };
        const snapshot = await service.discover({ ...request, workspacePath });
        try {
          const controls = snapshot.controls.filter((control) => control.kind === 'skill');
          const discovered = controls.some((control) => control.stages.discoverable);
          const enabled = controls.some(
            (control) => control.stages.invocable && control.availability.state === 'supported'
          );
          const unavailable =
            controls.length > 0 &&
            controls.every((control) =>
              ['unsupported', 'requires-auth', 'requires-restart', 'unknown'].includes(
                control.availability.state
              )
            );
          reportSkillOwnerReturn(
            observation,
            'discover',
            unavailable ? 'runtime_unavailable' : 'runtime_returned',
            {
              host: request.provider,
              scope: workspacePath ? 'current_context' : 'global',
              source: 'mixed',
              authority: 'runtime_snapshot',
              runtime: discovered ? 'discovered' : unavailable ? 'unavailable' : 'not_attested',
              effectiveEnablement: enabled ? 'enabled' : 'not_attested',
              observedAtMs: snapshot.capturedAt,
            }
          );
        } catch (ignoredError) {
          void ignoredError;
        }
        return snapshot;
      } catch (error) {
        reportSkillOwnerReturn(observation, 'discover', 'failed', observedContext);
        throw error;
      }
    },
    resolve: async (_event, value: unknown) => service.resolve(parseSelection(value)),
    inspectSkill: async (_event, value: unknown) => {
      const request = value as Record<string, unknown> | null;
      const selection = parseSelection(request?.selection);
      if (!service.inspectSkill) {
        return { ok: false, error: 'Skill inspection is unavailable.' };
      }
      return service.inspectSkill(selection);
    },
    forkConversation: async (_event, value: unknown) => {
      const request = value as Record<string, unknown> | null;
      const conversationId = request?.conversationId;
      if (typeof conversationId !== 'string' || !SAFE_SELECTION_ID.test(conversationId)) {
        throw new Error('Invalid conversation fork request.');
      }
      if (options.forkConversation) return options.forkConversation(conversationId);
      try {
        return { ok: true, ...forkConversationInDb(getDb(), { conversationId }) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    listManaged: async (_event, value: unknown) => {
      const request = managedListRequest(value);
      const workspacePath = request.workspacePath
        ? await assertWorkspacePath(request.workspacePath)
        : null;
      const runtime =
        options.extensionStore && options.memoryStore ? null : getRuntimeAgentCapabilityResources();
      const extensionStore = options.extensionStore ?? runtime!.extensionStore;
      const memoryStore = options.memoryStore ?? runtime!.memoryStore;
      const [commands, memory] = await Promise.all([
        extensionStore.list({ workspacePath }),
        memoryStore.list({ workspacePath, conversationId: request.conversationId }),
      ]);
      return {
        commands: commands.commands,
        skills: commands.skills,
        memory: memory.memory,
      } satisfies AgentManagedExtensionsSnapshot;
    },
    saveCommand: async (_event, value: unknown) => {
      try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('Invalid custom command.');
        }
        const request = value as AgentManagedCommandSaveRequest;
        const workspacePath =
          request.scope === 'workspace' && request.workspacePath
            ? await assertWorkspacePath(request.workspacePath)
            : null;
        const store = options.extensionStore ?? getRuntimeAgentCapabilityResources().extensionStore;
        await store.saveCommand({ ...request, workspacePath });
        service.invalidate?.();
        return { ok: true };
      } catch (error) {
        return mutationError(error);
      }
    },
    removeCommand: async (_event, value: unknown) => {
      try {
        const store = options.extensionStore ?? getRuntimeAgentCapabilityResources().extensionStore;
        await store.removeCommand(recordRemovalId(value));
        service.invalidate?.();
        return { ok: true };
      } catch (error) {
        return mutationResult(error);
      }
    },
    saveSkill: async (_event, value: unknown) => {
      const observation = captureSkillObservation();
      try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('Invalid skill.');
        }
        const request = value as AgentManagedSkillSaveRequest;
        const workspacePath =
          request.scope === 'workspace' && request.workspacePath
            ? await assertWorkspacePath(request.workspacePath)
            : null;
        const store = options.extensionStore ?? getRuntimeAgentCapabilityResources().extensionStore;
        const input = { ...request, workspacePath };
        await (observation ? store.saveSkill(input, observation) : store.saveSkill(input));
        service.invalidate?.();
        reportSkillOwnerReturn(
          observation,
          'save',
          'accepted',
          skillRequestObservationContext(value, 'local')
        );
        return { ok: true };
      } catch (error) {
        reportSkillOwnerReturn(
          observation,
          'save',
          'failed',
          skillRequestObservationContext(value, 'local')
        );
        return mutationError(error);
      }
    },
    importSkill: async (_event, value: unknown) => {
      const observation = captureSkillObservation();
      try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('Invalid skill import.');
        }
        const request = value as AgentManagedSkillImportRequest;
        if (typeof request.sourcePath !== 'string' || !isAbsolute(request.sourcePath)) {
          throw new Error('Skill import path must be absolute.');
        }
        const sourcePath = await assertWorkspacePath(request.sourcePath);
        const workspacePath =
          request.scope === 'workspace' && request.workspacePath
            ? await assertWorkspacePath(request.workspacePath)
            : null;
        const store = options.extensionStore ?? getRuntimeAgentCapabilityResources().extensionStore;
        const input = { ...request, sourcePath, workspacePath };
        await (observation ? store.importSkill(input, observation) : store.importSkill(input));
        service.invalidate?.();
        reportSkillOwnerReturn(
          observation,
          'import',
          'accepted',
          skillRequestObservationContext(value, 'local')
        );
        return { ok: true };
      } catch (error) {
        reportSkillOwnerReturn(
          observation,
          'import',
          'failed',
          skillRequestObservationContext(value, 'local')
        );
        return mutationError(error);
      }
    },
    setSkillEnabled: async (_event, value: unknown) => {
      const observation = captureSkillObservation();
      let observationAction: 'unknown' | 'enable' | 'disable' | 'inherit' = 'unknown';
      let observationContext: ReturnType<typeof skillRequestObservationContext> = {};
      try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('Invalid skill state.');
        }
        const request = value as AgentManagedSkillEnabledRequest;
        const id = recordRemovalId(request);
        const enabled = request.enabled;
        if (typeof enabled !== 'boolean') throw new Error('Invalid skill state.');
        observationAction = enabled ? 'enable' : 'disable';
        observationContext = skillRequestObservationContext(value, 'managed');
        const store = options.extensionStore ?? getRuntimeAgentCapabilityResources().extensionStore;
        const input = { id, enabled };
        await (observation
          ? store.setSkillEnabled(input, observation)
          : store.setSkillEnabled(input));
        service.invalidate?.();
        reportSkillOwnerReturn(observation, observationAction, 'accepted', observationContext);
        return { ok: true };
      } catch (error) {
        reportSkillOwnerReturn(observation, observationAction, 'failed', observationContext);
        return mutationError(error);
      }
    },
    setProviderSkillEnabled: async (_event, value: unknown) => {
      const observation = captureSkillObservation();
      let observationAction: 'unknown' | 'enable' | 'disable' | 'inherit' = 'unknown';
      let observationContext: ReturnType<typeof skillRequestObservationContext> = {};
      try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('Invalid provider skill state.');
        }
        const request = value as Record<string, unknown>;
        const selection = parseSelection(request.selection);
        if (request.inheritGlobal !== undefined && typeof request.inheritGlobal !== 'boolean') {
          throw new Error('Invalid provider skill inheritance state.');
        }
        const inheritGlobal = request.inheritGlobal === true;
        const enabled = inheritGlobal ? undefined : request.enabled;
        if (!inheritGlobal && typeof enabled !== 'boolean') {
          throw new Error('Invalid provider skill state.');
        }
        if (request.scope !== 'global' && request.scope !== 'workspace') {
          throw new Error('Invalid provider skill policy scope.');
        }
        if (inheritGlobal && request.scope !== 'workspace') {
          throw new Error('Only a workspace skill policy can inherit the everywhere setting.');
        }
        const workspacePath =
          request.scope === 'workspace' && typeof request.workspacePath === 'string'
            ? await assertWorkspacePath(request.workspacePath)
            : null;
        if (request.scope === 'workspace' && !workspacePath) {
          throw new Error('Choose a workspace before changing a workspace skill policy.');
        }
        const resolved = service.inspectContext?.(selection);
        if (
          !resolved?.ok ||
          resolved.control.kind !== 'skill' ||
          resolved.control.provider !== selection.provider ||
          resolved.control.source?.startsWith('dnaforge-skill:')
        ) {
          throw new Error('The selected CLI skill is stale or invalid.');
        }
        observationAction = inheritGlobal ? 'inherit' : enabled ? 'enable' : 'disable';
        observationContext = {
          host: selection.provider,
          scope: request.scope,
          source: 'provider_native',
        };
        const store = options.extensionStore ?? getRuntimeAgentCapabilityResources().extensionStore;
        if (inheritGlobal) {
          const input = {
            provider: selection.provider,
            nativeId: resolved.control.nativeId,
            scope: 'workspace' as const,
            workspacePath,
          };
          await (observation
            ? store.removeProviderSkillPolicy(input, observation)
            : store.removeProviderSkillPolicy(input));
        } else {
          const input: Parameters<AgentExtensionIpcStore['setProviderSkillPolicy']>[0] = {
            provider: selection.provider,
            nativeId: resolved.control.nativeId,
            enabled: enabled as boolean,
            scope: request.scope,
            workspacePath,
          };
          await (observation
            ? store.setProviderSkillPolicy(input, observation)
            : store.setProviderSkillPolicy(input));
        }
        service.invalidate?.(selection.provider);
        reportSkillOwnerReturn(observation, observationAction, 'accepted', observationContext);
        return { ok: true };
      } catch (error) {
        reportSkillOwnerReturn(observation, observationAction, 'failed', observationContext);
        return mutationError(error);
      }
    },
    listSkillPacks: async () => catalogService(options).listPacks(),
    browseSkillPack: async (_event, value: unknown) => {
      try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('Invalid skill pack request.');
        }
        const request = value as Record<string, unknown>;
        if (typeof request.packId !== 'string' || !SAFE_PACK_ID.test(request.packId)) {
          throw new Error('Invalid skill pack id.');
        }
        if (request.forceRefresh !== undefined && typeof request.forceRefresh !== 'boolean') {
          throw new Error('Invalid skill pack refresh option.');
        }
        return {
          ok: true,
          snapshot: await catalogService(options).browsePack({
            packId: request.packId,
            forceRefresh: request.forceRefresh === true,
          }),
        } satisfies AgentSkillCatalogBrowseResult;
      } catch (error) {
        return mutationError(error) satisfies AgentSkillCatalogBrowseResult;
      }
    },
    reviewCatalogSkill: async (_event, value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, error: 'Invalid catalog skill review request.' };
      }
      const request = value as Record<string, unknown>;
      if (
        typeof request.snapshotId !== 'string' ||
        !SAFE_SELECTION_ID.test(request.snapshotId) ||
        typeof request.skillId !== 'string' ||
        request.skillId.length > 500 ||
        !request.skillId ||
        request.skillId.startsWith('/') ||
        request.skillId
          .split('/')
          .some((segment) => !segment || segment === '.' || segment === '..')
      ) {
        return { ok: false, error: 'Invalid catalog skill review request.' };
      }
      const observation = captureSkillObservation();
      try {
        const result = await catalogService(options).reviewSkill({
          snapshotId: request.snapshotId,
          skillId: request.skillId,
        });
        reportSkillOwnerReturn(observation, 'review', result.ok ? 'reviewed' : 'refused', {
          source: 'catalog',
        });
        return result;
      } catch (error) {
        reportSkillOwnerReturn(observation, 'review', 'failed', { source: 'catalog' });
        throw error;
      }
    },
    installCatalogSkill: async (_event, value: unknown) => {
      const observation = captureSkillObservation();
      try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('Invalid catalog skill install request.');
        }
        const request = value as Record<string, unknown>;
        if (
          typeof request.reviewToken !== 'string' ||
          !SAFE_SELECTION_ID.test(request.reviewToken) ||
          (request.provider !== 'all' && !provider(request.provider)) ||
          (request.scope !== 'global' && request.scope !== 'workspace')
        ) {
          throw new Error('Invalid catalog skill install request.');
        }
        const workspacePath =
          request.scope === 'workspace' && typeof request.workspacePath === 'string'
            ? await assertWorkspacePath(request.workspacePath)
            : null;
        if (request.scope === 'workspace' && !workspacePath) {
          throw new Error('Choose a workspace before installing a workspace skill.');
        }
        const input: AgentSkillCatalogInstallRequest = {
          reviewToken: request.reviewToken,
          provider: request.provider as AgentManagedProvider,
          scope: request.scope,
          workspacePath,
        };
        const owner = catalogService(options);
        const result = await (observation
          ? owner.installSkill(input, observation)
          : owner.installSkill(input));
        if (result.ok) service.invalidate?.();
        reportSkillOwnerReturn(
          observation,
          'install',
          result.ok ? 'accepted' : result.stage === 'review' ? 'refused' : 'failed',
          skillRequestObservationContext(value, 'catalog')
        );
        return result;
      } catch (error) {
        reportSkillOwnerReturn(
          observation,
          'install',
          'failed',
          skillRequestObservationContext(value, 'catalog')
        );
        return mutationError(error) satisfies AgentSkillCatalogInstallResult;
      }
    },
    removeSkill: async (_event, value: unknown) => {
      const observation = captureSkillObservation();
      try {
        const id = recordRemovalId(value);
        const store = options.extensionStore ?? getRuntimeAgentCapabilityResources().extensionStore;
        await (observation ? store.removeSkill(id, observation) : store.removeSkill(id));
        service.invalidate?.();
        reportSkillOwnerReturn(
          observation,
          'remove',
          'accepted',
          skillRequestObservationContext(value, 'unknown')
        );
        return { ok: true };
      } catch (error) {
        reportSkillOwnerReturn(
          observation,
          'remove',
          'failed',
          skillRequestObservationContext(value, 'unknown')
        );
        return mutationError(error);
      }
    },
    saveMemory: async (_event, value: unknown) => {
      try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('Invalid memory entry.');
        }
        const request = value as AgentManagedMemorySaveRequest;
        const workspacePath =
          request.scope !== 'global' && request.workspacePath
            ? await assertWorkspacePath(request.workspacePath)
            : null;
        const store = options.memoryStore ?? getRuntimeAgentCapabilityResources().memoryStore;
        await store.saveMemory({ ...request, workspacePath });
        service.invalidate?.();
        return { ok: true };
      } catch (error) {
        return mutationResult(error);
      }
    },
    removeMemory: async (_event, value: unknown) => {
      try {
        const store = options.memoryStore ?? getRuntimeAgentCapabilityResources().memoryStore;
        await store.removeMemory(recordRemovalId(value));
        service.invalidate?.();
        return { ok: true };
      } catch (error) {
        return mutationResult(error);
      }
    },
    resetProviderMemory: async (_event, value: unknown) => {
      try {
        const rawRequest =
          value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
        const requestedProvider = provider(rawRequest?.provider);
        if (!requestedProvider) throw new Error('Invalid provider memory reset request.');
        const workspacePath =
          typeof rawRequest?.workspacePath === 'string' && rawRequest.workspacePath
            ? await assertWorkspacePath(rawRequest.workspacePath)
            : null;
        if (options.resetProviderMemory) {
          await options.resetProviderMemory(requestedProvider, workspacePath);
        } else {
          if (requestedProvider === 'codex-sdk') {
            const runtime = getRuntimeAgentCapabilityResources();
            await resetCodexProviderMemory({ runtimeRoot: runtime.runtimeRoot });
          } else if (requestedProvider === 'grok-acp') {
            await resetGrokProviderMemory(workspacePath);
          } else {
            throw new Error('This provider does not expose native memory reset.');
          }
        }
        service.invalidate?.(requestedProvider);
        return { ok: true };
      } catch (error) {
        return mutationResult(error);
      }
    },
    inspectProviderPlugin: async (_event, value: unknown) => {
      try {
        const request = await pluginManagementRequest(value);
        const plugin = options.inspectProviderPlugin
          ? await options.inspectProviderPlugin(
              request.control.nativeId,
              request.workspacePath,
              request.control.provider
            )
          : request.control.provider === 'claude-agent-sdk'
            ? await inspectClaudePlugin(request.control.nativeId, request.workspacePath)
            : request.control.provider === 'grok-acp'
              ? await inspectGrokPlugin(request.control.nativeId, request.workspacePath)
              : await inspectCodexPlugin(request.control.nativeId, request.workspacePath, {
                  runtimeRoot: getRuntimeAgentCapabilityResources().runtimeRoot,
                });
        return { ok: true, plugin };
      } catch (error) {
        return mutationError(error);
      }
    },
    installProviderPlugin: async (_event, value: unknown) => {
      try {
        const request = await pluginManagementRequest(value);
        if (options.installProviderPlugin) {
          await options.installProviderPlugin(
            request.control.nativeId,
            request.workspacePath,
            request.control.provider
          );
        } else if (request.control.provider === 'claude-agent-sdk') {
          await installOrUpdateClaudePlugin(request.control.nativeId, request.workspacePath);
        } else if (request.control.provider === 'grok-acp') {
          await installOrUpdateGrokPlugin(request.control.nativeId, request.workspacePath);
        } else {
          await installOrUpdateCodexPlugin(request.control.nativeId, request.workspacePath, {
            runtimeRoot: getRuntimeAgentCapabilityResources().runtimeRoot,
          });
        }
        service.invalidate?.(request.control.provider);
        return { ok: true };
      } catch (error) {
        return mutationResult(error);
      }
    },
    removeProviderPlugin: async (_event, value: unknown) => {
      try {
        const rawRequest = value as Record<string, unknown> | null;
        const request = await pluginManagementRequest(value);
        const action = rawRequest?.action === 'disable' ? 'disable' : 'uninstall';
        if (
          action === 'disable' &&
          request.control.provider !== 'claude-agent-sdk' &&
          request.control.provider !== 'grok-acp'
        ) {
          throw new Error('This provider does not expose plugin enable/disable controls.');
        }
        if (options.removeProviderPlugin) {
          await options.removeProviderPlugin(
            request.control.nativeId,
            request.workspacePath,
            request.control.provider,
            action
          );
        } else if (request.control.provider === 'claude-agent-sdk') {
          if (action === 'disable') {
            await setClaudePluginEnabled(request.control.nativeId, request.workspacePath, false);
          } else {
            await removeClaudePlugin(request.control.nativeId, request.workspacePath);
          }
        } else if (request.control.provider === 'grok-acp') {
          if (action === 'disable') {
            await setGrokPluginEnabled(request.control.nativeId, request.workspacePath, false);
          } else {
            await removeGrokPlugin(request.control.nativeId, request.workspacePath);
          }
        } else {
          const runtime = getRuntimeAgentCapabilityResources();
          await removeCodexPlugin(request.control.nativeId, { runtimeRoot: runtime.runtimeRoot });
        }
        service.invalidate?.(request.control.provider);
        return { ok: true };
      } catch (error) {
        return mutationResult(error);
      }
    },
  });
}
