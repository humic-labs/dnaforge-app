export type JsonSafeValue =
  | null
  | boolean
  | number
  | string
  | JsonSafeValue[]
  | { [key: string]: JsonSafeValue };

function marker(type: string, fields: Record<string, JsonSafeValue> = {}): JsonSafeValue {
  return { __conversation_ledger_type: type, ...fields };
}

function sanitize(value: unknown, seen: WeakSet<object>): JsonSafeValue {
  if (value === null) return null;

  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : marker('non_finite_number', { value: String(value) });
  }
  if (typeof value === 'bigint') return marker('bigint', { value: value.toString() });
  const primitiveType = typeof value;
  if (primitiveType === 'undefined') return marker('undefined');
  if (primitiveType === 'function') {
    return marker('function', { name: (value as { name?: string }).name || null });
  }
  if (primitiveType === 'symbol') return marker('symbol', { value: String(value) });

  if (value instanceof Date) return marker('date', { value: value.toISOString() });
  if (value instanceof Error) {
    return {
      __conversation_ledger_type: 'error',
      name: value.name,
      message: value.message,
      stack: value.stack ?? null,
      cause: sanitize((value as Error & { cause?: unknown }).cause, seen),
    };
  }
  if (value instanceof ArrayBuffer) {
    return marker('array_buffer', { base64: Buffer.from(value).toString('base64') });
  }
  if (ArrayBuffer.isView(value)) {
    return marker('typed_array', {
      name: value.constructor.name,
      base64: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64'),
    });
  }

  if (typeof value !== 'object') return marker('unknown', { value: String(value) });
  if (seen.has(value)) return marker('circular');
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => sanitize(entry, seen));
  }

  const input = value as Record<string, unknown>;
  const output: Record<string, JsonSafeValue> = {};
  const constructorName = value.constructor?.name;
  if (constructorName && constructorName !== 'Object') {
    output.__conversation_ledger_constructor = constructorName;
  }
  for (const [key, entry] of Object.entries(input)) {
    output[key] = sanitize(entry, seen);
  }
  return output;
}

export function serializeLedgerPayload(value: unknown): JsonSafeValue {
  return sanitize(value, new WeakSet<object>());
}

export function serializeLedgerLine(value: unknown): string {
  return JSON.stringify(serializeLedgerPayload(value));
}
