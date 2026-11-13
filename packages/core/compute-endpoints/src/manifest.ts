import { z } from 'zod';

export const COMPUTE_OPERATIONS = [
  'list_tools',
  'get_schema',
  'validate',
  'estimate',
  'submit',
  'status',
  'fetch_result',
  'cancel',
] as const;
export type ComputeOperation = (typeof COMPUTE_OPERATIONS)[number];

export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;

const httpsUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith('https://'), { message: 'must be an https:// URL' });

function isSafeRelativeRestPath(value: string): boolean {
  return (
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    !value.includes('#') &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

const RelativeRestPathSchema = z.string().min(1).max(256).refine(isSafeRelativeRestPath, {
  message: 'must be a same-origin relative path beginning with one slash',
});

export const ALLOWED_CREDENTIAL_HEADERS = ['x-api-key', 'authorization'] as const;

export const AuthSchemeSchema = z.discriminatedUnion('scheme', [
  z.object({
    scheme: z.literal('header'),
    headerName: z.enum(ALLOWED_CREDENTIAL_HEADERS),
    keyPrefix: z.string().min(1).max(32).optional(),
  }),
  z.object({
    scheme: z.literal('bearer'),
    keyPrefix: z.string().min(1).max(32).optional(),
  }),
  z.object({
    scheme: z.literal('oauth'),
    authorizationUrl: httpsUrl,
    tokenUrl: httpsUrl,
    scopes: z.array(z.string().min(1)).default([]),
  }),
]);
export type AuthScheme = z.infer<typeof AuthSchemeSchema>;

export const VerifyRequestSchema = z.object({
  method: z.enum(['GET', 'POST']),
  target: z.string().min(1).max(256),
  expectKey: z.string().min(1).max(64).optional(),
  okStatuses: z.array(z.number().int().min(400).max(499)).max(8).optional(),
});
export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;

export const TOOLMAP_PLACEHOLDERS = [
  '$tool_id',
  '$settings',
  '$label',
  '$remote_id',
  '$search',
  '$tags',
  '$tag',
  '$files',
  '$idempotency_key',
] as const;

export const ToolMapEntrySchema = z.union([
  z.string().min(1),
  z.object({
    tool: z.string().min(1),
    args: z.record(z.string().min(1), z.enum(TOOLMAP_PLACEHOLDERS)).default({}),
    resultPath: z.string().max(128).optional(),
  }),
]);
export type ToolMapEntry = z.infer<typeof ToolMapEntrySchema>;

export const ToolMapSchema = z.object({
  list_tools: ToolMapEntrySchema,
  get_schema: ToolMapEntrySchema,
  validate: ToolMapEntrySchema.optional(),
  estimate: ToolMapEntrySchema.optional(),
  submit: ToolMapEntrySchema,
  status: ToolMapEntrySchema,
  fetch_result: ToolMapEntrySchema,
  cancel: ToolMapEntrySchema.optional(),
});
export type ToolMap = z.infer<typeof ToolMapSchema>;

export const CancellationSchema = z.object({
  mode: z.enum(['provider', 'unavailable']),
  note: z.string().min(1).max(300),
});
export type Cancellation = z.infer<typeof CancellationSchema>;

export const JOB_STATES = ['queued', 'running', 'completed', 'failed', 'canceled'] as const;

const HttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const HttpJobPathTemplateSchema = RelativeRestPathSchema.refine(
  (value) => value.includes('{remote_id}'),
  {
    message: 'must contain {remote_id}',
  }
);
const SAFE_HTTP_JOB_HEADERS = new Set(['accept', 'content-type', 'prefer']);
const HttpJobHeadersSchema = z
  .record(z.string().min(1).max(80), z.string().max(500))
  .superRefine((headers, ctx) => {
    for (const name of Object.keys(headers)) {
      if (!SAFE_HTTP_JOB_HEADERS.has(name.toLowerCase())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: 'header is not in the declarative HTTP driver allowlist',
        });
      }
    }
  });

const HttpJobDriverSchema = z.object({
  kind: z.literal('http-job'),
  submit: z.object({
    method: HttpMethodSchema.default('POST'),
    idPath: z.string().min(1).max(128),
    bodyTemplate: z.unknown().optional(),
    headers: HttpJobHeadersSchema.optional(),
    acceptedStatuses: z.array(z.number().int().min(200).max(299)).min(1).max(8).optional(),
  }),
  status: z.object({
    method: HttpMethodSchema.default('GET'),
    pathTemplate: HttpJobPathTemplateSchema,
    statePath: z.string().min(1).max(128),
    statusMap: z.record(z.string().min(1), z.enum(JOB_STATES)),
  }),
  result: z.object({
    payloadPath: z.string().max(128).default(''),
    codec: z.enum(['raw-json']).default('raw-json'),
  }),
  cancel: z
    .object({
      method: HttpMethodSchema.default('POST'),
      pathTemplate: HttpJobPathTemplateSchema,
      statePath: z.string().min(1).max(128).optional(),
    })
    .optional(),
});

const HTTP_JOB_BODY_PLACEHOLDERS = new Set(['$settings', '$tool_id', '$label', '$idempotency_key']);

const INPUT_SCHEMA_KEYS = new Set([
  'type',
  'title',
  'description',
  'default',
  'enum',
  'required',
  'properties',
  'items',
  'minLength',
  'maxLength',
  'pattern',
  'patternMessage',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'additionalProperties',
]);
const INPUT_SCHEMA_TYPES = new Set([
  'object',
  'array',
  'string',
  'integer',
  'number',
  'boolean',
  'null',
]);
const SAFE_SIMPLE_PATTERN = /^\^\[[^\]\r\n]{1,80}\](?:[+*?]|\{\d{1,4}(?:,\d{0,4})?\})?\$$/u;

interface InputSchemaIssue {
  path: Array<string | number>;
  message: string;
}

function inputSchemaIssues(
  schema: unknown,
  path: Array<string | number> = [],
  depth = 0
): InputSchemaIssue[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return [{ path, message: 'must be an object' }];
  }
  if (depth > 12) return [{ path, message: 'may not be nested more than 12 levels' }];
  const value = schema as Record<string, unknown>;
  const issues: InputSchemaIssue[] = [];
  for (const key of Object.keys(value)) {
    if (!INPUT_SCHEMA_KEYS.has(key)) {
      issues.push({ path: [...path, key], message: 'is not a supported schema keyword' });
    }
  }
  if (value.type !== undefined && !INPUT_SCHEMA_TYPES.has(String(value.type))) {
    issues.push({ path: [...path, 'type'], message: 'is not a supported JSON type' });
  }
  for (const key of ['title', 'description', 'patternMessage'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 500)) {
      issues.push({ path: [...path, key], message: 'must be a string of at most 500 characters' });
    }
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    const bound = value[key];
    if (
      bound !== undefined &&
      (!Number.isSafeInteger(bound) || Number(bound) < 0 || Number(bound) > 1_000_000)
    ) {
      issues.push({ path: [...path, key], message: 'must be an integer from 0 to 1000000' });
    }
  }
  for (const key of ['minimum', 'maximum'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'number') {
      issues.push({ path: [...path, key], message: 'must be a number' });
    }
  }
  if (
    typeof value.minimum === 'number' &&
    typeof value.maximum === 'number' &&
    value.minimum > value.maximum
  ) {
    issues.push({ path, message: 'minimum may not exceed maximum' });
  }
  if (
    typeof value.minLength === 'number' &&
    typeof value.maxLength === 'number' &&
    value.minLength > value.maxLength
  ) {
    issues.push({ path, message: 'minLength may not exceed maxLength' });
  }
  if (
    typeof value.minItems === 'number' &&
    typeof value.maxItems === 'number' &&
    value.minItems > value.maxItems
  ) {
    issues.push({ path, message: 'minItems may not exceed maxItems' });
  }
  if (value.pattern !== undefined) {
    if (typeof value.pattern !== 'string' || !SAFE_SIMPLE_PATTERN.test(value.pattern)) {
      issues.push({
        path: [...path, 'pattern'],
        message: 'must be an anchored, bounded simple character-class pattern',
      });
    }
  }
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length > 256)) {
    issues.push({ path: [...path, 'enum'], message: 'must be an array of at most 256 values' });
  }
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean') {
    issues.push({ path: [...path, 'additionalProperties'], message: 'must be boolean' });
  }
  const properties = value.properties;
  if (properties !== undefined) {
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
      issues.push({ path: [...path, 'properties'], message: 'must be an object' });
    } else if (Object.keys(properties).length > 128) {
      issues.push({ path: [...path, 'properties'], message: 'may contain at most 128 fields' });
    } else {
      for (const [name, child] of Object.entries(properties)) {
        if (!name || name.length > 128) {
          issues.push({ path: [...path, 'properties', name], message: 'field name is invalid' });
        } else {
          issues.push(...inputSchemaIssues(child, [...path, 'properties', name], depth + 1));
        }
      }
    }
  }
  if (value.required !== undefined) {
    if (
      !Array.isArray(value.required) ||
      value.required.length > 128 ||
      value.required.some((field) => typeof field !== 'string' || !field || field.length > 128) ||
      new Set(value.required).size !== value.required.length
    ) {
      issues.push({
        path: [...path, 'required'],
        message: 'must contain unique valid field names',
      });
    }
  }
  if (value.items !== undefined) {
    issues.push(...inputSchemaIssues(value.items, [...path, 'items'], depth + 1));
  }
  return issues;
}

function invalidHttpBodyPlaceholder(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.startsWith('$') && !HTTP_JOB_BODY_PLACEHOLDERS.has(value) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const invalid = invalidHttpBodyPlaceholder(entry);
      if (invalid) return invalid;
    }
  } else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      const invalid = invalidHttpBodyPlaceholder(entry);
      if (invalid) return invalid;
    }
  }
  return null;
}

export const ComputeDriverSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mcp-tool-map') }),
  z.object({
    kind: z.literal('nvcf'),
    pollSeconds: z.number().int().min(1).max(300).default(30),
    pollSecondsHeader: z.string().min(1).max(80).default('NVCF-POLL-SECONDS'),
    requestIdHeader: z.string().min(1).max(80).default('nvcf-reqid'),
    statusPathTemplate: RelativeRestPathSchema.refine((value) => value.includes('{request_id}'), {
      message: 'must contain {request_id}',
    }).default('/status/{request_id}'),
    resultCodec: z.enum(['nvidia-biology', 'raw-json']).default('raw-json'),
  }),
  HttpJobDriverSchema,
]);
export type ComputeDriver = z.infer<typeof ComputeDriverSchema>;

const BaseManifestSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  id: z.string().regex(PROVIDER_ID_PATTERN, 'provider id must match ^[a-z][a-z0-9_-]{1,63}$'),
  displayName: z.string().min(1).max(80),
  summary: z.string().min(1).max(240),
  docsUrl: httpsUrl,
  keyPageUrl: httpsUrl.optional(),
  termsUrl: httpsUrl,
  privacyUrl: httpsUrl,
  auth: AuthSchemeSchema,
  verify: VerifyRequestSchema,
  catalog: z.enum(['dynamic', 'static']),
  jobModel: z.enum(['queue', 'longpoll-202', 'async']),
  staging: z.enum(['inline', 'upload', 'multipart']),
  cost: z.enum(['estimate', 'rate-card', 'credits', 'none']),
  disclosure: z.string().min(40).max(1200),
  retentionNote: z.string().min(1).max(400),
  cancellation: CancellationSchema,
  driver: ComputeDriverSchema.optional(),
  rateLimitRps: z.number().positive().max(50),
  staticTools: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        displayName: z.string().min(1).max(120),
        path: RelativeRestPathSchema,
        outputKind: z.enum(['structure', 'sequence-set', 'table', 'binary']),
        description: z.string().min(1).max(400).optional(),
        keywords: z.array(z.string().min(1).max(40)).max(20).optional(),
        inputSchema: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .optional(),
});

export const McpManifestSchema = BaseManifestSchema.extend({
  transport: z.literal('mcp'),
  mcpUrl: httpsUrl,
  toolMap: ToolMapSchema,
  statusPath: z.string().min(1).max(128),
  statusMap: z.record(z.string().min(1), z.enum(JOB_STATES)),
  remoteIdPath: z.string().max(128).default(''),
});

export const RestManifestSchema = BaseManifestSchema.extend({
  transport: z.literal('rest'),
  baseUrl: httpsUrl,
});

export const ProviderManifestSchema = z
  .discriminatedUnion('transport', [McpManifestSchema, RestManifestSchema])
  .superRefine((manifest, ctx) => {
    manifest.staticTools?.forEach((tool, index) => {
      if (!tool.inputSchema) return;
      for (const issue of inputSchemaIssues(tool.inputSchema)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['staticTools', index, 'inputSchema', ...issue.path],
          message: issue.message,
        });
      }
    });
    if (manifest.schemaVersion === 2 && !manifest.driver) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['driver'],
        message: 'driver is required in schema v2',
      });
    }
    if (manifest.driver?.kind === 'mcp-tool-map' && manifest.transport !== 'mcp') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['transport'],
        message: "driver 'mcp-tool-map' requires transport 'mcp'",
      });
    }
    if (manifest.driver?.kind === 'nvcf') {
      if (manifest.transport !== 'rest') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['transport'],
          message: "driver 'nvcf' requires transport 'rest'",
        });
      }
      if (manifest.jobModel !== 'longpoll-202') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['jobModel'],
          message: "driver 'nvcf' requires jobModel 'longpoll-202'",
        });
      }
      if (manifest.catalog !== 'static') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['catalog'],
          message: "driver 'nvcf' currently requires a static catalog",
        });
      }
      manifest.staticTools?.forEach((tool, index) => {
        if (!tool.inputSchema) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['staticTools', index, 'inputSchema'],
            message: "driver 'nvcf' requires an input schema for every tool",
          });
        }
      });
    }
    if (manifest.driver?.kind === 'http-job') {
      if (manifest.transport !== 'rest') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['transport'],
          message: "driver 'http-job' requires transport 'rest'",
        });
      }
      if (manifest.jobModel !== 'async') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['jobModel'],
          message: "driver 'http-job' requires jobModel 'async'",
        });
      }
      if (manifest.catalog !== 'static') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['catalog'],
          message: "driver 'http-job' currently requires a static catalog",
        });
      }
      manifest.staticTools?.forEach((tool, index) => {
        if (!tool.inputSchema) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['staticTools', index, 'inputSchema'],
            message: "driver 'http-job' requires an input schema for every tool",
          });
        }
      });
      const invalidPlaceholder = invalidHttpBodyPlaceholder(manifest.driver.submit.bodyTemplate);
      if (invalidPlaceholder) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['driver', 'submit', 'bodyTemplate'],
          message: `unknown or unsafe placeholder ${invalidPlaceholder}`,
        });
      }
      if (manifest.cancellation.mode === 'provider' && !manifest.driver.cancel) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['driver', 'cancel'],
          message: 'provider cancellation requires a cancel request',
        });
      }
      if (manifest.cancellation.mode === 'unavailable' && manifest.driver.cancel) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cancellation', 'mode'],
          message: "a cancel request requires cancellation.mode 'provider'",
        });
      }
    }
    if (manifest.transport === 'rest' && !isSafeRelativeRestPath(manifest.verify.target)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verify', 'target'],
        message: 'REST verification must use a same-origin relative path beginning with one slash',
      });
    }
    if (manifest.auth.scheme !== 'oauth' && !manifest.keyPageUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['keyPageUrl'],
        message: 'keyPageUrl is required when auth is header or bearer',
      });
    }
    if (
      manifest.catalog === 'static' &&
      !(manifest.staticTools && manifest.staticTools.length > 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['staticTools'],
        message: 'static catalogs must list at least one tool',
      });
    }
    if (manifest.catalog === 'dynamic' && manifest.staticTools && manifest.staticTools.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['staticTools'],
        message: 'dynamic catalogs must not embed a static tool list',
      });
    }
    if (
      manifest.cost === 'estimate' &&
      manifest.transport === 'mcp' &&
      !manifest.toolMap.estimate
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toolMap', 'estimate'],
        message: "cost 'estimate' requires toolMap.estimate",
      });
    }
    if (
      !/\bbill/i.test(manifest.disclosure) ||
      !manifest.disclosure.includes(manifest.displayName)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['disclosure'],
        message: 'disclosure must name the provider and say who is billed',
      });
    }
  });

export type ProviderManifest = z.infer<typeof ProviderManifestSchema>;

export type EffectiveDriverKind = ComputeDriver['kind'] | 'legacy-rest';

export function effectiveDriverKind(manifest: ProviderManifest): EffectiveDriverKind {
  if (manifest.driver) return manifest.driver.kind;
  return manifest.transport === 'mcp' ? 'mcp-tool-map' : 'legacy-rest';
}

export function toolMapEntry(entry: ToolMapEntry): {
  tool: string;
  args: Record<string, string>;
  resultPath?: string;
} {
  return typeof entry === 'string'
    ? { tool: entry, args: {} }
    : { tool: entry.tool, args: entry.args, resultPath: entry.resultPath };
}
export type McpProviderManifest = z.infer<typeof McpManifestSchema>;
export type RestProviderManifest = z.infer<typeof RestManifestSchema>;

export interface ManifestParseFailure {
  ok: false;
  errors: string[];
}
export interface ManifestParseSuccess {
  ok: true;
  manifest: ProviderManifest;
}

export function parseProviderManifest(input: unknown): ManifestParseSuccess | ManifestParseFailure {
  const result = ProviderManifestSchema.safeParse(input);
  if (result.success) {
    return { ok: true, manifest: result.data };
  }
  return {
    ok: false,
    errors: result.error.issues.map(
      (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`
    ),
  };
}

export function computeCredentialAccount(providerId: string): string {
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    throw new Error(`invalid provider id: ${providerId}`);
  }
  return `${providerId}_compute_key`;
}

export const PROVIDER_CREDENTIAL_ENV_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  tamarind: ['TAMARIND_'],
  boltz: ['BOLTZ_'],
  'nvidia-nim': ['NVIDIA_API_KEY', 'NVAPI_'],
  replicate: ['REPLICATE_'],
  runpod: ['RUNPOD_'],
  'hugging-face': ['HF_TOKEN', 'HUGGINGFACE_', 'HUGGING_FACE_'],
  baseten: ['BASETEN_'],
  biohub: ['BIOHUB_'],
  subseq: ['SUBSEQ_'],
};
