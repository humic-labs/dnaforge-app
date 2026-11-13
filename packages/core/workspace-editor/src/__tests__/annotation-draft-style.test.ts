import { describe, expect, it } from 'vitest';
import { resolveAnnotationDraftStyle } from '../annotation-draft-style';
import type { Annotation } from '@waypoint/sequence-utils';

const annotation = (type: string, qualifiers?: Annotation['qualifiers']): Annotation => ({
  type,
  name: `${type} draft`,
  start: 1,
  end: 30,
  direction: 1,
  color: '#4E79A7',
  qualifiers,
});

describe('resolveAnnotationDraftStyle', () => {
  it('applies the same authored draft style to regular annotations and CDS annotations', () => {
    const qualifiers = { source: ['annotation-draft'] };

    expect(resolveAnnotationDraftStyle(annotation('misc_feature', qualifiers))).toEqual(
      resolveAnnotationDraftStyle(annotation('CDS', qualifiers))
    );
    expect(resolveAnnotationDraftStyle(annotation('CDS', qualifiers))).toMatchObject({
      hasDottedOutline: true,
      isHollow: false,
      fillAlpha: 1,
      suppressInteractionOutline: true,
    });
  });

  it('keeps unchecked pLannotate candidates hollow but still dotted on every annotation type', () => {
    const qualifiers = { source: ['pLannotate-draft'], status: ['rejected'] };

    expect(resolveAnnotationDraftStyle(annotation('promoter', qualifiers))).toEqual(
      resolveAnnotationDraftStyle(annotation('CDS', qualifiers))
    );
    expect(resolveAnnotationDraftStyle(annotation('promoter', qualifiers))).toMatchObject({
      hasDottedOutline: true,
      isHollow: true,
      suppressInteractionOutline: true,
    });
  });

  it('does not mark committed annotations as drafts', () => {
    expect(resolveAnnotationDraftStyle(annotation('CDS'))).toMatchObject({
      hasDottedOutline: false,
      isHollow: false,
      fillAlpha: 1,
      suppressInteractionOutline: false,
    });
  });
});
