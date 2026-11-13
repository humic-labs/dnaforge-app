import { z } from 'zod';
import { parseDelimitedRows } from './delimited-rows';
import { translatedCdsCorrespondenceSchema } from './molecular-correspondence';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const name = z.string().min(1).max(200);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const scalar = z.union([z.string().max(10_000), z.number().finite(), z.boolean(), z.null()]);
export type MolecularDataValue = z.infer<typeof scalar>;
const integer = z.number().int();
const text = z.string().min(1).max(200);

const selectorShape = {
  label_entity_id: text.optional(),
  label_asym_id: text.optional(),
  auth_asym_id: text.optional(),
  label_seq_id: integer.optional(),
  auth_seq_id: integer.optional(),
  pdbx_PDB_ins_code: z.string().max(10).optional(),
  beg_label_seq_id: integer.optional(),
  end_label_seq_id: integer.optional(),
  beg_auth_seq_id: integer.optional(),
  end_auth_seq_id: integer.optional(),
  label_comp_id: text.optional(),
  auth_comp_id: text.optional(),
  label_atom_id: text.optional(),
  auth_atom_id: text.optional(),
  type_symbol: text.optional(),
  atom_id: integer.optional(),
  atom_index: integer.nonnegative().optional(),
  instance_id: text.optional(),
};
export const molecularDataSelectorExpressionSchema = z
  .object(selectorShape)
  .strict()
  .superRefine((value, context) => {
    const positional = [
      'label_seq_id',
      'auth_seq_id',
      'beg_label_seq_id',
      'end_label_seq_id',
      'beg_auth_seq_id',
      'end_auth_seq_id',
      'pdbx_PDB_ins_code',
    ].some((key) => key in value);
    if (
      !Object.keys(value).length ||
      (positional && !value.label_asym_id && !value.auth_asym_id && !value.label_entity_id)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Residue positions need an explicit chain or entity scope; empty selections are not allowed.',
      });
    for (const [begin, end] of [
      ['beg_label_seq_id', 'end_label_seq_id'],
      ['beg_auth_seq_id', 'end_auth_seq_id'],
    ] as const)
      if (value[begin] !== undefined && value[end] !== undefined && value[begin]! > value[end]!)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Selection ranges must increase.',
        });
  });
export const molecularDataSelectorSchema = z.union([
  molecularDataSelectorExpressionSchema,
  z.array(molecularDataSelectorExpressionSchema).min(1).max(1000),
]);
export type MolecularDataSelector = z.infer<typeof molecularDataSelectorSchema>;
const selectorKeySchema = z.enum(
  Object.keys(selectorShape) as [keyof typeof selectorShape, ...(keyof typeof selectorShape)[]]
);
const targetSchema = z
  .object({ row: z.number().int().nonnegative(), selector: molecularDataSelectorSchema })
  .strict();
const unresolvedSchema = z
  .object({ row: z.number().int().nonnegative(), reason: z.string().min(1).max(1000) })
  .strict();
const sourceSchema = z
  .object({
    label: z.string().min(1).max(500),
    correspondence: translatedCdsCorrespondenceSchema.optional(),
    script: z.string().max(2000).optional(),
    program: z
      .object({
        path: z.string().min(1).max(4096),
        sha256: hash,
        text: z.string().min(1).max(1_000_000),
      })
      .strict()
      .optional(),
    metadata: z.record(z.string().max(200), z.unknown()).optional(),
  })
  .strict();

export const molecularDataPublicationSchema = z
  .object({
    id: name,
    name,
    records: z
      .array(z.record(z.string().min(1).max(200), scalar))
      .min(1)
      .max(20_000)
      .optional()
      .describe(
        'Original scalar records with arbitrary column names. Supply records or table, exactly one.'
      ),
    table: z
      .object({ format: z.enum(['csv', 'tsv']), text: z.string().min(1).max(2_000_000) })
      .strict()
      .optional()
      .describe('Original CSV/TSV bytes as text. Supply table or records, exactly one.'),
    source: sourceSchema,
    mapping: z
      .object({
        coordinateSha256: hash,
        selectorColumns: z
          .record(selectorKeySchema, name)
          .optional()
          .describe(
            'Automatic mapping: selector keys map to table column names, e.g. {"label_asym_id":"chain"}. Supply selectorColumns or targets, exactly one. Rows in unresolved are skipped; all other rows are mapped and checked against the loaded coordinates.'
          ),
        selectorColumn: name
          .optional()
          .describe(
            'Column containing a JSON molecular selector or selector array in each row. This supports mixed protein, RNA, ligand and atom targets without requiring every row to have a sequence position. Supply exactly one of selectorColumn, selectorColumns or targets.'
          ),
        targets: z
          .array(targetSchema)
          .max(40_000)
          .optional()
          .describe(
            'Explicit mapping: zero-based data row and molecular selector. Supply targets or selectorColumns, exactly one. An explicitly targeted row cannot also be declared unresolved.'
          ),
        unresolved: z
          .array(unresolvedSchema)
          .max(20_000)
          .optional()
          .describe(
            'Optional zero-based rows and reasons declared unresolved by the producer. Automatic column mapping skips these rows while retaining their data and reasons. The app also reports missing or invalid targets itself.'
          ),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.records) === Boolean(value.table))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Supply records or a CSV/TSV table, exactly one.',
      });
    if (
      [value.mapping.selectorColumn, value.mapping.selectorColumns, value.mapping.targets].filter(
        (value) => value !== undefined
      ).length !== 1
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Supply selectorColumn, selectorColumns or explicit targets, exactly one.',
      });
    if (value.mapping.selectorColumns) {
      const placeholders = Object.fromEntries(
        Object.keys(value.mapping.selectorColumns).map((key) => [
          key,
          selectorShape[key as keyof typeof selectorShape].unwrap() instanceof z.ZodNumber
            ? 1
            : 'scope',
        ])
      );
      if (!molecularDataSelectorExpressionSchema.safeParse(placeholders).success)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Selector columns must describe supported, scoped molecular targets.',
        });
    }
    if (JSON.stringify(value).length > 2_000_000)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A publication exceeds the 2 MB data limit.',
      });
  });
export type MolecularDataPublication = z.infer<typeof molecularDataPublicationSchema>;

export const molecularDatasetSchema = z
  .object({
    id: name,
    name,
    revision: hash,
    records: z
      .array(z.record(z.string().min(1).max(200), scalar))
      .min(1)
      .max(20_000),
    source: sourceSchema,
    originalTable: z
      .object({ format: z.enum(['csv', 'tsv']), text: z.string().max(2_000_000) })
      .strict()
      .optional(),
  })
  .strict();
export const molecularDataMappingSchema = z
  .object({
    datasetId: name,
    dataRevision: hash,
    revision: hash,
    coordinateSha256: hash,
    targets: z.array(targetSchema).max(40_000),
    unresolved: z.array(unresolvedSchema).max(20_000),
  })
  .strict();
export const molecularDataStyleSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('continuous'),
      domain: z.array(z.number().finite()).length(2),
      colors: z.array(hex).min(2).max(32),
      missingColor: hex,
      transform: z.enum(['linear', 'log10']).default('linear'),
      quantization: z.number().int().min(2).max(4096).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('categorical'),
      colors: z.record(z.string().max(10_000), hex),
      missingColor: hex,
    })
    .strict(),
]);
export const molecularDataLayerSchema = z
  .object({
    id: name,
    name,
    datasetId: name,
    dataRevision: hash,
    mappingRevision: hash,
    column: name,
    units: z.string().max(80).optional(),
    style: molecularDataStyleSchema,
    filter: z.object({ column: name, equals: scalar }).strict().optional(),
    backgroundSelector: molecularDataSelectorSchema.optional(),
  })
  .strict()
  .superRefine((layer, context) => {
    if (layer.style.kind === 'continuous') {
      const [low, high] = layer.style.domain;
      if (low >= high || (layer.style.transform === 'log10' && low <= 0))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'The color domain must increase; log10 requires positive endpoints.',
        });
    }
  });
export type MolecularDataset = z.infer<typeof molecularDatasetSchema>;
export type MolecularDataMapping = z.infer<typeof molecularDataMappingSchema>;
export type MolecularDataLayer = z.infer<typeof molecularDataLayerSchema>;
export const molecularDataViewSchema = z
  .object({
    version: z.literal(1),
    datasets: z.array(molecularDatasetSchema).max(20),
    mappings: z.array(molecularDataMappingSchema).max(40),
    layers: z.array(molecularDataLayerSchema).max(40),
    activeLayerId: name.optional(),
    baseScene: z.string().min(1).max(500_000).optional(),
    retained: z
      .array(
        z
          .object({
            dataRevision: hash,
            mappingRevision: hash,
            datasetReferenceId: name,
            mappingReferenceId: name,
          })
          .strict()
      )
      .max(40)
      .optional(),
  })
  .strict()
  .refine(
    (value) => JSON.stringify(value).length <= 2_000_000,
    'The working data view exceeds the current 2 MB limit.'
  );
export type MolecularDataView = z.infer<typeof molecularDataViewSchema>;

export function validateMolecularDataMapping(
  dataset: MolecularDataset,
  mapping: MolecularDataMapping
): void {
  if (mapping.datasetId !== dataset.id || mapping.dataRevision !== dataset.revision)
    throw new Error('The mapping names a different data revision.');
  if (
    [...mapping.targets, ...mapping.unresolved].some(
      (target) => target.row >= dataset.records.length
    )
  )
    throw new Error('A mapping refers to a row outside the published data.');
  const mapped = new Set(mapping.targets.map((target) => target.row));
  if (mapping.unresolved.some((target) => mapped.has(target.row)))
    throw new Error('A row cannot be both mapped and explicitly unresolved.');
  const covered = new Set([...mapped, ...mapping.unresolved.map((target) => target.row)]);
  if (dataset.records.some((_, row) => !covered.has(row)))
    throw new Error('A data row is missing its mapping or unresolved reason.');
}

export function stableMolecularDataJson(value: unknown): string {
  const normalize = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(normalize)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, value]) => [key, normalize(value)])
          )
        : item;
  return JSON.stringify(normalize(value));
}
export async function molecularDataDigest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(stableMolecularDataJson(value))
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function parseMolecularDataTable(
  text: string,
  format: 'csv' | 'tsv'
): Array<Record<string, MolecularDataValue>> {
  const parsed = parseDelimitedRows(text.replace(/^\uFEFF/, ''), format === 'csv' ? ',' : '\t', {
    skipEmptyLines: true,
  });
  if (!parsed.ok) throw new Error(parsed.error);
  const rows = parsed.rows;
  const headers = rows.shift();
  if (
    !headers?.length ||
    headers.some((header) => !header.trim()) ||
    new Set(headers).size !== headers.length
  )
    throw new Error('Table headers must be nonempty and unique.');
  return rows.map((row, index) => {
    if (row.length !== headers.length)
      throw new Error(
        `Table row ${index + 2} has ${row.length} columns; expected ${headers.length}.`
      );
    return Object.fromEntries(
      headers.map((header, index) => [header, row[index] === '' ? null : row[index]])
    );
  });
}

export async function prepareMolecularDataPublication(
  input: unknown
): Promise<{ dataset: MolecularDataset; mapping: MolecularDataMapping }> {
  const publication = molecularDataPublicationSchema.parse(input);
  const records =
    publication.records ??
    parseMolecularDataTable(publication.table!.text, publication.table!.format);
  const contents = {
    id: publication.id,
    name: publication.name,
    records,
    source: publication.source,
    ...(publication.table ? { originalTable: publication.table } : {}),
  };
  const dataset = molecularDatasetSchema.parse({
    ...contents,
    revision: await molecularDataDigest(contents),
  });
  const targets = [...(publication.mapping.targets ?? [])];
  const unresolved = [...(publication.mapping.unresolved ?? [])];
  const declaredUnresolvedRows = new Set(unresolved.map(({ row }) => row));
  const selectorColumn = publication.mapping.selectorColumn;
  if (selectorColumn) {
    if (!records.some((row) => Object.prototype.hasOwnProperty.call(row, selectorColumn)))
      throw new Error(`Target column '${selectorColumn}' is absent from the data.`);
    records.forEach((row, index) => {
      if (declaredUnresolvedRows.has(index)) return;
      try {
        const value = row[selectorColumn];
        if (typeof value !== 'string') throw new Error('Missing selector');
        const selector = molecularDataSelectorSchema.parse(JSON.parse(value));
        targets.push({ row: index, selector });
      } catch {
        unresolved.push({
          row: index,
          reason: 'Missing or invalid molecular selector in this row.',
        });
      }
    });
  }
  const columns = publication.mapping.selectorColumns;
  if (columns) {
    for (const column of Object.values(columns))
      if (!records.some((row) => Object.prototype.hasOwnProperty.call(row, column)))
        throw new Error(`Target column '${column}' is absent from the data.`);
    records.forEach((row, index) => {
      if (declaredUnresolvedRows.has(index)) return;
      const selector = Object.fromEntries(
        Object.entries(columns).map(([key, column]) => {
          const value = row[column];
          const isInteger =
            selectorShape[key as keyof typeof selectorShape].unwrap() instanceof z.ZodNumber;
          return [
            key,
            isInteger && typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value,
          ];
        })
      );
      const parsed = molecularDataSelectorExpressionSchema.safeParse(selector);
      if (parsed.success) targets.push({ row: index, selector: parsed.data });
      else
        unresolved.push({
          row: index,
          reason: 'Missing or invalid target identifiers in this row.',
        });
    });
  }
  if ([...targets, ...unresolved].some((target) => target.row >= records.length))
    throw new Error('A mapping refers to a row outside the published data.');
  if (unresolved.some((row) => targets.some((target) => target.row === row.row)))
    throw new Error('A row cannot be both mapped and explicitly unresolved.');
  const covered = new Set([...targets, ...unresolved].map((target) => target.row));
  records.forEach((_, row) => {
    if (!covered.has(row)) unresolved.push({ row, reason: 'No target mapping supplied.' });
  });
  const mappingContents = {
    datasetId: dataset.id,
    dataRevision: dataset.revision,
    coordinateSha256: publication.mapping.coordinateSha256,
    targets,
    unresolved,
  };
  return {
    dataset,
    mapping: molecularDataMappingSchema.parse({
      ...mappingContents,
      revision: await molecularDataDigest(mappingContents),
    }),
  };
}

export function molecularDataColor(
  value: MolecularDataValue | undefined,
  style: MolecularDataLayer['style']
): string {
  if (value === null || value === undefined || value === '') return style.missingColor;
  if (style.kind === 'categorical')
    return Object.prototype.hasOwnProperty.call(style.colors, String(value))
      ? style.colors[String(value)]
      : style.missingColor;
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(numeric))
    throw new Error(
      'The selected column has nonnumeric values; choose a categorical palette or publish numeric results.'
    );
  const transform = style.transform === 'log10' ? Math.log10 : (number: number) => number;
  if (style.transform === 'log10' && numeric <= 0)
    throw new Error('Log10 cannot display zero or negative values.');
  const [low, high] = style.domain.map(transform);
  const t = Math.max(0, Math.min(1, (transform(numeric) - low) / (high - low)));
  const fraction =
    (style.quantization ? Math.round(t * style.quantization) / style.quantization : t) *
    (style.colors.length - 1);
  const index = Math.min(style.colors.length - 2, Math.floor(fraction));
  const amount = fraction - index;
  const channels = (color: string) =>
    [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
  const a = channels(style.colors[index]),
    b = channels(style.colors[index + 1]);
  return `#${a
    .map((value, index) =>
      Math.round(value + (b[index] - value) * amount)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

export function compileMolecularDataColors(
  dataset: MolecularDataset,
  mapping: MolecularDataMapping,
  layer: MolecularDataLayer
): Array<{ row: number; selector: MolecularDataSelector; color: string }> {
  validateMolecularDataMapping(dataset, mapping);
  if (
    dataset.id !== layer.datasetId ||
    dataset.revision !== layer.dataRevision ||
    mapping.datasetId !== dataset.id ||
    mapping.dataRevision !== dataset.revision ||
    mapping.revision !== layer.mappingRevision
  )
    throw new Error('The layer names a stale or mismatched data/mapping revision.');
  if (!dataset.records.some((row) => Object.prototype.hasOwnProperty.call(row, layer.column)))
    throw new Error(`Data column '${layer.column}' is absent.`);
  if (
    layer.filter &&
    !dataset.records.some((row) => Object.prototype.hasOwnProperty.call(row, layer.filter!.column))
  )
    throw new Error('The filter column is absent.');
  const seen = new Map<string, number>();
  return mapping.targets
    .filter(
      (target) =>
        !layer.filter || dataset.records[target.row][layer.filter.column] === layer.filter.equals
    )
    .map((target) => {
      const key = stableMolecularDataJson(target.selector);
      if (seen.has(key) && seen.get(key) !== target.row)
        throw new Error(
          'Multiple observations overlap this target. Select a replicate/condition or publish an explicitly aggregated result.'
        );
      seen.set(key, target.row);
      return {
        ...target,
        color: molecularDataColor(dataset.records[target.row][layer.column], layer.style),
      };
    });
}
