import { describe, expect, it } from 'vitest';
import { getCliInstallCommands, normalizeInstallOS } from './cli-install-commands';

describe('normalizeInstallOS', () => {
  it('maps platform strings to the three install OSes', () => {
    expect(normalizeInstallOS('darwin')).toBe('darwin');
    expect(normalizeInstallOS('win32')).toBe('win32');
    expect(normalizeInstallOS('linux')).toBe('linux');
    expect(normalizeInstallOS('freebsd')).toBe('linux');
  });
});

describe('getCliInstallCommands — Codex', () => {
  it('uses npm as the primary on every OS (canonical cross-platform)', () => {
    for (const os of ['darwin', 'win32', 'linux']) {
      const info = getCliInstallCommands('codex-sdk', os);
      expect(info.cliLabel).toBe('Codex CLI');
      expect(info.primary.command).toBe('npm install -g @openai/codex');
    }
  });

  it('offers the Homebrew CASK (never a bare `brew install codex`) on macOS', () => {
    const info = getCliInstallCommands('codex-sdk', 'darwin');
    const brew = info.alternatives.find((a) => a.label === 'Homebrew');
    expect(brew?.command).toBe('brew install --cask codex');
    const all = [info.primary, ...info.alternatives].map((c) => c.command);
    expect(all).not.toContain('brew install codex');
  });

  it('does not show Homebrew on linux/windows', () => {
    expect(getCliInstallCommands('codex-sdk', 'linux').alternatives).toHaveLength(0);
    expect(getCliInstallCommands('codex-sdk', 'win32').alternatives).toHaveLength(0);
  });
});

describe('getCliInstallCommands — Claude Code', () => {
  it('leads with the native installer on macOS/linux (npm prefix is the stripped dir)', () => {
    for (const os of ['darwin', 'linux']) {
      const info = getCliInstallCommands('claude-agent-sdk', os);
      expect(info.cliLabel).toBe('Claude Code CLI');
      expect(info.primary.command).toBe('curl -fsSL https://claude.ai/install.sh | bash');
      expect(info.alternatives.map((a) => a.command)).toContain(
        'npm install -g @anthropic-ai/claude-code'
      );
    }
  });

  it('uses the PowerShell native installer on Windows', () => {
    const info = getCliInstallCommands('claude-agent-sdk', 'win32');
    expect(info.primary.command).toBe('irm https://claude.ai/install.ps1 | iex');
    expect(info.alternatives.map((a) => a.command)).toContain(
      'npm install -g @anthropic-ai/claude-code'
    );
  });

  it('offers the Homebrew cask only on macOS', () => {
    const mac = getCliInstallCommands('claude-agent-sdk', 'darwin');
    expect(mac.alternatives.map((a) => a.command)).toContain('brew install --cask claude-code');
    const linux = getCliInstallCommands('claude-agent-sdk', 'linux');
    expect(linux.alternatives.map((a) => a.command)).not.toContain(
      'brew install --cask claude-code'
    );
  });

  it('points at the canonical setup docs', () => {
    expect(getCliInstallCommands('claude-agent-sdk', 'darwin').docUrl).toContain('claude.com');
    expect(getCliInstallCommands('codex-sdk', 'darwin').docUrl).toContain(
      'github.com/openai/codex'
    );
  });
});
