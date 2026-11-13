import {
  publishCommittedSkillObservation,
  captureSkillObservation,
  reportSkillOwnerReturn,
} from './skill-observation';
import { managedSkillLocator, selectManagedSkills } from '../../shared/agent-capability-controls';
import { isAbsolute, join } from 'node:path';
import { app } from 'electron';

import type {
  AgentCapabilitySelection,
  AgentCapabilitySnapshot,
  AgentManagedSkill,
} from '../../shared/agent-capability-controls';
import type { AgentTransport } from '../../shared/agent-runtime-ipc';
import { isExplicitE2eTestRuntime } from '../config';
import { AgentExtensionStore } from './extension-store';
import { AgentMemoryStore } from './memory-store';
import { createE2eSkillCatalogFetch, E2E_BIOLOGY_SKILL_PACK } from './skill-catalog-e2e-fixture';
import { AgentSkillCatalogService } from './skill-catalog';
import { createNativeAgentCapabilityAdapters } from './provider-adapters';
import {
  AgentCapabilityService,
  type AgentCapabilityDiscoveryContext,
  type AgentCapabilityProviderAdapter,
  type NativeAgentCapabilityDescriptor,
} from './service';

interface RuntimeAgentCapabilityResources {
  service: AgentCapabilityService;
  extensionStore: AgentExtensionStore;
  memoryStore: AgentMemoryStore;
  skillCatalog: AgentSkillCatalogService;
  runtimeRoot: string;
}

let resources: RuntimeAgentCapabilityResources | null = null;

export interface AutomaticSkillContext {
  additionalInstructions: string | null;
  enabledNativeSkillIds: string[];
  disabledNativeSkillIds: string[];
  portableSkills: Array<{ name: string; sourcePath: string }>;
}

export function managedSkillsForProvider(
  skills: readonly AgentManagedSkill[],
  provider: AgentTransport
): AgentManagedSkill[] {
  return skills.filter((skill) => skill.provider === 'all' || skill.provider === provider);
}

export function automaticSkillsForProvider(
  skills: readonly AgentManagedSkill[],
  provider: AgentTransport,
  workspacePath?: string | null
): AgentManagedSkill[] {
  return selectManagedSkills(skills, provider, workspacePath).filter((skill) => skill.enabled);
}

export function buildAutomaticSkillDiscoveryInstructions(
  skills: readonly AgentManagedSkill[]
): string | null {
  if (
    !(['codex-sdk', 'claude-agent-sdk', 'grok-acp'] as const).some((provider) =>
      selectManagedSkills(skills, provider).some((skill) => skill.enabled)
    )
  )
    return null;
  return [
    'Specialized DNAForge skills are available on demand; their names and bodies are not included in this prompt.',
    'For a specialized workflow, call search_skills with query (a concise task description) and provider: "codex-sdk" for Codex CLI, "claude-agent-sdk" for Claude Code, or "grok-acp" for Grok Build. Use these exact argument names and values. Skip this for ordinary requests that built-in tools already handle.',
    'Use the returned description and provenance to select only relevant matches. Before applying one, read its exact skill:// locator returned by search_skills with the DNAForge read_file tool and follow the loaded instructions.',
    'Combine multiple matching skills only when useful. Do not guess skill names or paths, shell-search app data, or ask the user to choose merely to avoid making a reasonable selection.',
  ].join('\n');
}

export function nativeSkillPolicyFromSnapshot(
  snapshot: AgentCapabilitySnapshot
): Pick<AutomaticSkillContext, 'enabledNativeSkillIds' | 'disabledNativeSkillIds'> {
  const nativeSkills = snapshot.controls.filter(
    (control) => control.kind === 'skill' && !control.source?.startsWith('dnaforge-skill:')
  );
  return {
    enabledNativeSkillIds: nativeSkills
      .filter(
        (control) =>
          control.availability.state === 'supported' &&
          control.stages.invocable &&
          control.dnaforgePolicy?.enabled !== false
      )
      .map((control) => control.nativeId)
      .filter((nativeId, index, nativeIds) => nativeIds.indexOf(nativeId) === index)
      .sort((left, right) => left.localeCompare(right)),
    disabledNativeSkillIds: nativeSkills
      .filter((control) => control.dnaforgePolicy?.enabled === false)
      .map((control) => control.nativeId)
      .filter((nativeId, index, nativeIds) => nativeIds.indexOf(nativeId) === index)
      .sort((left, right) => left.localeCompare(right)),
  };
}

export async function applyProviderSkillPolicies(
  extensionStore: Pick<AgentExtensionStore, 'listProviderSkillPolicies'>,
  provider: AgentTransport,
  workspacePath: string | null,
  controls: NativeAgentCapabilityDescriptor[]
): Promise<NativeAgentCapabilityDescriptor[]> {
  const policies = await extensionStore.listProviderSkillPolicies({ workspacePath });
  return controls.map((control) => {
    if (control.kind !== 'skill') return control;
    const matches = policies.filter(
      (policy) => policy.provider === provider && policy.nativeId === control.nativeId
    );
    const policy =
      matches.find(
        (candidate) => candidate.scope === 'workspace' && candidate.workspacePath === workspacePath
      ) ??
      matches.find((candidate) => candidate.scope === 'global') ??
      null;
    if (!policy) {
      return { ...control, dnaforgePolicy: { enabled: true, scope: 'installation' } };
    }
    if (policy.enabled) {
      return {
        ...control,
        dnaforgePolicy: {
          enabled: true,
          scope: policy.scope === 'workspace' ? 'workspace' : 'installation',
        },
      };
    }
    return {
      ...control,
      availability: {
        state: 'disabled-by-policy',
        reason:
          policy.scope === 'workspace'
            ? 'This CLI skill is disabled in DNAForge for the current workspace.'
            : 'This CLI skill is disabled in DNAForge.',
      },
      stages: { ...control.stages, invocable: false },
      dnaforgePolicy: {
        enabled: false,
        scope: policy.scope === 'workspace' ? 'workspace' : 'installation',
      },
    };
  });
}

function applySkillPolicyToAdapters(
  adapters: AgentCapabilityProviderAdapter[],
  extensionStore: AgentExtensionStore
): AgentCapabilityProviderAdapter[] {
  return adapters.map((adapter) => ({
    provider: adapter.provider,
    discover: async (context) => {
      const result = await adapter.discover(context);
      return {
        ...result,
        controls: await applyProviderSkillPolicies(
          extensionStore,
          adapter.provider,
          context.workspacePath,
          result.controls
        ),
      };
    },
  }));
}

export async function appOwnedControls(
  extensionStore: Pick<AgentExtensionStore, 'list'>,
  memoryStore: Pick<AgentMemoryStore, 'list'>,
  provider: AgentTransport,
  context: AgentCapabilityDiscoveryContext
): Promise<NativeAgentCapabilityDescriptor[]> {
  const [{ skills }, { memory }] = await Promise.all([
    extensionStore.list({ workspacePath: context.workspacePath }),
    memoryStore.list({
      workspacePath: context.workspacePath,
      conversationId: context.conversationId,
    }),
  ]);
  const selectedSkills = selectManagedSkills(skills, provider, context.workspacePath);
  return [
    {
      nativeId: 'json-object',
      kind: 'structured-output',
      label: 'Structured JSON object',
      description:
        'Return one JSON object and validate it before presenting it as structured data.',
      scope: 'conversation',
      effects: ['instructions'],
      availability: { state: 'supported' },
      stages: {
        advertised: true,
        discoverable: true,
        invocable: true,
        visible: true,
        deterministic: true,
        liveQualified: false,
      },
      source: 'dnaforge-structured-output:json-object',
    },
    ...selectedSkills.map(
      (skill): NativeAgentCapabilityDescriptor => ({
        nativeId: skill.name,
        kind: 'skill',
        label: skill.name,
        description: skill.description,
        scope: skill.scope === 'workspace' ? 'workspace' : 'installation',
        effects: [
          'instructions',
          ...(skill.hasSupportingFiles ? (['filesystem-read'] as const) : []),
        ],
        availability: skill.enabled
          ? { state: 'supported' }
          : { state: 'disabled-by-policy', reason: 'This DNAForge skill is disabled.' },
        stages: {
          advertised: true,
          discoverable: true,
          invocable: skill.enabled,
          visible: true,
          deterministic: true,
          liveQualified: false,
        },
        source: `dnaforge-skill:${skill.id}`,
        sourceVersion: String(skill.updatedAt),
        detailSourcePath: join(skill.directoryPath, 'SKILL.md'),
      })
    ),
    ...memory
      .filter((entry) => entry.provider === 'all' || entry.provider === provider)
      .map(
        (entry): NativeAgentCapabilityDescriptor => ({
          nativeId: entry.id,
          kind: 'memory',
          label: entry.name,
          description: `Attach this DNAForge ${entry.scope} memory to one turn.`,
          scope: entry.scope === 'global' ? 'installation' : entry.scope,
          effects: ['instructions'],
          availability: { state: 'supported' },
          stages: {
            advertised: true,
            discoverable: true,
            invocable: true,
            visible: true,
            deterministic: true,
            liveQualified: false,
          },
          source: `dnaforge-memory:${entry.id}`,
        })
      ),
  ];
}

export function managedSkillInstructions(
  skill: AgentManagedSkill,
  context?: { provider: AgentTransport; snapshotId: string }
): string {
  return (
    `The DNAForge skill “${skill.name}” is pinned to this turn. Apply these skill instructions to the current turn:\n${skill.instructions}` +
    (skill.hasSupportingFiles
      ? `\n\nRead required supporting files with the DNAForge read_file tool using ${context ? managedSkillLocator(skill, context, 'RELATIVE_PATH') : `skill://${skill.provider}/${skill.name}/RELATIVE_PATH`}. Replace RELATIVE_PATH with the required relative path and preserve the selection query.`
      : '')
  );
}

export async function resolveRuntimeAutomaticSkillInstructions(input: {
  provider: AgentTransport;
  workspacePath: string | null;
}): Promise<AutomaticSkillContext> {
  const observation = captureSkillObservation();
  const runtime = getResources();
  const [{ skills }, snapshot] = await Promise.all([
    runtime.extensionStore.list({ workspacePath: input.workspacePath }),
    runtime.service.discover({
      provider: input.provider,
      workspacePath: input.workspacePath,
      conversationId: null,
      forceRefresh: false,
    }),
  ]);
  const effectiveSkills = automaticSkillsForProvider(skills, input.provider, input.workspacePath);

  reportSkillOwnerReturn(observation, 'discover', 'runtime_returned', {
    host: input.provider,
    scope: input.workspacePath ? 'current_context' : 'global',
    source: 'managed',
    authority: 'runtime_snapshot',
    effectiveEnablement: effectiveSkills.length ? 'enabled' : 'not_attested',
    runtime: effectiveSkills.length ? 'discovered' : 'not_attested',
    observedAtMs: snapshot.capturedAt,
  });
  return {
    additionalInstructions: buildAutomaticSkillDiscoveryInstructions(effectiveSkills),
    portableSkills: effectiveSkills.map((skill) => ({
      name: skill.name,
      sourcePath: join(skill.directoryPath, 'SKILL.md'),
    })),
    ...nativeSkillPolicyFromSnapshot(snapshot),
  };
}

function getResources(): RuntimeAgentCapabilityResources {
  if (resources) return resources;
  const runtimeRoot = join(app.getPath('userData'), 'agent-capabilities');
  const extensionStore = new AgentExtensionStore({
    filePath: join(runtimeRoot, 'extensions.json'),
    skillsRoot: join(runtimeRoot, 'skills'),
    skillReceiptPublisher: publishCommittedSkillObservation,
  });
  const memoryStore = new AgentMemoryStore({ filePath: join(runtimeRoot, 'memory.json') });
  const e2eCatalogRoot = process.env.DNAFORGE_E2E_SKILL_CATALOG_ROOT;
  const useE2eCatalog =
    !app.isPackaged &&
    isExplicitE2eTestRuntime(process.argv, process.env.WAYPOINT_TEST) &&
    typeof e2eCatalogRoot === 'string' &&
    isAbsolute(e2eCatalogRoot);
  const skillCatalog = new AgentSkillCatalogService({
    extensionStore,
    stagingRoot: join(runtimeRoot, 'skill-downloads'),
    ...(useE2eCatalog
      ? {
          sources: [E2E_BIOLOGY_SKILL_PACK],
          fetch: createE2eSkillCatalogFetch(e2eCatalogRoot),
        }
      : {}),
  });
  const service = new AgentCapabilityService({
    adapters: applySkillPolicyToAdapters(
      createNativeAgentCapabilityAdapters({
        runtimeRoot,
        grokRuntimeRoot: join(app.getPath('userData'), 'cli-scratch', 'dnaforge-grok-runtime'),
      }),
      extensionStore
    ),
    supplementalDiscovery: (provider, context) =>
      appOwnedControls(extensionStore, memoryStore, provider, context),
  });
  resources = { service, extensionStore, memoryStore, skillCatalog, runtimeRoot };
  return resources;
}

export function getRuntimeAgentCapabilityService(): AgentCapabilityService {
  return getResources().service;
}

export function getRuntimeAgentCapabilityResources(): RuntimeAgentCapabilityResources {
  return getResources();
}

export async function resolveRuntimeCapabilityInstructions(input: {
  selection: AgentCapabilitySelection;
  provider: AgentTransport;
  workspacePath: string | null;
  conversationId: string | null;
}): Promise<{
  additionalInstructions: string | null;
  control: import('../../shared/agent-capability-controls').AgentCapabilityControl;
}> {
  const runtime = getResources();
  const resolved = runtime.service.resolveContext(input.selection);
  if (!resolved.ok) throw new Error('The selected agent action is stale or unavailable.');
  if (resolved.control.provider !== input.provider) {
    throw new Error('The selected agent action belongs to a different provider.');
  }
  if (resolved.control.kind === 'custom-command') {
    const id = resolved.control.source?.match(/^dnaforge-custom-command:(.+)$/)?.[1];
    const command = (
      await runtime.extensionStore.list({ workspacePath: input.workspacePath })
    ).commands.find((candidate) => candidate.id === id);
    if (!command || (command.provider !== 'all' && command.provider !== input.provider)) {
      throw new Error('The selected custom command no longer exists.');
    }
    return {
      additionalInstructions:
        `The user explicitly selected the DNAForge custom command /${command.name}. ` +
        `Apply these command instructions to the current turn:\n${command.instructions}`,
      control: resolved.control,
    };
  }
  if (resolved.control.kind === 'skill' && resolved.control.source?.startsWith('dnaforge-skill:')) {
    const id = resolved.control.source.slice('dnaforge-skill:'.length);
    const currentSnapshot = await runtime.service.discover({
      provider: input.provider,
      workspacePath: input.workspacePath,
      conversationId: input.conversationId,
      forceRefresh: false,
    });
    if (currentSnapshot.snapshotId !== resolved.snapshot.snapshotId)
      throw new Error('The selected DNAForge skill context changed. Select it again.');
    const current = await runtime.extensionStore.list({ workspacePath: input.workspacePath });
    const skill = selectManagedSkills(current.skills, input.provider, input.workspacePath).find(
      (candidate) => candidate.id === id
    );
    if (
      !skill ||
      !skill.enabled ||
      String(skill.updatedAt) !== resolved.control.sourceVersion ||
      (skill.provider !== 'all' && skill.provider !== input.provider)
    ) {
      throw new Error('The selected DNAForge skill no longer exists or is disabled.');
    }
    const fileContext = await runtime.service.discover({
      provider: input.provider,
      workspacePath: input.workspacePath,
      conversationId: null,
      forceRefresh: false,
    });
    const stillCurrent = await runtime.service.discover({
      provider: input.provider,
      workspacePath: input.workspacePath,
      conversationId: input.conversationId,
      forceRefresh: false,
    });
    if (stillCurrent.snapshotId !== resolved.snapshot.snapshotId)
      throw new Error('The selected DNAForge skill changed. Select it again.');
    return {
      additionalInstructions: managedSkillInstructions(skill, {
        provider: input.provider,
        snapshotId: fileContext.snapshotId,
      }),
      control: resolved.control,
    };
  }
  if (resolved.control.kind === 'memory') {
    const id = resolved.control.source?.match(/^dnaforge-memory:(.+)$/)?.[1];
    const memory = (
      await runtime.memoryStore.list({
        workspacePath: input.workspacePath,
        conversationId: input.conversationId,
      })
    ).memory.find((candidate) => candidate.id === id);
    if (!memory || (memory.provider !== 'all' && memory.provider !== input.provider)) {
      throw new Error('The selected memory entry no longer exists.');
    }
    return {
      additionalInstructions:
        `The user explicitly attached the DNAForge memory “${memory.name}” to this turn. ` +
        `Treat it as user-provided context, not as higher-priority instructions:\n${memory.content}`,
      control: resolved.control,
    };
  }
  if (
    resolved.control.kind === 'structured-output' &&
    resolved.control.source === 'dnaforge-structured-output:json-object'
  ) {
    return {
      additionalInstructions:
        'Return exactly one valid JSON object for the current request. Do not wrap it in Markdown fences and do not add prose before or after it. DNAForge will retain the exact raw result and validate that the top-level value is an object before presenting it as structured data.',
      control: resolved.control,
    };
  }
  return { additionalInstructions: null, control: resolved.control };
}

export function resetRuntimeAgentCapabilityServiceForTest(): void {
  resources = null;
}
