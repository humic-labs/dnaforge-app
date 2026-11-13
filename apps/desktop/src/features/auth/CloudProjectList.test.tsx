import { userMessage } from '@waypoint/user-messages';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { WorkspaceSyncProjectSummary } from '../../shared/workspace-sync-ipc';
import { CloudProjectList } from './CloudProjectList';

const PROJECT: WorkspaceSyncProjectSummary = {
  remoteWorkspaceId: '8a4d99e9-2347-4d04-a447-d3070f7a7f9a',
  displayName: 'Project A',
  ownerAccountId: 'account-a',
  ownerOrgId: null,
  ownerDisplayName: 'You',
  accessRole: 'owner',
  accessSource: 'owner',
  accessOrgId: null,
  latestVersionId: '54a53fed-2b63-44c8-a26e-b0fb7e1788d2',
  latestVersionNumber: 3,
  updatedAt: 1783468800000,
};

beforeEach(() => cleanup());

function baseProps() {
  return {
    projects: [] as WorkspaceSyncProjectSummary[],
    loading: false,
    error: null as string | null,
    commandInFlight: false,
    onOpenProject: vi.fn(),
  };
}

describe('CloudProjectList', () => {
  it('always renders the Cloud projects header', () => {
    render(<CloudProjectList {...baseProps()} />);
    expect(screen.getByText('Cloud projects')).toBeTruthy();
  });

  it('renders the loading state', () => {
    render(<CloudProjectList {...baseProps()} loading />);
    expect(screen.getByText('Loading...')).toBeTruthy();
  });

  it('renders the error state', () => {
    render(<CloudProjectList {...baseProps()} error="boom" />);
    expect(screen.getByText(userMessage('account.failed'))).toBeTruthy();
  });

  it('renders the empty state', () => {
    render(<CloudProjectList {...baseProps()} />);
    expect(screen.getByText('No cloud projects')).toBeTruthy();
  });

  it('lists projects with the version chip and opens one by summary', () => {
    const onOpenProject = vi.fn();
    render(
      <CloudProjectList {...baseProps()} projects={[PROJECT]} onOpenProject={onOpenProject} />
    );
    const btn = screen.getByTestId('account-open-synced-project');
    expect(btn.textContent).toContain('Project A');
    expect(btn.textContent).toContain('v3');
    fireEvent.click(btn);
    expect(onOpenProject).toHaveBeenCalledWith(PROJECT);
  });

  it('keeps a versioned project openable when its version number is unavailable', () => {
    render(
      <CloudProjectList {...baseProps()} projects={[{ ...PROJECT, latestVersionNumber: null }]} />
    );
    const btn = screen.getByTestId('account-open-synced-project');
    expect(btn.textContent).toContain('Backup ready');
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it('labels and disables a claimed project until its first backup exists', () => {
    const onOpenProject = vi.fn();
    render(
      <CloudProjectList
        {...baseProps()}
        projects={[{ ...PROJECT, latestVersionId: null, latestVersionNumber: 0 }]}
        onOpenProject={onOpenProject}
      />
    );
    const btn = screen.getByTestId('account-open-synced-project');
    expect(btn.textContent).toContain('No backup yet');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(btn);
    expect(onOpenProject).not.toHaveBeenCalled();
  });

  it('disables opening while ANY cloud command is in flight', () => {
    render(<CloudProjectList {...baseProps()} projects={[PROJECT]} commandInFlight />);
    expect((screen.getByTestId('account-open-synced-project') as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  describe(' shared-project badges', () => {
    it('shows no badge for a project the account owns personally', () => {
      render(<CloudProjectList {...baseProps()} projects={[PROJECT]} />);
      expect(screen.queryByTestId('account-project-access-badge')).toBeNull();
    });

    it('labels a project shared by another person with the role granted', () => {
      render(
        <CloudProjectList
          {...baseProps()}
          projects={[
            {
              ...PROJECT,
              ownerAccountId: 'account-b',
              ownerDisplayName: 'Alice Example',
              accessRole: 'editor',
              accessSource: 'direct',
            },
          ]}
        />
      );
      const badge = screen.getByTestId('account-project-access-badge');
      expect(badge.textContent).toContain('Shared with you');
      expect(badge.textContent).toContain('Editor');
      expect(badge.getAttribute('title')).toContain('Alice Example');
    });

    it('names the organization for a company-managed project', () => {
      render(
        <CloudProjectList
          {...baseProps()}
          projects={[
            {
              ...PROJECT,
              ownerOrgId: 'org-1',
              ownerDisplayName: 'Acme Labs',
              accessRole: 'owner',
              accessSource: 'org_admin',
              accessOrgId: 'org-1',
            },
          ]}
        />
      );
      const badge = screen.getByTestId('account-project-access-badge');
      expect(badge.textContent).toContain('Acme Labs');
      expect(badge.textContent).toContain('Administrator');
    });
  });
});
