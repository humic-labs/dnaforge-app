import { describe, expect, it } from 'vitest';

import { runHostedNativeRegexWorkerJob } from './hosted-native-regex-worker-job';

describe('Hosted native regex worker job', () => {
  it('returns bounded matching lines without carrying mutable state between lines', () => {
    expect(
      runHostedNativeRegexWorkerJob({
        source: 'alpha',
        caseSensitive: false,
        limit: 2,
        files: [
          { path: '/workspace/one.txt', content: 'Alpha\nbeta\nalpha two' },
          { path: '/workspace/two.txt', content: 'alpha three' },
        ],
      })
    ).toEqual({
      matches: [
        { path: '/workspace/one.txt', line: 1, text: 'Alpha' },
        { path: '/workspace/one.txt', line: 3, text: 'alpha two' },
      ],
      truncated: true,
    });
  });

  it('rejects malformed jobs inside the worker boundary', () => {
    expect(() =>
      runHostedNativeRegexWorkerJob({
        source: '[',
        caseSensitive: true,
        limit: 1,
        files: [],
      })
    ).toThrow();
  });
});
