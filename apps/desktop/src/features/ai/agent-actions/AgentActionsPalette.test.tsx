import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const discover = vi.fn();
const resolve = vi.fn();

vi.mock('../../../platform', () => ({
  platform: () => ({ agentCapabilities: { discover, resolve } }),
}));

import { AgentActionsPalette } from './AgentActionsPalette';

const command = {
  id: 'claude-agent-sdk:command:review',
  provider: 'claude-agent-sdk' as const,
  nativeId: 'review',
  kind: 'command' as const,
  label: '/review',
  description: 'Review current changes.',
  scope: 'session' as const,
  effects: ['instructions' as const],
  availability: { state: 'supported' as const },
  stages: {
    advertised: true,
    discoverable: true,
    invocable: true,
    visible: true,
    deterministic: true,
    liveQualified: false,
  },
};

const plugin = {
  ...command,
  id: 'claude-agent-sdk:plugin:lab-tools',
  nativeId: 'lab-tools',
  kind: 'plugin' as const,
  label: 'Lab tools',
  description: 'Installed provider plugin.',
  availability: {
    state: 'disabled-by-policy' as const,
    reason: 'Explicit enablement is required.',
  },
  stages: { ...command.stages, invocable: false },
};

const marketplacePlugin = {
  ...plugin,
  id: 'claude-agent-sdk:plugin:marketplace-only',
  nativeId: 'marketplace-only',
  label: 'Marketplace only',
  description: 'Available to install from Manage Extensions.',
  providerPlugin: {
    installed: false,
    enabled: false,
    updateAvailable: false,
    installable: true,
    removable: false,
    marketplace: 'official',
  },
};

const skill = {
  ...command,
  id: 'claude-agent-sdk:skill:tdd',
  nativeId: 'tdd',
  kind: 'skill' as const,
  label: 'tdd',
  description: 'Write a failing test first.',
};

const memory = {
  ...command,
  id: 'claude-agent-sdk:memory:lab-notes',
  nativeId: 'lab-notes',
  kind: 'memory' as const,
  label: 'Lab notes',
  description: 'Remember lab conventions.',
};

describe('AgentActionsPalette', () => {
  beforeEach(() => {
    discover.mockReset();
    resolve.mockReset();
    discover.mockResolvedValue({
      schemaVersion: 1,
      snapshotId: 'snapshot-1',
      provider: 'claude-agent-sdk',
      providerVersion: '1.0',
      accountFingerprint: null,
      workspaceFingerprint: null,
      capturedAt: 1,
      controls: [command, plugin, marketplacePlugin, skill, memory],
    });
  });

  it('discovers the selected provider and exposes separate capability groups', async () => {
    render(
      <AgentActionsPalette
        open
        provider="claude-agent-sdk"
        workspacePath="/workspace"
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    expect(await screen.findByText('/review')).toBeInTheDocument();
    expect(screen.getByText('Lab tools')).toBeInTheDocument();
    expect(screen.getByTestId('agent-actions-command')).toBeInTheDocument();
    expect(screen.getByTestId('agent-actions-plugin')).toBeInTheDocument();
    expect(screen.queryByText('tdd')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-actions-skill')).not.toBeInTheDocument();
    expect(screen.queryByText('Marketplace only')).not.toBeInTheDocument();
    expect(discover).toHaveBeenCalledWith({
      provider: 'claude-agent-sdk',
      workspacePath: '/workspace',
    });
    expect(screen.getByRole('button', { name: /Lab tools/i })).toBeDisabled();
  });

  it('filters locally and resolves the immutable selection before staging it', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    resolve.mockResolvedValue({ ok: true, control: command });
    render(
      <AgentActionsPalette
        open
        provider="claude-agent-sdk"
        workspacePath={null}
        onClose={onClose}
        onSelect={onSelect}
      />
    );

    await screen.findByText('/review');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search agent actions' }), {
      target: { value: 'review' },
    });
    expect(screen.queryByText('Lab tools')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /review/i }));

    await waitFor(() =>
      expect(resolve).toHaveBeenCalledWith({
        snapshotId: 'snapshot-1',
        provider: 'claude-agent-sdk',
        capabilityId: command.id,
      })
    );
    expect(onSelect).toHaveBeenCalledWith({ snapshotId: 'snapshot-1', control: command });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps automatically selected skills out of per-turn action filters', async () => {
    render(
      <AgentActionsPalette
        open
        provider="claude-agent-sdk"
        workspacePath={null}
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    await screen.findByText('/review');
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('3 discovered actions')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Skills/ })).not.toBeInTheDocument();
    expect(screen.queryByText('tdd')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Commands 1' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Commands 1' }));

    expect(screen.getByText('/review')).toBeInTheDocument();
    expect(discover).toHaveBeenCalledOnce();
  });

  it('does not stage a stale selection', async () => {
    const onSelect = vi.fn();
    resolve.mockResolvedValue({ ok: false, reason: 'stale-snapshot' });
    render(
      <AgentActionsPalette
        open
        provider="claude-agent-sdk"
        workspacePath={null}
        onClose={vi.fn()}
        onSelect={onSelect}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    expect(
      await screen.findByText(
        'This provider catalog changed. Refresh it before choosing an action.'
      )
    ).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('navigates enabled results from the search field and chooses with Enter', async () => {
    const onSelect = vi.fn();
    resolve.mockResolvedValue({ ok: true, control: memory });
    render(
      <AgentActionsPalette
        open
        provider="claude-agent-sdk"
        workspacePath={null}
        onClose={vi.fn()}
        onSelect={onSelect}
      />
    );

    await screen.findByText('/review');
    const search = screen.getByRole('textbox', { name: 'Search agent actions' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });

    await waitFor(() =>
      expect(resolve).toHaveBeenCalledWith({
        snapshotId: 'snapshot-1',
        provider: 'claude-agent-sdk',
        capabilityId: memory.id,
      })
    );
    expect(onSelect).toHaveBeenCalledWith({ snapshotId: 'snapshot-1', control: memory });
  });

  it('offers a direct path to manage commands, memory, and plugins', async () => {
    const calls: string[] = [];
    const onManage = vi.fn(() => calls.push('manage'));
    const onClose = vi.fn(() => calls.push('close'));
    render(
      <AgentActionsPalette
        open
        provider="claude-agent-sdk"
        workspacePath={null}
        onClose={onClose}
        onSelect={vi.fn()}
        onManage={onManage}
      />
    );

    await screen.findByText('/review');
    expect(screen.getByTestId('agent-actions-backdrop')).toHaveClass('z-[10000]');
    fireEvent.click(screen.getByRole('button', { name: 'Manage agent extensions' }));

    expect(onManage).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(calls).toEqual(['close', 'manage']);
  });
});
