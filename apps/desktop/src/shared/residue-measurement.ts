import { z } from 'zod';
import { translatedCdsCorrespondenceSchema } from './molecular-correspondence';
import {
  variantMeasurementEvidenceSchema,
  variantSignalValues,
} from './variant-measurement-evidence';
export {
  variantSignalValues,
  type VariantMeasurementEvidence,
} from './variant-measurement-evidence';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const point = z
  .object({ residue: z.number().int().positive(), value: z.number().finite().nullable() })
  .strict();
const counts = z
  .object({
    residue: z.number().int().positive(),
    before: z.number().finite().nonnegative(),
    after: z.number().finite().nonnegative(),
  })
  .strict();
export const MEASUREMENT_CORRESPONDENCE_DESCRIPTION =
  'Optional exact translated-CDS sequence/annotation mapping snapshot from color_variant_protein result.source.correspondence. Copy the complete returned object unchanged; it is not a calculation recipe or an artifact list. If no exact returned snapshot is available, omit this optional field; the linked inspection still validates the measurement against its current protein mapping. Retain the calculation formula, original observations, program and output as workspace artifacts instead.';
export const residueMeasurementSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    proteinSequenceSha256: z.string().regex(/^[0-9a-f]{64}$/),
    source: z
      .object({
        label: z.string().min(1).max(500),
        analysisId: z.string().min(1).max(500),
        revision: z.string().min(1).max(500),
        correspondence: translatedCdsCorrespondenceSchema
          .optional()
          .describe(MEASUREMENT_CORRESPONDENCE_DESCRIPTION),
      })
      .strict(),
    units: z.string().max(80),
    values: z.array(point).min(1).max(5000),
    scale: z
      .object({
        transform: z.enum(['linear', 'log10']),

        domain: z
          .array(z.number().finite())
          .length(2)
          .transform((values): [number, number] => [values[0], values[1]])
          .describe(
            'Exactly two endpoints [minimum, maximum] in measurement units. Do not include midpoint or one entry per color.'
          ),
        colors: z
          .array(hex)
          .min(2)
          .max(20)
          .describe(
            'Palette stops spaced evenly between the two domain endpoints; a three-color diverging palette places its middle color halfway.'
          ),
        missingColor: hex,
      })
      .strict(),
    variantEvidence: variantMeasurementEvidenceSchema.optional(),
    derivation: z
      .object({
        kind: z.literal('log2-enrichment'),
        normalization: z.literal('table-total'),
        pseudocount: z.number().finite().positive(),
        counts: z.array(counts).min(1).max(5000),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((data, context) => {
    if (new Set(data.values.map((p) => p.residue)).size !== data.values.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Use one value per residue; aggregate duplicate variants explicitly before import.',
      });
    const [low, high] = data.scale.domain;
    if (low >= high || (data.scale.transform === 'log10' && low <= 0))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'The color domain must increase; log10 needs a positive lower bound.',
      });
    if (
      data.scale.transform === 'log10' &&
      data.values.some((p) => p.value !== null && p.value <= 0)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Log10 cannot display zero or negative measurements. Choose linear or derive a different signal.',
      });
    if (data.variantEvidence) {
      const expected = variantSignalValues(data.variantEvidence);
      if (
        data.derivation ||
        expected.length !== data.values.length ||
        expected.some(
          (p, i) => p.residue !== data.values[i].residue || p.value !== data.values[i].value
        )
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Variant-derived values do not match their saved counts and recipe.',
        });
    }
    if (data.derivation) {
      if (
        new Set(data.derivation.counts.map((row) => row.residue)).size !==
        data.derivation.counts.length
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Supply one count pair per residue.',
        });
        return;
      }
      const expected = log2Enrichment(data.derivation.counts, data.derivation.pseudocount);
      if (
        expected.length !== data.values.length ||
        expected.some(
          (p, i) => p.residue !== data.values[i].residue || p.value !== data.values[i].value
        )
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Derived values do not match their saved counts and pseudocount.',
        });
    }
  });
export type ResidueMeasurement = z.infer<typeof residueMeasurementSchema>;
export const MEASUREMENT_PALETTES = {
  viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
  diverging: ['#2166ac', '#f7f7f7', '#b2182b'],
  magma: ['#000004', '#51127c', '#b73779', '#fc8961', '#fcfdbf'],
};

export function log2Enrichment(rows: Array<z.infer<typeof counts>>, pseudocount: number) {
  if (!(pseudocount > 0) || !Number.isFinite(pseudocount))
    throw new Error('Pseudocount must be positive.');
  rows.forEach((row) => counts.parse(row));
  if (!rows.length || new Set(rows.map((row) => row.residue)).size !== rows.length)
    throw new Error('Supply one count pair per residue.');
  const beforeTotal = rows.reduce((total, row) => total + row.before + pseudocount, 0);
  const afterTotal = rows.reduce((total, row) => total + row.after + pseudocount, 0);
  return rows.map((row) => ({
    residue: row.residue,
    value: Math.log2(
      (row.after + pseudocount) / afterTotal / ((row.before + pseudocount) / beforeTotal)
    ),
  }));
}

export function measurementColor(measurement: ResidueMeasurement, value: number | null): string {
  if (value === null) return measurement.scale.missingColor;
  const transform = measurement.scale.transform === 'log10' ? Math.log10 : (x: number) => x;
  const [low, high] = measurement.scale.domain.map(transform);

  const t =
    Math.round(Math.max(0, Math.min(1, (transform(value) - low) / (high - low))) * 256) / 256;
  const colors = measurement.scale.colors;
  const position = t * (colors.length - 1);
  const index = Math.min(Math.floor(position), colors.length - 2);
  const fraction = position - index;
  const rgb = [1, 3, 5].map((offset) => {
    const a = parseInt(colors[index].slice(offset, offset + 2), 16);
    const b = parseInt(colors[index + 1].slice(offset, offset + 2), 16);
    return Math.round(a + (b - a) * fraction)
      .toString(16)
      .padStart(2, '0');
  });
  return `#${rgb.join('')}`;
}
