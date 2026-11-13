import type { EntitySchemaFieldSnapshot } from '../../../../shared/entity-schema';
import {
  resolvedEntitySchemaFields,
  resolvedEntitySchemaProperties,
  type SequenceDerivedPropertyDefinition,
} from '../../../../shared/sequence-entity-schema';
import type {
  LimsRegistrySort,
  LimsRegistrySortColumn,
  LimsSchemaDefinitionView,
} from '../../../../shared/lims';

export const REGISTRY_SORT_OPTIONS: Array<{ value: LimsRegistrySort; label: string }> = [
  { value: 'updated_desc', label: 'Newest updated' },
  { value: 'updated_asc', label: 'Oldest updated' },
  { value: 'name_asc', label: 'Name A-Z' },
  { value: 'name_desc', label: 'Name Z-A' },
  { value: 'kind_asc', label: 'Schema A-Z' },
  { value: 'kind_desc', label: 'Schema Z-A' },
  { value: 'status_asc', label: 'Status A-Z' },
  { value: 'status_desc', label: 'Status Z-A' },
  { value: 'registry_id_asc', label: 'ID ascending' },
  { value: 'registry_id_desc', label: 'ID descending' },
];

export const REGISTRY_PAGE_SIZE = 50;

export type RegistryFilterType = 'text' | 'categorical' | 'date';

export interface RegistryColumnDef {
  key: string;
  label: string;
  sort?: LimsRegistrySortColumn;
  width: number;
  align?: 'right';
  filter?: RegistryFilterType;
  options?: readonly { value: string; label: string }[];
  field?: EntitySchemaFieldSnapshot;
  property?: SequenceDerivedPropertyDefinition;
}
export const STATUS_FILTER_OPTIONS = [
  { value: 'registered', label: 'Registered' },
  { value: 'drifted', label: 'Edited' },
  { value: 'unresolved', label: 'Unresolved' },
] as const;

export interface DevScenario {
  id: string;
  group: string;
  label: string;
  run: () => void | Promise<void>;
}

export const REGISTRY_COLUMNS: RegistryColumnDef[] = [
  { key: 'name', label: 'Name', sort: 'name', width: 180, filter: 'text' },
  { key: 'registryId', label: 'ID', sort: 'registry_id', width: 96, filter: 'text' },
  {
    key: 'kind',
    label: 'Schema',
    sort: 'kind',
    width: 140,
    filter: 'categorical',
  },
  {
    key: 'status',
    label: 'Status',
    sort: 'status',
    width: 110,
    filter: 'categorical',
    options: STATUS_FILTER_OPTIONS,
  },
  { key: 'actions', label: 'Actions', width: 64, align: 'right' },
];

export function registryColumnsForSchema(
  schema: LimsSchemaDefinitionView | null | undefined,
  schemaOptions: readonly { value: string; label: string }[] = []
): RegistryColumnDef[] {
  const system = REGISTRY_COLUMNS.map((column) =>
    column.key === 'kind' ? { ...column, options: schemaOptions } : column
  );
  if (!schema) return system;
  const snapshot = {
    baseKind: schema.baseKind,
    fields: schema.fields.map((field) => ({ ...field }) as EntitySchemaFieldSnapshot),
  };
  const fieldColumns = resolvedEntitySchemaFields(snapshot).map(
    (field): RegistryColumnDef => ({
      key: `field:${field.key}`,
      label: field.label,
      width: field.type === 'long_text' ? 190 : field.type === 'string_array' ? 170 : 140,
      field,
    })
  );
  const actions = system.find((column) => column.key === 'actions')!;
  const propertyColumns = resolvedEntitySchemaProperties(snapshot).map(
    (property): RegistryColumnDef => ({
      key: `property:${property.key}`,
      label: property.label,
      width: 140,
      property,
    })
  );
  return [
    ...system.filter((column) => column.key !== 'actions'),
    ...propertyColumns,
    ...fieldColumns,
    actions,
  ];
}
export const REGISTRY_MIN_COL_WIDTH = 48;
export const REGISTRY_COLUMN_WIDTHS_KEY = 'waypoint:lims-registry-column-widths';

export const REGISTRY_GRID_BASE = 'grid items-center px-4';

export function registrySortForColumn(
  column: LimsRegistrySortColumn,
  current: LimsRegistrySort
): LimsRegistrySort {
  const asc = `${column}_asc` as LimsRegistrySort;
  const desc = `${column}_desc` as LimsRegistrySort;
  if (current === asc) return desc;
  if (current === desc) return asc;
  return column === 'updated' ? desc : asc;
}

export function registrySortDirection(
  column: LimsRegistrySortColumn,
  current: LimsRegistrySort
): 'asc' | 'desc' | null {
  if (current === `${column}_asc`) return 'asc';
  if (current === `${column}_desc`) return 'desc';
  return null;
}

export function loadRegistryColumnWidths(): Record<string, number> {
  const defaults: Record<string, number> = {};
  for (const column of REGISTRY_COLUMNS) defaults[column.key] = column.width;
  if (typeof window === 'undefined') return defaults;
  try {
    const raw = window.localStorage.getItem(REGISTRY_COLUMN_WIDTHS_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Record<string, number>;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && value >= REGISTRY_MIN_COL_WIDTH) defaults[key] = value;
    }
  } catch {}
  return defaults;
}

export function persistRegistryColumnWidths(widths: Record<string, number>): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(REGISTRY_COLUMN_WIDTHS_KEY, JSON.stringify(widths));
}
