export const METADATA_FIELD_TYPES = [
  'text',
  'long_text',
  'number',
  'boolean',
  'enum',
  'date',
  'string_array',
] as const;

export type MetadataFieldType = (typeof METADATA_FIELD_TYPES)[number];

export interface MetadataFieldDefinition<T extends string = MetadataFieldType> {
  key: string;
  label: string;
  type: T;
  required?: boolean;
  suggested?: boolean;
  enumOptions?: readonly string[];
  maxLength?: number;
  minValue?: number;
  maxValue?: number;
  minDate?: string;
  maxDate?: string;
  description?: string;
  readOnly?: boolean;
}

export interface MetadataValueIssues {
  malformed: string[];
  incomplete: string[];
}

export interface MetadataValidationOptions {
  rejectUnknownFields?: boolean;
}

const fieldKeys = new Set([
  'key',
  'label',
  'type',
  'required',
  'suggested',
  'enumOptions',
  'maxLength',
  'minValue',
  'maxValue',
  'minDate',
  'maxDate',
  'description',
  'readOnly',
]);

export function isMetadataFieldType(value: unknown): value is MetadataFieldType {
  return typeof value === 'string' && (METADATA_FIELD_TYPES as readonly string[]).includes(value);
}

export function parseMetadataFieldDefinitions(value: unknown): MetadataFieldDefinition[] {
  if (!Array.isArray(value)) throw new TypeError('metadata fields must be an array');
  const keys = new Set<string>();
  return Array.from(value, (raw, index) => {
    const path = `metadata fields[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TypeError(`${path} must be an object`);
    }
    const field = raw as Record<string, unknown>;
    for (const key of Object.keys(field)) {
      if (!fieldKeys.has(key)) throw new TypeError(`${path}.${key} is not supported`);
    }
    if (typeof field.key !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(field.key)) {
      throw new TypeError(
        `${path}.key must start with a letter and contain only letters, digits, or underscores`
      );
    }
    if (keys.has(field.key)) throw new TypeError(`${path}.key duplicates ${field.key}`);
    keys.add(field.key);
    if (typeof field.label !== 'string' || field.label.length === 0) {
      throw new TypeError(`${path}.label must be a nonempty string`);
    }
    if (!isMetadataFieldType(field.type)) throw new TypeError(`${path}.type is not supported`);
    const parsed: MetadataFieldDefinition = {
      key: field.key,
      label: field.label,
      type: field.type,
    };
    for (const key of ['required', 'suggested', 'readOnly'] as const) {
      if (field[key] !== undefined) {
        if (typeof field[key] !== 'boolean')
          throw new TypeError(`${path}.${key} must be a boolean`);
        parsed[key] = field[key];
      }
    }
    if (field.enumOptions !== undefined) {
      if (
        !Array.isArray(field.enumOptions) ||
        Array.from(field.enumOptions).some(
          (entry) => typeof entry !== 'string' || entry.length === 0
        )
      ) {
        throw new TypeError(`${path}.enumOptions must be an array of nonempty strings`);
      }
      parsed.enumOptions = [...field.enumOptions];
    }
    if (parsed.type === 'enum' && !parsed.enumOptions?.length) {
      throw new TypeError(`${path}: enum fields require enumOptions`);
    }
    if (field.maxLength !== undefined) {
      if (
        typeof field.maxLength !== 'number' ||
        !Number.isSafeInteger(field.maxLength) ||
        field.maxLength <= 0
      ) {
        throw new TypeError(`${path}.maxLength must be a positive safe integer`);
      }
      parsed.maxLength = field.maxLength;
    }
    for (const key of ['minValue', 'maxValue'] as const) {
      if (field[key] !== undefined) {
        if (typeof field[key] !== 'number' || !Number.isFinite(field[key])) {
          throw new TypeError(`${path}.${key} must be a finite number`);
        }
        parsed[key] = field[key];
      }
    }
    for (const key of ['minDate', 'maxDate'] as const) {
      if (field[key] !== undefined) {
        if (typeof field[key] !== 'string' || !isIsoDateTime(field[key])) {
          throw new TypeError(`${path}.${key} must be an ISO date-time with an offset`);
        }
        parsed[key] = field[key];
      }
    }
    if (field.description !== undefined) {
      if (typeof field.description !== 'string')
        throw new TypeError(`${path}.description must be a string`);
      parsed.description = field.description;
    }
    if (parsed.required && parsed.suggested)
      throw new TypeError(`${path}: required fields cannot also be suggested optionals`);
    if (
      parsed.minValue !== undefined &&
      parsed.maxValue !== undefined &&
      parsed.minValue > parsed.maxValue
    ) {
      throw new TypeError(`${path}: maxValue must be greater than or equal to minValue`);
    }
    if (
      parsed.minDate !== undefined &&
      parsed.maxDate !== undefined &&
      Date.parse(parsed.minDate) > Date.parse(parsed.maxDate)
    ) {
      throw new TypeError(`${path}: maxDate must be on or after minDate`);
    }
    return parsed;
  });
}

export function metadataFieldDefinitionsJsonSchema(): Record<string, unknown> {
  return {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['key', 'label', 'type'],
      properties: {
        key: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]*$' },
        label: { type: 'string', minLength: 1 },
        type: { type: 'string', enum: [...METADATA_FIELD_TYPES] },
        required: { type: 'boolean' },
        suggested: { type: 'boolean' },
        readOnly: { type: 'boolean' },
        enumOptions: { type: 'array', items: { type: 'string', minLength: 1 } },
        maxLength: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        minValue: { type: 'number' },
        maxValue: { type: 'number' },
        minDate: { type: 'string', format: 'date-time' },
        maxDate: { type: 'string', format: 'date-time' },
        description: { type: 'string' },
      },
      allOf: [
        {
          if: { properties: { type: { const: 'enum' } }, required: ['type'] },
          then: { required: ['enumOptions'], properties: { enumOptions: { minItems: 1 } } },
        },
        {
          not: {
            properties: { required: { const: true }, suggested: { const: true } },
            required: ['required', 'suggested'],
          },
        },
      ],
    },
  };
}

export function isMetadataValueMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

export function validateMetadataFieldValue(
  field: MetadataFieldDefinition,
  value: unknown
): string | null {
  switch (field.type) {
    case 'text':
    case 'long_text':
      if (typeof value !== 'string') return `${field.key} must be a string`;
      return field.maxLength !== undefined && value.length > field.maxLength
        ? `${field.key} exceeds ${field.maxLength} characters`
        : null;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value))
        return `${field.key} must be a finite number`;
      if (field.minValue !== undefined && value < field.minValue)
        return `${field.key} must be at least ${field.minValue}`;
      if (field.maxValue !== undefined && value > field.maxValue)
        return `${field.key} must be at most ${field.maxValue}`;
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${field.key} must be a boolean`;
    case 'string_array':
      return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
        ? null
        : `${field.key} must be an array of strings`;
    case 'enum':
      if (typeof value !== 'string') return `${field.key} must be a string`;
      return field.enumOptions && !field.enumOptions.includes(value)
        ? `${field.key} must be one of ${field.enumOptions.join(', ')}`
        : null;
    case 'date': {
      if (typeof value !== 'string') return `${field.key} must be a string`;
      if (field.minDate === undefined && field.maxDate === undefined) return null;
      const epoch = Date.parse(value);
      if (!Number.isFinite(epoch)) return `${field.key} must be a valid date`;
      if (field.minDate !== undefined && epoch < Date.parse(field.minDate))
        return `${field.key} must be on or after ${field.minDate}`;
      if (field.maxDate !== undefined && epoch > Date.parse(field.maxDate))
        return `${field.key} must be on or before ${field.maxDate}`;
      return null;
    }
  }
}

export function classifyMetadataValues(
  fields: readonly MetadataFieldDefinition[],
  values: Readonly<Record<string, unknown>>,
  options: MetadataValidationOptions = {}
): MetadataValueIssues {
  const malformed: string[] = [];
  const incomplete: string[] = [];
  for (const field of fields) {
    const value = Object.hasOwn(values, field.key) ? values[field.key] : undefined;
    if (isMetadataValueMissing(value)) {
      if (field.required) incomplete.push(`${field.key} is required`);
      continue;
    }
    const error = validateMetadataFieldValue(field, value);
    if (error) malformed.push(error);
  }
  if (options.rejectUnknownFields) {
    const keys = new Set(fields.map((field) => field.key));
    for (const key of Object.keys(values)) {
      if (!keys.has(key)) malformed.push(`${key} is not a declared field`);
    }
  }
  return { malformed, incomplete };
}

export function validateMetadataValues(
  fields: readonly MetadataFieldDefinition[],
  values: Readonly<Record<string, unknown>>,
  options?: MetadataValidationOptions
): string[] {
  const { malformed, incomplete } = classifyMetadataValues(fields, values, options);
  return [...malformed, ...incomplete];
}

function isIsoDateTime(value: string): boolean {
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value
    );
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}
