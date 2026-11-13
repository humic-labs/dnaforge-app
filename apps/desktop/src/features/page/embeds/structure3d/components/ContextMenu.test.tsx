import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ContextMenu } from './ContextMenu';
import { SafeAgentApprovalDialog } from '@/components/SafeAgentApprovalDialog';

it('lets a later tool approval deny on Escape while a structure menu is open', () => {
  const onDeny = vi.fn();
  render(
    <>
      <ContextMenu
        position={{ x: 20, y: 30 }}
        onClose={vi.fn()}
        targetResidue={{ chain: 'A', position: 104 }}
        selectedResidues={[{ chain: 'A', position: 104 }]}
        onCenterSelection={vi.fn()}
      />
      <SafeAgentApprovalDialog
        title="Allow structure change?"
        body="Change the structure representation."
        allowLabel="Allow"
        denyLabel="Deny"
        onAllow={vi.fn()}
        onDeny={onDeny}
        testId="approval"
        allowTestId="allow"
        denyTestId="deny"
      />
    </>
  );
  const deny = screen.getByTestId('deny');
  expect(deny).toHaveFocus();

  fireEvent.keyDown(deny, { key: 'Escape' });

  expect(onDeny).toHaveBeenCalledOnce();
});

it('takes keyboard focus after the opening gesture finishes', async () => {
  const trigger = document.createElement('button');
  document.body.append(trigger);
  render(
    <ContextMenu
      position={{ x: 20, y: 30 }}
      onClose={vi.fn()}
      targetResidue={{ chain: 'A', position: 104 }}
      selectedResidues={[]}
      onCenterSelection={vi.fn()}
    />
  );
  trigger.focus();
  await waitFor(() =>
    expect(screen.getByRole('menuitem', { name: 'Center on residue' })).toHaveFocus()
  );
  trigger.remove();
});
