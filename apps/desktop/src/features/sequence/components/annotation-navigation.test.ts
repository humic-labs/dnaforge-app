// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { findAnnotationIdentityForHighlight } from './annotation-navigation';
import type { Annotation } from '@waypoint/sequence-utils';

const ANNOTATIONS: Annotation[] = [
  { name: 'araC', type: 'CDS', start: 703, end: 1500, direction: -1 },
  { name: 'ori', type: 'rep_origin', start: 4800, end: 120, direction: 1 },
];

describe('annotation navigation helpers', () => {
  it('resolves an external 0-indexed highlight back to the selected annotation identity', () => {
    expect(findAnnotationIdentityForHighlight(ANNOTATIONS, { start: 702, end: 1499 })).toEqual({
      type: 'CDS',
      name: 'araC',
      start: 703,
      end: 1500,
      direction: -1,
    });
  });

  it('preserves wrapping annotation identity across the circular origin', () => {
    expect(
      findAnnotationIdentityForHighlight(ANNOTATIONS, { start: 4799, end: 119, wraps: true })
    ).toEqual({
      type: 'rep_origin',
      name: 'ori',
      start: 4800,
      end: 120,
      direction: 1,
    });
  });

  it('does not force annotation selection for partial or generic ranges', () => {
    expect(findAnnotationIdentityForHighlight(ANNOTATIONS, { start: 800, end: 900 })).toBeNull();
  });
});
