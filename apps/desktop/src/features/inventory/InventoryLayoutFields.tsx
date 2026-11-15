import {
  inventoryStoragePositions,
  parseInventoryCommand,
  type InventoryLayout,
} from '@waypoint/domain-services';
import { Select, TextArea, TextField } from '../../components/ui';

export interface InventoryLayoutDraft {
  kind: InventoryLayout['kind'];
  positions: string;
  rows: string;
  columns: string;
  capacity: string;
}

export function inventoryLayoutDraft(layout?: InventoryLayout): InventoryLayoutDraft {
  return {
    kind: layout?.kind ?? 'named',
    positions: layout?.kind === 'named' ? layout.slots.join(', ') : 'A1, A2, A3, A4',
    rows: layout && 'rows' in layout ? String(layout.rows) : '8',
    columns: layout && 'columns' in layout ? String(layout.columns) : '12',
    capacity: layout?.kind === 'stack' ? String(layout.capacity) : '10',
  };
}

export function inventoryLayoutFromDraft(draft: InventoryLayoutDraft): InventoryLayout {
  return draft.kind === 'named'
    ? {
        kind: 'named',
        slots: draft.positions
          .split(/[,\n]/)
          .map((slot) => slot.trim())
          .filter(Boolean),
      }
    : draft.kind === 'stack'
      ? { kind: 'stack', capacity: Number(draft.capacity), removal: 'top-only' }
      : { kind: draft.kind, rows: Number(draft.rows), columns: Number(draft.columns) };
}

export function inventoryLayoutPositions(draft: InventoryLayoutDraft): readonly string[] {
  try {
    const command = parseInventoryCommand({
      kind: 'create-layout-storage',
      id: 'preview',
      name: 'Preview',
      layout: inventoryLayoutFromDraft(draft),
      placement: { kind: 'root' },
    });
    return command.kind === 'create-layout-storage' ? inventoryStoragePositions(command) : [];
  } catch {
    return [];
  }
}

export function InventoryLayoutFields({
  value,
  onChange,
  disabled = false,
}: {
  value: InventoryLayoutDraft;
  onChange(value: InventoryLayoutDraft): void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-3">
      <label className="flex flex-col gap-1.5 text-xs font-medium text-fg-muted">
        <span>Positions</span>
        <Select
          ariaLabel="Position layout"
          value={value.kind}
          disabled={disabled}
          options={[
            { value: 'named', label: 'Named positions' },
            { value: 'grid', label: 'Grid' },
            { value: 'removable-tube', label: 'Tube box' },
            { value: 'fixed-well', label: 'Well plate' },
            { value: 'stack', label: 'Ordered stack' },
          ]}
          onValueChange={(kind) => onChange({ ...value, kind: kind as InventoryLayout['kind'] })}
        />
      </label>
      {value.kind === 'named' ? (
        <label className="flex flex-col gap-1.5 text-xs font-medium text-fg-muted">
          <span>Position names, separated by commas</span>
          <TextArea
            aria-label="Position names"
            value={value.positions}
            disabled={disabled}
            rows={3}
            required
            onChange={(event) => onChange({ ...value, positions: event.target.value })}
          />
        </label>
      ) : value.kind === 'stack' ? (
        <label className="flex flex-col gap-1.5 text-xs font-medium text-fg-muted">
          <span>Stack capacity</span>
          <TextField
            aria-label="Stack capacity"
            type="number"
            min={1}
            max={10000}
            value={value.capacity}
            disabled={disabled}
            required
            onChange={(event) => onChange({ ...value, capacity: event.target.value })}
          />
        </label>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5 text-xs font-medium text-fg-muted">
            <span>Rows</span>
            <TextField
              aria-label="Rows"
              type="number"
              min={1}
              max={10000}
              value={value.rows}
              disabled={disabled}
              required
              onChange={(event) => onChange({ ...value, rows: event.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-medium text-fg-muted">
            <span>Columns</span>
            <TextField
              aria-label="Columns"
              type="number"
              min={1}
              max={10000}
              value={value.columns}
              disabled={disabled}
              required
              onChange={(event) => onChange({ ...value, columns: event.target.value })}
            />
          </label>
        </div>
      )}
    </div>
  );
}
