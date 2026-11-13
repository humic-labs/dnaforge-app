import { z } from 'zod';
import { jsonObjectSchema } from '../../../shared/json-value';

                                                                                 
const providerJsonObjectSchema = jsonObjectSchema.describe(
  'Provider-defined JSON object. Its keys and nested values depend on the selected provider and tool.'
);

const providerSummarySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  connected: z.boolean(),
  hasBinding: z.boolean(),
  catalog: z.string(),
  cost: z.string(),
  docsUrl: z.string(),
});

const toolDescriptorSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  output_kind: z.string().nullable().optional(),
});

export const computeJobReferenceOutputSchema = z.object({
  provider: z.string(),
  remote_id: z.string(),
  tool_id: z.string(),
  artifact_refs: z.array(z.string()).optional(),
});

export const computeListProvidersOutputSchema = z.object({
  ok: z.literal(true),
  providers: z.array(providerSummarySchema),
  next: z.string(),
});

export const computeListToolsOutputSchema = z.object({
  ok: z.literal(true),
  provider: z.string(),
  tools: z.array(toolDescriptorSchema),
});

export const computeGetSchemaOutputSchema = z.object({
  ok: z.literal(true),
  provider: z.string(),
  tool_id: z.string(),
  schema: providerJsonObjectSchema.describe(
    'The selected provider tool’s JSON Schema for job settings. Read this schema before validating or submitting settings.'
  ),
});

export const computeValidateOutputSchema = z.object({
  ok: z.literal(true),
  provider: z.string(),
  tool_id: z.string(),
  valid: z
    .boolean()
    .describe(
      'Whether the provider accepted these settings; false is a completed validation, not a failed tool call.'
    ),
  problems: z.array(z.string()),
});

export const computeEstimateOutputSchema = z.object({
  ok: z.literal(true),
  provider: z.string(),
  tool_id: z.string(),
  amount: z.number().nullable(),
  unit: z.string(),
  estimated_seconds: z.number().nullable(),
  note: z.string(),
  known: z.boolean(),
});

export const computeSubmitOutputSchema = z.object({
  ok: z.literal(true),
  job: computeJobReferenceOutputSchema,
  job_record_id: z.string().nullable(),
  next: z.string(),
});

export const computeStatusOutputSchema = z.object({
  ok: z.literal(true),
  ref: computeJobReferenceOutputSchema,
  state: z.enum(['queued', 'running', 'completed', 'failed', 'canceled']),
  provider_state: z.string(),
  progress_note: z.string(),
  cost_amount: z.number().nullable(),
  cost_unit: z.string().nullable(),
  terminal: z.boolean(),
});

export const computeCancelOutputSchema = computeStatusOutputSchema;

export const computeImportResultOutputSchema = z.object({
  ok: z.literal(true),
  ref: computeJobReferenceOutputSchema,
  output_kind: z.string(),
  written_paths: z.array(z.string()),
  opened: z.array(z.string()),
  inspection_attached: z.literal(true).optional(),
  url_only: z.array(z.object({ name: z.string(), url: z.string() })),
  metrics: providerJsonObjectSchema.describe(
    'Provider-reported scores and confidence metrics, preserved as JSON under provider-defined names. These are measurements, not a DNAForge verdict.'
  ),
  provenance: z.record(z.string(), z.string()),
  prediction_result_ids: z.array(z.string()),
  catalog_observation_ids: z.array(z.string()),
  prediction_library_warnings: z.array(z.string()),
  next: z.string(),
});
