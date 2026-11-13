import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { HostedKeepWorkButton } from './HostedKeepWork';
import { HostedShareButton } from './HostedWorkspaceChrome';
import { requireHostedCapability, setHostedDemoSession } from './capabilities';

vi.mock('./controller', () => ({
  hostedDurableSync: { subscribe: () => () => {}, getRevision: () => 0 },
}));

it('preserves the signup guidance for each demo action', () => {
  const previousRuntime = document.documentElement.dataset.dnaforgeRuntime;
  document.documentElement.dataset.dnaforgeRuntime = 'hosted-browser';
  setHostedDemoSession(true);
  const openShare = vi.fn();
  const view = render(
    <>
      <HostedKeepWorkButton />
      <HostedShareButton target={null} onOpen={openShare} />
    </>
  );
  try {
    fireEvent.click(screen.getByTestId('hosted-share-open'));
    expect(within(screen.getByRole('dialog')).getByRole('heading').textContent).toBe(
      'Sign up to share'
    );
    expect(openShare).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep exploring' }));
    fireEvent.click(screen.getByTestId('hosted-demo-keep-work'));
    expect(within(screen.getByRole('dialog')).getByRole('heading').textContent).toBe(
      'Sign up to keep your work'
    );
    for (const [capability, copy] of [
      ['external-lookups', 'Sign up to search'],
      ['server-jobs', 'Sign up to run this'],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name: 'Keep exploring' }));
      act(() => expect(() => requireHostedCapability(capability)).toThrow(copy));
      expect(within(screen.getByRole('dialog')).getByRole('heading').textContent).toBe(copy);
    }
  } finally {
    view.unmount();
    setHostedDemoSession(false);
    if (previousRuntime === undefined) delete document.documentElement.dataset.dnaforgeRuntime;
    else document.documentElement.dataset.dnaforgeRuntime = previousRuntime;
  }
});
