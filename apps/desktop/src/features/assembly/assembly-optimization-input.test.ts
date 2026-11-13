// @vitest-environment node

import { describe, expect, it } from 'vitest';
import * as optimizationInput from './assembly-optimization-input';
import * as publicOptimizationInput from './public/assembly-optimization-input';

describe('assembly optimization input public surface', () => {
  it('does not export unused canonicalizeAssemblyOptimizationInput', () => {
    expect(optimizationInput).not.toHaveProperty('canonicalizeAssemblyOptimizationInput');
    expect(publicOptimizationInput).not.toHaveProperty('canonicalizeAssemblyOptimizationInput');
    expect(typeof optimizationInput.buildAssemblyOptimizationInput).toBe('function');
  });
});
