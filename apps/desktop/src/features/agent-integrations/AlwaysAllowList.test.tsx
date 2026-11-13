import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AlwaysAllowList } from './AlwaysAllowList';

const rule = { key: 'command:blastn', label: 'blastn commands', enabled: true, createdAt: 1 };
const agentSession = vi.hoisted(() => ({
  listAlwaysAllowRules: vi.fn(),
  setAlwaysAllowRuleEnabled: vi.fn(),
  removeAlwaysAllowRule: vi.fn(),
}));

vi.mock('../../platform', () => ({ platform: () => ({ agentSession }) }));

describe('AlwaysAllowList', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('lists always-allowed requests and switches one off', async () => {
    agentSession.listAlwaysAllowRules.mockResolvedValue([rule]);
    agentSession.setAlwaysAllowRuleEnabled.mockResolvedValue([{ ...rule, enabled: false }]);
    render(<AlwaysAllowList />);

    const toggle = await screen.findByRole('switch', { name: 'Always allow blastn commands' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Always allow blastn commands' })).toHaveAttribute(
        'aria-checked',
        'false'
      )
    );
    expect(agentSession.setAlwaysAllowRuleEnabled).toHaveBeenCalledWith('command:blastn', false);
  });

  it('removes a rule and says when the list is empty', async () => {
    agentSession.listAlwaysAllowRules.mockResolvedValue([rule]);
    agentSession.removeAlwaysAllowRule.mockResolvedValue([]);
    render(<AlwaysAllowList />);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove blastn commands' }));
    expect(await screen.findByTestId('agent-always-allow-empty')).toHaveTextContent('Nothing yet.');
    expect(agentSession.removeAlwaysAllowRule).toHaveBeenCalledWith('command:blastn');
  });
});
