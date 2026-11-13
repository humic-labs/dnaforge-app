import { describe, expect, it } from 'vitest';

import { deriveCompiledBroadTrackMountScopeKey } from './IndexedGenomeViewer';

describe('compiled broad track mount scope', () => {
  it('does not remount when a late descriptor publishes its source identity', () => {
    const input = {
      requirementIdentityKey: 'indexed-full-assembly:grch38',
      sourceScopeKey: 'assembly-annotation-source-scope.v1:grch38',
    };

    const beforeDescriptor = deriveCompiledBroadTrackMountScopeKey({
      ...input,
      stableSourceIdentity: null,
    });
    const afterDescriptor = deriveCompiledBroadTrackMountScopeKey({
      ...input,
      stableSourceIdentity: 'assembly-annotation-source-sha256.v1:complete-grch38',
    });

    expect(afterDescriptor).toBe(beforeDescriptor);
    expect(afterDescriptor).toBe(input.requirementIdentityKey);
  });

  it('stays stable while a theme-keyed descriptor is temporarily unavailable', () => {
    const completeSourceIdentity = 'assembly-annotation-source-sha256.v1:complete-grch38';
    const input = {
      requirementIdentityKey: 'indexed-full-assembly:grch38',
      stableSourceIdentity: completeSourceIdentity,
      sourceScopeKey: 'assembly-annotation-source-scope.v1:grch38',
    };

    const beforeThemeChange = deriveCompiledBroadTrackMountScopeKey(input);
    const duringThemeDescriptorGap = deriveCompiledBroadTrackMountScopeKey(input);

    expect(duringThemeDescriptorGap).toBe(beforeThemeChange);
    expect(duringThemeDescriptorGap).toBe(input.requirementIdentityKey);
  });

  it('reconciles a source-scope replacement without remounting a compiled loader', () => {
    const current = deriveCompiledBroadTrackMountScopeKey({
      requirementIdentityKey: 'indexed-full-assembly:grch38',
      stableSourceIdentity: 'assembly-annotation-source-sha256.v1:source-a',
      sourceScopeKey: 'assembly-annotation-source-scope.v1:source-a',
    });
    const replacement = deriveCompiledBroadTrackMountScopeKey({
      requirementIdentityKey: 'indexed-full-assembly:grch38',
      stableSourceIdentity: null,
      sourceScopeKey: 'assembly-annotation-source-scope.v1:source-b',
    });

    expect(replacement).toBe(current);
    expect(replacement).toBe('indexed-full-assembly:grch38');
  });

  it('still scopes a non-compiled fallback by its source contract', () => {
    const current = deriveCompiledBroadTrackMountScopeKey({
      requirementIdentityKey: null,
      stableSourceIdentity: 'assembly-annotation-source-sha256.v1:source-a',
      sourceScopeKey: 'assembly-annotation-source-scope.v1:source-a',
    });
    const replacement = deriveCompiledBroadTrackMountScopeKey({
      requirementIdentityKey: null,
      stableSourceIdentity: 'assembly-annotation-source-sha256.v1:source-b',
      sourceScopeKey: 'assembly-annotation-source-scope.v1:source-b',
    });

    expect(replacement).not.toBe(current);
    expect(replacement).toContain('source-b');
  });
});
