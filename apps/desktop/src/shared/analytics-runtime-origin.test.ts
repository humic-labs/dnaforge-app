import { describe, expect, it } from 'vitest';
import { sanitizeClosedBetaProperties } from './analytics-allowlist';

describe('runtime provenance property boundary', () => {
  it.each(['synthetic', 'private', 'unknown', 'eligible_release'])(
    'preserves %s without changing origin clocks',
    (classification) => {
      expect(
        sanitizeClosedBetaProperties({
          runtime_origin_class: classification,
          occurred_at_ms: 123,
          origin_started_at_ms: 100,
        })
      ).toEqual({
        runtime_origin_class: classification,
        occurred_at_ms: 123,
        origin_started_at_ms: 100,
      });
    }
  );

  it.each(
    [null, false, 3, {}, [], '', 'PRIVATE', '/private/reference.gb', 'a'.repeat(64)].map(
      (classification) => ({ classification })
    )
  )('excludes malformed runtime provenance $classification', ({ classification }) => {
    expect(sanitizeClosedBetaProperties({ runtime_origin_class: classification })).toEqual({});
  });
});
