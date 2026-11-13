// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { buildInlineRnaSequenceRef } from './rna-sequence';

describe('buildInlineRnaSequenceRef', () => {
  it('preserves RNA base case and uracil while removing whitespace', async () => {
    const ref = await buildInlineRnaSequenceRef('a u\nCg');
    expect(ref).toMatchObject({
      mode: 'inline',
      bases: 'auCg',
      topology: 'linear',
      length: 4,
    });
    expect(ref.contentHash).toMatch(/^sha256:/);
  });
});
