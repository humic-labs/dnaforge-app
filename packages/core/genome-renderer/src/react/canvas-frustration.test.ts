import { describe, expect, it } from 'vitest';
import { createCanvasFrustrationDetector } from './canvas-frustration';

const feature = (id = 1) => ({ kind: 'feature' as const, payload: { id, start: 0, end: 10 } });

describe('createCanvasFrustrationDetector', () => {
  it('requires three clicks in a rolling one-second window, including the boundary', () => {
    const click = createCanvasFrustrationDetector();
    expect(click(feature(), 0)).toBeNull();
    expect(click(feature(), 700)).toBeNull();
    expect(click(feature(), 1001)).toBeNull();
    expect(click(feature(), 1700)).toEqual({
      component: 'sequence-viewer.feature',
      action: 'click',
    });
  });

  it('does not combine different regions of the same kind or misses', () => {
    const click = createCanvasFrustrationDetector();
    click(feature(), 0);
    click(feature(), 100);
    expect(click(feature(2), 200)).toBeNull();
    click(feature(2), 300);
    click(null, 400);
    expect(click(feature(2), 500)).toBeNull();
  });

  it('reports once per burst and rearms after an idle second', () => {
    const click = createCanvasFrustrationDetector();
    const results = [0, 100, 200, 300, 400, 1500, 1600, 1700].map((time) => click(feature(), time));
    expect(results.filter(Boolean)).toHaveLength(2);
  });

  it('keeps document names and identities out of the result', () => {
    const click = createCanvasFrustrationDetector();
    const hit = {
      ...feature(),
      payload: {
        ...feature().payload,
        canonicalIdentity: 'private-id',
        displayName: 'private-name',
      },
    };
    click(hit, 0);
    click(hit, 1);
    expect(click(hit, 2)).toEqual({ component: 'sequence-viewer.feature', action: 'click' });
  });
});
