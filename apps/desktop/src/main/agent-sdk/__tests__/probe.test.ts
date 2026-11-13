import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildStaticProviderProbeMatrix,
  classifyProviderProbe,
  getProviderProbeVersions,
  getProviderSdkVersions,
  resolvePackageVersionFromSearchRoots,
  type ProviderProbeInput,
} from '../probe';
import type { AgentSdkDetection } from '../detect';

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
    defaultModel: 'grok-4.6',
    availableModels: ['grok-4.6', 'grok-4.5'],
  },
};

const baseProbe: ProviderProbeInput = {
  transport: 'codex-sdk',
  cliInstalled: true,
  authenticated: true,
  sdkVersion: '0.133.0',
  cliVersion: 'codex 1.0.0',
  toolAccess: 'native_tools_enabled',
  permission: {
    mode: 'unknown',
    promptSurface: 'unknown',
    nonInteractiveDenial: 'unknown',
  },
  stop: {
    modelStream: 'supported',
    providerTool: 'unknown',
    childProcessReaping: 'unknown',
    mechanisms: ['AbortSignal'],
  },
};

describe('provider permission/stop probe contract', () => {
  it('marks a missing or unauthenticated provider as unsupported', () => {
    const result = classifyProviderProbe({
      ...baseProbe,
      cliInstalled: false,
      authenticated: false,
    });

    expect(result.releaseMode).toBe('unsupported');
    expect(result.permission.mode).toBe('unsupported');
    expect(result.stop.userVisibleStopState).toBe('unsupported');
    expect(result.warnings).toContain('Provider CLI is not installed.');
  });

  it('keeps native-tool providers dev-only until permission behavior is known', () => {
    const result = classifyProviderProbe(baseProbe);

    expect(result.releaseMode).toBe('dev_only');
    expect(result.permission.mode).toBe('unknown');
    expect(result.warnings).toContain(
      'Native tool permission behavior is unknown; do not expose this provider outside development.'
    );
  });

  it('allows read-only provider mode when model-stream stop is proven', () => {
    const result = classifyProviderProbe({
      ...baseProbe,
      toolAccess: 'read_only',
      permission: {
        mode: 'non_interactive',
        promptSurface: 'not_supported',
        nonInteractiveDenial: 'supported',
      },
      stop: {
        modelStream: 'supported',
        providerTool: 'not_supported',
        childProcessReaping: 'not_required',
        mechanisms: ['AbortSignal'],
      },
    });

    expect(result.releaseMode).toBe('read_only');
    expect(result.stop.userVisibleStopState).toBe('cancelled');
    expect(result.warnings).toEqual([]);
  });

  it('requires proven child reaping before native-tool routes can claim cancelled', () => {
    const result = classifyProviderProbe({
      ...baseProbe,
      permission: {
        mode: 'interactive',
        promptSurface: 'supported',
        nonInteractiveDenial: 'supported',
      },
      stop: {
        modelStream: 'supported',
        providerTool: 'supported',
        childProcessReaping: 'unknown',
        mechanisms: ['Options.abortController', 'Query.close'],
      },
    });

    expect(result.releaseMode).toBe('dev_only');
    expect(result.stop.userVisibleStopState).toBe('stop_requested');
    expect(result.warnings).toContain(
      'Child process reaping is not proven; UI may only report stop_requested.'
    );
  });

  it('marks native-tool stop as stop_requested when child reaping is known unsupported', () => {
    const result = classifyProviderProbe({
      ...baseProbe,
      permission: {
        mode: 'interactive',
        promptSurface: 'supported',
        nonInteractiveDenial: 'supported',
      },
      stop: {
        modelStream: 'supported',
        providerTool: 'supported',
        childProcessReaping: 'not_supported',
        mechanisms: ['AbortSignal'],
      },
    });

    expect(result.releaseMode).toBe('dev_only');
    expect(result.stop.userVisibleStopState).toBe('stop_requested');
    expect(result.warnings).toContain(
      'Child process reaping is not supported; UI may only report stop_requested.'
    );
  });

  it('builds a conservative static probe matrix from detection results', () => {
    const rows = buildStaticProviderProbeMatrix(installedDetection, {
      codexSdkVersion: '0.133.0',
      claudeSdkVersion: '0.3.150',
      grokAcpSdkVersion: '1.4.0',
      codexCliVersion: 'codex 1.0.0',
      claudeCliVersion: 'claude 2.0.0',
      grokCliVersion: 'grok 1.0.13',
    });

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.transport)).toEqual(['codex-sdk', 'claude-agent-sdk', 'grok-acp']);
    expect(rows[0]).toMatchObject({
      transport: 'codex-sdk',
      releaseMode: 'dev_only',
      sdkVersion: '0.133.0',
      cliVersion: 'codex 1.0.0',
      stop: {
        modelStream: 'supported',
        childProcessReaping: 'not_supported',
        userVisibleStopState: 'stop_requested',
      },
    });
    expect(rows[1]).toMatchObject({
      transport: 'claude-agent-sdk',
      releaseMode: 'dev_only',
      sdkVersion: '0.3.150',
      cliVersion: 'claude 2.0.0',
      permission: {
        mode: 'interactive',
        promptSurface: 'supported',
      },
      stop: {
        modelStream: 'supported',
        childProcessReaping: 'not_supported',
        userVisibleStopState: 'stop_requested',
      },
    });
    expect(rows[2]).toMatchObject({
      transport: 'grok-acp',
      releaseMode: 'dev_only',
      sdkVersion: '1.4.0',
      cliVersion: 'grok 1.0.13',
      permission: {
        mode: 'interactive',
        promptSurface: 'supported',
      },
      stop: {
        modelStream: 'supported',
        providerTool: 'supported',
        childProcessReaping: 'unknown',
        userVisibleStopState: 'stop_requested',
      },
    });
  });

  it('resolves provider SDK versions through an injectable package resolver', async () => {
    await expect(
      getProviderSdkVersions(async (packageName) => {
        if (packageName === '@openai/codex-sdk') return '0.133.0';
        if (packageName === '@anthropic-ai/claude-agent-sdk') return '0.3.150';
        if (packageName === '@agentclientprotocol/sdk') return '1.4.0';
        return null;
      })
    ).resolves.toEqual({
      codexSdkVersion: '0.133.0',
      claudeSdkVersion: '0.3.150',
      grokAcpSdkVersion: '1.4.0',
    });
  });

  it('owns the complete provider-version batch in the main helper lifecycle', async () => {
    const { getAgentHelperLifecycleSnapshot } = await import('../helper-lifecycle');
    const before = getAgentHelperLifecycleSnapshot();
    const detectionWithoutCliPaths: AgentSdkDetection = {
      claudeCode: { ...installedDetection.claudeCode, path: null },
      codex: { ...installedDetection.codex, path: null },
      grok: { ...installedDetection.grok, path: null },
    };

    await getProviderProbeVersions(detectionWithoutCliPaths);

    const after = getAgentHelperLifecycleSnapshot();
    expect(after.started - before.started).toBe(1);
    expect(after.settled - before.settled).toBe(1);
    expect(after.active).toBe(0);
  });

  it('resolves package versions from node_modules package.json search roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'provider-probe-'));
    try {
      const packageDir = join(root, 'node_modules', '@vendor', 'hidden-package-json');
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ version: '1.2.3' }));

      expect(
        resolvePackageVersionFromSearchRoots('@vendor/hidden-package-json', [
          join(root, 'apps', 'desktop'),
        ])
      ).toBe('1.2.3');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
