import { describe, expect, it, vi } from 'vitest';

import {
  grokPluginControlId,
  installOrUpdateClaudePlugin,
  installOrUpdateGrokPlugin,
  inspectCodexPlugin,
  installOrUpdateCodexPlugin,
  removeCodexPlugin,
  resetCodexProviderMemory,
  removeClaudePlugin,
  removeGrokPlugin,
  resetGrokProviderMemory,
  resolveClaudePluginInstallPath,
  resolveGrokPluginInstallPath,
  resolveGrokSkillSourcePath,
  resolveGrokSkillSourcePaths,
  setClaudePluginEnabled,
  setGrokPluginEnabled,
  relevantClaudeInstalledPlugins,
  type ClaudeCapabilityOperationDependencies,
  type CodexCapabilityOperationDependencies,
  type GrokCapabilityCatalog,
  type GrokCapabilityOperationDependencies,
} from './provider-operations';

function grokDependencies(catalog: GrokCapabilityCatalog): {
  deps: GrokCapabilityOperationDependencies;
  runCli: ReturnType<typeof vi.fn>;
} {
  const runCli = vi.fn(async (_binaryPath: string, args: string[]) => {
    const command = args.join(' ');
    if (command.endsWith('inspect --json')) return JSON.stringify(catalog.inspection);
    if (command.endsWith('plugin list --json')) return JSON.stringify(catalog.installed);
    if (command.endsWith('plugin list --available --json')) {
      return JSON.stringify([...catalog.installed, ...catalog.available]);
    }
    return '';
  });
  return {
    runCli,
    deps: {
      detectGrok: vi.fn().mockResolvedValue({
        cli: 'installed',
        path: '/test/grok',
        auth: 'authenticated',
      }),
      runCli,
    },
  };
}

function claudeDependencies(catalog: unknown): {
  deps: ClaudeCapabilityOperationDependencies;
  runCli: ReturnType<typeof vi.fn>;
} {
  const runCli = vi.fn().mockResolvedValueOnce(JSON.stringify(catalog)).mockResolvedValue('');
  return {
    runCli,
    deps: {
      detectClaudeCode: vi.fn().mockResolvedValue({
        cli: 'installed',
        path: '/test/claude',
        auth: 'authenticated',
      }),
      runCli,
    },
  };
}

function dependencies(clientMethods: string[]): {
  deps: CodexCapabilityOperationDependencies;
  request: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn().mockResolvedValue({});
  const dispose = vi.fn();
  return {
    request,
    dispose,
    deps: {
      detectCodex: vi.fn().mockResolvedValue({
        cli: 'installed',
        path: '/test/codex',
        auth: 'authenticated',
      }),
      launchAppServer: vi.fn().mockResolvedValue({
        supervisor: { request },
        protocol: { client: clientMethods, server: [], notification: [] },
        runtimeDir: '/runtime',
        dispose,
      }),
      runtimeRoot: '/runtime-root',
    },
  };
}

describe('provider capability operations', () => {
  it('gives same-name Grok marketplace plugins distinct stable control ids', () => {
    const official = grokPluginControlId({ name: 'laboratory', marketplace: 'xAI Official' });
    const internal = grokPluginControlId({ name: 'laboratory', marketplace: 'Internal Tools' });

    expect(official).toMatch(/^laboratory@[a-f0-9]{12}$/);
    expect(internal).toMatch(/^laboratory@[a-f0-9]{12}$/);
    expect(official).not.toBe(internal);
  });

  it('keeps Grok marketplace control ids valid for maximum-length native names', () => {
    const id = grokPluginControlId({ name: `a${'b'.repeat(159)}`, marketplace: 'Official' });

    expect(id).toMatch(/^grok-plugin-[a-f0-9]{32}$/);
    expect(id).toHaveLength(44);
  });

  it('re-resolves Grok marketplace plugins before install and native lifecycle mutations', async () => {
    const availableCatalog: GrokCapabilityCatalog = {
      installed: [],
      available: [
        {
          status: 'available',
          name: 'laboratory',
          marketplace: 'xAI Official',
          description: 'Laboratory tools.',
        },
      ],
      inspection: { skills: [], plugins: [] },
    };
    const install = grokDependencies(availableCatalog);
    const pluginId = grokPluginControlId(availableCatalog.available[0])!;
    await installOrUpdateGrokPlugin(pluginId, '/workspace', install.deps);
    expect(install.runCli).toHaveBeenCalledWith(
      '/test/grok',
      ['--no-auto-update', 'plugin', 'install', 'laboratory@xAI Official', '--trust'],
      '/workspace'
    );

    const installedCatalog: GrokCapabilityCatalog = {
      installed: [
        {
          status: 'installed',
          name: 'laboratory',
          marketplace: 'xAI Official',
          path: '/plugins/laboratory-repo',
        },
      ],
      available: [],
      inspection: {
        skills: [],
        plugins: [
          {
            name: 'laboratory',
            path: '/plugins/laboratory-repo/plugins/laboratory',
            enabled: true,
          },
        ],
      },
    };
    const installedId = grokPluginControlId(installedCatalog.installed[0])!;
    const disable = grokDependencies(installedCatalog);
    await setGrokPluginEnabled(installedId, '/workspace', false, disable.deps);
    expect(disable.runCli).toHaveBeenCalledWith(
      '/test/grok',
      ['--no-auto-update', 'plugin', 'disable', 'laboratory'],
      '/workspace'
    );

    const remove = grokDependencies(installedCatalog);
    await removeGrokPlugin(installedId, '/workspace', remove.deps);
    expect(remove.runCli).toHaveBeenCalledWith(
      '/test/grok',
      ['--no-auto-update', 'plugin', 'uninstall', 'laboratory', '--confirm'],
      '/workspace'
    );
  });

  it('resolves only enabled absolute Grok plugin and skill paths for a selected turn', async () => {
    const catalog: GrokCapabilityCatalog = {
      installed: [
        {
          status: 'installed',
          name: 'laboratory',
          marketplace: 'xAI Official',
          path: '/plugins/laboratory-repo',
        },
      ],
      available: [],
      inspection: {
        plugins: [
          {
            name: 'laboratory',
            path: '/plugins/laboratory-repo/plugins/laboratory',
            enabled: true,
          },
        ],
        skills: [
          {
            name: 'review-sequence',
            description: 'Review a sequence.',
            userInvocable: true,
            source: { type: 'project', path: '/skills/review-sequence/SKILL.md' },
          },
        ],
      },
    };
    const plugin = grokDependencies(catalog);
    await expect(
      resolveGrokPluginInstallPath(
        grokPluginControlId(catalog.installed[0])!,
        '/workspace',
        plugin.deps
      )
    ).resolves.toBe('/plugins/laboratory-repo/plugins/laboratory');

    const skill = grokDependencies(catalog);
    await expect(
      resolveGrokSkillSourcePath('review-sequence', '/workspace', skill.deps)
    ).resolves.toBe('/skills/review-sequence/SKILL.md');

    const skillSet = grokDependencies({
      ...catalog,
      inspection: {
        ...catalog.inspection,
        skills: [
          ...(Array.isArray(catalog.inspection.skills) ? catalog.inspection.skills : []),
          {
            name: 'search-sequences',
            description: 'Search sequences.',
            userInvocable: true,
            source: { type: 'user', path: '/skills/search-sequences/SKILL.md' },
          },
        ],
      },
    });
    await expect(
      resolveGrokSkillSourcePaths(
        ['review-sequence', 'search-sequences'],
        '/workspace',
        skillSet.deps
      )
    ).resolves.toEqual([
      { nativeId: 'review-sequence', sourcePath: '/skills/review-sequence/SKILL.md' },
      { nativeId: 'search-sequences', sourcePath: '/skills/search-sequences/SKILL.md' },
    ]);
    expect(skillSet.runCli).toHaveBeenCalledTimes(3);
  });

  it('refuses Grok plugin paths that are uninspected, disabled, ambiguous, or outside the install root', async () => {
    const installed = {
      status: 'installed',
      name: 'laboratory',
      marketplace: 'xAI Official',
      path: '/plugins/laboratory-repo',
    };
    const pluginId = grokPluginControlId(installed)!;
    for (const plugins of [
      [],
      [{ name: 'laboratory', path: '/plugins/laboratory-repo/plugin', enabled: false }],
      [
        { name: 'laboratory', path: '/plugins/laboratory-repo/one', enabled: true },
        { name: 'laboratory', path: '/plugins/laboratory-repo/two', enabled: true },
      ],
      [{ name: 'laboratory', path: '/plugins/laboratory-repository/escape', enabled: true }],
    ]) {
      const operation = grokDependencies({
        installed: [installed],
        available: [],
        inspection: { skills: [], plugins },
      });
      await expect(
        resolveGrokPluginInstallPath(pluginId, '/workspace', operation.deps)
      ).rejects.toThrow('Enable the Grok plugin');
    }
  });

  it('clears only Grok workspace memory through its non-interactive CLI flag', async () => {
    const operation = grokDependencies({ installed: [], available: [], inspection: {} });

    await resetGrokProviderMemory('/workspace', operation.deps);

    expect(operation.runCli).toHaveBeenCalledWith(
      '/test/grok',
      ['--no-auto-update', 'memory', 'clear', '--workspace', '-y'],
      '/workspace'
    );
  });

  it('keeps user plugins and only the current workspace Claude plugin instance', () => {
    expect(
      relevantClaudeInstalledPlugins(
        [
          { id: 'shared@official', scope: 'user' },
          { id: 'feature@official', scope: 'local', projectPath: '/workspace' },
          { id: 'other@official', scope: 'local', projectPath: '/other' },
        ],
        '/workspace'
      ).map((plugin) => plugin.id)
    ).toEqual(['shared@official', 'feature@official']);
  });

  it('refuses a relative Claude plugin path for a selected turn', async () => {
    const operation = claudeDependencies({
      installed: [
        {
          id: 'feature@official',
          scope: 'local',
          enabled: true,
          projectPath: '/workspace',
          installPath: 'relative/plugin',
        },
      ],
      available: [{ pluginId: 'feature@official' }],
    });

    await expect(
      resolveClaudePluginInstallPath('feature@official', '/workspace', operation.deps)
    ).rejects.toThrow('Enable the Claude plugin');
  });

  it('uses Claude non-interactive plugin lifecycle commands with the resolved scope', async () => {
    const enabled = claudeDependencies({
      installed: [
        {
          id: 'feature@official',
          scope: 'local',
          enabled: true,
          projectPath: '/workspace',
        },
      ],
      available: [{ pluginId: 'feature@official' }],
    });
    await installOrUpdateClaudePlugin('feature@official', '/workspace', enabled.deps);
    expect(enabled.runCli).toHaveBeenLastCalledWith(
      '/test/claude',
      ['plugin', 'update', 'feature@official', '--scope', 'local', '-y'],
      '/workspace'
    );

    const disabled = claudeDependencies({
      installed: [
        {
          id: 'feature@official',
          scope: 'local',
          enabled: false,
          projectPath: '/workspace',
        },
      ],
      available: [{ pluginId: 'feature@official' }],
    });
    await installOrUpdateClaudePlugin('feature@official', '/workspace', disabled.deps);
    expect(disabled.runCli).toHaveBeenLastCalledWith(
      '/test/claude',
      ['plugin', 'enable', 'feature@official', '--scope', 'local'],
      '/workspace'
    );

    const available = claudeDependencies({
      installed: [],
      available: [{ pluginId: 'new-plugin@official' }],
    });
    await installOrUpdateClaudePlugin('new-plugin@official', '/workspace', available.deps);
    expect(available.runCli).toHaveBeenLastCalledWith(
      '/test/claude',
      ['plugin', 'install', 'new-plugin@official', '--scope', 'local', '-y'],
      '/workspace'
    );
  });

  it('disables and uninstalls only the re-resolved Claude plugin scope', async () => {
    const catalog = {
      installed: [
        {
          id: 'feature@official',
          scope: 'project',
          enabled: true,
          projectPath: '/workspace',
        },
      ],
      available: [{ pluginId: 'feature@official' }],
    };
    const disable = claudeDependencies(catalog);
    await setClaudePluginEnabled('feature@official', '/workspace', false, disable.deps);
    expect(disable.runCli).toHaveBeenLastCalledWith(
      '/test/claude',
      ['plugin', 'disable', 'feature@official', '--scope', 'project'],
      '/workspace'
    );

    const remove = claudeDependencies(catalog);
    await removeClaudePlugin('feature@official', '/workspace', remove.deps);
    expect(remove.runCli).toHaveBeenLastCalledWith(
      '/test/claude',
      ['plugin', 'uninstall', 'feature@official', '--scope', 'project', '-y'],
      '/workspace'
    );
  });

  it('uses only the advertised native memory reset method and closes the process', async () => {
    const { deps, request, dispose } = dependencies(['memory/reset']);

    await resetCodexProviderMemory(deps);

    expect(request).toHaveBeenCalledWith('memory/reset', undefined);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('refuses a provider build that does not advertise memory reset', async () => {
    const { deps, request, dispose } = dependencies([]);

    await expect(resetCodexProviderMemory(deps)).rejects.toThrow('does not support');
    expect(request).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('passes only the resolved opaque plugin id to native uninstall', async () => {
    const { deps, request } = dependencies(['plugin/uninstall']);

    await removeCodexPlugin('plugin-123', deps);

    expect(request).toHaveBeenCalledWith('plugin/uninstall', { pluginId: 'plugin-123' });
  });

  it('re-resolves a plugin and returns only sanitized permissions and dependencies', async () => {
    const { deps, request } = dependencies(['plugin/list', 'plugin/read']);
    request
      .mockResolvedValueOnce({
        marketplaces: [
          {
            name: 'local',
            path: '/private/catalog.json',
            plugins: [
              {
                id: 'plugin-123',
                name: 'Laboratory tools',
                installed: false,
                enabled: false,
                version: '2.0.0',
                localVersion: null,
                installPolicy: 'AVAILABLE',
                availability: 'AVAILABLE',
                authPolicy: 'ON_USE',
              },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({
        plugin: {
          description: 'Connects laboratory records.',
          skills: [{ name: 'review', description: 'Review a record.', enabled: true }],
          hooks: [{ key: 'after', eventName: 'afterTool' }],
          apps: [{ id: 'lims', name: 'LIMS', description: null }],
          mcpServers: ['lab-server'],
          scheduledTasks: [{ key: 'weekly', name: 'Weekly review' }],
        },
      });

    const inspected = await inspectCodexPlugin('plugin-123', '/workspace', deps);
    expect(inspected).toEqual({
      id: 'plugin-123',
      name: 'Laboratory tools',
      description: 'Connects laboratory records.',
      installed: false,
      currentVersion: null,
      availableVersion: '2.0.0',
      updateAvailable: false,
      installable: true,
      authPolicy: 'ON_USE',
      skills: ['review'],
      apps: ['LIMS'],
      mcpServers: ['lab-server'],
      hooks: ['afterTool'],
      scheduledTasks: ['Weekly review'],
    });
    expect(JSON.stringify(inspected)).not.toContain('/private/catalog.json');
  });

  it('installs or updates only the re-resolved marketplace entry', async () => {
    const { deps, request } = dependencies(['plugin/list', 'plugin/install']);
    request.mockResolvedValueOnce({
      marketplaces: [
        {
          name: 'local',
          path: '/marketplace/catalog.json',
          plugins: [
            {
              id: 'plugin-123',
              name: 'laboratory-tools',
              installed: true,
              version: '2.0.0',
              localVersion: '1.0.0',
              installPolicy: 'AVAILABLE',
              availability: 'AVAILABLE',
            },
          ],
        },
      ],
    });

    await installOrUpdateCodexPlugin('plugin-123', '/workspace', deps);

    expect(request).toHaveBeenNthCalledWith(1, 'plugin/list', {
      cwds: ['/workspace'],
      marketplaceKinds: ['local'],
      forceRefetch: true,
    });
    expect(request).toHaveBeenNthCalledWith(
      2,
      'plugin/install',
      expect.objectContaining({
        marketplacePath: '/marketplace/catalog.json',
        pluginName: 'laboratory-tools',
      })
    );
  });
});
