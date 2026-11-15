import type { InventoryChildPolicy, InventoryPhysicalTypeVersion } from '@waypoint/domain-services';
import { Select } from '../../components/ui';
import { PhysicalField } from './InventoryPhysicalControls';

export function InventoryChildPolicyFields({
  value,
  onChange,
  types,
  label = 'Allowed children',
}: {
  value: InventoryChildPolicy;
  onChange(value: InventoryChildPolicy): void;
  types: readonly InventoryPhysicalTypeVersion[];
  label?: string;
}) {
  const logicalTypes = [
    ...new Map(
      [...types].sort((a, b) => a.version - b.version).map((type) => [type.typeId, type])
    ).values(),
  ];
  return (
    <div className="space-y-2">
      <PhysicalField label={label}>
        <Select
          ariaLabel={label}
          value={value.kind}
          options={[
            { value: 'any-legal', label: 'Any structurally allowed item' },
            { value: 'none', label: 'No children' },
            { value: 'types', label: 'Selected types' },
          ]}
          onValueChange={(kind) =>
            onChange(
              kind === 'types' ? { kind, typeIds: [] } : { kind: kind as 'any-legal' | 'none' }
            )
          }
        />
      </PhysicalField>
      {value.kind === 'types' ? (
        <div className="space-y-2 rounded border border-border p-3">
          {logicalTypes.map((type) => (
            <label key={type.typeId} className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                aria-label={`${label}: ${type.name}`}
                checked={value.typeIds.includes(type.typeId)}
                onChange={(event) =>
                  onChange({
                    kind: 'types',
                    typeIds: event.target.checked
                      ? [...value.typeIds, type.typeId]
                      : value.typeIds.filter((id) => id !== type.typeId),
                  })
                }
              />
              {type.name}
            </label>
          ))}
          <p className="text-xs text-fg-muted">
            These rules use stable type identities. Each installed child retains its own version.
          </p>
        </div>
      ) : null}
    </div>
  );
}
