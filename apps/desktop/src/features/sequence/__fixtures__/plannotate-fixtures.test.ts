// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { FIXTURES, createDraftsFromFixture, makeFeature } from './plannotate-fixtures';
import { CONFIDENCE_THRESHOLDS } from '../types';

describe('plannotate fixtures', () => {
  describe('pBP010', () => {
    it('has 11 features from real API response', () => {
      expect(FIXTURES.pBP010.features).toHaveLength(11);
    });

    it('sequenceLength matches real construct', () => {
      expect(FIXTURES.pBP010.sequenceLength).toBe(3126);
    });

    it('SET1 is a low-coverage fragment', () => {
      const set1 = FIXTURES.pBP010.features.find((f) => f.name === 'SET1');
      expect(set1).toBeDefined();
      expect(set1!.coverage).toBeLessThan(20);
      expect(set1!.fragment).toBe(true);
    });

    it('cat is a full-length high-confidence CDS', () => {
      const cat = FIXTURES.pBP010.features.find((f) => f.name === 'cat');
      expect(cat).toBeDefined();
      expect(cat!.identity).toBe(100);
      expect(cat!.coverage).toBe(100);
      expect(cat!.fragment).toBe(false);
      expect(cat!.db_source).toBe('protein');
    });

    it('SET1 should NOT be auto-accepted (low confidence)', () => {
      const drafts = createDraftsFromFixture('pBP010');
      const set1 = drafts.find((d) => d.name === 'SET1');
      expect(set1).toBeDefined();
      expect(set1!.confidence).toBeLessThan(CONFIDENCE_THRESHOLDS.MEDIUM);
      expect(set1!.accepted).toBe(false);
    });

    it('AmpR promoter fragment should NOT be auto-accepted (56% coverage)', () => {
      const drafts = createDraftsFromFixture('pBP010');
      const ampR = drafts.find((d) => d.name === 'AmpR promoter');
      expect(ampR).toBeDefined();
      expect(ampR!.confidence).toBeLessThan(CONFIDENCE_THRESHOLDS.AUTO_ACCEPT);
      expect(ampR!.accepted).toBe(false);
    });

    it('cat should be auto-accepted (high confidence)', () => {
      const drafts = createDraftsFromFixture('pBP010');
      const cat = drafts.find((d) => d.name === 'cat');
      expect(cat).toBeDefined();
      expect(cat!.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLDS.HIGH);
      expect(cat!.accepted).toBe(true);
    });

    it('ori should be auto-accepted (high confidence)', () => {
      const drafts = createDraftsFromFixture('pBP010');
      const ori = drafts.find((d) => d.name === 'ori');
      expect(ori).toBeDefined();
      expect(ori!.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLDS.HIGH);
      expect(ori!.accepted).toBe(true);
    });
  });

  describe('makeFeature', () => {
    it('creates a feature with sensible defaults', () => {
      const f = makeFeature({ name: 'test', start: 0, end: 100 });
      expect(f.identity).toBe(100);
      expect(f.coverage).toBe(100);
      expect(f.fragment).toBe(false);
      expect(f.db_source).toBe('nucleotide');
    });

    it('allows overriding defaults', () => {
      const f = makeFeature({
        name: 'partial',
        start: 0,
        end: 50,
        coverage: 30,
        fragment: true,
      });
      expect(f.coverage).toBe(30);
      expect(f.fragment).toBe(true);
    });
  });
});
