import type { AssemblyWorkbenchEditableField } from './AssemblyWorkbenchContract';
import type { JunctionWorkbenchRow } from './model';

export type SourceRegisterOwner = 'left' | 'right';
export type ProductSourceRegisterOwner = SourceRegisterOwner | 'spacer';
type SourceRegisterRow = JunctionWorkbenchRow & { kind: 'left-source' | 'right-source' };

export type SourceRegisterDragUnavailableReason =
  | 'not-source-register-row'
  | 'not-product-owner'
  | 'spacer-owner'
  | 'missing-source-row'
  | 'missing-source-boundary-field'
  | 'disabled-source-boundary-field';

export type SourceRegisterDragCapability =
  | {
      status: 'enabled';
      field: AssemblyWorkbenchEditableField;
      activeRow: SourceRegisterRow;
      owner: SourceRegisterOwner;
    }
  | {
      status: 'disabled';
      reason: SourceRegisterDragUnavailableReason;
      field?: AssemblyWorkbenchEditableField;
      activeRow?: SourceRegisterRow;
      owner?: SourceRegisterOwner;
      message: string;
    };

export function sourceRegisterDragCapabilityForSourceRow(
  row: JunctionWorkbenchRow,
  fields: AssemblyWorkbenchEditableField[]
): SourceRegisterDragCapability {
  if (!isSourceRegisterRow(row)) {
    return {
      status: 'disabled',
      reason: 'not-source-register-row',
      message: 'Only source rows can edit source contribution boundaries directly.',
    };
  }
  const field = sourceContributionBoundaryFieldForRowIncludingDisabled(row, fields);
  const owner = row.kind === 'left-source' ? 'left' : 'right';
  if (!field) {
    return {
      status: 'disabled',
      reason: 'missing-source-boundary-field',
      activeRow: row,
      owner,
      message: 'No source contribution boundary field exists for this row.',
    };
  }
  if (field.disabled) {
    return {
      status: 'disabled',
      reason: 'disabled-source-boundary-field',
      field,
      activeRow: row,
      owner,
      message: field.constraints[0]?.message ?? 'This source boundary is constrained.',
    };
  }
  return {
    status: 'enabled',
    field,
    activeRow: row,
    owner,
  };
}

export function sourceRegisterDragCapabilityForProductOwner(input: {
  owner: ProductSourceRegisterOwner | null;
  rows: JunctionWorkbenchRow[];
  fields: AssemblyWorkbenchEditableField[];
}): SourceRegisterDragCapability {
  const owner = input.owner;
  if (owner !== 'left' && owner !== 'right') {
    return {
      status: 'disabled',
      reason: owner === 'spacer' ? 'spacer-owner' : 'not-product-owner',
      message:
        owner === 'spacer'
          ? 'Spacer bases are edited by the spacer sequence control, not source-register drag.'
          : 'This product position is not owned by a draggable source row.',
    };
  }

  const activeRow = input.rows.find(
    (row): row is SourceRegisterRow => row.kind === `${owner}-source`
  );
  if (!activeRow) {
    return {
      status: 'disabled',
      reason: 'missing-source-row',
      owner,
      message: 'The source row for this product owner is not present.',
    };
  }

  return sourceRegisterDragCapabilityForSourceRow(activeRow, input.fields);
}

export function sourceContributionBoundaryFieldForRow(
  row: JunctionWorkbenchRow,
  fields: AssemblyWorkbenchEditableField[]
): AssemblyWorkbenchEditableField | null {
  const capability = sourceRegisterDragCapabilityForSourceRow(row, fields);
  return capability.status === 'enabled' ? capability.field : null;
}

export function sourceContributionBoundaryFieldById(
  fields: AssemblyWorkbenchEditableField[],
  fieldId: string | undefined
): AssemblyWorkbenchEditableField | null {
  if (!fieldId) return null;
  const field = fields.find(
    (candidate) => candidate.id === fieldId && isSourceContributionBoundaryField(candidate)
  );
  return field ?? null;
}

export function hasAnyEnabledSourceContributionBoundaryField(
  fields: AssemblyWorkbenchEditableField[]
): boolean {
  return fields.some((field) => isSourceContributionBoundaryField(field) && !field.disabled);
}

function sourceContributionBoundaryFieldForRowIncludingDisabled(
  row: SourceRegisterRow,
  fields: AssemblyWorkbenchEditableField[]
): AssemblyWorkbenchEditableField | null {
  return (
    fields.find(
      (field) =>
        isSourceContributionBoundaryField(field) &&
        field.anchors.some((anchor) => anchor.rowId === row.id && anchor.role === 'boundary')
    ) ?? null
  );
}

export function isSourceContributionBoundaryField(
  field: AssemblyWorkbenchEditableField
): field is AssemblyWorkbenchEditableField & {
  kind: 'sourceContributionBoundary';
  units: 'bp';
  value: number;
} {
  return (
    field.kind === 'sourceContributionBoundary' &&
    field.units === 'bp' &&
    typeof field.value === 'number' &&
    !!field.range
  );
}

function isSourceRegisterRow(row: JunctionWorkbenchRow): row is SourceRegisterRow {
  return row.kind === 'left-source' || row.kind === 'right-source';
}
