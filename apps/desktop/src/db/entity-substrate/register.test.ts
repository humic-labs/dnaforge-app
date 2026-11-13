import { afterEach, describe, expect, it } from 'vitest';
import { __resetEntityAdapterRegistryForTests, getEntityAdapterForKind } from './adapter';
import {
  REQUIRED_ENTITY_KINDS,
  assertRequiredEntityAdaptersRegistered,
  registerAllEntityAdapters,
} from './register';

afterEach(() => __resetEntityAdapterRegistryForTests());

describe('entity adapter registration + required-kind manifest (M1/M8 enforcement)', () => {
  it('registerAllEntityAdapters registers every REQUIRED kind', () => {
    registerAllEntityAdapters();
    for (const kind of REQUIRED_ENTITY_KINDS) {
      expect(getEntityAdapterForKind(kind), `kind "${kind}" must be registered`).not.toBeNull();
    }
    expect(() => assertRequiredEntityAdaptersRegistered()).not.toThrow();
  });

  it('the guard THROWS when a required kind is missing (cannot pass vacuously)', () => {
    expect(REQUIRED_ENTITY_KINDS.length).toBeGreaterThan(0);
    expect(() => assertRequiredEntityAdaptersRegistered()).toThrow(/required adapter/);
  });
});
