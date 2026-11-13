import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { WorkspaceConflictActions } from './WorkspaceConflictActions';

beforeEach(() => cleanup());

describe('WorkspaceConflictActions', () => {
  it('renders both resolution actions with their idle labels', () => {
    render(
      <WorkspaceConflictActions syncBusy={null} commandInFlight={false} onResolve={vi.fn()} />
    );
    expect(screen.getByTestId('account-resolve-keep-local').textContent).toBe('Upload local');
    expect(screen.getByTestId('account-resolve-use-remote').textContent).toBe('Open cloud');
  });

  it('calls onResolve with keep_local / use_remote', () => {
    const onResolve = vi.fn();
    render(
      <WorkspaceConflictActions syncBusy={null} commandInFlight={false} onResolve={onResolve} />
    );
    fireEvent.click(screen.getByTestId('account-resolve-keep-local'));
    fireEvent.click(screen.getByTestId('account-resolve-use-remote'));
    expect(onResolve).toHaveBeenNthCalledWith(1, 'keep_local');
    expect(onResolve).toHaveBeenNthCalledWith(2, 'use_remote');
  });

  it('disables both buttons and shows the in-flight label while busy', () => {
    render(
      <WorkspaceConflictActions syncBusy="resolve-keep-local" commandInFlight onResolve={vi.fn()} />
    );
    expect((screen.getByTestId('account-resolve-keep-local') as HTMLButtonElement).disabled).toBe(
      true
    );
    expect((screen.getByTestId('account-resolve-use-remote') as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(screen.getByTestId('account-resolve-keep-local').textContent).toBe('Queueing');
  });

  it('shows the Opening label when use_remote is in flight', () => {
    render(
      <WorkspaceConflictActions syncBusy="resolve-use-remote" commandInFlight onResolve={vi.fn()} />
    );
    expect(screen.getByTestId('account-resolve-use-remote').textContent).toBe('Opening');
  });
});
