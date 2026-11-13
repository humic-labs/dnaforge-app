import type { AgentTransport } from '../../platform';

export type InstallOS = 'darwin' | 'win32' | 'linux';

export interface InstallCommand {
  label: string;
  command: string;
}

export interface CliInstallInfo {
  cliLabel: string;
  primary: InstallCommand;
  alternatives: InstallCommand[];
  docUrl: string;
  note?: string;
}

export function normalizeInstallOS(platform: string): InstallOS {
  if (platform === 'win32') return 'win32';
  if (platform === 'darwin') return 'darwin';
  return 'linux';
}

const NPM_NEEDS_NODE = 'npm commands require Node.js (https://nodejs.org).';

function codexInstall(os: InstallOS): CliInstallInfo {
  const npm: InstallCommand = { label: 'npm', command: 'npm install -g @openai/codex' };
  const docUrl = 'https://github.com/openai/codex';
  if (os === 'darwin') {
    return {
      cliLabel: 'Codex CLI',
      primary: npm,
      alternatives: [{ label: 'Homebrew', command: 'brew install --cask codex' }],
      docUrl,
      note: NPM_NEEDS_NODE,
    };
  }
  return { cliLabel: 'Codex CLI', primary: npm, alternatives: [], docUrl, note: NPM_NEEDS_NODE };
}

function claudeInstall(os: InstallOS): CliInstallInfo {
  const npm: InstallCommand = {
    label: 'npm',
    command: 'npm install -g @anthropic-ai/claude-code',
  };
  const docUrl = 'https://code.claude.com/docs/en/setup';
  if (os === 'win32') {
    return {
      cliLabel: 'Claude Code CLI',
      primary: {
        label: 'Native installer (PowerShell)',
        command: 'irm https://claude.ai/install.ps1 | iex',
      },
      alternatives: [npm],
      docUrl,
    };
  }
  const alternatives: InstallCommand[] = [npm];
  if (os === 'darwin') {
    alternatives.unshift({ label: 'Homebrew', command: 'brew install --cask claude-code' });
  }
  return {
    cliLabel: 'Claude Code CLI',
    primary: {
      label: 'Native installer',
      command: 'curl -fsSL https://claude.ai/install.sh | bash',
    },
    alternatives,
    docUrl,
  };
}

function grokInstall(os: InstallOS): CliInstallInfo {
  const npm: InstallCommand = {
    label: 'npm',
    command: 'npm install -g @xai-official/grok',
  };
  const docUrl = 'https://docs.x.ai/build/overview';
  if (os === 'win32') {
    return { cliLabel: 'Grok Build', primary: npm, alternatives: [], docUrl, note: NPM_NEEDS_NODE };
  }
  return {
    cliLabel: 'Grok Build',
    primary: {
      label: 'Native installer',
      command: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    },
    alternatives: [npm],
    docUrl,
  };
}

export function getCliInstallCommands(transport: AgentTransport, platform: string): CliInstallInfo {
  const os = normalizeInstallOS(platform);
  switch (transport) {
    case 'codex-sdk':
      return codexInstall(os);
    case 'claude-agent-sdk':
      return claudeInstall(os);
    case 'grok-acp':
      return grokInstall(os);
    default: {
      const _exhaustive: never = transport;
      void _exhaustive;
      return claudeInstall(os);
    }
  }
}
