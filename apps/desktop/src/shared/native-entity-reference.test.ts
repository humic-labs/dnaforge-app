// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  isPortableNativeEntityId,
  nativeEntityReferenceHref,
  nativeEntityReferenceIdFromHref,
} from './native-entity-reference';

describe('native entity references', () => {
  it('round-trips a portable workspace entity ID', () => {
    const id = 'benchling-notebook-084bdfc5151d7d577873fce0';
    expect(nativeEntityReferenceIdFromHref(nativeEntityReferenceHref(id))).toBe(id);
  });

  it('reads the legacy migration URI without writing it back', () => {
    const id = 'benchling-notebook-084bdfc5151d7d577873fce0';
    expect(nativeEntityReferenceIdFromHref(`entity://migration/${encodeURIComponent(id)}`)).toBe(
      id
    );
    expect(nativeEntityReferenceHref(id)).toBe(`entity://workspace/${encodeURIComponent(id)}`);
  });

  it('rejects path escapes, controls, fragments, and malformed escapes', () => {
    expect(isPortableNativeEntityId('../outside')).toBe(false);
    expect(nativeEntityReferenceHref('bad\nvalue')).toBeNull();
    expect(nativeEntityReferenceIdFromHref('entity://workspace/good#fragment')).toBeNull();
    expect(nativeEntityReferenceIdFromHref('entity://workspace/%ZZ')).toBeNull();
  });
});
