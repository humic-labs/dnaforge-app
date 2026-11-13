// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { parseExternalProviderSourceRequest } from './benchling-migration-raw-source';

describe('parseExternalProviderSourceRequest', () => {
  it('accepts only the three identity fields', () => {
    expect(
      parseExternalProviderSourceRequest({
        workspaceId: 12,
        entityId: 'strain-1',
        sourceRecordId: 'bfi_STRAINAA',
      })
    ).toEqual({ workspaceId: 12, entityId: 'strain-1', sourceRecordId: 'bfi_STRAINAA' });
  });

  it.each([
    { workspaceId: 12, entityId: 'strain-1', sourceRecordId: 'bfi_STRAINAA', path: '/tmp/a.zip' },
    {
      workspaceId: 12,
      entityId: 'strain-1',
      sourceRecordId: 'bfi_STRAINAA',
      originalPath: '/tmp/a.zip',
    },
    { workspaceId: 0, entityId: 'strain-1', sourceRecordId: 'bfi_STRAINAA' },
    { workspaceId: 12, entityId: '../strain-1', sourceRecordId: '' },
  ])('rejects malformed or renderer-supplied path data: %o', (request) => {
    expect(() => parseExternalProviderSourceRequest(request)).toThrow();
  });
});
