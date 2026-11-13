// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { candidatePackagedConstructPath } from './resolve-construct-path';

describe('candidatePackagedConstructPath', () => {
  it('maps a loose GenBank onto the package product', () => {
    expect(candidatePackagedConstructPath('/lab/pUC19.gb')).toBe('/lab/pUC19/pUC19.gb');
    expect(candidatePackagedConstructPath('/lab/vectors/pET28.gbk')).toBe(
      '/lab/vectors/pET28/pET28.gbk'
    );
  });

  it('maps a converted FASTA onto the GenBank product', () => {
    expect(candidatePackagedConstructPath('/lab/recA.fna')).toBe('/lab/recA/recA.gb');
  });

  it('returns null for instrument data and untitled stems', () => {
    expect(candidatePackagedConstructPath('/lab/clone.ab1')).toBeNull();
    expect(candidatePackagedConstructPath('/lab/.gb')).toBeNull();
  });
});
