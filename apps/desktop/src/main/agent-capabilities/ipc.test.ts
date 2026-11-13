import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handle } = vi.hoisted(() => ({ handle: vi.fn() }));

vi.mock('../analytics', () => ({
  captureOptionalTelemetryOrigin: () => null,
  enqueueOptionalAnalyticsEvent: () => false,
  enqueueOptionalAnalyticsEventFromReceipt: () => false,
}));

vi.mock('electron', () => ({ ipcMain: { handle } }));

import { registerAgentCapabilityHandlers } from './ipc';

function registeredHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const registration = handle.mock.calls.find(([candidate]) => candidate === channel);
  if (!registration) throw new Error(`Missing IPC handler: ${channel}`);
  return registration[1];
}

describe('agent capability IPC', () => {
  beforeEach(() => handle.mockReset());

  it('validates and canonicalizes discovery requests before reaching the service', async () => {
    const discover = vi.fn(async () => ({
      schemaVersion: 1 as const,
      snapshotId: 'snapshot-1',
      provider: 'codex-sdk' as const,
      providerVersion: null,
      accountFingerprint: null,
      workspaceFingerprint: null,
      capturedAt: 1,
      controls: [],
    }));
    const assertWorkspacePath = vi.fn(async () => '/canonical/workspace');
    registerAgentCapabilityHandlers({
      service: { discover, resolve: vi.fn() },
      assertWorkspacePath,
    });

    await expect(
      registeredHandler('agentCapabilities:discover')(
        {},
        { provider: 'codex-sdk', workspacePath: '/workspace', forceRefresh: true }
      )
    ).resolves.toMatchObject({ snapshotId: 'snapshot-1' });
    expect(assertWorkspacePath).toHaveBeenCalledWith('/workspace');
    expect(discover).toHaveBeenCalledWith({
      provider: 'codex-sdk',
      workspacePath: '/canonical/workspace',
      conversationId: null,
      forceRefresh: true,
    });
  });

  it('rejects malformed providers and workspace paths before discovery', async () => {
    const discover = vi.fn();
    registerAgentCapabilityHandlers({
      service: { discover, resolve: vi.fn() },
      assertWorkspacePath: vi.fn(),
    });

    await expect(
      registeredHandler('agentCapabilities:discover')(
        {},
        { provider: 'made-up-provider', workspacePath: null }
      )
    ).rejects.toThrow('Invalid agent capability discovery request');
    await expect(
      registeredHandler('agentCapabilities:discover')(
        {},
        { provider: 'codex-sdk', workspacePath: 'relative/workspace' }
      )
    ).rejects.toThrow('absolute');
    expect(discover).not.toHaveBeenCalled();
  });

  it('passes only validated immutable selections to the service', async () => {
    const resolve = vi.fn(() => ({ ok: false as const, reason: 'stale-snapshot' as const }));
    registerAgentCapabilityHandlers({
      service: { discover: vi.fn(), resolve },
      assertWorkspacePath: vi.fn(),
    });

    await expect(
      registeredHandler('agentCapabilities:resolve')(
        {},
        {
          snapshotId: 'snapshot-1',
          provider: 'grok-acp',
          capabilityId: 'grok-acp:command:review',
        }
      )
    ).resolves.toEqual({ ok: false, reason: 'stale-snapshot' });
    expect(resolve).toHaveBeenCalledWith({
      snapshotId: 'snapshot-1',
      provider: 'grok-acp',
      capabilityId: 'grok-acp:command:review',
    });
  });

  it('reads a selected skill through the immutable snapshot boundary', async () => {
    const inspectSkill = vi.fn(async () => ({
      ok: true as const,
      skill: {
        document: '# Sequence audit\n',
        sourcePath: '~/.codex/skills/sequence-audit/SKILL.md',
        files: [{ path: 'SKILL.md', byteCount: 17 }],
      },
    }));
    registerAgentCapabilityHandlers({
      service: { discover: vi.fn(), resolve: vi.fn(), inspectSkill },
      assertWorkspacePath: vi.fn(),
    });

    const selection = {
      snapshotId: 'snapshot-1',
      provider: 'codex-sdk',
      capabilityId: 'codex-sdk:skill:sequence-audit',
    } as const;
    await expect(
      registeredHandler('agentCapabilities:inspectSkill')({}, { selection })
    ).resolves.toMatchObject({ ok: true, skill: { document: '# Sequence audit\n' } });
    expect(inspectSkill).toHaveBeenCalledWith(selection);
  });

  it('forks a durable conversation', async () => {
    const forkConversation = vi.fn(() => ({
      ok: true as const,
      conversationId: 'conversation-forked',
      parentConversationId: 'conversation-parent',
    }));
    registerAgentCapabilityHandlers({
      service: { discover: vi.fn(), resolve: vi.fn() },
      assertWorkspacePath: vi.fn(async () => '/canonical/workspace'),
      forkConversation,
    });

    await expect(
      registeredHandler('agentCapabilities:forkConversation')(
        {},
        { conversationId: 'conversation-parent' }
      )
    ).resolves.toMatchObject({ ok: true, conversationId: 'conversation-forked' });
    expect(forkConversation).toHaveBeenCalledWith('conversation-parent');
  });

  it('persists managed commands and memory, then invalidates stale catalogs', async () => {
    const invalidate = vi.fn();
    const extensionStore = {
      list: vi.fn(async () => ({ commands: [], skills: [] })),
      saveCommand: vi.fn(async (request) => ({
        ...request,
        id: 'command-1',
        createdAt: 1,
        updatedAt: 1,
      })),
      removeCommand: vi.fn(async () => undefined),
      saveSkill: vi.fn(),
      importSkill: vi.fn(),
      setSkillEnabled: vi.fn(),
      setProviderSkillPolicy: vi.fn(),
      removeProviderSkillPolicy: vi.fn(),
      removeSkill: vi.fn(),
    };
    const memoryStore = {
      list: vi.fn(async () => ({ memory: [] })),
      saveMemory: vi.fn(async (request) => ({
        ...request,
        id: 'memory-1',
        createdAt: 1,
        updatedAt: 1,
      })),
      removeMemory: vi.fn(async () => undefined),
    };
    registerAgentCapabilityHandlers({
      service: { discover: vi.fn(), resolve: vi.fn(), invalidate },
      assertWorkspacePath: vi.fn(async () => '/canonical/workspace'),
      extensionStore,
      memoryStore,
    });

    await expect(
      registeredHandler('agentCapabilities:saveCommand')(
        {},
        {
          name: 'review',
          description: 'Review work.',
          instructions: 'Review carefully.',
          provider: 'all',
          scope: 'workspace',
          workspacePath: '/workspace',
        }
      )
    ).resolves.toEqual({ ok: true });
    expect(extensionStore.saveCommand).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: '/canonical/workspace' })
    );

    await expect(
      registeredHandler('agentCapabilities:saveMemory')(
        {},
        {
          name: 'Organism',
          content: 'E. coli K-12',
          provider: 'codex-sdk',
          scope: 'global',
          workspacePath: null,
          conversationId: null,
        }
      )
    ).resolves.toEqual({ ok: true });
    expect(memoryStore.saveMemory).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('imports, creates, and toggles managed skills through validated IPC', async () => {
    const invalidate = vi.fn();
    const extensionStore = {
      list: vi.fn(async () => ({ commands: [], skills: [] })),
      saveCommand: vi.fn(),
      removeCommand: vi.fn(),
      importSkill: vi.fn(async (request) => ({ ...request, id: 'skill-1' })),
      saveSkill: vi.fn(async (request) => ({ ...request, id: 'skill-2' })),
      setSkillEnabled: vi.fn(async (request) => request),
      setProviderSkillPolicy: vi.fn(async (request) => ({ ...request, id: 'policy-1' })),
      removeProviderSkillPolicy: vi.fn(),
      removeSkill: vi.fn(async () => undefined),
    };
    const assertWorkspacePath = vi.fn(async (path: string) => `/allowed${path}`);
    registerAgentCapabilityHandlers({
      service: { discover: vi.fn(), resolve: vi.fn(), invalidate },
      extensionStore,
      memoryStore: {
        list: vi.fn(async () => ({ memory: [] })),
        saveMemory: vi.fn(),
        removeMemory: vi.fn(),
      },
      assertWorkspacePath,
    });

    await expect(
      registeredHandler('agentCapabilities:importSkill')(
        {},
        {
          sourcePath: '/chosen-skill',
          provider: 'all',
          scope: 'global',
          workspacePath: null,
        }
      )
    ).resolves.toEqual({ ok: true });
    expect(extensionStore.importSkill).toHaveBeenCalledWith({
      sourcePath: '/allowed/chosen-skill',
      provider: 'all',
      scope: 'global',
      workspacePath: null,
    });

    await expect(
      registeredHandler('agentCapabilities:saveSkill')(
        {},
        {
          name: 'primer-review',
          description: 'Review primers.',
          instructions: 'Check specificity.',
          provider: 'all',
          scope: 'global',
          workspacePath: null,
          enabled: true,
        }
      )
    ).resolves.toEqual({ ok: true });
    await expect(
      registeredHandler('agentCapabilities:setSkillEnabled')({}, { id: 'skill-1', enabled: false })
    ).resolves.toEqual({ ok: true });
    expect(extensionStore.setSkillEnabled).toHaveBeenCalledWith({ id: 'skill-1', enabled: false });
    await expect(
      registeredHandler('agentCapabilities:removeSkill')({}, { id: 'skill-1' })
    ).resolves.toEqual({ ok: true });
    expect(extensionStore.removeSkill).toHaveBeenCalledWith('skill-1');
    expect(invalidate).toHaveBeenCalledTimes(4);
  });

  it('lists, reviews, and installs catalog skills only through the main-owned review token', async () => {
    const catalog = {
      listPacks: vi.fn(() => [
        {
          id: 'fixture-biology',
          name: 'Fixture Biology',
          publisher: 'Fixture Lab',
          description: 'Fixture source.',
          repositoryUrl: 'https://github.com/fixture/biology',
          delivery: 'dnaforge' as const,
          provider: null,
          trust: 'community' as const,
          repositoryLicense: 'MIT',
        },
      ]),
      browsePack: vi.fn(async () => ({ snapshotId: 'catalog-snapshot-1' })),
      reviewSkill: vi.fn(async () => ({
        ok: true as const,
        reviewToken: 'review-token-1',
        skill: { name: 'crispr-guide-audit' },
      })),
      installSkill: vi.fn(async () => ({ ok: true as const, skillId: 'skill-1' })),
    };
    const invalidate = vi.fn();
    registerAgentCapabilityHandlers({
      service: { discover: vi.fn(), resolve: vi.fn(), invalidate },
      skillCatalog: catalog as never,
      assertWorkspacePath: vi.fn(async () => '/canonical/workspace'),
    });

    await expect(
      registeredHandler('agentCapabilities:listSkillPacks')({}, undefined)
    ).resolves.toHaveLength(1);
    await expect(
      registeredHandler('agentCapabilities:browseSkillPack')({}, { packId: 'fixture-biology' })
    ).resolves.toEqual({ ok: true, snapshot: { snapshotId: 'catalog-snapshot-1' } });
    await expect(
      registeredHandler('agentCapabilities:reviewCatalogSkill')(
        {},
        { snapshotId: 'catalog-snapshot-1', skillId: 'skills/crispr-guide-audit' }
      )
    ).resolves.toMatchObject({ ok: true, reviewToken: 'review-token-1' });
    await expect(
      registeredHandler('agentCapabilities:installCatalogSkill')(
        {},
        {
          reviewToken: 'review-token-1',
          provider: 'all',
          scope: 'workspace',
          workspacePath: '/workspace',
        }
      )
    ).resolves.toEqual({ ok: true, skillId: 'skill-1' });
    expect(catalog.installSkill).toHaveBeenCalledWith({
      reviewToken: 'review-token-1',
      provider: 'all',
      scope: 'workspace',
      workspacePath: '/canonical/workspace',
    });
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it('stores a DNAForge-only enable policy after revalidating a native skill selection', async () => {
    const setProviderSkillPolicy = vi.fn(async (request) => ({ ...request, id: 'policy-1' }));
    const removeProviderSkillPolicy = vi.fn(async () => undefined);
    const invalidate = vi.fn();
    registerAgentCapabilityHandlers({
      service: {
        discover: vi.fn(),
        resolve: vi.fn(),
        invalidate,
        inspectContext: vi.fn(() => ({
          ok: true,
          snapshot: {},
          control: {
            kind: 'skill',
            nativeId: 'native-primer-review',
            provider: 'codex-sdk',
            source: 'codex-skills-list',
          },
        })) as never,
      },
      extensionStore: {
        list: vi.fn(),
        saveCommand: vi.fn(),
        removeCommand: vi.fn(),
        saveSkill: vi.fn(),
        importSkill: vi.fn(),
        setSkillEnabled: vi.fn(),
        setProviderSkillPolicy,
        removeProviderSkillPolicy,
        removeSkill: vi.fn(),
      },
      assertWorkspacePath: vi.fn(async () => '/canonical/workspace'),
    });

    await expect(
      registeredHandler('agentCapabilities:setProviderSkillEnabled')(
        {},
        {
          selection: {
            snapshotId: 'snapshot-1',
            provider: 'codex-sdk',
            capabilityId: 'codex-sdk:skill:native-primer-review',
          },
          enabled: false,
          scope: 'workspace',
          workspacePath: '/workspace',
        }
      )
    ).resolves.toEqual({ ok: true });
    expect(setProviderSkillPolicy).toHaveBeenCalledWith({
      provider: 'codex-sdk',
      nativeId: 'native-primer-review',
      enabled: false,
      scope: 'workspace',
      workspacePath: '/canonical/workspace',
    });
    expect(invalidate).toHaveBeenCalledWith('codex-sdk');

    await expect(
      registeredHandler('agentCapabilities:setProviderSkillEnabled')(
        {},
        {
          selection: {
            snapshotId: 'snapshot-1',
            provider: 'codex-sdk',
            capabilityId: 'codex-sdk:skill:native-primer-review',
          },
          inheritGlobal: true,
          scope: 'workspace',
          workspacePath: '/workspace',
        }
      )
    ).resolves.toEqual({ ok: true });
    expect(removeProviderSkillPolicy).toHaveBeenCalledWith({
      provider: 'codex-sdk',
      nativeId: 'native-primer-review',
      scope: 'workspace',
      workspacePath: '/canonical/workspace',
    });
  });

  it('removes only a plugin from the inspected Codex snapshot', async () => {
    const removeProviderPlugin = vi.fn(async () => undefined);
    const invalidate = vi.fn();
    registerAgentCapabilityHandlers({
      service: {
        discover: vi.fn(),
        resolve: vi.fn(),
        invalidate,
        inspectContext: vi.fn(() => ({
          ok: true,
          snapshot: {},
          control: {
            kind: 'plugin',
            nativeId: 'plugin-123',
            provider: 'codex-sdk',
          },
        })) as never,
      },
      removeProviderPlugin,
    });

    await expect(
      registeredHandler('agentCapabilities:removeProviderPlugin')(
        {},
        {
          selection: {
            snapshotId: 'snapshot-1',
            provider: 'codex-sdk',
            capabilityId: 'codex-sdk:plugin:plugin-123',
          },
        }
      )
    ).resolves.toEqual({ ok: true });
    expect(removeProviderPlugin).toHaveBeenCalledWith('plugin-123', null, 'codex-sdk', 'uninstall');
    expect(invalidate).toHaveBeenCalledWith('codex-sdk');
  });

  it('inspects and installs only a revalidated Codex plugin in the canonical workspace', async () => {
    const inspectProviderPlugin = vi.fn(async () => ({ id: 'plugin-123', name: 'Lab tools' }));
    const installProviderPlugin = vi.fn(async () => undefined);
    const invalidate = vi.fn();
    const inspectContext = vi.fn(() => ({
      ok: true,
      snapshot: {},
      control: { kind: 'plugin', nativeId: 'plugin-123', provider: 'codex-sdk' },
    })) as never;
    registerAgentCapabilityHandlers({
      service: { discover: vi.fn(), resolve: vi.fn(), invalidate, inspectContext },
      assertWorkspacePath: vi.fn(async () => '/canonical/workspace'),
      inspectProviderPlugin: inspectProviderPlugin as never,
      installProviderPlugin,
    });
    const request = {
      selection: {
        snapshotId: 'snapshot-1',
        provider: 'codex-sdk',
        capabilityId: 'codex-sdk:plugin:plugin-123',
      },
      workspacePath: '/workspace',
    };

    await expect(
      registeredHandler('agentCapabilities:inspectProviderPlugin')({}, request)
    ).resolves.toEqual({ ok: true, plugin: { id: 'plugin-123', name: 'Lab tools' } });
    await expect(
      registeredHandler('agentCapabilities:installProviderPlugin')({}, request)
    ).resolves.toEqual({ ok: true });

    expect(inspectContext).toHaveBeenCalledTimes(2);
    expect(inspectProviderPlugin).toHaveBeenCalledWith(
      'plugin-123',
      '/canonical/workspace',
      'codex-sdk'
    );
    expect(installProviderPlugin).toHaveBeenCalledWith(
      'plugin-123',
      '/canonical/workspace',
      'codex-sdk'
    );
    expect(invalidate).toHaveBeenCalledWith('codex-sdk');
  });

  it('routes an explicit Claude disable through the same typed plugin boundary', async () => {
    const removeProviderPlugin = vi.fn(async () => undefined);
    const invalidate = vi.fn();
    registerAgentCapabilityHandlers({
      service: {
        discover: vi.fn(),
        resolve: vi.fn(),
        invalidate,
        inspectContext: vi.fn(() => ({
          ok: true,
          snapshot: {},
          control: {
            kind: 'plugin',
            nativeId: 'feature-dev@official',
            provider: 'claude-agent-sdk',
          },
        })) as never,
      },
      assertWorkspacePath: vi.fn(async () => '/canonical/workspace'),
      removeProviderPlugin,
    });

    await expect(
      registeredHandler('agentCapabilities:removeProviderPlugin')(
        {},
        {
          selection: {
            snapshotId: 'snapshot-claude',
            provider: 'claude-agent-sdk',
            capabilityId: 'claude-agent-sdk:plugin:feature-dev@official',
          },
          workspacePath: '/workspace',
          action: 'disable',
        }
      )
    ).resolves.toEqual({ ok: true });
    expect(removeProviderPlugin).toHaveBeenCalledWith(
      'feature-dev@official',
      '/canonical/workspace',
      'claude-agent-sdk',
      'disable'
    );
    expect(invalidate).toHaveBeenCalledWith('claude-agent-sdk');
  });

  it('routes Grok plugin disable through the typed main-process boundary', async () => {
    const removeProviderPlugin = vi.fn(async () => undefined);
    const invalidate = vi.fn();
    registerAgentCapabilityHandlers({
      service: {
        discover: vi.fn(),
        resolve: vi.fn(),
        invalidate,
        inspectContext: vi.fn(() => ({
          ok: true,
          snapshot: {},
          control: {
            kind: 'plugin',
            nativeId: 'laboratory@abc123',
            provider: 'grok-acp',
          },
        })) as never,
      },
      assertWorkspacePath: vi.fn(async () => '/canonical/workspace'),
      removeProviderPlugin,
    });

    await expect(
      registeredHandler('agentCapabilities:removeProviderPlugin')(
        {},
        {
          selection: {
            snapshotId: 'snapshot-grok',
            provider: 'grok-acp',
            capabilityId: 'grok-acp:plugin:laboratory@abc123',
          },
          workspacePath: '/workspace',
          action: 'disable',
        }
      )
    ).resolves.toEqual({ ok: true });
    expect(removeProviderPlugin).toHaveBeenCalledWith(
      'laboratory@abc123',
      '/canonical/workspace',
      'grok-acp',
      'disable'
    );
    expect(invalidate).toHaveBeenCalledWith('grok-acp');
  });
});
