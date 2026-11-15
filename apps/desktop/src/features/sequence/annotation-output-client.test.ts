// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAnnotationOutputFile } from './annotation-output-client';

const mocks = vi.hoisted(() => ({ parse: vi.fn(), bind: vi.fn() }));
vi.mock('@waypoint/api-client', () => ({
  parseAnnotationOutputAnnotationOutputParsePost: mocks.parse,
}));
vi.mock('@/services/service-manager', () => ({
  serviceManager: {
    client: () => {
      mocks.bind();
      return { options: (options: RequestInit = {}) => options };
    },
  },
}));

describe('annotation output parser client', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the generated parser and preserves valid empty output', async () => {
    const data = { output_sha256: 'a'.repeat(64), result: { features: [], sequence_length: 0 } };
    mocks.parse.mockResolvedValue({ status: 200, data });
    expect(await parseAnnotationOutputFile('##gff-version 3\n', 'gff3')).toBe(data);
    expect(mocks.bind).toHaveBeenCalledOnce();
    expect(mocks.parse).toHaveBeenCalledWith({ content: '##gff-version 3\n', format: 'gff3' }, {});
  });

  it.each([
    undefined,
    null,
    'unexpected',
    {},
    {
      output_sha256: 'a'.repeat(64),
      result: { features: [], sequence_length: 5, error: 'failed' },
    },
    { output_sha256: 'wrong', result: { features: [], sequence_length: 0 } },
  ])(
    'rejects malformed parser data with the feature error rather than a property-access crash',
    async (data) => {
      mocks.parse.mockResolvedValue({ status: 200, data });
      await expect(parseAnnotationOutputFile('{}', 'json')).rejects.toThrow(
        'The file could not be read as a successful annotation result.'
      );
    }
  );
});
