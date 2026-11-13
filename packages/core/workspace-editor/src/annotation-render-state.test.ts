import { expect, it } from 'vitest';
import { annotationRenderState, type AnnotationStateIdentity } from './annotation-render-state';

it('retains selected priority, feature type and normalized direction', () => {
  const feature: AnnotationStateIdentity = {
    type: 'CDS',
    name: 'waa|A',
    start: 10,
    end: 100,
  };
  const input = { selected: feature, hovered: { ...feature, type: 'gene' } };
  expect(annotationRenderState({ ...feature, direction: 0 }, input)).toBe('selected');
  expect(annotationRenderState({ ...feature, type: 'gene' }, input)).toBe('hovered');
  expect(annotationRenderState({ ...feature, direction: -1 }, input)).toBe('default');
  expect(annotationRenderState({ ...feature, end: 101 }, input)).toBe('default');
  expect(annotationRenderState(feature, {})).toBe('default');
});

it('reads in-place edits and deselection immediately without a cached identity', () => {
  const feature: AnnotationStateIdentity = {
    type: 'CDS',
    name: 'thrA',
    start: 10,
    end: 100,
    direction: 1,
  };
  const input = { selected: feature };
  const before = { ...feature };
  expect(annotationRenderState(before, input)).toBe('selected');
  feature.end = 130;
  expect(annotationRenderState(before, input)).toBe('default');
  expect(annotationRenderState(feature, input)).toBe('selected');
  expect(annotationRenderState(feature, { selected: null })).toBe('default');
});

it('preserves the numeric spelling rules of the original string identity', () => {
  const feature: AnnotationStateIdentity = {
    type: 'CDS',
    name: 'numeric-edge',
    start: Number.NaN,
    end: Infinity,
    direction: -0,
  };
  expect(annotationRenderState({ ...feature, direction: 0 }, { selected: feature })).toBe(
    'selected'
  );
  expect(annotationRenderState({ ...feature, end: -Infinity }, { selected: feature })).toBe(
    'default'
  );
  expect(annotationRenderState({ ...feature, direction: 1 }, { hovered: feature })).toBe('default');
});
