import { useState } from 'react';
import type { InventoryFitSubject } from '@waypoint/domain-services';
import { Select } from '../../components/ui';
import type { InventoryData } from './inventory-controller';
import { PhysicalField } from './InventoryPhysicalControls';

export function InventoryPhysicalSubjectFields({
  data,
  label,
  value,
  onChange,
  parent = false,
}: {
  data: InventoryData;
  label: string;
  value: InventoryFitSubject | null;
  onChange(value: InventoryFitSubject | null): void;
  parent?: boolean;
}) {
  const [scope, setScope] = useState<'installed' | 'type-version'>(value?.kind ?? 'installed');
  const physical = data.availability?.physical;
  const installed = Object.values(physical?.items ?? {}).filter(
    (view) => !parent || view.item.kind === 'storage'
  );
  const types =
    physical?.typeVersions.filter((type) => !parent || type.definition.kind === 'storage') ?? [];
  return (
    <div className="space-y-2">
      <PhysicalField label={`${label} scope`}>
        <Select
          ariaLabel={`${label} scope`}
          value={scope}
          options={[
            { value: 'installed', label: 'Installed item' },
            { value: 'type-version', label: 'Type version' },
          ]}
          onValueChange={(next) => {
            setScope(next as 'installed' | 'type-version');
            onChange(null);
          }}
        />
      </PhysicalField>
      <PhysicalField label={label}>
        <Select
          ariaLabel={label}
          value={value ? (value.kind === 'installed' ? value.item.id : value.versionId) : ''}
          options={[
            { value: '', label: `Choose ${label.toLowerCase()}` },
            ...(scope === 'installed'
              ? installed.map((view) => ({
                  value: view.item.id,
                  label:
                    view.item.kind === 'storage'
                      ? data.state.storage[view.item.id].name
                      : data.state.vessels[view.item.id].name,
                }))
              : types.map((type) => ({
                  value: type.id,
                  label: `${type.name} · v${type.version}`,
                }))),
          ]}
          onValueChange={(id) => {
            const view = physical?.items[id];
            onChange(
              !id
                ? null
                : scope === 'type-version'
                  ? { kind: 'type-version', versionId: id }
                  : view
                    ? {
                        kind: 'installed',
                        item: view.item,
                        configurationRevision: view.configuration.revision,
                      }
                    : null
            );
          }}
        />
      </PhysicalField>
    </div>
  );
}
