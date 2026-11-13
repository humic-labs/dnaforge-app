import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CliInstallInstructions } from './CliInstallInstructions';

function getCmd(testid: string): string {
  return screen.getByTestId(testid).textContent ?? '';
}

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe('CliInstallInstructions', () => {
  it('shows the OS-specific install command for Codex on macOS', () => {
    render(<CliInstallInstructions transport="codex-sdk" os="darwin" onRecheck={vi.fn()} />);
    expect(getCmd('cli-install-command-codex-sdk')).toContain('npm install -g @openai/codex');
  });

  it('leads with the native installer for Claude Code on macOS', () => {
    render(<CliInstallInstructions transport="claude-agent-sdk" os="darwin" onRecheck={vi.fn()} />);
    expect(getCmd('cli-install-command-claude-agent-sdk')).toContain(
      'curl -fsSL https://claude.ai/install.sh | bash'
    );
  });

  it('copies the command and confirms with a Copied state', async () => {
    render(<CliInstallInstructions transport="codex-sdk" os="darwin" onRecheck={vi.fn()} />);
    fireEvent.click(screen.getByTestId('cli-install-copy-codex-sdk'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('npm install -g @openai/codex');
    await waitFor(() =>
      expect(screen.getByTestId('cli-install-copy-codex-sdk').textContent).toContain('Copied')
    );
  });

  it('re-checks via onRecheck and shows the "still not found" hint when it stays missing', async () => {
    const onRecheck = vi.fn().mockResolvedValue({ codex: {}, claudeCode: {} });
    render(
      <CliInstallInstructions
        transport="codex-sdk"
        os="darwin"
        searchedDirs={['/usr/bin', '/opt/homebrew/bin', '/Users/x/.codex/bin']}
        onRecheck={onRecheck}
      />
    );
    expect(screen.queryByTestId('cli-install-still-missing-codex-sdk')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('cli-install-recheck-codex-sdk'));
    });

    expect(onRecheck).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByTestId('cli-install-still-missing-codex-sdk')).toBeTruthy()
    );

    fireEvent.click(screen.getByTestId('cli-install-diagnostic-toggle-codex-sdk'));
    const searched = screen.getByTestId('cli-install-searched-dirs-codex-sdk').textContent ?? '';
    expect(searched).toContain('/Users/x/.codex/bin');
    expect(searched).toContain('/opt/homebrew/bin');
  });

  it('does NOT claim "Copied" when the clipboard write fails (review fix)', async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    render(<CliInstallInstructions transport="codex-sdk" os="darwin" onRecheck={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('cli-install-copy-codex-sdk'));
      await Promise.resolve();
    });
    expect(screen.getByTestId('cli-install-copy-codex-sdk').textContent).not.toContain('Copied');
  });

  it('on a detection ERROR (null) shows the error note, NOT a contradictory "still not found"', async () => {
    const onRecheck = vi.fn().mockResolvedValue(null);
    render(<CliInstallInstructions transport="codex-sdk" os="darwin" onRecheck={onRecheck} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('cli-install-recheck-codex-sdk'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('cli-install-recheck-error-codex-sdk')).toBeTruthy()
    );
    expect(screen.queryByTestId('cli-install-still-missing-codex-sdk')).toBeNull();
  });

  it('links to the install docs', () => {
    render(<CliInstallInstructions transport="claude-agent-sdk" os="win32" onRecheck={vi.fn()} />);
    const docs = screen.getByTestId('cli-install-docs-claude-agent-sdk');
    expect(docs.getAttribute('href')).toContain('claude.com');
    expect(getCmd('cli-install-command-claude-agent-sdk')).toContain(
      'irm https://claude.ai/install.ps1'
    );
  });
});
