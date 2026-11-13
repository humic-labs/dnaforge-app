// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest';
import {
  clearFinalizedPlasmidIdentitiesForTests,
  forgetFinalizedPlasmid,
  plasmidIdentityForDocument,
  rememberFinalizedPlasmid,
} from './plasmid-identity';
import type { AcceptedAssemblyVersion } from './accepted-types';

describe('finalized plasmid session identity', () => {
  afterEach(() => {
    clearFinalizedPlasmidIdentitiesForTests();
  });

  it('remembers the plasmid by document ID so reopen does not depend on its product path', () => {
    const acceptedVersion = { id: 'accepted-1' } as AcceptedAssemblyVersion;
    rememberFinalizedPlasmid({
      productPath: '/workspace/assemblies/pX/pX.gb',
      packageRoot: '/workspace/assemblies/pX',
      metaPath: '/workspace/assemblies/pX/.forge/plasmid.json',
      constructId: 'construct-1',
      acceptedVersion,
    });

    expect(plasmidIdentityForDocument('construct-1')).toMatchObject({
      constructId: 'construct-1',
      packageRoot: '/workspace/assemblies/pX',
      acceptedVersion,
    });
    forgetFinalizedPlasmid('construct-1');
    expect(plasmidIdentityForDocument('construct-1')).toBeNull();
  });
});
