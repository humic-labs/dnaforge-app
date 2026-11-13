import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';

import type { AgentCapabilityStages } from '../../shared/agent-capability-controls';
import type { AgentCapabilityProviderAdapter, NativeAgentCapabilityDescriptor } from './service';
import { detectClaudeCode, detectCodex, detectGrok } from '../agent-sdk/detect';
import { getCliVersion } from '../agent-sdk/probe';
import { claudeCliEnv } from '../agent-sdk/subprocess-env';
import { launchLocalCodexAppServer } from '../agent-sdk/local-codex-app-server';
import { openGrokAcpClient } from '../agent-sdk/grok-acp';
import {
  grokExternalPluginControlId,
  grokMemoryClearSupported,
  grokPluginControlId,
  listGrokCapabilityCatalog,
  listClaudePluginCatalog,
  relevantClaudeInstalledPlugins,
  type ClaudePluginCatalog,
  type GrokCapabilityCatalog,
} from './provider-operations';

interface ClaudeCommandLike {
  name?: unknown;
  description?: unknown;
  argumentHint?: unknown;
  aliases?: unknown;
}

interface CodexCatalogInput {
  skills: unknown;
  plugins: unknown;
  memoryResetSupported?: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(record).filter((entry): entry is Record<string, unknown> => entry !== null)
    : [];
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function displayText(value: unknown, maxLength = 480): string | null {
  const normalized = text(value);
  if (!normalized) return null;
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}\u2026`;
}

function nativeId(value: unknown): string | null {
  const normalized = text(value)?.replace(/^\/+/, '');
  return normalized && /^[A-Za-z0-9][A-Za-z0-9._@:/-]{0,159}$/.test(normalized) ? normalized : null;
}

function stages(invocable: boolean): AgentCapabilityStages {
  return {
    advertised: true,
    discoverable: true,
    invocable,
    visible: true,
    deterministic: true,
    liveQualified: false,
  };
}

export function mapClaudeCommands(
  commands: ClaudeCommandLike[],
  skillNames: readonly string[] = [],
  skillPaths: ReadonlyMap<string, string> = new Map()
): NativeAgentCapabilityDescriptor[] {
  const skills = new Set(skillNames);
  return commands.flatMap((command) => {
    const id = nativeId(command.name);
    const description = text(command.description);
    if (!id || !description) return [];
    const hint = text(command.argumentHint);
    return [
      {
        nativeId: id,
        kind: skills.has(id) ? 'skill' : 'command',
        label: skills.has(id) ? id : `/${id}`,
        description: hint ? `${description} Arguments: ${hint}` : description,
        scope: 'session',
        effects: ['instructions'],
        availability: { state: 'supported' },
        stages: stages(true),
        source: skills.has(id) ? 'claude-supportedSkills' : 'claude-supportedCommands',
        ...(skills.has(id) && skillPaths.has(id) ? { detailSourcePath: skillPaths.get(id)! } : {}),
      },
    ];
  });
}

export function mapClaudePlugins(
  catalog: ClaudePluginCatalog,
  cwd: string | null
): NativeAgentCapabilityDescriptor[] {
  const installedById = new Map(
    relevantClaudeInstalledPlugins(catalog.installed, cwd).flatMap((plugin) => {
      const id = nativeId(plugin.id);
      return id ? [[id, plugin] as const] : [];
    })
  );
  const availableById = new Map(
    catalog.available.flatMap((plugin) => {
      const id = nativeId(plugin.pluginId);
      return id ? [[id, plugin] as const] : [];
    })
  );
  return [...new Set([...installedById.keys(), ...availableById.keys()])].flatMap((id) => {
    const installed = installedById.get(id) ?? null;
    const available = availableById.get(id) ?? null;
    const label = text(available?.name) ?? id.split('@')[0] ?? id;
    const description =
      displayText(available?.description) ??
      `${installed ? 'Installed' : 'Available'} Claude plugin${text(installed?.version) ? `, version ${text(installed?.version)}` : ''}.`;
    const scope = installed?.scope;
    const errors = Array.isArray(installed?.errors) ? installed.errors.filter(Boolean) : [];
    const enabled = installed ? installed.enabled !== false : false;
    const invocable = Boolean(installed && enabled && errors.length === 0);
    const marketplace = text(available?.marketplaceName) ?? id.split('@')[1] ?? 'Claude';
    return [
      {
        nativeId: id,
        kind: 'plugin',
        label,
        description,
        scope: scope === 'local' || scope === 'project' ? 'workspace' : 'installation',
        effects: ['instructions', 'filesystem-read', 'process', 'network'],
        availability:
          errors.length > 0
            ? {
                state: 'disabled-by-policy',
                reason: `Claude reported ${errors.length} plugin load ${errors.length === 1 ? 'error' : 'errors'}.`,
              }
            : invocable
              ? { state: 'supported' }
              : {
                  state: 'disabled-by-policy',
                  reason: installed
                    ? 'This Claude plugin is disabled.'
                    : 'Install this Claude plugin before selecting it for a turn.',
                },
        stages: stages(invocable),
        source: 'claude-plugin-list',
        ...(text(installed?.version) ? { sourceVersion: text(installed?.version)! } : {}),
        providerPlugin: {
          installed: installed !== null,
          enabled,
          updateAvailable: false,
          updatable: installed !== null && available !== null,
          installable: available !== null,
          removable: installed !== null,
          toggleable: installed !== null,
          ...(scope === 'user' || scope === 'project' || scope === 'local' ? { scope } : {}),
          marketplace,
        },
      },
    ];
  });
}

function mapClaudeMemory(memoryFiles: unknown): NativeAgentCapabilityDescriptor[] {
  return records(memoryFiles).flatMap((memory) => {
    const path = text(memory.path);
    if (!path) return [];
    const id = `memory-${createHash('sha256').update(path).digest('hex').slice(0, 16)}`;
    return [
      {
        nativeId: id,
        kind: 'memory',
        label: basename(path),
        description: `Claude memory currently loaded for this ${memory.type === 'user' ? 'account' : 'workspace'}.`,
        scope: memory.type === 'user' ? 'account' : 'workspace',
        effects: ['instructions', 'filesystem-read'],
        availability: { state: 'supported' },
        stages: stages(false),
        source: 'claude-context-memory',
      },
    ];
  });
}

async function discoverClaudeSkillPaths(
  cwd: string,
  plugins: ClaudePluginCatalog
): Promise<Map<string, string>> {
  const installedPaths = relevantClaudeInstalledPlugins(plugins.installed, cwd).flatMap(
    (plugin) => {
      const installPath = text(plugin.installPath);
      return installPath ? [join(installPath, 'skills')] : [];
    }
  );
  const roots = [
    ...installedPaths,
    join(homedir(), '.claude', 'skills'),
    join(cwd, '.claude', 'skills'),
  ];
  const discovered = await Promise.all(
    roots.map(async (root) => {
      try {
        return (await readdir(root, { withFileTypes: true })).flatMap((entry) =>
          entry.isDirectory() && nativeId(entry.name)
            ? ([[entry.name, join(root, entry.name, 'SKILL.md')]] as const)
            : []
        );
      } catch {
        return [];
      }
    })
  );
  const paths = new Map<string, string>();
  for (const [name, path] of discovered.flat()) paths.set(name, path);
  return paths;
}

export function mapCodexCatalog(input: CodexCatalogInput): NativeAgentCapabilityDescriptor[] {
  const controls: NativeAgentCapabilityDescriptor[] = [];
  const skillGroups = records(record(input.skills)?.data);
  for (const group of skillGroups) {
    for (const skill of records(group.skills)) {
      const id = nativeId(skill.name);
      const description = text(skill.description) ?? text(skill.shortDescription);
      if (!id || !description) continue;
      const enabled = skill.enabled !== false;
      controls.push({
        nativeId: id,
        kind: 'skill',
        label: id,
        description,
        scope: skill.scope === 'user' ? 'installation' : 'workspace',
        effects: ['instructions', 'filesystem-read'],
        availability: enabled
          ? { state: 'supported' }
          : { state: 'disabled-by-policy', reason: 'This skill is disabled in Codex.' },
        stages: stages(enabled),
        source: 'codex-skills-list',
        ...(text(skill.path) && isAbsolute(text(skill.path)!)
          ? {
              detailSourcePath: text(skill.path)!.endsWith('SKILL.md')
                ? text(skill.path)!
                : join(text(skill.path)!, 'SKILL.md'),
            }
          : {}),
      });
    }
  }

  for (const marketplace of records(record(input.plugins)?.marketplaces)) {
    const marketplaceName = text(marketplace.name) ?? 'Codex marketplace';
    for (const plugin of records(marketplace.plugins)) {
      const id = nativeId(plugin.id);
      const label = text(plugin.name);
      if (!id || !label) continue;
      const installed = plugin.installed === true;
      const currentVersion = text(plugin.localVersion);
      const availableVersion = text(plugin.version);
      const version = currentVersion ?? availableVersion;
      const updateAvailable = Boolean(
        installed && currentVersion && availableVersion && currentVersion !== availableVersion
      );
      const installable =
        plugin.availability !== 'DISABLED_BY_ADMIN' && plugin.installPolicy !== 'NOT_AVAILABLE';
      controls.push({
        nativeId: id,
        kind: 'plugin',
        label,
        description: `${installed ? 'Installed' : 'Available'} Codex plugin${version ? `, version ${version}` : ''}.`,
        scope: 'installation',
        effects: ['instructions', 'filesystem-read', 'process', 'network'],
        availability: {
          state: 'disabled-by-policy',
          reason: 'Installed provider plugins stay isolated until explicitly enabled for DNAForge.',
        },
        stages: stages(false),
        source: 'codex-plugin-list',
        ...(version ? { sourceVersion: version } : {}),
        providerPlugin: {
          installed,
          updateAvailable,
          installable,
          removable: installed,
          marketplace: marketplaceName,
        },
      });
    }
  }

  if (input.memoryResetSupported) {
    controls.push({
      nativeId: 'reset',
      kind: 'memory',
      label: 'Reset Codex memory',
      description: 'Clear provider-native Codex memory. DNAForge memory is managed separately.',
      scope: 'account',
      effects: ['external-account'],
      availability: { state: 'supported' },
      stages: stages(false),
      source: 'codex-memory-reset',
    });
  }
  return controls;
}

function grokCommands(meta: Record<string, unknown> | null): NativeAgentCapabilityDescriptor[] {
  return records(meta?.availableCommands).flatMap((command) => {
    const id = nativeId(command.name) ?? nativeId(command.command);
    const description = text(command.description);
    if (!id || !description) return [];
    const hint = text(command.input) ?? text(command.argumentHint);
    return [
      {
        nativeId: id,
        kind: 'command',
        label: `/${id}`,
        description: hint ? `${description} Arguments: ${hint}` : description,
        scope: 'session',
        effects: ['instructions'],
        availability: { state: 'supported' },
        stages: stages(true),
        source: 'grok-acp-availableCommands',
      },
    ];
  });
}

export function mapGrokInitializeCapabilities(
  initialized: unknown
): NativeAgentCapabilityDescriptor[] {
  const root = record(initialized);
  const capabilities = record(root?.agentCapabilities);
  const controls = grokCommands(record(root?._meta));

  const prompt = record(capabilities?.promptCapabilities);
  if (prompt?.image === true) {
    controls.push({
      nativeId: 'image',
      kind: 'attachment-input',
      label: 'Image input',
      description: 'Attach an image to a Grok ACP prompt.',
      scope: 'turn',
      effects: ['filesystem-read'],
      availability: { state: 'supported' },
      stages: stages(false),
      source: 'grok-acp-capabilities',
    });
  }
  if (prompt?.audio === true) {
    controls.push({
      nativeId: 'audio',
      kind: 'attachment-input',
      label: 'Audio input',
      description: 'Attach audio to a Grok ACP prompt.',
      scope: 'turn',
      effects: ['filesystem-read'],
      availability: { state: 'supported' },
      stages: stages(false),
      source: 'grok-acp-capabilities',
    });
  }
  return controls;
}

function grokInspectionPlugins(catalog: GrokCapabilityCatalog): Record<string, unknown>[] {
  return records(catalog.inspection.plugins);
}

function grokInspectionPluginForInstalled(
  installed: Record<string, unknown>,
  catalog: GrokCapabilityCatalog
): Record<string, unknown> | null {
  const name = text(installed.name);
  const installedPath = text(installed.path);
  return (
    grokInspectionPlugins(catalog).find((candidate) => {
      if (text(candidate.name) !== name) return false;
      const path = text(candidate.path);
      return (
        !installedPath || !path || path === installedPath || path.startsWith(`${installedPath}/`)
      );
    }) ?? null
  );
}

function grokComponentCountDescription(plugin: Record<string, unknown>): string {
  const components = record(plugin.components);
  if (!components) return '';
  const counts = [
    ['skill', records(components.skills).length],
    ['command', records(components.commands).length],
    ['agent', records(components.agents).length],
    ['MCP server', records(components.mcpServers).length],
    ['hook', records(components.hooks).length],
  ] as const;
  const available = counts
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${count} ${label}${count === 1 ? '' : 's'}`);
  return available.length > 0 ? ` Includes ${available.join(', ')}.` : '';
}

export function mapGrokInspectionCapabilities(
  catalog: GrokCapabilityCatalog,
  options: { workspaceMemoryResetSupported?: boolean } = {}
): NativeAgentCapabilityDescriptor[] {
  const controls: NativeAgentCapabilityDescriptor[] = [];
  const inspectedPlugins = grokInspectionPlugins(catalog);

  for (const skill of records(catalog.inspection.skills)) {
    const source = record(skill.source);
    const sourcePath = text(source?.path);
    if (!sourcePath?.endsWith('SKILL.md')) continue;
    const name = nativeId(skill.invocableAs) ?? nativeId(skill.name);
    const description = displayText(skill.description);
    if (!name || !description || skill.userInvocable !== true) continue;
    const disabled = skill.disabled === true || (skill.collidesWith != null && !skill.invocableAs);
    controls.push({
      nativeId: name,
      kind: 'skill',
      label: text(skill.name) ?? name,
      description,
      scope: source?.type === 'user' ? 'installation' : 'workspace',
      effects: ['instructions', 'filesystem-read'],
      availability: disabled
        ? {
            state: 'disabled-by-policy',
            reason:
              skill.disabled === true
                ? 'This skill is disabled in Grok.'
                : 'This Grok skill has an unresolved slash-command name collision.',
          }
        : { state: 'supported' },
      stages: stages(!disabled),
      source: 'grok-inspect-skills',
      detailSourcePath: sourcePath,
    });
  }

  const installedById = new Map(
    catalog.installed.flatMap((plugin) => {
      const id = grokPluginControlId(plugin);
      return id ? [[id, plugin] as const] : [];
    })
  );
  const availableById = new Map(
    catalog.available.flatMap((plugin) => {
      const id = grokPluginControlId(plugin);
      return id ? [[id, plugin] as const] : [];
    })
  );
  const mappedInspectionPaths = new Set<string>();
  for (const id of new Set([...installedById.keys(), ...availableById.keys()])) {
    const installed = installedById.get(id) ?? null;
    const available = availableById.get(id) ?? null;
    const inspected = installed ? grokInspectionPluginForInstalled(installed, catalog) : null;
    const inspectedPath = text(inspected?.path);
    if (inspectedPath) mappedInspectionPaths.add(inspectedPath);
    const name = text(installed?.name) ?? text(available?.name);
    if (!name) continue;
    const enabled = installed !== null && inspected?.enabled === true;
    const currentVersion = text(installed?.version);
    const availableVersion = text(available?.version);
    const version = currentVersion ?? availableVersion;
    const marketplace =
      text(installed?.marketplace) ?? text(available?.marketplace) ?? 'Direct Grok install';
    controls.push({
      nativeId: id,
      kind: 'plugin',
      label: name,
      description:
        displayText(available?.description) ??
        `${installed ? 'Installed' : 'Available'} Grok plugin${version ? `, version ${version}` : ''}.${available ? grokComponentCountDescription(available) : ''}`,
      scope: inspected?.scope === 'project' ? 'workspace' : 'installation',
      effects: ['instructions', 'filesystem-read', 'process', 'network'],
      availability: enabled
        ? { state: 'supported' }
        : {
            state: 'disabled-by-policy',
            reason: installed
              ? 'This Grok plugin is disabled.'
              : 'Install this Grok plugin before selecting it for a turn.',
          },
      stages: stages(enabled),
      source: 'grok-plugin-list',
      ...(version ? { sourceVersion: version } : {}),
      providerPlugin: {
        installed: installed !== null,
        enabled,
        updateAvailable: Boolean(
          installed && currentVersion && availableVersion && currentVersion !== availableVersion
        ),
        updatable: installed !== null,
        installable: available !== null,
        removable: installed !== null,
        toggleable: installed !== null,
        ...(inspected?.scope === 'project'
          ? { scope: 'project' as const }
          : inspected?.scope === 'user'
            ? { scope: 'user' as const }
            : {}),
        marketplace,
      },
    });
  }

  for (const plugin of inspectedPlugins) {
    const path = text(plugin.path);
    const name = text(plugin.name);
    if (!path || !name || mappedInspectionPaths.has(path)) continue;
    const enabled = plugin.enabled === true;
    controls.push({
      nativeId: grokExternalPluginControlId(path),
      kind: 'plugin',
      label: name,
      description: 'Compatibility plugin discovered by Grok for this workspace.',
      scope: plugin.scope === 'project' ? 'workspace' : 'installation',
      effects: ['instructions', 'filesystem-read', 'process', 'network'],
      availability: enabled
        ? { state: 'supported' }
        : { state: 'disabled-by-policy', reason: 'This compatibility plugin is disabled.' },
      stages: stages(enabled),
      source: 'grok-inspect-plugin',
      providerPlugin: {
        installed: true,
        enabled,
        updateAvailable: false,
        updatable: false,
        installable: false,
        removable: false,
        toggleable: false,
        marketplace: 'External compatibility',
      },
    });
  }

  if (options.workspaceMemoryResetSupported) {
    controls.push({
      nativeId: 'clear-workspace',
      kind: 'memory',
      label: 'Clear Grok workspace memory',
      description:
        'Clear provider-native Grok memory for this workspace. DNAForge memory is managed separately.',
      scope: 'workspace',
      effects: ['filesystem-write'],
      availability: { state: 'supported' },
      stages: stages(false),
      source: 'grok-memory-clear-workspace',
    });
  }
  return controls;
}

function fingerprint(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

async function bounded<T>(operation: Promise<T>, timeoutMs = 10_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Provider capability discovery timed out.')),
          timeoutMs
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function unavailableProviderControl(
  providerLabel: string,
  state: 'requires-auth' | 'unsupported',
  reason: string
): NativeAgentCapabilityDescriptor {
  return {
    nativeId: 'provider-status',
    kind: 'account',
    label: providerLabel,
    description: 'Provider capability catalog status.',
    scope: 'account',
    effects: ['external-account'],
    availability: { state, reason },
    stages: {
      advertised: false,
      discoverable: true,
      invocable: false,
      visible: true,
      deterministic: true,
      liveQualified: false,
    },
    source: 'dnaforge-provider-detection',
  };
}

async function discoverClaudeCatalog(input: { binaryPath: string; cwd: string }): Promise<{
  commands: ClaudeCommandLike[];
  account: unknown;
  memoryFiles: unknown;
}> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const inputController = new AbortController();
  async function* idleInput() {
    await new Promise<void>((resolve) =>
      inputController.signal.addEventListener('abort', () => resolve(), { once: true })
    );
    yield* [];
  }
  const query = sdk.query({
    prompt: idleInput(),
    options: {
      pathToClaudeCodeExecutable: input.binaryPath,
      cwd: input.cwd,
      settingSources: ['user', 'project', 'local'],
      skills: 'all',
      permissionMode: 'dontAsk',
      env: claudeCliEnv(),
    },
  });
  try {
    const [initialized, contextUsage] = await bounded(
      Promise.all([
        query.initializationResult(),
        query.getContextUsage().catch(() => ({ memoryFiles: [] })),
      ]),
      12_000
    );
    return {
      commands: initialized.commands as ClaudeCommandLike[],
      account: initialized.account,
      memoryFiles: contextUsage.memoryFiles ?? [],
    };
  } finally {
    inputController.abort();
    query.close();
  }
}

export function createNativeAgentCapabilityAdapters(options: {
  runtimeRoot: string;
  grokRuntimeRoot?: string;
}): AgentCapabilityProviderAdapter[] {
  return [
    {
      provider: 'claude-agent-sdk',
      async discover(context) {
        const detection = await detectClaudeCode();
        const version = detection.path ? await getCliVersion(detection.path, 'claude') : null;
        if (!detection.path) {
          return {
            providerVersion: version,
            accountFingerprint: null,
            workspaceFingerprint: fingerprint(context.workspacePath),
            controls: [
              unavailableProviderControl(
                'Claude Code',
                'unsupported',
                'Claude Code is not installed.'
              ),
            ],
          };
        }
        if (detection.auth === 'unauthenticated') {
          return {
            providerVersion: version,
            accountFingerprint: null,
            workspaceFingerprint: fingerprint(context.workspacePath),
            controls: [
              unavailableProviderControl(
                'Claude Code',
                'requires-auth',
                'Sign in to Claude Code before discovering commands.'
              ),
            ],
          };
        }
        const cwd = context.workspacePath ?? options.runtimeRoot;
        const [runtime, plugins] = await Promise.all([
          discoverClaudeCatalog({ binaryPath: detection.path, cwd }),
          listClaudePluginCatalog(detection.path, cwd).catch(() => ({
            installed: [],
            available: [],
          })),
        ]);
        const skillPaths = await discoverClaudeSkillPaths(cwd, plugins);
        return {
          providerVersion: version,
          accountFingerprint: fingerprint(runtime.account),
          workspaceFingerprint: fingerprint(context.workspacePath),
          controls: [
            ...mapClaudeCommands(runtime.commands, [...skillPaths.keys()], skillPaths),
            ...mapClaudePlugins(plugins, context.workspacePath),
            ...mapClaudeMemory(runtime.memoryFiles),
          ].map((control) => ({
            ...control,
            sourceVersion: control.sourceVersion ?? version ?? undefined,
          })),
        };
      },
    },
    {
      provider: 'codex-sdk',
      async discover(context) {
        const detection = await detectCodex();
        const version = detection.path ? await getCliVersion(detection.path, 'codex') : null;
        if (!detection.path) {
          return {
            providerVersion: version,
            accountFingerprint: null,
            workspaceFingerprint: fingerprint(context.workspacePath),
            controls: [
              unavailableProviderControl('Codex CLI', 'unsupported', 'Codex CLI is not installed.'),
            ],
          };
        }
        if (detection.auth === 'unauthenticated') {
          return {
            providerVersion: version,
            accountFingerprint: null,
            workspaceFingerprint: fingerprint(context.workspacePath),
            controls: [
              unavailableProviderControl(
                'Codex CLI',
                'requires-auth',
                'Sign in to Codex before discovering skills.'
              ),
            ],
          };
        }
        const rootDir = join(options.runtimeRoot, 'codex-capabilities');
        const appServer = await launchLocalCodexAppServer({
          binaryPath: detection.path,
          rootDir,
          requestTimeoutMs: 15_000,
        });
        try {
          const cwds = context.workspacePath ? [context.workspacePath] : [];
          const [skills, plugins, account] = await bounded(
            Promise.all([
              appServer.supervisor.request('skills/list', {
                cwds,
                forceReload: context.forceRefresh,
              }),
              appServer.supervisor.request('plugin/list', {
                cwds,
                marketplaceKinds: ['local'],
                forceRefetch: false,
              }),
              appServer.supervisor.request('account/read', { refreshToken: false }),
            ]),
            15_000
          );
          return {
            providerVersion: version,
            accountFingerprint: fingerprint(record(account)?.account),
            workspaceFingerprint: fingerprint(context.workspacePath),
            controls: mapCodexCatalog({
              skills,
              plugins,
              memoryResetSupported: appServer.protocol.client.includes('memory/reset'),
            }).map((control) => ({
              ...control,
              sourceVersion: control.sourceVersion ?? version ?? undefined,
            })),
          };
        } finally {
          await appServer.dispose();
        }
      },
    },
    {
      provider: 'grok-acp',
      async discover(context) {
        const detection = await detectGrok();
        const version = detection.path ? await getCliVersion(detection.path, 'grok') : null;
        if (!detection.path) {
          return {
            providerVersion: version,
            accountFingerprint: null,
            workspaceFingerprint: fingerprint(context.workspacePath),
            controls: [
              unavailableProviderControl(
                'Grok Build',
                'unsupported',
                'Grok Build is not installed.'
              ),
            ],
          };
        }
        if (detection.auth === 'unauthenticated') {
          return {
            providerVersion: version,
            accountFingerprint: null,
            workspaceFingerprint: fingerprint(context.workspacePath),
            controls: [
              unavailableProviderControl(
                'Grok Build',
                'requires-auth',
                'Sign in to Grok before discovering commands.'
              ),
            ],
          };
        }
        const cwd = context.workspacePath ?? options.runtimeRoot;
        const abortController = new AbortController();
        const opened = openGrokAcpClient({
          binaryPath: detection.path,
          cwd,
          permissionMode: 'app-supervised',
          systemPrompt: 'Discover provider capabilities only. Do not start a model turn.',
          runtimeRoot: options.grokRuntimeRoot ?? join(options.runtimeRoot, 'grok-capabilities'),
          conversationId: null,
          signal: abortController.signal,
          requestUserInput: async () => ({ outcome: 'cancelled', answers: {} }),
        });
        try {
          const [initialized, catalog, memoryClearSupported] = await bounded(
            Promise.all([
              opened.rpc.initialize(),
              listGrokCapabilityCatalog(detection.path, cwd),
              context.workspacePath
                ? grokMemoryClearSupported(detection.path, cwd)
                : Promise.resolve(false),
            ]),
            20_000
          );
          return {
            providerVersion: version,
            accountFingerprint: fingerprint({ auth: detection.auth }),
            workspaceFingerprint: fingerprint(context.workspacePath),
            controls: [
              ...mapGrokInitializeCapabilities(initialized),
              ...mapGrokInspectionCapabilities(catalog, {
                workspaceMemoryResetSupported: memoryClearSupported,
              }),
            ].map((control) => ({
              ...control,
              sourceVersion: control.sourceVersion ?? version ?? undefined,
            })),
          };
        } finally {
          abortController.abort();
          opened.rpc.close();
        }
      },
    },
  ];
}
