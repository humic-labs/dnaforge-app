import { describe, expect, it } from 'vitest';
import {
  canStartAuthorityProfile,
  collectProviderDescriptorContract,
  createClaudeProviderDescriptor,
  createCodexProviderDescriptor,
  createGrokProviderDescriptor,
  getProviderDescriptorContractFailures,
  migrateLegacyAuthorityProfileInput,
  resolveLegacyAuthorityProfileId,
  validateAuthorityProfileShape,
  validateConcreteAuthorityProfileInput,
  validateProviderSessionStartSpec,
} from '../index';
import type { AgentSdkDetection } from '../../agent-sdk/detect';
import type { ProviderDescriptorDependencies } from '../types';

const installedDetection: AgentSdkDetection = {
  claudeCode: {
    cli: 'installed',
    path: '/usr/local/bin/claude',
    auth: 'authenticated',
    defaultModel: 'claude-fable-5[1m]',
    keychainEntryPresent: true,
    credentialsFilePresent: null,
  },
  codex: {
    cli: 'installed',
    path: '/usr/local/bin/codex',
    auth: 'authenticated',
    defaultModel: 'gpt-5.5',
    authMode: 'chatgpt',
    authFilePresent: true,
  },
  grok: {
    cli: 'installed',
    path: '/usr/local/bin/grok',
    auth: 'authenticated',
    defaultModel: null,
    availableModels: [],
  },
};

const deps: ProviderDescriptorDependencies = {
  detectAgentSdk: async () => installedDetection,
  getProviderProbeVersions: async () => ({
    codexSdkVersion: '0.133.0',
    claudeSdkVersion: '0.3.150',
    codexCliVersion: 'codex-cli 0.136.0',
    claudeCliVersion: '2.1.161 (Claude Code)',
    grokAcpSdkVersion: '1.4.0',
    grokCliVersion: '1.0.13',
  }),
};

describe('agent provider descriptor parity contract', () => {
  it('runs the same descriptor parity harness against Codex, Claude, and Grok', async () => {
    const descriptors = [
      createCodexProviderDescriptor(deps),
      createClaudeProviderDescriptor(deps),
      createGrokProviderDescriptor(deps),
    ];

    for (const descriptor of descriptors) {
      const snapshot = await collectProviderDescriptorContract(descriptor);
      expect(getProviderDescriptorContractFailures(snapshot)).toEqual([]);
      expect(snapshot.profiles.map((profile) => profile.provider)).toEqual(
        snapshot.profiles.map(() => descriptor.provider)
      );
    }
  });

  it('reports provider auth, exact binary path, SDK version, and CLI version', async () => {
    const codex = await createCodexProviderDescriptor(deps).describeCapabilities();
    const claude = await createClaudeProviderDescriptor(deps).describeCapabilities();
    const grok = await createGrokProviderDescriptor(deps).describeCapabilities();

    expect(codex).toMatchObject({
      provider: 'codex-sdk',
      auth: 'authenticated',
      versions: {
        sdkVersion: '0.133.0',
        cliVersion: 'codex-cli 0.136.0',
        binaryPath: '/usr/local/bin/codex',
      },
    });
    expect(claude).toMatchObject({
      provider: 'claude-agent-sdk',
      auth: 'authenticated',
      versions: {
        sdkVersion: '0.3.150',
        cliVersion: '2.1.161 (Claude Code)',
        binaryPath: '/usr/local/bin/claude',
      },
    });
    expect(grok).toMatchObject({
      provider: 'grok-acp',
      auth: 'authenticated',
      versions: {
        sdkVersion: '1.4.0',
        cliVersion: '1.0.13',
        binaryPath: '/usr/local/bin/grok',
      },
      activity: {
        permissionEvents: { status: 'supported', evidence: 'declared' },
      },
      cancellation: {
        modelStop: { status: 'supported', evidence: 'declared' },
        activeToolStop: 'supported',
      },
      workspace: {
        cwd: { supported: true, evidence: 'declared' },
        additionalRoots: { supported: false, evidence: 'declared' },
      },
      mcp: {
        stdioServer: { supported: true, evidence: 'declared' },
        perTurnCorrelation: { supported: true, evidence: 'declared' },
      },
    });
    expect(codex.cancellation.childReaping).toMatchObject({
      status: 'unsupported',
      evidence: 'static_probe',
    });
    expect(claude.cancellation.childReaping).toMatchObject({
      status: 'unsupported',
      evidence: 'static_probe',
    });
  });

  it('allows a missing CLI to report no binary path without failing descriptor shape', async () => {
    const missingCodexDeps: ProviderDescriptorDependencies = {
      detectAgentSdk: async () => ({
        ...installedDetection,
        codex: {
          cli: 'missing',
          path: null,
          auth: 'unauthenticated',
          defaultModel: null,
          authMode: null,
          authFilePresent: false,
        },
      }),
      getProviderProbeVersions: async () => ({
        codexSdkVersion: '0.133.0',
        claudeSdkVersion: '0.3.150',
        codexCliVersion: null,
        claudeCliVersion: '2.1.161 (Claude Code)',
        grokAcpSdkVersion: '1.4.0',
        grokCliVersion: '1.0.13',
      }),
    };

    const snapshot = await collectProviderDescriptorContract(
      createCodexProviderDescriptor(missingCodexDeps)
    );

    expect(snapshot.capabilities).toMatchObject({
      auth: 'missing',
      versions: { binaryPath: null, cliVersion: null },
    });
    expect(getProviderDescriptorContractFailures(snapshot)).toEqual([]);
  });

  it('preserves an inconclusive Grok auth probe so the real CLI turn can decide', async () => {
    const inconclusiveGrokDeps: ProviderDescriptorDependencies = {
      ...deps,
      detectAgentSdk: async () => ({
        ...installedDetection,
        grok: {
          ...installedDetection.grok,
          auth: 'unknown',
        },
      }),
    };

    const capabilities =
      await createGrokProviderDescriptor(inconclusiveGrokDeps).describeCapabilities();

    expect(capabilities.auth).toBe('unknown');
  });

  it('exposes Claude standard CLI workspace write as startable while preserving the legacy blocked profile', async () => {
    const claudeProfiles = await createClaudeProviderDescriptor(deps).listAuthorityProfiles();
    const standard = claudeProfiles.find(
      (profile) => profile.id === 'claude-agent-sdk:native-workspace-write'
    );
    const blocked = claudeProfiles.find(
      (profile) => profile.id === 'claude-agent-sdk:native-workspace-write-blocked'
    );

    expect(standard).toMatchObject({
      authorityClass: 'native-workspace-write',
      releaseMode: 'production',
      userVisibleClaims: expect.arrayContaining([
        expect.objectContaining({ code: 'native_workspace_write' }),
        expect.objectContaining({ code: 'dnaforge_mcp_available' }),
      ]),
      unsupportedClaims: expect.arrayContaining([
        expect.objectContaining({ code: 'app_controls_native_cli_permissions' }),
      ]),
    });
    expect(
      canStartAuthorityProfile({
        profile: standard!,
        releaseChannel: 'production',
      })
    ).toEqual({ ok: true, reason: null });
    expect(blocked).toMatchObject({
      authorityClass: 'disabled',
      releaseMode: 'dev_only',
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: 'native_write_unresolved', blocksStart: true }),
      ]),
      unsupportedClaims: expect.arrayContaining([
        expect.objectContaining({ code: 'claude_native_write_parity' }),
      ]),
    });
    expect(
      canStartAuthorityProfile({
        profile: blocked!,
        releaseChannel: 'development',
      })
    ).toEqual({
      ok: false,
      reason: 'claude-agent-sdk:native-workspace-write-blocked is disabled.',
    });
  });

  it('fails profile validation for unknown typed claim/control/blocker codes', async () => {
    const [profile] = await createCodexProviderDescriptor(deps).listAuthorityProfiles();

    expect(
      validateAuthorityProfileShape({
        ...profile,
        userVisibleClaims: [{ code: 'vague_claim' as any, description: 'too vague' }],
      })
    ).toContain(`Profile ${profile.id} has unknown visible claim code vague_claim.`);
  });

  it('rejects generic permission labels on the new concrete start path', () => {
    expect(() =>
      validateConcreteAuthorityProfileInput({
        provider: 'codex-sdk',
        permissionMode: 'native-cli',
      })
    ).toThrow('A concrete provider authorityProfileId is required');
  });

  it('maps legacy route permission strings to concrete provider authority ids before start', () => {
    expect(
      resolveLegacyAuthorityProfileId({
        provider: 'codex-sdk',
        permissionMode: 'native-cli',
      })
    ).toBe('codex-sdk:native-workspace-write-dev');
    expect(
      resolveLegacyAuthorityProfileId({
        provider: 'claude-agent-sdk',
        permissionMode: 'native-cli',
      })
    ).toBe('claude-agent-sdk:native-workspace-write');
    expect(
      migrateLegacyAuthorityProfileInput({
        provider: 'claude-agent-sdk',
        permissionMode: 'app-supervised',
      })
    ).toEqual({
      provider: 'claude-agent-sdk',
      authorityProfileId: 'claude-agent-sdk:app-supervised',
    });
  });

  it('allows standard CLI profiles to start in production while blocking disabled profiles', () => {
    expect(
      validateProviderSessionStartSpec({
        provider: 'codex-sdk',
        authorityProfileId: 'codex-sdk:native-workspace-write-dev',
        cwd: '/workspace',
        releaseChannel: 'production',
      })
    ).toMatchObject({
      id: 'codex-sdk:native-workspace-write-dev',
      authorityClass: 'native-workspace-write',
    });

    expect(
      validateProviderSessionStartSpec({
        provider: 'claude-agent-sdk',
        authorityProfileId: 'claude-agent-sdk:native-workspace-write',
        cwd: '/workspace',
        releaseChannel: 'production',
      })
    ).toMatchObject({
      id: 'claude-agent-sdk:native-workspace-write',
      authorityClass: 'native-workspace-write',
    });

    expect(
      validateProviderSessionStartSpec({
        provider: 'grok-acp',
        authorityProfileId: 'grok-acp:native-workspace-write',
        cwd: '/workspace',
        releaseChannel: 'production',
      })
    ).toMatchObject({
      id: 'grok-acp:native-workspace-write',
      authorityClass: 'native-workspace-write',
    });

    expect(() =>
      validateProviderSessionStartSpec({
        provider: 'claude-agent-sdk',
        authorityProfileId: 'claude-agent-sdk:native-workspace-write-blocked',
        cwd: '/workspace',
        releaseChannel: 'development',
      })
    ).toThrow('disabled');

    expect(() =>
      validateProviderSessionStartSpec({
        provider: 'grok-acp',
        authorityProfileId: 'grok-acp:app-supervised',
        cwd: '/workspace',
        releaseChannel: 'production',
      })
    ).toThrow('disabled');
  });

  it('classifies Stop honestly when child reaping is unsupported', () => {
    const descriptor = createCodexProviderDescriptor(deps);

    expect(
      descriptor.classifyTerminalState({
        abortRequested: true,
        activeToolRunning: true,
        childReaping: {
          status: 'unsupported',
          evidence: 'static_probe',
          notes: ['child survives provider stop'],
        },
      })
    ).toBe('stop_requested');
  });
});
