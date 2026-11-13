// @vitest-environment node

import { describe, expect, it } from 'vitest';
import * as designTypes from './types';
import * as publicDesignTypes from './public/types';

describe('design length helpers', () => {
  it('does not export unused getDesignLength', () => {
    expect(designTypes).not.toHaveProperty('getDesignLength');
    expect(publicDesignTypes).not.toHaveProperty('getDesignLength');
    expect(typeof designTypes.getComposedSequence).toBe('function');
  });
});
