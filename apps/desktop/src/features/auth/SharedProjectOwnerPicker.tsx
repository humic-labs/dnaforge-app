import { MenuNativeSelect } from '@waypoint/ui-components';

import type {
  WorkspaceSyncOrganizationSummary,
  WorkspaceSyncOwnerChoice,
} from '../../shared/workspace-sync-ipc';

export interface SharedProjectOwnerPickerProps {
  organizations: WorkspaceSyncOrganizationSummary[];
  value: WorkspaceSyncOwnerChoice;
  disabled: boolean;
  onChange: (value: WorkspaceSyncOwnerChoice) => void;
}

export function eligibleProjectOwners(
  organizations: WorkspaceSyncOrganizationSummary[]
): WorkspaceSyncOrganizationSummary[] {
  return organizations.filter((org) => org.canCreateManagedProjects);
}

export function defaultOwnerChoice(
  _organizations: WorkspaceSyncOrganizationSummary[]
): WorkspaceSyncOwnerChoice {
  return { kind: 'personal' };
}

export function SharedProjectOwnerPicker({
  organizations,
  value,
  disabled,
  onChange,
}: SharedProjectOwnerPickerProps) {
  const eligible = eligibleProjectOwners(organizations);
  if (eligible.length === 0) return null;

  const selected = value.kind === 'org' ? value.orgId : 'personal';
  return (
    <label className="flex flex-col gap-1 text-sm text-fg">
      <span className="text-fg-muted">This project belongs to</span>
      <span className="block min-w-0 w-full">
        <MenuNativeSelect
          density="form"
          aria-label="Project owner"
          data-testid="shared-project-owner-picker"
          value={selected}
          disabled={disabled}
          onChange={(event) =>
            onChange(
              event.target.value === 'personal'
                ? { kind: 'personal' }
                : { kind: 'org', orgId: event.target.value }
            )
          }
        >
          <option value="personal">Just me</option>
          {eligible.map((org) => (
            <option key={org.orgId} value={org.orgId}>
              {org.displayName}
            </option>
          ))}
        </MenuNativeSelect>
      </span>
    </label>
  );
}
