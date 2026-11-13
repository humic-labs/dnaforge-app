import type {
  AssemblyWorkbenchCommand,
  AssemblyWorkbenchEditableField,
} from './AssemblyWorkbenchContract';

export type EditableFieldCommandResolveResult =
  | {
      status: 'resolved';
      fieldId: string;
      value: number | string;
      command: AssemblyWorkbenchCommand;
    }
  | {
      status: 'rejected';
      fieldId: string;
      reason: 'disabled' | 'invalid-value' | 'missing-value-key' | 'unsupported-command';
      message: string;
    };

export interface EditableFieldCommandResolveOptions {
  expectedDesignVersion?: number;
  recomputePrimers?: boolean;
}

export function resolveEditableFieldCommand(
  field: AssemblyWorkbenchEditableField,
  nextValue: number | string,
  options: EditableFieldCommandResolveOptions = {}
): EditableFieldCommandResolveResult {
  if (field.disabled) {
    return rejected(field, 'disabled', 'This field is disabled.');
  }
  if (field.command.type === 'setEditableField') {
    return rejected(field, 'unsupported-command', 'Generic editable field commands are not wired.');
  }

  const value = normalizeFieldValue(field, nextValue);
  if (value === null) {
    return rejected(field, 'invalid-value', 'The requested field value is invalid.');
  }

  const payload = clonePayload(field.command.payload);
  if (field.command.valueKey) {
    if (!setNestedPayloadValue(payload, field.command.valueKey, value)) {
      return rejected(
        field,
        'missing-value-key',
        `Missing payload path ${field.command.valueKey}.`
      );
    }
  }
  if (
    options.expectedDesignVersion !== undefined &&
    field.command.type !== 'selectJunction' &&
    !('expectedDesignVersion' in payload)
  ) {
    payload.expectedDesignVersion = options.expectedDesignVersion;
  }
  if (field.command.type === 'setHomologyEncoding' && options.recomputePrimers !== undefined) {
    payload.recomputePrimers = options.recomputePrimers;
  }

  return {
    status: 'resolved',
    fieldId: field.id,
    value,
    command: {
      type: field.command.type,
      ...payload,
    } as AssemblyWorkbenchCommand,
  };
}

function normalizeFieldValue(
  field: AssemblyWorkbenchEditableField,
  nextValue: number | string
): number | string | null {
  if (field.units === 'sequence') return typeof nextValue === 'string' ? nextValue : null;
  const numeric = typeof nextValue === 'number' ? nextValue : Number(nextValue);
  if (!Number.isFinite(numeric)) return null;
  const integerValue = Math.round(numeric);
  if (!field.range) return integerValue;
  return clamp(integerValue, field.range.min, field.range.max);
}

function clonePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return structuredCloneAvailable()
    ? structuredClone(payload)
    : (JSON.parse(JSON.stringify(payload)) as Record<string, unknown>);
}

function structuredCloneAvailable(): boolean {
  return typeof structuredClone === 'function';
}

function setNestedPayloadValue(
  payload: Record<string, unknown>,
  path: string,
  value: number | string
): boolean {
  const parts = path.split('.');
  let target: Record<string, unknown> = payload;
  for (const part of parts.slice(0, -1)) {
    const next = target[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) return false;
    target = next as Record<string, unknown>;
  }
  target[parts[parts.length - 1]] = value;
  return true;
}

function rejected(
  field: AssemblyWorkbenchEditableField,
  reason: Extract<EditableFieldCommandResolveResult, { status: 'rejected' }>['reason'],
  message: string
): EditableFieldCommandResolveResult {
  return {
    status: 'rejected',
    fieldId: field.id,
    reason,
    message,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
