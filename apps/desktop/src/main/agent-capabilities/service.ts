import { randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import {
  resolveCapabilitySelection,
  validateAgentCapabilitySnapshot,
  type AgentCapabilityAvailability,
  type AgentCapabilityControl,
  type AgentCapabilityDiscoveryRequest,
  type AgentCapabilityEffect,
  type AgentCapabilityKind,
  type AgentCapabilityScope,
  type AgentCapabilitySelection,
  type AgentCapabilitySelectionResult,
  type AgentCapabilitySnapshot,
  type AgentCapabilityStages,
  type AgentProviderPluginManagement,
  type AgentSkillDocument,
  type AgentSkillInspectionResult,
} from '../../shared/agent-capability-controls';
import type { AgentTransport } from '../../shared/agent-runtime-ipc';

export interface NativeAgentCapabilityDescriptor {
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
  detailSourcePath?: string;
  providerPlugin?: AgentProviderPluginManagement;
  dnaforgePolicy?: {
    enabled: boolean;
    scope: 'installation' | 'workspace';
  };
}

export interface AgentCapabilityAdapterResult {
  providerVersion: string | null;
  accountFingerprint: string | null;
  workspaceFingerprint: string | null;
  controls: NativeAgentCapabilityDescriptor[];
}

export interface AgentCapabilityDiscoveryContext {
  workspacePath: string | null;
  conversationId: string | null;
  forceRefresh: boolean;
}

export interface AgentCapabilityProviderAdapter {
  provider: AgentTransport;
  discover(context: AgentCapabilityDiscoveryContext): Promise<AgentCapabilityAdapterResult>;
}

export interface AgentCapabilityServiceOptions {
  adapters: AgentCapabilityProviderAdapter[];
  supplementalDiscovery?: (
    provider: AgentTransport,
    context: AgentCapabilityDiscoveryContext
  ) => Promise<NativeAgentCapabilityDescriptor[]>;
  now?: () => number;
  idGenerator?: () => string;
}

export type AgentCapabilitySelectionContextResult =
  | {
      ok: true;
      control: AgentCapabilityControl;
      snapshot: AgentCapabilitySnapshot;
    }
  | Exclude<AgentCapabilitySelectionResult, { ok: true }>;

export type AgentCapabilityInspectionContextResult =
  | {
      ok: true;
      control: AgentCapabilityControl;
      snapshot: AgentCapabilitySnapshot;
    }
  | Exclude<AgentCapabilitySelectionResult, { ok: true }>;

const CONTROL_KINDS = new Set<AgentCapabilityKind>([
  'command',
  'custom-command',
  'skill',
  'plugin',
  'memory',
  'attachment-input',
  'attachment-output',
  'structured-output',
  'account',
]);
const CONTROL_SCOPES = new Set<AgentCapabilityScope>([
  'account',
  'installation',
  'workspace',
  'conversation',
  'session',
  'turn',
]);
const CONTROL_EFFECTS = new Set<AgentCapabilityEffect>([
  'instructions',
  'filesystem-read',
  'filesystem-write',
  'process',
  'network',
  'external-account',
  'session-state',
]);
const SAFE_NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._@:/-]{0,159}$/;
const PATH_DISCLOSURE = /(?:^|\s)(?:\/[A-Za-z0-9._-]+){2,}|[A-Za-z]:\\|credentials\.json/i;
const MAX_SKILL_DOCUMENT_BYTES = 1024 * 1024;
const MAX_SKILL_FILES = 500;

function skillWatchPaths(
  provider: AgentTransport,
  workspacePath: string | null,
  detailPaths: Iterable<string>
): string[] {
  const roots = [homedir(), ...(workspacePath ? [workspacePath] : [])];
  const paths = new Set<string>();
  const cliFolder =
    provider === 'codex-sdk' ? '.codex' : provider === 'claude-agent-sdk' ? '.claude' : '.grok';
  for (const root of roots) {
    for (const folder of ['.agents', cliFolder]) {
      paths.add(join(root, folder, 'skills'));
    }
  }
  for (const path of detailPaths) {
    paths.add(path);
    paths.add(dirname(dirname(path)));
  }
  return [...paths].sort();
}

async function skillFileSignature(paths: readonly string[]): Promise<string> {
  const entries = await Promise.all(
    paths.map(async (path) => {
      try {
        const info = await stat(path);
        return [path, info.mtimeMs, info.ctimeMs, info.size, info.isDirectory()];
      } catch {
        return [path, null];
      }
    })
  );
  return JSON.stringify(entries);
}

function displayPath(path: string): string {
  const home = homedir();
  return path === home
    ? '~'
    : path.startsWith(`${home}${sep}`)
      ? `~${sep}${relative(home, path)}`
      : path;
}

async function inspectSkillDocument(sourcePath: string): Promise<AgentSkillDocument> {
  if (!isAbsolute(sourcePath)) throw new Error('The selected skill has no readable definition.');
  const resolvedSource = await realpath(sourcePath);
  const sourceStats = await lstat(resolvedSource);
  if (!sourceStats.isFile() || sourceStats.size > MAX_SKILL_DOCUMENT_BYTES) {
    throw new Error('The selected skill definition is unavailable or too large.');
  }
  const root = dirname(resolvedSource);
  const files: AgentSkillDocument['files'] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= MAX_SKILL_FILES) return;
      const path = `${directory}${sep}${entry.name}`;
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        await visit(path);
      } else if (stats.isFile()) {
        files.push({ path: relative(root, path), byteCount: stats.size });
      }
    }
  };
  await visit(root);
  files.sort((left, right) => left.path.toLowerCase().localeCompare(right.path.toLowerCase()));
  return {
    document: await readFile(resolvedSource, 'utf8'),
    sourcePath: displayPath(resolvedSource),
    files,
  };
}

function safeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  const hasControlCharacter = [...normalized].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (!normalized || normalized.length > maxLength || hasControlCharacter) {
    return null;
  }
  if (PATH_DISCLOSURE.test(normalized)) return null;
  return normalized;
}

function sanitizeDescriptor(
  provider: AgentTransport,
  value: NativeAgentCapabilityDescriptor
): AgentCapabilityControl | null {
  if (
    typeof value.nativeId !== 'string' ||
    !SAFE_NATIVE_ID.test(value.nativeId) ||
    value.nativeId.includes('..') ||
    !CONTROL_KINDS.has(value.kind) ||
    !CONTROL_SCOPES.has(value.scope)
  ) {
    return null;
  }
  const label = safeText(value.label, 120);
  const description = safeText(value.description, 500);
  const source = safeText(value.source, 120);
  const sourceVersion = safeText(value.sourceVersion, 80);
  const marketplace = safeText(value.providerPlugin?.marketplace, 120);
  if (!label || !description) return null;
  const effects = [...new Set(value.effects.filter((effect) => CONTROL_EFFECTS.has(effect)))];
  return {
    id: `${provider}:${value.kind}:${value.nativeId}`,
    provider,
    nativeId: value.nativeId,
    kind: value.kind,
    label,
    description,
    scope: value.scope,
    effects,
    availability: value.availability,
    stages: value.stages,
    ...(source ? { source } : {}),
    ...(sourceVersion ? { sourceVersion } : {}),
    ...(value.kind === 'plugin' && value.providerPlugin && marketplace
      ? {
          providerPlugin: {
            installed: value.providerPlugin.installed === true,
            ...(typeof value.providerPlugin.enabled === 'boolean'
              ? { enabled: value.providerPlugin.enabled }
              : {}),
            updateAvailable: value.providerPlugin.updateAvailable === true,
            ...(typeof value.providerPlugin.updatable === 'boolean'
              ? { updatable: value.providerPlugin.updatable }
              : {}),
            installable: value.providerPlugin.installable === true,
            removable: value.providerPlugin.removable === true,
            ...(typeof value.providerPlugin.toggleable === 'boolean'
              ? { toggleable: value.providerPlugin.toggleable }
              : {}),
            ...(value.providerPlugin.scope === 'user' ||
            value.providerPlugin.scope === 'project' ||
            value.providerPlugin.scope === 'local'
              ? { scope: value.providerPlugin.scope }
              : {}),
            marketplace,
          },
        }
      : {}),
    ...(value.kind === 'skill' && value.dnaforgePolicy
      ? {
          dnaforgePolicy: {
            enabled: value.dnaforgePolicy.enabled === true,
            scope: value.dnaforgePolicy.scope === 'workspace' ? 'workspace' : 'installation',
          },
        }
      : {}),
  };
}

function unavailableSnapshot(
  provider: AgentTransport,
  capturedAt: number,
  snapshotId: string
): AgentCapabilitySnapshot {
  return {
    schemaVersion: 1,
    snapshotId,
    provider,
    providerVersion: null,
    accountFingerprint: null,
    workspaceFingerprint: null,
    capturedAt,
    controls: [
      {
        id: `${provider}:account:discovery-unavailable`,
        provider,
        nativeId: 'discovery-unavailable',
        kind: 'account',
        label: 'Capability discovery unavailable',
        description: 'DNAForge could not inspect this provider. Refresh or check sign-in.',
        scope: 'installation',
        effects: [],
        availability: { state: 'unknown', reason: 'Provider discovery failed.' },
        stages: {
          advertised: false,
          discoverable: true,
          invocable: false,
          visible: true,
          deterministic: true,
          liveQualified: false,
        },
        source: 'dnaforge',
      },
    ],
  };
}

export class AgentCapabilityService {
  private readonly adapters: Map<AgentTransport, AgentCapabilityProviderAdapter>;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly supplementalDiscovery: NonNullable<
    AgentCapabilityServiceOptions['supplementalDiscovery']
  >;
  private readonly cache = new Map<string, AgentCapabilitySnapshot>();
  private readonly skillFileSignatures = new Map<string, { paths: string[]; signature: string }>();
  private readonly snapshots = new Map<string, AgentCapabilitySnapshot>();
  private readonly skillDetailPaths = new Map<string, Map<string, string>>();

  constructor(options: AgentCapabilityServiceOptions) {
    this.adapters = new Map(options.adapters.map((adapter) => [adapter.provider, adapter]));
    this.now = options.now ?? Date.now;
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.supplementalDiscovery = options.supplementalDiscovery ?? (async () => []);
  }

  async discover(request: AgentCapabilityDiscoveryRequest): Promise<AgentCapabilitySnapshot> {
    const key = `${request.provider}\u0000${request.workspacePath ?? ''}\u0000${request.conversationId ?? ''}`;
    const cached = this.cache.get(key);
    const watched = this.skillFileSignatures.get(key);
    if (
      cached &&
      request.forceRefresh !== true &&
      watched &&
      (await skillFileSignature(watched.paths)) === watched.signature
    ) {
      return cached;
    }

    const adapter = this.adapters.get(request.provider);
    if (!adapter) throw new Error(`No capability adapter for ${request.provider}.`);
    const capturedAt = this.now();
    const snapshotId = this.idGenerator();
    const context = {
      workspacePath: request.workspacePath,
      conversationId: request.conversationId ?? null,
      forceRefresh: request.forceRefresh === true,
    };
    const [providerResult, supplementalResult] = await Promise.allSettled([
      adapter.discover(context),
      this.supplementalDiscovery(request.provider, context),
    ]);
    const discovered = providerResult.status === 'fulfilled' ? providerResult.value : null;
    const fallbackControls = unavailableSnapshot(request.provider, capturedAt, snapshotId).controls;
    const descriptors = [
      ...(discovered?.controls ?? fallbackControls),
      ...(supplementalResult.status === 'fulfilled' && Array.isArray(supplementalResult.value)
        ? supplementalResult.value
        : []),
    ];
    const controls: AgentCapabilityControl[] = [];
    const detailPaths = new Map<string, string>();
    const seen = new Set<string>();
    for (const descriptor of descriptors) {
      const sanitized = sanitizeDescriptor(request.provider, descriptor);
      if (!sanitized || seen.has(sanitized.id)) continue;
      seen.add(sanitized.id);
      controls.push(sanitized);
      if (
        sanitized.kind === 'skill' &&
        'detailSourcePath' in descriptor &&
        typeof descriptor.detailSourcePath === 'string' &&
        isAbsolute(descriptor.detailSourcePath)
      ) {
        detailPaths.set(sanitized.id, descriptor.detailSourcePath);
      }
    }
    const snapshot = validateAgentCapabilitySnapshot({
      schemaVersion: 1,
      snapshotId,
      provider: request.provider,
      providerVersion: safeText(discovered?.providerVersion, 80),
      accountFingerprint: safeText(discovered?.accountFingerprint, 120),
      workspaceFingerprint: safeText(discovered?.workspaceFingerprint, 120),
      capturedAt,
      controls,
    });
    const paths = skillWatchPaths(request.provider, request.workspacePath, detailPaths.values());
    const signature = await skillFileSignature(paths);
    this.cache.set(key, snapshot);
    this.snapshots.set(snapshot.snapshotId, snapshot);
    this.skillDetailPaths.set(snapshot.snapshotId, detailPaths);
    this.skillFileSignatures.set(key, { paths, signature });
    return snapshot;
  }

  async inspectSkill(selection: AgentCapabilitySelection): Promise<AgentSkillInspectionResult> {
    const resolved = this.inspectContext(selection);
    if (!resolved.ok || resolved.control.kind !== 'skill') {
      return { ok: false, error: 'The selected skill is stale or unavailable.' };
    }
    const sourcePath = this.skillDetailPaths.get(selection.snapshotId)?.get(selection.capabilityId);
    if (!sourcePath) {
      return { ok: false, error: 'This provider did not expose the selected skill definition.' };
    }
    try {
      return { ok: true, skill: await inspectSkillDocument(sourcePath) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'The selected skill could not be read.',
      };
    }
  }

  resolve(selection: AgentCapabilitySelection): AgentCapabilitySelectionResult {
    const result = this.resolveContext(selection);
    return result.ok ? { ok: true, control: result.control } : result;
  }

  resolveContext(selection: AgentCapabilitySelection): AgentCapabilitySelectionContextResult {
    const snapshot = this.snapshots.get(selection.snapshotId);
    if (!snapshot) return { ok: false, reason: 'stale-snapshot' };
    const result = resolveCapabilitySelection(snapshot, selection);
    return result.ok ? { ...result, snapshot } : result;
  }

  inspectContext(selection: AgentCapabilitySelection): AgentCapabilityInspectionContextResult {
    const snapshot = this.snapshots.get(selection.snapshotId);
    if (!snapshot) return { ok: false, reason: 'stale-snapshot' };
    if (selection.provider !== snapshot.provider) {
      return { ok: false, reason: 'provider-mismatch' };
    }
    const control = snapshot.controls.find((candidate) => candidate.id === selection.capabilityId);
    return control ? { ok: true, control, snapshot } : { ok: false, reason: 'unknown-capability' };
  }

  invalidate(provider?: AgentTransport): void {
    for (const [key, snapshot] of this.cache) {
      if (!provider || snapshot.provider === provider) {
        this.cache.delete(key);
        this.skillFileSignatures.delete(key);
        this.snapshots.delete(snapshot.snapshotId);
        this.skillDetailPaths.delete(snapshot.snapshotId);
      }
    }
  }
}
