import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'waypoint-designs';

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
  vi.resetModules();
});

afterEach(() => {
  localStorage.removeItem(STORAGE_KEY);
});

it(
  'cold-imports when persisted designs contain primers that need Tm refinement',
  { timeout: 20_000 },
  async () => {
    const warmModule = await import('./store');
    warmModule.useDesignStore.setState({
      designs: {
        'cold-start-design': {
          id: 'cold-start-design',
          name: 'cold start',
          regions: [],
          topology: 'circular',
          assemblyMethod: 'gibson',
          defaultHomologyLength: 30,
          homologyRegions: [],
          designPrimers: [
            {
              forward: {
                id: 'forward',
                name: 'forward',
                sequence: 'GCGCTATAGC',
                pbs: { start: 0, end: 10, sequence: 'GCGCTATAGC' },
                overhang: { length: 0, sequence: '' },
                direction: 'forward',
                fragmentIndex: 0,
                junctionIndex: 0,
                tm: 50,
              },
              reverse: {
                id: 'reverse',
                name: 'reverse',
                sequence: 'GCGCTATAGC',
                pbs: { start: 0, end: 10, sequence: 'GCGCTATAGC' },
                overhang: { length: 0, sequence: '' },
                direction: 'reverse',
                fragmentIndex: 0,
                junctionIndex: 0,
                tm: 50,
              },
              fragmentIndex: 0,
            },
          ],
          spacers: [],
          status: 'draft',
          assemblyState: 'drafting',
          validationErrors: [],
          version: 1,
          pcrPolymerase: null,
          createdAt: new Date('2026-07-27T00:00:00Z'),
          updatedAt: new Date('2026-07-27T00:00:00Z'),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      },
      activeDesignId: 'cold-start-design',
      pendingDispatchId: null,
    });

    const persisted = localStorage.getItem(STORAGE_KEY);
    expect(persisted).not.toBeNull();

    vi.resetModules();
    localStorage.setItem(STORAGE_KEY, persisted!);

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const coldModule = await import('./store');
    expect(coldModule.useDesignStore.getState().designs['cold-start-design']).toBeDefined();
    expect(consoleError).not.toHaveBeenCalledWith(
      'Failed to rehydrate design state:',
      expect.any(ReferenceError)
    );
  }
);
