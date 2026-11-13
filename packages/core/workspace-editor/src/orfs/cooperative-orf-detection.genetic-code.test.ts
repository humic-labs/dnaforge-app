import { describe, expect, it } from 'vitest';
import { findORFs } from '@waypoint/sequence-utils';
import { findORFsCooperatively } from './cooperative-orf-detection';

const WITH_INTERNAL_TGA = `ATG${'AAA'.repeat(40)}TGA${'AAA'.repeat(40)}TAA`;
const alwaysActive = () => true;

describe('findORFsCooperatively and the genetic code', () => {
  it('matches the shared scanner under the standard code', async () => {
    const cooperative = await findORFsCooperatively(WITH_INTERNAL_TGA, 30, alwaysActive);
    expect(cooperative).toEqual(findORFs(WITH_INTERNAL_TGA, 30));
  });

  it('matches the shared scanner under a code that reassigns a stop', async () => {
    const cooperative = await findORFsCooperatively(WITH_INTERNAL_TGA, 30, alwaysActive, 4);
    expect(cooperative).toEqual(findORFs(WITH_INTERNAL_TGA, 30, { geneticCode: 4 }));
  });

  it('actually reads through the reassigned stop rather than merely agreeing', async () => {
    const standard = await findORFsCooperatively(WITH_INTERNAL_TGA, 30, alwaysActive);
    const mitochondrial = await findORFsCooperatively(WITH_INTERNAL_TGA, 30, alwaysActive, 4);
    const frameOne = (orfs: typeof standard) =>
      orfs!.find((orf) => orf.strand === '+' && orf.frame === 1)!;
    expect(frameOne(standard).length).toBe(126);
    expect(frameOne(mitochondrial).length).toBe(249);
  });

  it('falls back to the standard code for an unpublished id', async () => {
    const unpublished = await findORFsCooperatively(WITH_INTERNAL_TGA, 30, alwaysActive, 999);
    expect(unpublished).toEqual(findORFs(WITH_INTERNAL_TGA, 30));
  });
});
