import { z } from 'zod';

const utf8 = (value: string) =>
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    new TextEncoder().encode(value)
  ) === value;
const text = z.string().min(1).max(1024);
const sha256 = z
  .string()
  .refine((value): value is `sha256:${string}` => /^sha256:[a-f0-9]{64}$/.test(value));
const line = z
  .string()
  .min(1)
  .refine((value) => !!value.trim() && !/[\0\r\n]/.test(value) && utf8(value));
const key = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const kind = z.enum(['text', 'number', 'boolean', 'date']);
const value = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('text'),
      value: z.string().refine((v) => !v.includes('\0') && utf8(v)),
    })
    .strict(),
  z
    .object({
      type: z.literal('number'),
      value: z
        .number()
        .finite()
        .refine((v) => !Number.isInteger(v) || Number.isSafeInteger(v)),
    })
    .strict(),
  z.object({ type: z.literal('boolean'), value: z.boolean() }).strict(),
  z
    .object({
      type: z.literal('date'),
      value: z
        .string()
        .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v),
    })
    .strict(),
]);
const reason = z
  .string()
  .min(1)
  .max(2000)
  .refine((v) => !!v.trim() && !v.includes('\0') && utf8(v));
const base = z
  .object({ project: text, entityId: text, requestId: text, expectedSourceSha256: sha256 })
  .strict();
const declaration = z
  .object({
    direction: z.enum(['inputs', 'outputs']),
    key,
    label: line,
    required: z.boolean(),
    description: line.nullable(),
    valueType: z.object({ kind }).strict(),
  })
  .strict();
const actual = z
  .object({
    collection: z.enum(['inputs', 'outputs', 'measurements']),
    key,
    label: line,
    value,
    origin: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('local-actual') }).strict(),
      z.object({ kind: z.literal('frozen-declaration'), definitionSha256: sha256 }).strict(),
    ]),
  })
  .strict();
export const protocolEditDeclarationsSchema = base
  .extend({
    choices: z
      .object({ upserts: z.array(declaration).min(1).max(100).readonly(), reason })
      .strict(),
  })
  .strict();
export const protocolRecordRunValuesSchema = base
  .extend({
    choices: z.object({ upserts: z.array(actual).min(1).max(100).readonly(), reason }).strict(),
  })
  .strict();
export type NativeProtocolEditDeclarationsRequest = z.infer<typeof protocolEditDeclarationsSchema>;
export type NativeProtocolRecordRunValuesRequest = z.infer<typeof protocolRecordRunValuesSchema>;
export const protocolValueEditRequestSchema = z.discriminatedUnion('kind', [
  protocolEditDeclarationsSchema.extend({ kind: z.literal('edit-protocol-declarations') }).strict(),
  protocolRecordRunValuesSchema.extend({ kind: z.literal('record-run-values') }).strict(),
]);
export type NativeProtocolValueEditRequest = z.infer<typeof protocolValueEditRequestSchema>;
export const nativeProtocolValueEditReceiptSchema = z
  .object({
    version: z.literal(2),
    requestId: text,
    intentSha256: sha256,
    operation: z.literal('save'),
    phase: z.enum(['prepared', 'published', 'ready']),
    projectId: text,
    root: text,
    entityId: text,
    portableId: text,
    fileObjectUuid: text,
    path: text,
    kind: z.enum(['protocol', 'protocol-run']),
    text: z.string().min(1),
    at: z.number().int().nonnegative(),
    actor: text,
    expectedFileSha256: sha256,
    protocolSource: z.null(),
    request: protocolValueEditRequestSchema,
    base: z
      .object({
        originalText: z.string().min(1),
        sourceSha256: sha256,
        fileSha256: sha256,
        bindingSha256: sha256,
        referencesSha256: sha256,
      })
      .strict(),
    output: z.object({ sourceSha256: sha256, fileSha256: sha256, changed: z.boolean() }).strict(),
  })
  .strict();
export type NativeProtocolValueEditReceipt = z.infer<typeof nativeProtocolValueEditReceiptSchema>;
