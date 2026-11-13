import { describe, expect, it } from 'vitest';
import { hasRequiredCapabilities } from './capability-policy';

describe('agent capability policy', () => {
  it('treats legacy workspace-write grants as including primer edits', () => {
    expect(hasRequiredCapabilities(['write-workspace'], ['edit-primers'])).toBe(true);
    expect(hasRequiredCapabilities(['write-workspace'], ['edit-protocols'])).toBe(true);
  });

  it('does not let a primer-only grant write arbitrary workspace files', () => {
    expect(hasRequiredCapabilities(['edit-primers'], ['write-workspace'])).toBe(false);
  });

  it('does not let an unrelated grant edit primers', () => {
    expect(hasRequiredCapabilities(['read-workspace'], ['edit-primers'])).toBe(false);
  });

  it('does not let protocol revision authority write arbitrary workspace files', () => {
    expect(hasRequiredCapabilities(['edit-protocols'], ['write-workspace'])).toBe(false);
  });

  it('does not let ordinary protocol revision authority accept a protocol', () => {
    expect(hasRequiredCapabilities(['edit-protocols'], ['finalize-protocol'])).toBe(false);
  });
});
