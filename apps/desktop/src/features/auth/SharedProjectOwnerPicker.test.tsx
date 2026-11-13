import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  defaultOwnerChoice,
  eligibleProjectOwners,
  SharedProjectOwnerPicker,
} from './SharedProjectOwnerPicker';
import type { WorkspaceSyncOrganizationSummary } from '../../shared/workspace-sync-ipc';

function org(
  overrides: Partial<WorkspaceSyncOrganizationSummary> = {}
): WorkspaceSyncOrganizationSummary {
  return {
    orgId: 'org-1',
    slug: 'acme',
    displayName: 'Acme',
    role: 'member',
    canCreateManagedProjects: true,
    isAdministrator: false,
    ...overrides,
  };
}

describe('defaultOwnerChoice', () => {
  it('starts a new project as private even when the person belongs to an organization', () => {
    expect(defaultOwnerChoice([org()])).toEqual({ kind: 'personal' });
    expect(defaultOwnerChoice([])).toEqual({ kind: 'personal' });
  });
});

describe('eligibleProjectOwners', () => {
  it('keeps organizations that can own a project', () => {
    expect(
      eligibleProjectOwners([
        org({ orgId: 'yes' }),
        org({ orgId: 'no', canCreateManagedProjects: false }),
      ]).map((item) => item.orgId)
    ).toEqual(['yes']);
  });
});

describe('SharedProjectOwnerPicker', () => {
  it('always offers Just me alongside each organization', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SharedProjectOwnerPicker
        organizations={[
          org({ orgId: 'org-a', displayName: 'Acme' }),
          org({ orgId: 'org-b', displayName: 'Beta' }),
        ]}
        value={{ kind: 'personal' }}
        disabled={false}
        onChange={onChange}
      />
    );

    const picker = screen.getByTestId('shared-project-owner-picker') as HTMLSelectElement;
    expect(Array.from(picker.options).map((option) => option.text)).toEqual([
      'Just me',
      'Acme',
      'Beta',
    ]);
    await user.selectOptions(picker, 'org-b');
    expect(onChange).toHaveBeenCalledWith({ kind: 'org', orgId: 'org-b' });
  });

  it('hides the picker when no organization can own a project', () => {
    render(
      <SharedProjectOwnerPicker
        organizations={[org({ canCreateManagedProjects: false })]}
        value={{ kind: 'personal' }}
        disabled={false}
        onChange={vi.fn()}
      />
    );
    expect(screen.queryByTestId('shared-project-owner-picker')).toBeNull();
  });
});
