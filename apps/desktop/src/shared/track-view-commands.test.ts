import { asSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import { trackViewCommandSchema, trackViewToolRequestSchema } from './track-view-commands';

const create = {
  operation: 'create',
  project: ' /lab/project ',
  path: ' comparison.dnaforge-track-view.json ',
  referenceId: 'GRCh38',
  requestId: 'provider-track-comparison',
  name: 'Measured signal',
  viewport: { chrom: 'chr1', start0: 0, end0: 100 },
  tracks: [
    {
      source: { kind: 'url', url: 'https://data.example.org/signal.bw' },
      format: 'bigwig',
      range: { min: 0, max: 12 },
    },
  ],
};

describe('Track View provider input contract', () => {
  it('advertises an object and preserves flat canonical commands and normalization', async () => {
    const projected = asSchema(trackViewToolRequestSchema);
    expect(projected.jsonSchema.type).toBe('object');
    for (const alternative of ['anyOf', 'allOf', 'oneOf'])
      expect(projected.jsonSchema).not.toHaveProperty(alternative);
    for (const input of [
      { operation: 'references' },
      { operation: 'inspect', project: ' /lab/project ', path: ' view.json ' },
      create,
    ]) {
      const result = await projected.validate!(input);
      expect(result.success).toBe(true);
      if (result.success) expect(result.value).toEqual(trackViewCommandSchema.parse(input));
    }
  });

  it('retains required fields, operation boundaries and source safety at runtime', async () => {
    const projected = asSchema(trackViewToolRequestSchema);
    for (const input of [
      {},
      { operation: 'references', project: '/lab/project' },
      { operation: 'inspect', project: '/lab/project' },
      { operation: 'create', project: '/lab/project', path: 'view.json' },
      { ...create, requestId: '../another-request' },
      { ...create, viewport: { chrom: 'chr1', start0: 100, end0: 100 } },
      {
        ...create,
        tracks: [{ source: { kind: 'url', url: 'file:///private/signal.bw' }, format: 'bigwig' }],
      },
      { ...create, unexpected: 'value' },
    ]) {
      expect(trackViewCommandSchema.safeParse(input).success).toBe(false);
      expect((await projected.validate!(input)).success).toBe(false);
    }
  });
});
