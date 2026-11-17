import { describe, expect, it } from 'vitest';
import { resolveAnnotationDataColors } from './annotation-data-colors';
import type { Feature } from './types';

const feature: Feature = {
  id: 37,
  type: 'gene',
  start: 100,
  end: 250,
  direction: 'forward',
  displayName: 'rutA',
  color: 0x123456,
  lane: 0,
  qualifiers: { locus_tag: 'b1012' },
};

describe('annotation data color identity resolution', () => {
  it('resolves the same scientific identity with different viewer-local IDs', () => {
    const colors = new Map([['b1012', '#aabbcc']]);
    expect(resolveAnnotationDataColors([feature], colors)).toEqual(new Map([[37, 0xaabbcc]]));
    expect(resolveAnnotationDataColors([{ ...feature, id: 8024 }], colors)).toEqual(
      new Map([[8024, 0xaabbcc]])
    );
    expect(feature.color).toBe(0x123456);
  });

  it('keeps missing annotation styling separate from stored feature colors', () => {
    expect(resolveAnnotationDataColors([feature], new Map(), '#cccccc')).toEqual(
      new Map([[37, 0xcccccc]])
    );
    expect(resolveAnnotationDataColors([feature], new Map())).toEqual(new Map());
    expect(feature.color).toBe(0x123456);
  });

  it('rejects conflicting colors bound through different aliases of one annotation', () => {
    expect(() =>
      resolveAnnotationDataColors(
        [{ ...feature, canonicalIdentity: 'gene:rutA' }],
        new Map([
          ['b1012', '#aabbcc'],
          ['gene:rutA', '#112233'],
        ])
      )
    ).toThrow('conflicting data colors');
  });
});
