import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AgentApprovalCard, type AgentApprovalCardProps } from './AgentApprovalCard';

it.each([
  'platform.trackViews.list is not available in the hosted browser runtime.',
  'UCSC tracks: VITE_API_URL is not set',
])('does not display provider diagnostics as an approval: %s', (raw) => {
  render(
    <AgentApprovalCard
      requestId="request"
      title={raw as AgentApprovalCardProps['title']}
      detail={raw as AgentApprovalCardProps['detail']}
      ruleLabel={raw as AgentApprovalCardProps['ruleLabel']}
      command="python analyze.py"
      paths={[]}
      onChoose={vi.fn()}
    />
  );
  expect(screen.getByTestId('agent-confirm-inline')).not.toHaveTextContent(raw);
  expect(screen.getByTestId('agent-confirm-command')).toHaveTextContent('python analyze.py');
});
