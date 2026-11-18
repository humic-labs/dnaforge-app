import { describe, expect, it } from 'vitest';
import { catalogIconContext } from './catalog-icon-context';
import { entityColorFamily } from './entity-color-family';

describe('catalog icon context', () => {
  it('preserves an RNA oligo schema through the generic primer catalog type', () => {
    const context = catalogIconContext({
      metadata: JSON.stringify({
        entitySchema: { name: 'rna_oligo' },
        relativePath: 'Guide.primer.json',
      }),
    });
    expect(context).toEqual({ kind: 'rna_oligo', path: 'Guide.primer.json' });
    expect(entityColorFamily({ kind: 'primer', ...context })).toBe('rna');
    expect(
      catalogIconContext({
        kind: 'primer',
        metadata: JSON.stringify({ entitySchema: { name: 'rna_oligo' } }),
      })
    ).toEqual({ kind: 'rna_oligo' });
  });

  it('preserves native RNA classification and exact source paths', () => {
    const context = catalogIconContext({
      kind: 'rna_sequence',
      path: '/project/Reference.gb',
      metadata: JSON.stringify({ classificationDecision: { molecule: 'rna' } }),
    });
    expect(context).toEqual({
      kind: 'rna_sequence',
      path: '/project/Reference.gb',
      molecule: 'rna',
    });
    expect(entityColorFamily(context!)).toBe('rna');
  });

  it('keeps neutral records neutral and does not use labels as paths', () => {
    expect(entityColorFamily(catalogIconContext({ kind: 'strain' })!)).toBe('neutral');
    expect(catalogIconContext({ metadata: '{broken' })).toBeUndefined();
    expect(
      catalogIconContext({ metadata: JSON.stringify({ name: 'Misleading.py' }) })
    ).toBeUndefined();
  });
});
