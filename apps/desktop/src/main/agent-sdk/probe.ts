import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { AgentSdkDetection } from './detect';
import { trackAgentHelperOperation } from './helper-lifecycle';
import { subprocessEnv, type SubprocessTarget } from './subprocess-env';

const execFileAsync = promisify(execFile);

export type ProbeTransport = 'codex-sdk' | 'claude-agent-sdk' | 'grok-acp';

export type ProbeSupport = 'supported' | 'not_supported' | 'not_required' | 'unknown';

export type ProbeToolAccess = 'native_tools_enabled' | 'read_only' | 'none';

export type ProbePermissionMode = 'interactive' | 'non_interactive' | 'unknown' | 'unsupported';

export type ProbeReleaseMode = 'local_cli_with_consent' | 'read_only' | 'dev_only' | 'unsupported';

export type ProbeStopState = 'cancelled' | 'stop_requested' | 'unsupported';

export interface ProviderProbeInput {
  transport: ProbeTransport;
  cliInstalled: boolean;
  authenticated: boolean;
  sdkVersion: string | null;
  cliVersion: string | null;
  toolAccess: ProbeToolAccess;
  permission: {
    mode: ProbePermissionMode;
    promptSurface: ProbeSupport;
    nonInteractiveDenial: ProbeSupport;
  };
  stop: {
    modelStream: ProbeSupport;
    providerTool: ProbeSupport;
    childProcessReaping: ProbeSupport;
    mechanisms: string[];
  };
}

export interface ProviderProbeResult extends ProviderProbeInput {
  releaseMode: ProbeReleaseMode;
  stop: ProviderProbeInput['stop'] & {
    userVisibleStopState: ProbeStopState;
  };
  warnings: string[];
}

export interface ProviderProbeVersions {
  codexSdkVersion: string | null;
  claudeSdkVersion: string | null;
  grokAcpSdkVersion: string | null;
  codexCliVersion?: string | null;
  claudeCliVersion?: string | null;
  grokCliVersion?: string | null;
}

export type PackageVersionResolver = (packageName: string) => Promise<string | null>;

const PROVIDER_PACKAGE_NAMES = {
  codex: '@openai/codex-sdk',
  claude: '@anthropic-ai/claude-agent-sdk',
  grokAcp: '@agentclientprotocol/sdk',
} as const;

function isAuthenticated(auth: string): boolean {
  return auth === 'authenticated';
}

function classifyStopState(input: ProviderProbeInput, warnings: string[]): ProbeStopState {
  if (!input.cliInstalled || !input.authenticated) return 'unsupported';

  if (input.stop.modelStream !== 'supported') {
    warnings.push('Model-stream stop propagation is not proven.');
    return 'stop_requested';
  }

  if (input.toolAccess === 'native_tools_enabled') {
    if (input.stop.childProcessReaping === 'supported') return 'cancelled';
    if (input.stop.childProcessReaping === 'not_supported') {
      warnings.push('Child process reaping is not supported; UI may only report stop_requested.');
      return 'stop_requested';
    }
    warnings.push('Child process reaping is not proven; UI may only report stop_requested.');
    return 'stop_requested';
  }

  return 'cancelled';
}

function classifyReleaseMode(
  input: ProviderProbeInput,
  stopState: ProbeStopState,
  warnings: string[]
): ProbeReleaseMode {
  if (!input.cliInstalled || !input.authenticated) return 'unsupported';

  if (input.stop.modelStream !== 'supported') return 'dev_only';

  if (input.toolAccess === 'read_only' || input.toolAccess === 'none') {
    return 'read_only';
  }

  if (input.permission.mode === 'unknown') {
    warnings.push(
      'Native tool permission behavior is unknown; do not expose this provider outside development.'
    );
    return 'dev_only';
  }

  if (input.permission.mode === 'unsupported') {
    warnings.push('Native tool permissions are unsupported for this provider route.');
    return 'dev_only';
  }

  if (stopState !== 'cancelled') return 'dev_only';

  return 'local_cli_with_consent';
}

export function classifyProviderProbe(input: ProviderProbeInput): ProviderProbeResult {
  const warnings: string[] = [];

  if (!input.cliInstalled) {
    warnings.push('Provider CLI is not installed.');
  }
  if (input.cliInstalled && !input.authenticated) {
    warnings.push('Provider CLI is not authenticated.');
  }

  const unsupported = !input.cliInstalled || !input.authenticated;
  const permission = unsupported
    ? {
        mode: 'unsupported' as const,
        promptSurface: 'not_supported' as const,
        nonInteractiveDenial: 'not_supported' as const,
      }
    : input.permission;

  const normalizedInput: ProviderProbeInput = { ...input, permission };
  const userVisibleStopState = classifyStopState(normalizedInput, warnings);
  const releaseMode = classifyReleaseMode(normalizedInput, userVisibleStopState, warnings);

  return {
    ...normalizedInput,
    releaseMode,
    stop: {
      ...normalizedInput.stop,
      userVisibleStopState,
    },
    warnings,
  };
}

export function buildStaticProviderProbeMatrix(
  detection: AgentSdkDetection,
  versions: ProviderProbeVersions
): ProviderProbeResult[] {
  const codex = classifyProviderProbe({
    transport: 'codex-sdk',
    cliInstalled: detection.codex.cli === 'installed',
    authenticated: isAuthenticated(detection.codex.auth),
    sdkVersion: versions.codexSdkVersion,
    cliVersion: versions.codexCliVersion ?? null,
    toolAccess: 'native_tools_enabled',
    permission: {
      mode: 'unknown',
      promptSurface: 'unknown',
      nonInteractiveDenial: 'unknown',
    },
    stop: {
      modelStream: 'supported',
      providerTool: 'unknown',
      childProcessReaping: 'not_supported',
      mechanisms: ['AbortSignal'],
    },
  });

  const claude = classifyProviderProbe({
    transport: 'claude-agent-sdk',
    cliInstalled: detection.claudeCode.cli === 'installed',
    authenticated: isAuthenticated(detection.claudeCode.auth),
    sdkVersion: versions.claudeSdkVersion,
    cliVersion: versions.claudeCliVersion ?? null,
    toolAccess: 'native_tools_enabled',
    permission: {
      mode: 'interactive',
      promptSurface: 'supported',
      nonInteractiveDenial: 'supported',
    },
    stop: {
      modelStream: 'supported',
      providerTool: 'unknown',
      childProcessReaping: 'not_supported',
      mechanisms: ['Options.abortController', 'Query.close'],
    },
  });

  const grok = classifyProviderProbe({
    transport: 'grok-acp',
    cliInstalled: detection.grok.cli === 'installed',
    authenticated: isAuthenticated(detection.grok.auth),
    sdkVersion: versions.grokAcpSdkVersion,
    cliVersion: versions.grokCliVersion ?? null,
    toolAccess: 'native_tools_enabled',
    permission: {
      mode: 'interactive',
      promptSurface: 'supported',
      nonInteractiveDenial: 'supported',
    },
    stop: {
      modelStream: 'supported',
      providerTool: 'supported',
      childProcessReaping: 'unknown',
      mechanisms: ['session/cancel', 'ACP connection close', 'SIGTERM'],
    },
  });

  return [codex, claude, grok];
}

function packageNameSegments(packageName: string): string[] {
  return packageName.split('/').filter((segment) => segment.length > 0);
}

export function resolvePackageVersionFromSearchRoots(
  packageName: string,
  searchRoots: string[]
): string | null {
  const segments = packageNameSegments(packageName);

  for (const searchRoot of searchRoots) {
    let current = searchRoot;
    const root = parse(current).root;
    while (current.length > 0) {
      const packageJsonPath = join(current, 'node_modules', ...segments, 'package.json');
      if (existsSync(packageJsonPath)) {
        try {
          const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
            version?: unknown;
          };
          return typeof parsed.version === 'string' ? parsed.version : null;
        } catch {
          return null;
        }
      }

      if (current === root) break;
      current = dirname(current);
    }
  }

  return null;
}

function packageVersionSearchRoots(): string[] {
  const roots = new Set<string>([process.cwd()]);
  try {
    roots.add(dirname(fileURLToPath(import.meta.url)));
  } catch {}
  return [...roots];
}

async function defaultPackageVersionResolver(packageName: string): Promise<string | null> {
  try {
    const require = createRequire(import.meta.url);
    const packageJson = require(`${packageName}/package.json`) as { version?: unknown };
    return typeof packageJson.version === 'string' ? packageJson.version : null;
  } catch {
    return resolvePackageVersionFromSearchRoots(packageName, packageVersionSearchRoots());
  }
}

export async function getProviderSdkVersions(
  resolvePackageVersion: PackageVersionResolver = defaultPackageVersionResolver
): Promise<
  Pick<ProviderProbeVersions, 'codexSdkVersion' | 'claudeSdkVersion' | 'grokAcpSdkVersion'>
> {
  const [codexSdkVersion, claudeSdkVersion, grokAcpSdkVersion] = await Promise.all([
    resolvePackageVersion(PROVIDER_PACKAGE_NAMES.codex),
    resolvePackageVersion(PROVIDER_PACKAGE_NAMES.claude),
    resolvePackageVersion(PROVIDER_PACKAGE_NAMES.grokAcp),
  ]);
  return { codexSdkVersion, claudeSdkVersion, grokAcpSdkVersion };
}

export async function getCliVersion(
  cliPath: string | null,
  target: SubprocessTarget
): Promise<string | null> {
  if (!cliPath) return null;
  try {
    const { stdout, stderr } = await execFileAsync(cliPath, ['--version'], {
      timeout: 2000,
      env: subprocessEnv(target),
    });
    const version = (stdout || stderr).split(/\r?\n/).find((line) => line.trim().length > 0);
    return version ? version.trim() : null;
  } catch {
    return null;
  }
}

export async function getProviderProbeVersions(
  detection: AgentSdkDetection
): Promise<ProviderProbeVersions> {
  return trackAgentHelperOperation(async () => {
    const [
      { codexSdkVersion, claudeSdkVersion, grokAcpSdkVersion },
      codexCliVersion,
      claudeCliVersion,
      grokCliVersion,
    ] = await Promise.all([
      getProviderSdkVersions(),
      getCliVersion(detection.codex.path, 'codex'),
      getCliVersion(detection.claudeCode.path, 'claude'),
      getCliVersion(detection.grok.path, 'grok'),
    ]);
    return {
      codexSdkVersion,
      claudeSdkVersion,
      grokAcpSdkVersion,
      codexCliVersion,
      claudeCliVersion,
      grokCliVersion,
    };
  });
}
