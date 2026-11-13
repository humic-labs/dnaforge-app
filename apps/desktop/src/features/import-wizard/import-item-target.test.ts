import { describe, it, expect } from 'vitest';
import { resolveItemTarget } from './import-item-target';
import type { ImportDestination } from '../workspace-loader/resolve-import-destination';

const ROOT: ImportDestination = { kind: 'existing-root', rootPath: '/ws/a' };
const NEWWS: ImportDestination = { kind: 'new-workspace' };

describe('resolveItemTarget  Phase 0a — per-item routing)', () => {
  it('undefined target inherits the batch destination (both kinds)', () => {
    expect(resolveItemTarget(undefined, ROOT)).toEqual(ROOT);
    expect(resolveItemTarget(undefined, NEWWS)).toEqual(NEWWS);
  });

  it('"default" target inherits the batch destination', () => {
    expect(resolveItemTarget({ kind: 'default' }, ROOT)).toEqual(ROOT);
    expect(resolveItemTarget({ kind: 'default' }, NEWWS)).toEqual(NEWWS);
  });

  it('an explicit existing-root overrides the batch, regardless of batch kind', () => {
    expect(resolveItemTarget({ kind: 'existing-root', rootPath: '/ws/b' }, ROOT)).toEqual({
      kind: 'existing-root',
      rootPath: '/ws/b',
    });
    expect(resolveItemTarget({ kind: 'existing-root', rootPath: '/ws/b' }, NEWWS)).toEqual({
      kind: 'existing-root',
      rootPath: '/ws/b',
    });
  });

  it('an explicit new-workspace overrides the batch, regardless of batch kind', () => {
    expect(resolveItemTarget({ kind: 'new-workspace' }, ROOT)).toEqual({ kind: 'new-workspace' });
    expect(resolveItemTarget({ kind: 'new-workspace' }, NEWWS)).toEqual({ kind: 'new-workspace' });
  });

  it('an explicit registry target resolves to a registry destination, regardless of batch kind  Phase 0)', () => {
    expect(resolveItemTarget({ kind: 'registry' }, ROOT)).toEqual({ kind: 'registry' });
    expect(resolveItemTarget({ kind: 'registry' }, NEWWS)).toEqual({ kind: 'registry' });
    const REGISTRY_BATCH: ImportDestination = { kind: 'registry' };
    expect(resolveItemTarget({ kind: 'registry' }, REGISTRY_BATCH)).toEqual({ kind: 'registry' });
  });

  it('a "default"/undefined target inherits a registry batch destination  Phase 0)', () => {
    const REGISTRY_BATCH: ImportDestination = { kind: 'registry' };
    expect(resolveItemTarget(undefined, REGISTRY_BATCH)).toEqual(REGISTRY_BATCH);
    expect(resolveItemTarget({ kind: 'default' }, REGISTRY_BATCH)).toEqual(REGISTRY_BATCH);
  });
});
