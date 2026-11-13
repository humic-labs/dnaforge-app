import { describe, it, expect } from 'vitest';
import { LODTier } from '../types';
import { computeLODTier, computeSegmentCount, isInViewport } from './lod';

describe('computeLODTier', () => {
  const circumference = 2000;

  it('returns Hidden for sub-pixel features', () => {
    expect(computeLODTier(100, 1_000_000, circumference)).toBe(LODTier.Hidden);
  });

  it('returns Rect for 0.5-2px features', () => {
    expect(computeLODTier(500, 1_000_000, circumference)).toBe(LODTier.Rect);
  });

  it('returns Arrow for 2-8px features', () => {
    expect(computeLODTier(2000, 1_000_000, circumference)).toBe(LODTier.Arrow);
  });

  it('returns Detailed for >8px features', () => {
    expect(computeLODTier(10000, 1_000_000, circumference)).toBe(LODTier.Detailed);
  });
});

describe('computeSegmentCount', () => {
  const circumference = 2000;

  it('keeps a minimum for tiny pixel arcs', () => {
    expect(computeSegmentCount(10, 1_000_000, circumference)).toBe(8);
  });

  it('uses sub-two-pixel polygon edges for visible arcs', () => {
    expect(computeSegmentCount(500_000, 1_000_000, circumference)).toBe(667);
  });

  it('caps extreme zoom tessellation to a bounded vertex count', () => {
    expect(computeSegmentCount(1_000_000, 1_000_000, 10_000)).toBe(2048);
  });
});

describe('isInViewport', () => {
  it('includes features in visible window', () => {
    expect(isInViewport(500, 5000, 0, 2)).toBe(true);
  });

  it('excludes features outside visible window', () => {
    expect(isInViewport(4000, 5000, 0, 4)).toBe(false);
  });

  it('handles wraparound with viewOffset', () => {
    expect(isInViewport(0, 5000, 0.9, 4)).toBe(true);
  });

  it('shows everything at zoom=1', () => {
    expect(isInViewport(2500, 5000, 0, 1)).toBe(true);
    expect(isInViewport(4999, 5000, 0, 1)).toBe(true);
  });
});
