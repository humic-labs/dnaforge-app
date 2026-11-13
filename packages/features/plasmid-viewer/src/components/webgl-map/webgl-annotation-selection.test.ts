import { describe, expect, it } from 'vitest';
import type { Feature } from '@waypoint/genome-renderer';
import {
  annotationIdentityFromFeature,
  featureMatchesAnnotation,
  selectionWrapsOrigin,
} from './webgl-annotation-selection';

const feature: Feature = {
  id: 7,
  type: 'CDS',
  start: 99,
  end: 250,
  direction: 'forward',
  displayName: 'lacZ',
  color: 0x3b82f6,
  lane: 0,
};

describe('WebGL annotation selection bridge', () => {
  it('converts WebGL feature coordinates into the Canvas annotation identity contract', () => {
    expect(annotationIdentityFromFeature(feature)).toEqual({
      type: 'CDS',
      name: 'lacZ',
      start: 100,
      end: 250,
      direction: 1,
    });
  });

  it('matches the same annotation identity across WebGL and Canvas 2D', () => {
    expect(
      featureMatchesAnnotation(feature, {
        type: 'CDS',
        name: 'lacZ',
        start: 100,
        end: 250,
        direction: 1,
      })
    ).toBe(true);
  });

  it('preserves an origin-wrapped selection even when the map geometry is linear', () => {
    expect(selectionWrapsOrigin(996, 1)).toBe(true);
    expect(selectionWrapsOrigin(120, 125)).toBe(false);
  });

  it('does not collapse coextensive gene and CDS annotations into one selection', () => {
    expect(
      featureMatchesAnnotation(feature, {
        type: 'gene',
        name: 'lacZ',
        start: 100,
        end: 250,
        direction: 1,
      })
    ).toBe(false);
  });

  it('matches a WebGL feature when Canvas 2D selected a grouped coextensive annotation label', () => {
    expect(
      featureMatchesAnnotation(
        {
          ...feature,
          type: 'misc_feature',
          displayName: 'kanMX',
        },
        {
          type: 'misc_feature',
          name: 'AphA · kanMX',
          start: 100,
          end: 250,
          direction: 1,
        }
      )
    ).toBe(true);
  });

  it('still rejects grouped labels with the wrong coordinate identity', () => {
    expect(
      featureMatchesAnnotation(
        {
          ...feature,
          type: 'misc_feature',
          displayName: 'kanMX',
        },
        {
          type: 'misc_feature',
          name: 'AphA · kanMX',
          start: 101,
          end: 250,
          direction: 1,
        }
      )
    ).toBe(false);
  });
});
