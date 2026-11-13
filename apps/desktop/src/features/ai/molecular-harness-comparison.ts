import { z } from 'zod';

const referenceId = z.string().uuid();
const previewImage = z
  .string()
  .max(2_000_000)
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);

const outcomeSchema = z
  .object({
    id: z.string().min(1).max(100),
    label: z.string().min(1).max(120),
    provenance: z.enum(['native-code', 'prompt-only']),
    sourceUrl: z
      .string()
      .url()
      .regex(/^https?:\/\//)
      .max(2000)
      .optional(),
    runEvidence: z.string().min(1).max(1000).optional(),
    executionTrace: z.string().max(50_000).optional(),
    referenceId: referenceId.optional(),
    imageDataUrl: previewImage.optional(),
    testResult: z
      .object({
        status: z.enum(['rendered', 'failed', 'unverified']),
        observation: z.string().min(1).max(2000),
        checkedAt: z.number().int().nonnegative().optional(),
        structureCount: z.number().int().nonnegative().optional(),
        representationCount: z.number().int().nonnegative().optional(),
        error: z.string().max(2000).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => Boolean(value.referenceId) !== Boolean(value.imageDataUrl), {
    message: 'Each comparison outcome needs exactly one view reference or image.',
  })
  .refine(
    (value) => value.provenance !== 'native-code' || Boolean(value.sourceUrl && value.runEvidence),
    { message: 'Native harness outcomes need a source URL and execution evidence.' }
  );

const legacyComparisonSchema = z
  .object({
    question: z.string().min(1).max(500),
    outcomes: z.array(outcomeSchema).max(24),
  })
  .strict()
  .refine(
    (value) => new Set(value.outcomes.map((outcome) => outcome.id)).size === value.outcomes.length,
    {
      message: 'Comparison outcome IDs must be unique.',
    }
  );

const caseSchema = z
  .object({
    id: z.string().min(1).max(100),
    title: z.string().min(1).max(120),
    question: z.string().min(1).max(500),
    fixtureIds: z
      .array(z.string().regex(/^[0-9A-Za-z]{4}$/))
      .max(4)
      .optional(),
    note: z.string().max(1000).optional(),
    outcomes: z.array(outcomeSchema).max(24),
  })
  .strict()
  .refine(
    (value) => new Set(value.outcomes.map((outcome) => outcome.id)).size === value.outcomes.length,
    { message: 'Comparison outcome IDs must be unique within a case.' }
  );

const comparisonSchema = z
  .object({
    version: z.literal(2),
    cases: z.array(caseSchema).min(1).max(12),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.cases.map((comparisonCase) => comparisonCase.id)).size === value.cases.length,
    { message: 'Comparison case IDs must be unique.' }
  );

export type MolecularHarnessComparison = z.infer<typeof comparisonSchema>;
export type MolecularHarnessCase = MolecularHarnessComparison['cases'][number];
export type MolecularHarnessOutcome = MolecularHarnessCase['outcomes'][number];

export function parseMolecularHarnessComparison(value: unknown): MolecularHarnessComparison | null {
  const parsed = comparisonSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const STORAGE_KEY = 'dnaforge:protein-harness-comparison-v2';
const LEGACY_STORAGE_KEY = 'dnaforge:protein-harness-comparison-v1';
export const MOLECULAR_HARNESS_COMPARISON_CHANGE_EVENT =
  'dnaforge:protein-harness-comparison-change';

export function readMolecularHarnessComparison(): MolecularHarnessComparison | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return parseMolecularHarnessComparison(JSON.parse(raw));
    }
    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!legacyRaw) return null;
    const legacy = legacyComparisonSchema.safeParse(JSON.parse(legacyRaw));
    return legacy.success
      ? { version: 2, cases: [{ id: 'pilot', title: 'Earlier pilot', ...legacy.data }] }
      : null;
  } catch {
    return null;
  }
}

export function writeMolecularHarnessComparison(comparison: MolecularHarnessComparison): void {
  const validated = comparisonSchema.parse(comparison);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(validated));
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event(MOLECULAR_HARNESS_COMPARISON_CHANGE_EVENT));
}
