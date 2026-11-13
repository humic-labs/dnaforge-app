// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { sourceCdsIdentityForRequest } from './source-cds-identity';
import type { StructureDrawerRequest } from '../types/structure-drawer';

const request: StructureDrawerRequest = {
  translation: 'MKT',
  cdsLabel: 'thrL',
  entityId: 'sequence-document:mg1655',
  cdsBounds: {
    cdsStart: 189,
    cdsEnd: 254,
    strand: 1,
  },
  hints: {},
};

describe('sourceCdsIdentityForRequest', () => {
  it('converts drawer source CDS bounds into selected-annotation identity', () => {
    expect(sourceCdsIdentityForRequest(request, 'sequence-document:mg1655')).toEqual({
      type: 'CDS',
      name: 'thrL',
      start: 190,
      end: 255,
      direction: 1,
    });
  });

  it('does not mark a CDS in a different sequence tab', () => {
    expect(sourceCdsIdentityForRequest(request, 'sequence-document:other')).toBeNull();
  });

  it('returns null when the drawer request lacks CDS bounds', () => {
    expect(
      sourceCdsIdentityForRequest({ ...request, cdsBounds: undefined }, 'sequence-document:mg1655')
    ).toBeNull();
  });
});
