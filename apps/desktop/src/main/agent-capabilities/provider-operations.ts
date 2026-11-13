import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import type { AgentProviderPluginInspection } from '../../shared/agent-capability-controls';

import {
  detectClaudeCode as defaultDetectClaudeCode,
  detectCodex as defaultDetectCodex,
  detectGrok as defaultDetectGrok,
} from '../agent-sdk/detect';
import { claudeCliEnv, grokCliEnv } from '../agent-sdk/subprocess-env';
import {
  launchLocalCodexAppServer,
  type LocalCodexProtocol,
} from '../agent-sdk/local-codex-app-server';

interface CapabilityOperationAppServer {
  supervisor: { request(method: string, params?: unknown): Promise<unknown> };
  protocol: LocalCodexProtocol;
  runtimeDir: string;
  dispose(): void | Promise<void>;
}

export interface CodexCapabilityOperationDependencies {
  detectCodex?: typeof defaultDetectCodex;
  launchAppServer?: (options: {
    binaryPath: string;
    rootDir: string;
    requestTimeoutMs?: number;
  }) => Promise<CapabilityOperationAppServer>;
  runtimeRoot: string;
}

interface ResolvedCodexPlugin {
  marketplaceName: string;
  marketplacePath: string | null;
  plugin: Record<string, unknown>;
}

const SAFE_PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._@:/-]{0,159}$/;

function validPluginId(pluginId: string): boolean {
  return SAFE_PLUGIN_ID.test(pluginId) && !pluginId.includes('..');
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

function safeText(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized && normalized.length <= 500 ? normalized : fallback;
}

function optionalText(value: unknown): string | null {
  const normalized = safeText(value);
  return normalized || null;
}

async function resolveCodexPlugin(
  appServer: CapabilityOperationAppServer,
  pluginId: string,
  workspacePath: string | null,
  forceRefetch: boolean
): Promise<ResolvedCodexPlugin> {
  if (!appServer.protocol.client.includes('plugin/list')) {
    throw new Error('This Codex build does not support provider plugin discovery.');
  }
  const catalog = record(
    await appServer.supervisor.request('plugin/list', {
      cwds: workspacePath ? [workspacePath] : [],
      marketplaceKinds: ['local'],
      forceRefetch,
    })
  );
  for (const marketplace of records(catalog?.marketplaces)) {
    for (const plugin of records(marketplace.plugins)) {
      if (plugin.id !== pluginId) continue;
      const marketplaceName = safeText(marketplace.name);
      if (!marketplaceName) throw new Error('The Codex plugin marketplace is invalid.');
      return {
        marketplaceName,
        marketplacePath: optionalText(marketplace.path),
        plugin,
      };
    }
  }
  throw new Error('The selected Codex plugin no longer exists.');
}

async function withCodexAppServer<T>(
  dependencies: CodexCapabilityOperationDependencies,
  operation: (appServer: CapabilityOperationAppServer) => Promise<T>
): Promise<T> {
  const detection = await (dependencies.detectCodex ?? defaultDetectCodex)();
  if (!detection.path) throw new Error('Codex CLI is not installed.');
  if (detection.auth === 'unauthenticated') throw new Error('Sign in to Codex first.');
  const appServer = await (dependencies.launchAppServer ?? launchLocalCodexAppServer)({
    binaryPath: detection.path,
    rootDir: join(dependencies.runtimeRoot, 'provider-operations'),
    requestTimeoutMs: 15_000,
  });
  try {
    return await operation(appServer);
  } finally {
    await appServer.dispose();
  }
}

export function resetCodexProviderMemory(
  dependencies: CodexCapabilityOperationDependencies
): Promise<void> {
  return withCodexAppServer(dependencies, async (appServer) => {
    if (!appServer.protocol.client.includes('memory/reset')) {
      throw new Error('This Codex build does not support provider memory reset.');
    }
    await appServer.supervisor.request('memory/reset', undefined);
  });
}

export function removeCodexPlugin(
  pluginId: string,
  dependencies: CodexCapabilityOperationDependencies
): Promise<void> {
  if (!validPluginId(pluginId)) {
    return Promise.reject(new Error('Invalid Codex plugin id.'));
  }
  return withCodexAppServer(dependencies, async (appServer) => {
    if (!appServer.protocol.client.includes('plugin/uninstall')) {
      throw new Error('This Codex build does not support plugin removal.');
    }
    await appServer.supervisor.request('plugin/uninstall', { pluginId });
  });
}

export function inspectCodexPlugin(
  pluginId: string,
  workspacePath: string | null,
  dependencies: CodexCapabilityOperationDependencies
): Promise<AgentProviderPluginInspection> {
  if (!validPluginId(pluginId)) return Promise.reject(new Error('Invalid Codex plugin id.'));
  return withCodexAppServer(dependencies, async (appServer) => {
    if (!appServer.protocol.client.includes('plugin/read')) {
      throw new Error('This Codex build does not support provider plugin inspection.');
    }
    const resolved = await resolveCodexPlugin(appServer, pluginId, workspacePath, false);
    const pluginName = safeText(resolved.plugin.name);
    if (!pluginName) throw new Error('The selected Codex plugin has no valid name.');
    const detailRoot = record(
      await appServer.supervisor.request('plugin/read', {
        ...(resolved.marketplacePath
          ? { marketplacePath: resolved.marketplacePath }
          : { remoteMarketplaceName: resolved.marketplaceName }),
        pluginName,
      })
    );
    const detail = record(detailRoot?.plugin);
    const currentVersion = optionalText(resolved.plugin.localVersion);
    const availableVersion = optionalText(resolved.plugin.version);
    const installed = resolved.plugin.installed === true;
    const installable =
      resolved.plugin.availability !== 'DISABLED_BY_ADMIN' &&
      resolved.plugin.installPolicy !== 'NOT_AVAILABLE';
    const names = (value: unknown, field: string): string[] =>
      records(value)
        .map((entry) => safeText(entry[field]))
        .filter(Boolean)
        .slice(0, 100);
    return {
      id: pluginId,
      name: pluginName,
      description: safeText(detail?.description, 'No plugin description was provided.'),
      installed,
      currentVersion,
      availableVersion,
      updateAvailable: Boolean(
        installed && currentVersion && availableVersion && currentVersion !== availableVersion
      ),
      installable,
      authPolicy:
        resolved.plugin.authPolicy === 'ON_INSTALL' || resolved.plugin.authPolicy === 'ON_USE'
          ? resolved.plugin.authPolicy
          : null,
      skills: names(detail?.skills, 'name'),
      apps: names(detail?.apps, 'name'),
      mcpServers: Array.isArray(detail?.mcpServers)
        ? detail.mcpServers
            .map((entry) => safeText(entry))
            .filter(Boolean)
            .slice(0, 100)
        : [],
      hooks: names(detail?.hooks, 'eventName'),
      scheduledTasks: names(detail?.scheduledTasks, 'name'),
    };
  });
}

export function installOrUpdateCodexPlugin(
  pluginId: string,
  workspacePath: string | null,
  dependencies: CodexCapabilityOperationDependencies
): Promise<void> {
  if (!validPluginId(pluginId)) return Promise.reject(new Error('Invalid Codex plugin id.'));
  return withCodexAppServer(dependencies, async (appServer) => {
    if (!appServer.protocol.client.includes('plugin/install')) {
      throw new Error('This Codex build does not support provider plugin installation.');
    }
    const resolved = await resolveCodexPlugin(appServer, pluginId, workspacePath, true);
    if (
      resolved.plugin.availability === 'DISABLED_BY_ADMIN' ||
      resolved.plugin.installPolicy === 'NOT_AVAILABLE'
    ) {
      throw new Error('This Codex plugin is not installable under the current provider policy.');
    }
    const pluginName = safeText(resolved.plugin.name);
    if (!pluginName) throw new Error('The selected Codex plugin has no valid name.');
    await appServer.supervisor.request('plugin/install', {
      ...(resolved.marketplacePath
        ? { marketplacePath: resolved.marketplacePath }
        : { remoteMarketplaceName: resolved.marketplaceName }),
      installAttemptId: randomUUID(),
      pluginName,
    });
  });
}

interface ClaudeCliRunner {
  (binaryPath: string, args: string[], cwd: string | null): Promise<string>;
}

export interface ClaudeCapabilityOperationDependencies {
  detectClaudeCode?: typeof defaultDetectClaudeCode;
  runCli?: ClaudeCliRunner;
}

export interface ClaudePluginCatalog {
  installed: Record<string, unknown>[];
  available: Record<string, unknown>[];
}

function runClaudeCli(binaryPath: string, args: string[], cwd: string | null): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binaryPath,
      args,
      {
        ...(cwd ? { cwd } : {}),
        env: claudeCliEnv(),
        encoding: 'utf8',
        timeout: 20_000,
        maxBuffer: 12_000_000,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const detail = safeText(stderr) || safeText(stdout) || 'Claude plugin command failed.';
        reject(new Error(detail));
      }
    );
  });
}

export async function listClaudePluginCatalog(
  binaryPath: string,
  cwd: string | null,
  runCli: ClaudeCliRunner = runClaudeCli
): Promise<ClaudePluginCatalog> {
  const output = await runCli(binaryPath, ['plugin', 'list', '--available', '--json'], cwd);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error('Claude returned an invalid plugin catalog.');
  }
  const catalog = record(parsed);
  if (!catalog) throw new Error('Claude returned an invalid plugin catalog.');
  return {
    installed: records(catalog.installed),
    available: records(catalog.available),
  };
}

export function relevantClaudeInstalledPlugins(
  installed: readonly Record<string, unknown>[],
  cwd: string | null
): Record<string, unknown>[] {
  const relevant = installed.filter((plugin) => {
    const scope = plugin.scope;
    if (scope === 'user') return true;
    return (
      (scope === 'project' || scope === 'local') &&
      cwd !== null &&
      optionalText(plugin.projectPath) === cwd
    );
  });
  const rank = (plugin: Record<string, unknown>): number =>
    plugin.scope === 'local' ? 3 : plugin.scope === 'project' ? 2 : 1;
  const selected = new Map<string, Record<string, unknown>>();
  for (const plugin of relevant) {
    const id = optionalText(plugin.id);
    if (!id || !validPluginId(id)) continue;
    const current = selected.get(id);
    if (!current || rank(plugin) > rank(current)) selected.set(id, plugin);
  }
  return [...selected.values()];
}

interface ResolvedClaudePlugin {
  id: string;
  installed: Record<string, unknown> | null;
  available: Record<string, unknown> | null;
  scope: 'user' | 'project' | 'local';
}

async function withClaudePlugin<T>(
  pluginId: string,
  cwd: string | null,
  dependencies: ClaudeCapabilityOperationDependencies,
  operation: (
    plugin: ResolvedClaudePlugin,
    binaryPath: string,
    runCli: ClaudeCliRunner
  ) => Promise<T>
): Promise<T> {
  if (!validPluginId(pluginId)) throw new Error('Invalid Claude plugin id.');
  const detection = await (dependencies.detectClaudeCode ?? defaultDetectClaudeCode)();
  if (!detection.path) throw new Error('Claude Code is not installed.');
  if (detection.auth === 'unauthenticated') throw new Error('Sign in to Claude Code first.');
  const runner = dependencies.runCli ?? runClaudeCli;
  const catalog = await listClaudePluginCatalog(detection.path, cwd, runner);
  const installed =
    relevantClaudeInstalledPlugins(catalog.installed, cwd).find(
      (candidate) => optionalText(candidate.id) === pluginId
    ) ?? null;
  const available =
    catalog.available.find((candidate) => optionalText(candidate.pluginId) === pluginId) ?? null;
  if (!installed && !available) throw new Error('The selected Claude plugin no longer exists.');
  const rawScope = installed?.scope;
  const scope =
    rawScope === 'user' || rawScope === 'project' || rawScope === 'local'
      ? rawScope
      : cwd
        ? 'local'
        : 'user';
  return operation({ id: pluginId, installed, available, scope }, detection.path, runner);
}

async function namesInDirectory(path: string, extension: string | null): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .flatMap((entry) => {
        if (extension === null && entry.isDirectory()) return [entry.name];
        if (extension && entry.isFile() && entry.name.endsWith(extension)) {
          return [entry.name.slice(0, -extension.length)];
        }
        return [];
      })
      .filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(name))
      .sort()
      .slice(0, 100);
  } catch {
    return [];
  }
}

async function jsonKeys(path: string): Promise<string[]> {
  try {
    const contents = await readFile(path, 'utf8');
    if (contents.length > 256_000) return [];
    const parsed = record(JSON.parse(contents));
    return parsed ? Object.keys(parsed).slice(0, 100) : [];
  } catch {
    return [];
  }
}

export function inspectClaudePlugin(
  pluginId: string,
  workspacePath: string | null,
  dependencies: ClaudeCapabilityOperationDependencies = {}
): Promise<AgentProviderPluginInspection> {
  return withClaudePlugin(pluginId, workspacePath, dependencies, async (plugin) => {
    const installPath = optionalText(plugin.installed?.installPath);
    const [skills, commands, agents, mcpServers, hooks] = installPath
      ? await Promise.all([
          namesInDirectory(join(installPath, 'skills'), null),
          namesInDirectory(join(installPath, 'commands'), '.md'),
          namesInDirectory(join(installPath, 'agents'), '.md'),
          jsonKeys(join(installPath, '.mcp.json')),
          jsonKeys(join(installPath, 'hooks', 'hooks.json')),
        ])
      : [[], [], [], [], []];
    const errors = Array.isArray(plugin.installed?.errors)
      ? plugin.installed.errors.flatMap((value) => {
          const message = safeText(value);
          return message ? [message] : [];
        })
      : [];
    return {
      id: plugin.id,
      name: optionalText(plugin.available?.name) ?? plugin.id.split('@')[0] ?? 'Claude plugin',
      description:
        optionalText(plugin.available?.description) ??
        `Claude plugin${plugin.installed ? ' installed for this scope' : ' available to install'}.`,
      installed: plugin.installed !== null,
      currentVersion: optionalText(plugin.installed?.version),
      availableVersion: null,
      updateAvailable: false,
      installable: plugin.available !== null,
      authPolicy: null,
      skills,
      commands,
      agents,
      apps: [],
      mcpServers,
      hooks,
      scheduledTasks: [],
      errors,
    };
  });
}

export function resolveClaudePluginInstallPath(
  pluginId: string,
  workspacePath: string | null,
  dependencies: ClaudeCapabilityOperationDependencies = {}
): Promise<string> {
  return withClaudePlugin(pluginId, workspacePath, dependencies, async (plugin) => {
    const installPath = optionalText(plugin.installed?.installPath);
    if (!installPath || !isAbsolute(installPath) || plugin.installed?.enabled === false) {
      throw new Error('Enable the Claude plugin before selecting it for a turn.');
    }
    if (Array.isArray(plugin.installed?.errors) && plugin.installed.errors.length > 0) {
      throw new Error('Claude reported load errors for the selected plugin.');
    }
    return installPath;
  });
}

export function installOrUpdateClaudePlugin(
  pluginId: string,
  workspacePath: string | null,
  dependencies: ClaudeCapabilityOperationDependencies = {}
): Promise<void> {
  return withClaudePlugin(
    pluginId,
    workspacePath,
    dependencies,
    async (plugin, binaryPath, runner) => {
      const scopeArgs = ['--scope', plugin.scope];
      if (!plugin.installed) {
        await runner(
          binaryPath,
          ['plugin', 'install', plugin.id, ...scopeArgs, '-y'],
          workspacePath
        );
      } else if (plugin.installed.enabled === false) {
        await runner(binaryPath, ['plugin', 'enable', plugin.id, ...scopeArgs], workspacePath);
      } else {
        await runner(
          binaryPath,
          ['plugin', 'update', plugin.id, ...scopeArgs, '-y'],
          workspacePath
        );
      }
    }
  );
}

export function setClaudePluginEnabled(
  pluginId: string,
  workspacePath: string | null,
  enabled: boolean,
  dependencies: ClaudeCapabilityOperationDependencies = {}
): Promise<void> {
  return withClaudePlugin(
    pluginId,
    workspacePath,
    dependencies,
    async (plugin, binaryPath, runner) => {
      if (!plugin.installed)
        throw new Error('Install the Claude plugin before changing its state.');
      await runner(
        binaryPath,
        ['plugin', enabled ? 'enable' : 'disable', plugin.id, '--scope', plugin.scope],
        workspacePath
      );
    }
  );
}

export function removeClaudePlugin(
  pluginId: string,
  workspacePath: string | null,
  dependencies: ClaudeCapabilityOperationDependencies = {}
): Promise<void> {
  return withClaudePlugin(
    pluginId,
    workspacePath,
    dependencies,
    async (plugin, binaryPath, runner) => {
      if (!plugin.installed) throw new Error('The selected Claude plugin is not installed.');
      await runner(
        binaryPath,
        ['plugin', 'uninstall', plugin.id, '--scope', plugin.scope, '-y'],
        workspacePath
      );
    }
  );
}

interface GrokCliRunner {
  (binaryPath: string, args: string[], cwd: string | null): Promise<string>;
}

export interface GrokCapabilityOperationDependencies {
  detectGrok?: typeof defaultDetectGrok;
  runCli?: GrokCliRunner;
}

export interface GrokCapabilityCatalog {
  installed: Record<string, unknown>[];
  available: Record<string, unknown>[];
  inspection: Record<string, unknown>;
}

function runGrokCli(binaryPath: string, args: string[], cwd: string | null): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binaryPath,
      args,
      {
        ...(cwd ? { cwd } : {}),
        env: grokCliEnv(),
        encoding: 'utf8',
        timeout: 20_000,
        maxBuffer: 16_000_000,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const detail = safeText(stderr) || safeText(stdout) || 'Grok capability command failed.';
        reject(new Error(detail));
      }
    );
  });
}

function parseGrokJson(output: string, label: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`Grok returned invalid ${label} data.`);
  }
}

export async function listGrokCapabilityCatalog(
  binaryPath: string,
  cwd: string | null,
  runCli: GrokCliRunner = runGrokCli
): Promise<GrokCapabilityCatalog> {
  const [inspectionOutput, installedOutput, availableOutput] = await Promise.all([
    runCli(binaryPath, ['--no-auto-update', 'inspect', '--json'], cwd),
    runCli(binaryPath, ['--no-auto-update', 'plugin', 'list', '--json'], cwd),
    runCli(binaryPath, ['--no-auto-update', 'plugin', 'list', '--available', '--json'], cwd),
  ]);
  const inspection = record(parseGrokJson(inspectionOutput, 'inspection'));
  const installed = records(parseGrokJson(installedOutput, 'installed plugin catalog')).filter(
    (entry) => entry.status === 'installed'
  );
  const available = records(parseGrokJson(availableOutput, 'plugin catalog')).filter(
    (entry) => entry.status === 'available'
  );
  if (!inspection) throw new Error('Grok returned invalid inspection data.');
  return { installed, available, inspection };
}

export async function grokMemoryClearSupported(
  binaryPath: string,
  cwd: string | null,
  runCli: GrokCliRunner = runGrokCli
): Promise<boolean> {
  try {
    await runCli(binaryPath, ['--no-auto-update', 'memory', 'clear', '--help'], cwd);
    return true;
  } catch {
    return false;
  }
}

function grokMarketplaceKey(marketplace: string): string {
  return createHash('sha256').update(marketplace).digest('hex').slice(0, 12);
}

export function grokPluginControlId(plugin: Record<string, unknown>): string | null {
  const name = optionalText(plugin.name);
  if (!name || !validPluginId(name)) return null;
  const marketplace = optionalText(plugin.marketplace);
  if (!marketplace) return name;
  const controlId = `${name}@${grokMarketplaceKey(marketplace)}`;
  return validPluginId(controlId)
    ? controlId
    : `grok-plugin-${createHash('sha256')
        .update(`${name}\0${marketplace}`)
        .digest('hex')
        .slice(0, 32)}`;
}

export function grokExternalPluginControlId(path: string): string {
  return `external-${createHash('sha256').update(path).digest('hex').slice(0, 16)}`;
}

interface ResolvedGrokPlugin {
  controlId: string;
  name: string;
  installed: Record<string, unknown> | null;
  available: Record<string, unknown> | null;
  inspected: Record<string, unknown> | null;
  marketplace: string | null;
  external: boolean;
}

function grokInspectedPlugins(catalog: GrokCapabilityCatalog): Record<string, unknown>[] {
  return records(catalog.inspection.plugins);
}

function pathIsWithin(candidate: string, root: string): boolean {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

function resolveGrokPluginFromCatalog(
  pluginId: string,
  catalog: GrokCapabilityCatalog
): ResolvedGrokPlugin {
  const installed =
    catalog.installed.find((candidate) => grokPluginControlId(candidate) === pluginId) ?? null;
  const available =
    catalog.available.find((candidate) => grokPluginControlId(candidate) === pluginId) ?? null;
  const installedName = optionalText(installed?.name);
  const installedPath = optionalText(installed?.path);
  const inspectedMatches = installedPath
    ? grokInspectedPlugins(catalog).filter((candidate) => {
        if (optionalText(candidate.name) !== installedName) return false;
        const path = optionalText(candidate.path);
        return Boolean(path && isAbsolute(path) && pathIsWithin(path, installedPath));
      })
    : [];
  const inspected = inspectedMatches.length === 1 ? inspectedMatches[0] : null;
  if (installed || available) {
    const name = optionalText(installed?.name) ?? optionalText(available?.name);
    if (!name) throw new Error('The selected Grok plugin has no valid name.');
    return {
      controlId: pluginId,
      name,
      installed,
      available,
      inspected,
      marketplace:
        optionalText(installed?.marketplace) ?? optionalText(available?.marketplace) ?? null,
      external: false,
    };
  }
  const external =
    grokInspectedPlugins(catalog).find((candidate) => {
      const path = optionalText(candidate.path);
      return path ? grokExternalPluginControlId(path) === pluginId : false;
    }) ?? null;
  const name = optionalText(external?.name);
  if (!external || !name) throw new Error('The selected Grok plugin no longer exists.');
  return {
    controlId: pluginId,
    name,
    installed: null,
    available: null,
    inspected: external,
    marketplace: 'External compatibility',
    external: true,
  };
}

async function withGrokPlugin<T>(
  pluginId: string,
  cwd: string | null,
  dependencies: GrokCapabilityOperationDependencies,
  operation: (plugin: ResolvedGrokPlugin, binaryPath: string, runCli: GrokCliRunner) => Promise<T>
): Promise<T> {
  if (!validPluginId(pluginId)) throw new Error('Invalid Grok plugin id.');
  const detection = await (dependencies.detectGrok ?? defaultDetectGrok)();
  if (!detection.path) throw new Error('Grok Build is not installed.');
  if (detection.auth === 'unauthenticated') throw new Error('Sign in to Grok first.');
  const runner = dependencies.runCli ?? runGrokCli;
  const catalog = await listGrokCapabilityCatalog(detection.path, cwd, runner);
  return operation(resolveGrokPluginFromCatalog(pluginId, catalog), detection.path, runner);
}

function grokComponentNames(
  plugin: ResolvedGrokPlugin,
  key: 'skills' | 'commands' | 'agents' | 'mcpServers' | 'hooks'
): string[] {
  const components = record(plugin.available?.components);
  return records(components?.[key])
    .map((entry) => safeText(entry.name))
    .filter(Boolean)
    .slice(0, 100);
}

export function inspectGrokPlugin(
  pluginId: string,
  workspacePath: string | null,
  dependencies: GrokCapabilityOperationDependencies = {}
): Promise<AgentProviderPluginInspection> {
  return withGrokPlugin(pluginId, workspacePath, dependencies, async (plugin) => {
    const path = optionalText(plugin.inspected?.path) ?? optionalText(plugin.installed?.path);
    const [directorySkills, directoryCommands, directoryAgents, directoryMcp, directoryHooks] = path
      ? await Promise.all([
          namesInDirectory(join(path, 'skills'), null),
          namesInDirectory(join(path, 'commands'), '.md'),
          namesInDirectory(join(path, 'agents'), '.md'),
          jsonKeys(join(path, '.mcp.json')),
          jsonKeys(join(path, 'hooks', 'hooks.json')),
        ])
      : [[], [], [], [], []];
    const currentVersion = optionalText(plugin.installed?.version);
    const availableVersion = optionalText(plugin.available?.version);
    return {
      id: plugin.controlId,
      name: plugin.name,
      description:
        optionalText(plugin.available?.description) ??
        `${plugin.external ? 'Compatibility' : 'Grok'} plugin${plugin.installed || plugin.external ? ' loaded for this scope' : ' available to install'}.`,
      installed: plugin.installed !== null || plugin.external,
      currentVersion,
      availableVersion,
      updateAvailable: Boolean(
        currentVersion && availableVersion && currentVersion !== availableVersion
      ),
      installable: plugin.available !== null,
      authPolicy: null,
      skills: grokComponentNames(plugin, 'skills').length
        ? grokComponentNames(plugin, 'skills')
        : directorySkills,
      commands: grokComponentNames(plugin, 'commands').length
        ? grokComponentNames(plugin, 'commands')
        : directoryCommands,
      agents: grokComponentNames(plugin, 'agents').length
        ? grokComponentNames(plugin, 'agents')
        : directoryAgents,
      apps: [],
      mcpServers: grokComponentNames(plugin, 'mcpServers').length
        ? grokComponentNames(plugin, 'mcpServers')
        : directoryMcp,
      hooks: grokComponentNames(plugin, 'hooks').length
        ? grokComponentNames(plugin, 'hooks')
        : directoryHooks,
      scheduledTasks: [],
    };
  });
}

export function resolveGrokPluginInstallPath(
  pluginId: string,
  workspacePath: string | null,
  dependencies: GrokCapabilityOperationDependencies = {}
): Promise<string> {
  return withGrokPlugin(pluginId, workspacePath, dependencies, async (plugin) => {
    const path = optionalText(plugin.inspected?.path);
    if (!path || !isAbsolute(path) || plugin.inspected?.enabled !== true) {
      throw new Error('Enable the Grok plugin before selecting it for a turn.');
    }
    return path;
  });
}

export function resolveGrokSkillSourcePath(
  skillId: string,
  workspacePath: string | null,
  dependencies: GrokCapabilityOperationDependencies = {}
): Promise<string> {
  if (!validPluginId(skillId)) return Promise.reject(new Error('Invalid Grok skill id.'));
  return (async () => {
    const detection = await (dependencies.detectGrok ?? defaultDetectGrok)();
    if (!detection.path) throw new Error('Grok Build is not installed.');
    if (detection.auth === 'unauthenticated') throw new Error('Sign in to Grok first.');
    const catalog = await listGrokCapabilityCatalog(
      detection.path,
      workspacePath,
      dependencies.runCli ?? runGrokCli
    );
    const skill = records(catalog.inspection.skills).find((candidate) => {
      const name = optionalText(candidate.invocableAs) ?? optionalText(candidate.name);
      return name === skillId;
    });
    const source = record(skill?.source);
    const path = optionalText(source?.path);
    if (
      !skill ||
      skill.disabled === true ||
      skill.userInvocable !== true ||
      !path ||
      !isAbsolute(path) ||
      !path.endsWith('SKILL.md')
    ) {
      throw new Error('The selected Grok skill is no longer available.');
    }
    return path;
  })();
}

export async function resolveGrokSkillSourcePaths(
  skillIds: readonly string[],
  workspacePath: string | null,
  dependencies: GrokCapabilityOperationDependencies = {}
): Promise<Array<{ nativeId: string; sourcePath: string }>> {
  const requestedIds = [...new Set(skillIds)];
  if (requestedIds.some((skillId) => !validPluginId(skillId))) {
    throw new Error('Invalid Grok skill id.');
  }
  if (requestedIds.length === 0) return [];

  const detection = await (dependencies.detectGrok ?? defaultDetectGrok)();
  if (!detection.path) throw new Error('Grok Build is not installed.');
  if (detection.auth === 'unauthenticated') throw new Error('Sign in to Grok first.');
  const catalog = await listGrokCapabilityCatalog(
    detection.path,
    workspacePath,
    dependencies.runCli ?? runGrokCli
  );
  const available = new Map<string, string>();
  for (const skill of records(catalog.inspection.skills)) {
    const nativeId = optionalText(skill.invocableAs) ?? optionalText(skill.name);
    const sourcePath = optionalText(record(skill.source)?.path);
    if (
      !nativeId ||
      !requestedIds.includes(nativeId) ||
      skill.disabled === true ||
      skill.userInvocable !== true ||
      !sourcePath ||
      !isAbsolute(sourcePath) ||
      !sourcePath.endsWith('SKILL.md')
    ) {
      continue;
    }
    available.set(nativeId, sourcePath);
  }
  return requestedIds.map((nativeId) => {
    const sourcePath = available.get(nativeId);
    if (!sourcePath)
      throw new Error(`The enabled Grok skill “${nativeId}” is no longer available.`);
    return { nativeId, sourcePath };
  });
}

export function installOrUpdateGrokPlugin(
  pluginId: string,
  workspacePath: string | null,
  dependencies: GrokCapabilityOperationDependencies = {}
): Promise<void> {
  return withGrokPlugin(
    pluginId,
    workspacePath,
    dependencies,
    async (plugin, binaryPath, runner) => {
      if (plugin.external)
        throw new Error('Compatibility plugins are managed by their owning CLI.');
      if (!plugin.installed) {
        if (!plugin.available || !plugin.marketplace) {
          throw new Error('The selected Grok plugin is not installable.');
        }
        await runner(
          binaryPath,
          [
            '--no-auto-update',
            'plugin',
            'install',
            `${plugin.name}@${plugin.marketplace}`,
            '--trust',
          ],
          workspacePath
        );
      } else if (plugin.inspected?.enabled === false || plugin.inspected === null) {
        await runner(
          binaryPath,
          ['--no-auto-update', 'plugin', 'enable', plugin.name],
          workspacePath
        );
      } else {
        await runner(
          binaryPath,
          ['--no-auto-update', 'plugin', 'update', plugin.name],
          workspacePath
        );
      }
    }
  );
}

export function setGrokPluginEnabled(
  pluginId: string,
  workspacePath: string | null,
  enabled: boolean,
  dependencies: GrokCapabilityOperationDependencies = {}
): Promise<void> {
  return withGrokPlugin(
    pluginId,
    workspacePath,
    dependencies,
    async (plugin, binaryPath, runner) => {
      if (!plugin.installed || plugin.external) {
        throw new Error('Only installed Grok plugins can be enabled or disabled here.');
      }
      await runner(
        binaryPath,
        ['--no-auto-update', 'plugin', enabled ? 'enable' : 'disable', plugin.name],
        workspacePath
      );
    }
  );
}

export function removeGrokPlugin(
  pluginId: string,
  workspacePath: string | null,
  dependencies: GrokCapabilityOperationDependencies = {}
): Promise<void> {
  return withGrokPlugin(
    pluginId,
    workspacePath,
    dependencies,
    async (plugin, binaryPath, runner) => {
      if (!plugin.installed || plugin.external) {
        throw new Error('The selected Grok plugin is not installed by Grok.');
      }
      await runner(
        binaryPath,
        ['--no-auto-update', 'plugin', 'uninstall', plugin.name, '--confirm'],
        workspacePath
      );
    }
  );
}

export async function resetGrokProviderMemory(
  workspacePath: string | null,
  dependencies: GrokCapabilityOperationDependencies = {}
): Promise<void> {
  if (!workspacePath) throw new Error('Open a workspace before clearing Grok workspace memory.');
  const detection = await (dependencies.detectGrok ?? defaultDetectGrok)();
  if (!detection.path) throw new Error('Grok Build is not installed.');
  if (detection.auth === 'unauthenticated') throw new Error('Sign in to Grok first.');
  await (dependencies.runCli ?? runGrokCli)(
    detection.path,
    ['--no-auto-update', 'memory', 'clear', '--workspace', '-y'],
    workspacePath
  );
}
