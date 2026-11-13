import { describe, expect, it } from 'vitest';
import { reverseComplement, type AnnotatedSequence } from '@waypoint/sequence-utils';
import { composeSequenceProduct, primerDnaSource } from './sequence-product';
import { predictPcrProducts } from './pcr-product';

const sequence = (bases: string, circular = false): AnnotatedSequence => ({
  id: 'template',
  name: 'template',
  sequence: bases,
  length: bases.length,
  circular,
  annotations: [],
});
const forward = 'GGGACGTCA',
  reverse = 'CCTAGGAT';
const template = sequence('TTACGTCATTTATCCTAAA');
const request = {
  templateDocumentId: 'template',
  template,
  forwardPrimerId: 'F',
  forward,
  reversePrimerId: 'R',
  reverse,
  forwardAnnealingLength: 6,
  reverseAnnealingLength: 5,
  maxProductLength: 100,
};
const sources = (target: AnnotatedSequence) =>
  new Map([
    ['template', target],
    ['F', primerDnaSource('F', 'F', forward)],
    ['R', primerDnaSource('R', 'R', reverse)],
  ]);

describe('saved-oligo PCR prediction', () => {
  it('includes complete ordered oligos and correctly orients the same amplicon on either template strand', () => {
    for (const target of [template, sequence(reverseComplement(template.sequence))]) {
      const products = predictPcrProducts({ ...request, template: target });
      expect(products).toHaveLength(1);
      const product = composeSequenceProduct('PCR', false, products[0].parts, sources(target));
      expect(product.sequence).toBe('GGGACGTCATTTATCCTAGG');
      expect(product.length).toBe(products[0].length);
    }
  });
  it('predicts an origin-crossing circular product and reports no product when the reverse oligo cannot anneal', () => {
    const target = sequence('TTTATCCTAAATTACGTCA', true);
    const products = predictPcrProducts({ ...request, template: target });
    expect(products).toHaveLength(1);
    expect(composeSequenceProduct('PCR', false, products[0].parts, sources(target)).sequence).toBe(
      'GGGACGTCATTTATCCTAGG'
    );
    expect(predictPcrProducts({ ...request, reverse: 'GGGGGGGG' })).toEqual([]);
  });
});
