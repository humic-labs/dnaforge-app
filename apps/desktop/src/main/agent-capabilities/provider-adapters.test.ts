import { describe, expect, it } from 'vitest';

import {
  mapClaudeCommands,
  mapClaudePlugins,
  mapCodexCatalog,
  mapGrokInitializeCapabilities,
  mapGrokInspectionCapabilities,
} from './provider-adapters';

describe('agent capability provider adapters', () => {
  it('maps Claude supported commands without treating their argument hint as instructions', () => {
    expect(
      mapClaudeCommands([
        {
          name: 'review',
          description: 'Review the current changes.',
          argumentHint: '<focus>',
          aliases: ['inspect'],
        },
      ])
    ).toMatchObject([
      {
        nativeId: 'review',
        kind: 'command',
        label: '/review',
        description: 'Review the current changes. Arguments: <focus>',
        source: 'claude-supportedCommands',
      },
    ]);
  });

  it('separates Claude skills and filters installed plugins to the active workspace', () => {
    expect(
      mapClaudeCommands(
        [
          { name: 'review', description: 'Review changes.' },
          { name: 'tdd', description: 'Write a failing test first.' },
        ],
        ['tdd']
      )
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'command', nativeId: 'review', label: '/review' }),
        expect.objectContaining({ kind: 'skill', nativeId: 'tdd', label: 'tdd' }),
      ])
    );

    const plugins = mapClaudePlugins(
      {
        installed: [
          {
            id: 'feature-dev@official',
            scope: 'local',
            enabled: true,
            version: '2.0.0',
            projectPath: '/workspace',
          },
          {
            id: 'wrong-worktree@official',
            scope: 'local',
            enabled: true,
            projectPath: '/other-worktree',
          },
          {
            id: 'broken@local',
            scope: 'user',
            enabled: true,
            errors: ['load failed'],
          },
        ],
        available: [
          {
            pluginId: 'feature-dev@official',
            name: 'Feature development',
            description: 'Build features.',
            marketplaceName: 'official',
          },
          {
            pluginId: 'available@official',
            name: 'Available plugin',
            description: 'Available to install.',
            marketplaceName: 'official',
          },
        ],
      },
      '/workspace'
    );

    expect(plugins.map((plugin) => plugin.nativeId)).toEqual([
      'feature-dev@official',
      'broken@local',
      'available@official',
    ]);
    expect(plugins[0]).toMatchObject({
      availability: { state: 'supported' },
      stages: { invocable: true },
      providerPlugin: {
        installed: true,
        enabled: true,
        scope: 'local',
        toggleable: true,
        updatable: true,
      },
    });
    expect(plugins[1]).toMatchObject({
      availability: { state: 'disabled-by-policy', reason: 'Claude reported 1 plugin load error.' },
    });
    expect(plugins[2]).toMatchObject({
      providerPlugin: { installed: false, enabled: false, installable: true, updatable: false },
    });
  });

  it('keeps long Claude marketplace descriptions inside the shared descriptor limit', () => {
    const [plugin] = mapClaudePlugins(
      {
        installed: [],
        available: [
          {
            pluginId: 'verbose@official',
            name: 'Verbose plugin',
            description: 'x'.repeat(800),
            marketplaceName: 'official',
          },
        ],
      },
      '/workspace'
    );

    expect(plugin.description).toHaveLength(480);
    expect(plugin.description.endsWith('\u2026')).toBe(true);
  });

  it('maps Codex skills, manageable plugins, and threads as separate control kinds', () => {
    const controls = mapCodexCatalog({
      skills: {
        data: [
          {
            cwd: '/workspace',
            errors: [],
            skills: [
              {
                name: 'tdd',
                description: 'Test first.',
                path: '/private/skill/path',
                scope: 'repo',
                enabled: true,
              },
            ],
          },
        ],
      },
      plugins: {
        marketplaces: [
          {
            name: 'local',
            plugins: [
              {
                id: 'laboratory-tools',
                name: 'Laboratory tools',
                installed: true,
                enabled: false,
                version: '1.3.0',
                localVersion: '1.2.0',
                installPolicy: 'AVAILABLE',
                availability: 'AVAILABLE',
              },
              {
                id: 'sequence-search',
                name: 'Sequence search',
                installed: false,
                enabled: false,
                version: '2.0.0',
                installPolicy: 'AVAILABLE',
                availability: 'AVAILABLE',
              },
            ],
          },
        ],
      },
      memoryResetSupported: true,
    });

    expect(controls.map((control) => [control.kind, control.nativeId])).toEqual([
      ['skill', 'tdd'],
      ['plugin', 'laboratory-tools'],
      ['plugin', 'sequence-search'],
      ['memory', 'reset'],
    ]);
    expect(controls[0]).toMatchObject({
      detailSourcePath: '/private/skill/path/SKILL.md',
    });
    expect(controls[1].availability.state).toBe('disabled-by-policy');
    expect(controls[1].providerPlugin).toEqual({
      installed: true,
      updateAvailable: true,
      installable: true,
      removable: true,
      marketplace: 'local',
    });
    expect(controls[2].providerPlugin).toEqual({
      installed: false,
      updateAvailable: false,
      installable: true,
      removable: false,
      marketplace: 'local',
    });
    expect(controls[3]).toMatchObject({
      source: 'codex-memory-reset',
      stages: { invocable: false },
    });
  });

  it('maps Grok ACP command metadata without session controls', () => {
    const controls = mapGrokInitializeCapabilities({
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { fork: null, list: {} },
      },
      _meta: {
        availableCommands: [
          { name: 'review', description: 'Review changes.', input: '<focus>' },
          { command: '/model', description: 'Choose a model.' },
        ],
      },
    });

    expect(controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'command', nativeId: 'review', label: '/review' }),
        expect.objectContaining({ kind: 'command', nativeId: 'model', label: '/model' }),
      ])
    );
    expect(controls.map((control) => control.kind)).not.toContain('session');
  });

  it('maps Grok native skills, marketplace plugins, compatibility plugins, and memory controls', () => {
    const controls = mapGrokInspectionCapabilities(
      {
        installed: [
          {
            status: 'installed',
            name: 'laboratory',
            marketplace: 'xAI Official',
            path: '/plugins/repo',
            version: '1.0.0',
          },
        ],
        available: [
          {
            status: 'available',
            name: 'sequence-search',
            marketplace: 'Internal Tools',
            description: 'Search sequence records.',
            components: { skills: [{ name: 'search-sequences' }] },
          },
        ],
        inspection: {
          skills: [
            {
              name: 'review-sequence',
              description: 'Review a sequence.',
              source: { type: 'project', path: '/workspace/skills/review-sequence/SKILL.md' },
              userInvocable: true,
            },
          ],
          plugins: [
            {
              name: 'laboratory',
              scope: 'user',
              path: '/plugins/repo/plugins/laboratory',
              enabled: true,
            },
            {
              name: 'compatibility-tools',
              scope: 'project',
              path: '/workspace/.claude/plugins/compatibility-tools',
              enabled: true,
            },
          ],
        },
      },
      { workspaceMemoryResetSupported: true }
    );

    expect(controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'skill',
          nativeId: 'review-sequence',
          source: 'grok-inspect-skills',
        }),
        expect.objectContaining({
          kind: 'plugin',
          label: 'laboratory',
          availability: { state: 'supported' },
          providerPlugin: expect.objectContaining({ installed: true, enabled: true }),
        }),
        expect.objectContaining({
          kind: 'plugin',
          label: 'sequence-search',
          providerPlugin: expect.objectContaining({ installed: false, installable: true }),
        }),
        expect.objectContaining({
          kind: 'plugin',
          label: 'compatibility-tools',
          source: 'grok-inspect-plugin',
          providerPlugin: expect.objectContaining({ removable: false }),
        }),
        expect.objectContaining({
          kind: 'memory',
          nativeId: 'clear-workspace',
          source: 'grok-memory-clear-workspace',
        }),
      ])
    );
  });
});
