import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoundPrimer, Primer } from '../primers/public/types';

const existing = new Set<string>();

vi.mock('../../platform', () => ({
  platform: () => ({
    fs: { exists: (path: string) => Promise.resolve(existing.has(path)) },
  }),
}));

const { primerArtifactLocation, boundPrimerForDisplay } = await import('./primer-menu-actions');

function primerAt(artifactPath: string): Primer {
  return { originDetails: { artifactPath } } as unknown as Primer;
}

const folders = [
  { path: '/projects/dev-assets', pinned: true },
  { path: '/projects/my-project' },
  { path: '/projects/samples' },
];

describe('boundPrimerForDisplay', () => {
  const first = { id: 'shared-primer', binding: { id: 'first-site' } } as BoundPrimer;
  const second = { id: 'shared-primer', binding: { id: 'second-site' } } as BoundPrimer;

  it('selects the exact attachment even when the shared entity has an earlier binding', () => {
    expect(
      boundPrimerForDisplay({ id: 'second-site', sourcePrimerId: 'shared-primer' }, [first, second])
    ).toBe(second);
  });

  it('only falls back to the entity when its attachment is unambiguous', () => {
    const legacyDisplay = { id: 'legacy-display', sourcePrimerId: 'shared-primer' };
    expect(boundPrimerForDisplay(legacyDisplay, [first])).toBe(first);
    expect(boundPrimerForDisplay(legacyDisplay, [first, second])).toBeNull();
  });
});

describe('primerArtifactLocation', () => {
  beforeEach(() => existing.clear());

  it('finds a relative artifact in the one open project that has it, pinned included', async () => {
    existing.add('/projects/dev-assets/primers/P1.primer.json');
    await expect(
      primerArtifactLocation(primerAt('primers/P1.primer.json'), folders)
    ).resolves.toEqual({
      artifactPath: '/projects/dev-assets/primers/P1.primer.json',
      workspaceRoot: '/projects/dev-assets',
      destinationPath: '/projects/dev-assets/primers',
    });
  });

  it('refuses to guess when several open projects have the file', async () => {
    existing.add('/projects/my-project/primers/P1.primer.json');
    existing.add('/projects/samples/primers/P1.primer.json');
    await expect(
      primerArtifactLocation(primerAt('primers/P1.primer.json'), folders)
    ).resolves.toBeNull();
  });

  it('returns null when no open project has the file', async () => {
    await expect(
      primerArtifactLocation(primerAt('primers/P1.primer.json'), folders)
    ).resolves.toBeNull();
  });
});
