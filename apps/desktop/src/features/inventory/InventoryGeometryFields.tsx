import type { InventoryDimension, InventoryGeometry } from '@waypoint/domain-services';
import { Select, TextField } from '../../components/ui';

interface DimensionDraft {
  value: string;
  unit: Extract<InventoryDimension, { kind: 'known' }>['unit'];
}
type DimensionsDraft = Record<'width' | 'height' | 'depth', DimensionDraft>;
export interface InventoryGeometryDraft {
  external: DimensionsDraft;
  usable: DimensionsDraft;
}

export function inventoryGeometryDraft(geometry?: InventoryGeometry): InventoryGeometryDraft {
  const dimensions = (kind: 'external' | 'usable'): DimensionsDraft =>
    Object.fromEntries(
      (['width', 'height', 'depth'] as const).map((axis) => {
        const value = geometry?.[kind][axis];
        return [
          axis,
          value?.kind === 'known'
            ? { value: value.value, unit: value.unit }
            : { value: '', unit: 'mm' },
        ];
      })
    ) as DimensionsDraft;
  return { external: dimensions('external'), usable: dimensions('usable') };
}

export function inventoryGeometryFromDraft(draft: InventoryGeometryDraft): InventoryGeometry {
  const dimension = ({ value, unit }: DimensionDraft): InventoryDimension =>
    value.trim() ? { kind: 'known', value: value.trim(), unit } : { kind: 'unknown' };
  return {
    external: {
      width: dimension(draft.external.width),
      height: dimension(draft.external.height),
      depth: dimension(draft.external.depth),
    },
    usable: {
      width: dimension(draft.usable.width),
      height: dimension(draft.usable.height),
      depth: dimension(draft.usable.depth),
    },
  };
}

export function InventoryGeometryFields({
  value,
  onChange,
  label = 'Dimensions',
  groups = ['external', 'usable'],
}: {
  value: InventoryGeometryDraft;
  onChange(value: InventoryGeometryDraft): void;
  label?: string;
  groups?: readonly ('external' | 'usable')[];
}) {
  return (
    <fieldset className="space-y-3 rounded border border-border p-3">
      <legend className="px-1 text-sm font-semibold">{label}</legend>
      <p className="text-xs text-fg-muted">
        Leave a dimension blank when unknown. Nominal size labels do not establish exact dimensions.
      </p>
      {groups.map((kind) => (
        <div key={kind} className="space-y-2">
          <h4 className="text-xs font-medium text-fg-muted">
            {kind === 'external' ? 'External dimensions' : 'Usable internal dimensions'}
          </h4>
          {(['width', 'height', 'depth'] as const).map((axis) => (
            <div key={axis} className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
              <label className="flex flex-col gap-1 text-xs text-fg-muted">
                <span className="capitalize">{axis}</span>
                <TextField
                  aria-label={`${kind} ${axis}`}
                  inputMode="decimal"
                  value={value[kind][axis].value}
                  onChange={(event) =>
                    onChange({
                      ...value,
                      [kind]: {
                        ...value[kind],
                        [axis]: { ...value[kind][axis], value: event.target.value },
                      },
                    })
                  }
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-fg-muted">
                <span>Unit</span>
                <Select
                  ariaLabel={`${kind} ${axis} unit`}
                  value={value[kind][axis].unit}
                  options={['mm', 'cm', 'in'].map((unit) => ({ value: unit, label: unit }))}
                  onValueChange={(unit) =>
                    onChange({
                      ...value,
                      [kind]: {
                        ...value[kind],
                        [axis]: { ...value[kind][axis], unit: unit as DimensionDraft['unit'] },
                      },
                    })
                  }
                />
              </label>
            </div>
          ))}
        </div>
      ))}
    </fieldset>
  );
}
