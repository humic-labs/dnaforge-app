// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { canUseRdFragmentInAssembly, rdFragmentAssemblyBlockReason } from './rd-fragment-policy';

describe('RD fragment assembly policy', () => {
  it.each(['gibson', 'nebuilder'] as const)(
    '%s accepts any restriction digest fragment polarity as a physical part',
    (assemblyMethod) => {
      expect(canUseRdFragmentInAssembly(assemblyMethod, 'insert')).toBe(true);
      expect(canUseRdFragmentInAssembly(assemblyMethod, 'backbone')).toBe(true);
      expect(canUseRdFragmentInAssembly(assemblyMethod, 'unusable')).toBe(true);
      expect(canUseRdFragmentInAssembly(assemblyMethod, undefined)).toBe(true);
    }
  );

  it('keeps insert/backbone/unusable filtering scoped to Golden Gate', () => {
    expect(rdFragmentAssemblyBlockReason('goldengate', 'insert')).toBeNull();
    expect(rdFragmentAssemblyBlockReason('goldengate', 'backbone')).toContain(
      'only insert fragments are supported'
    );
    expect(rdFragmentAssemblyBlockReason('goldengate', 'unusable')).toContain(
      'only insert fragments are supported'
    );
  });
});
