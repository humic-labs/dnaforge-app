import { useState } from 'react';
import type {
  InventoryDimensions,
  InventoryPhysicalTypeVersion,
  InventoryPositionRule,
} from '@waypoint/domain-services';
import { Button, Select, TextArea } from '../../components/ui';
import { InventoryChildPolicyFields } from './InventoryChildPolicyFields';
import {
  InventoryGeometryFields,
  inventoryGeometryDraft,
  inventoryGeometryFromDraft,
} from './InventoryGeometryFields';
import { inventoryLayoutPositions, type InventoryLayoutDraft } from './InventoryLayoutFields';
import { PhysicalField } from './InventoryPhysicalControls';

function PositionDimensions({
  value,
  onChange,
}: {
  value: InventoryDimensions | null;
  onChange(value: InventoryDimensions | null): void;
}) {
  const [draft, setDraft] = useState(() => {
    const initial = inventoryGeometryDraft();
    return value
      ? inventoryGeometryDraft({
          external: inventoryGeometryFromDraft(initial).external,
          usable: value,
        })
      : initial;
  });
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={value !== null}
          onChange={(event) =>
            onChange(event.target.checked ? inventoryGeometryFromDraft(draft).usable : null)
          }
        />
        Override usable dimensions for this position
      </label>
      {value ? (
        <InventoryGeometryFields
          label="Position dimensions"
          groups={['usable']}
          value={draft}
          onChange={(next) => {
            setDraft(next);
            onChange(inventoryGeometryFromDraft(next).usable);
          }}
        />
      ) : null}
    </div>
  );
}

export function InventoryPositionRulesFields({
  layout,
  value,
  onChange,
  types,
}: {
  layout: InventoryLayoutDraft;
  value: Readonly<Record<string, InventoryPositionRule>>;
  onChange(value: Readonly<Record<string, InventoryPositionRule>>): void;
  types: readonly InventoryPhysicalTypeVersion[];
}) {
  const positions = inventoryLayoutPositions(layout);
  const free = positions.filter((position) => !Object.hasOwn(value, position));
  function replace(position: string, rule: InventoryPositionRule) {
    onChange({ ...value, [position]: rule });
  }
  return (
    <fieldset className="space-y-3 rounded border border-border p-3">
      <legend className="px-1 text-sm font-semibold">Position rules</legend>
      {Object.entries(value).map(([position, rule], index) => (
        <div key={position} className="space-y-3 rounded border border-border p-3">
          <PhysicalField label={`Rule ${index + 1} position`}>
            <Select
              ariaLabel={`Rule ${index + 1} position`}
              value={position}
              options={[
                { value: position, label: position },
                ...free.map((id) => ({ value: id, label: id })),
              ]}
              onValueChange={(next) => {
                const rest = Object.fromEntries(
                  Object.entries(value).filter(([id]) => id !== position)
                );
                onChange({ ...rest, [next]: rule });
              }}
            />
          </PhysicalField>
          <PhysicalField label={`Rule ${index + 1} state`}>
            <Select
              ariaLabel={`Rule ${index + 1} state`}
              value={rule.kind}
              options={[
                { value: 'available', label: 'Available' },
                { value: 'unavailable', label: 'Unavailable' },
              ]}
              onValueChange={(kind) =>
                replace(
                  position,
                  kind === 'unavailable'
                    ? { kind, reason: '' }
                    : { kind: 'available', childPolicy: null, usable: null }
                )
              }
            />
          </PhysicalField>
          {rule.kind === 'unavailable' ? (
            <PhysicalField label={`Rule ${index + 1} reason`}>
              <TextArea
                aria-label={`Rule ${index + 1} reason`}
                value={rule.reason}
                onChange={(event) => replace(position, { ...rule, reason: event.target.value })}
                required
              />
            </PhysicalField>
          ) : (
            <>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={rule.childPolicy === null}
                  onChange={(event) =>
                    replace(position, {
                      ...rule,
                      childPolicy: event.target.checked ? null : { kind: 'any-legal' },
                    })
                  }
                />
                Use parent child rule
              </label>
              {rule.childPolicy ? (
                <InventoryChildPolicyFields
                  label={`Position ${position} allowed children`}
                  value={rule.childPolicy}
                  types={types}
                  onChange={(childPolicy) => replace(position, { ...rule, childPolicy })}
                />
              ) : null}
              <PositionDimensions
                value={rule.usable}
                onChange={(usable) => replace(position, { ...rule, usable })}
              />
            </>
          )}
          <Button
            onClick={() =>
              onChange(Object.fromEntries(Object.entries(value).filter(([id]) => id !== position)))
            }
          >
            Remove rule {index + 1}
          </Button>
        </div>
      ))}
      <Button
        disabled={!free.length}
        onClick={() => onChange({ ...value, [free[0]]: { kind: 'unavailable', reason: '' } })}
      >
        Add position rule
      </Button>
    </fieldset>
  );
}
