// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  scopedProjectionId,
  stripWorkspaceScope,
  hasWorkspaceScope,
  WORKSPACE_SCOPE_SEP,
} from './workspace-scoped-identity';

describe('workspace-scoped-identity', () => {
  it('scopes a raw embedded id under the workspace scope', () => {
    expect(scopedProjectionId('repo-a', 'example-moclo-golden-gate')).toBe(
      'repo-a::example-moclo-golden-gate'
    );
    expect(scopedProjectionId('ws7', 'nb-uuid')).toBe('ws7::nb-uuid');
  });

  it('two distinct workspaces produce two distinct keys for the SAME embedded id', () => {
    const a = scopedProjectionId('repo-a', 'example-moclo-golden-gate');
    const b = scopedProjectionId('repo-b', 'example-moclo-golden-gate');
    expect(a).not.toBe(b);
  });

  it('leaves the id unscoped when there is no workspace (singleton)', () => {
    expect(scopedProjectionId(null, 'nb-uuid')).toBe('nb-uuid');
    expect(scopedProjectionId(undefined, 'nb-uuid')).toBe('nb-uuid');
  });

  it('re-scoping is idempotent — strips an inherited scope instead of nesting', () => {
    const inA = scopedProjectionId('repo-a', 'nb-uuid');
    expect(scopedProjectionId('repo-b', inA)).toBe('repo-b::nb-uuid');
    expect(scopedProjectionId('repo-a', inA)).toBe('repo-a::nb-uuid');
  });

  it('stripWorkspaceScope returns the segment after the last separator', () => {
    expect(stripWorkspaceScope('repo-a::nb-uuid')).toBe('nb-uuid');
    expect(stripWorkspaceScope('nb-uuid')).toBe('nb-uuid');
    expect(stripWorkspaceScope(`a${WORKSPACE_SCOPE_SEP}b${WORKSPACE_SCOPE_SEP}c`)).toBe('c');
  });

  it('hasWorkspaceScope detects the prefix', () => {
    expect(hasWorkspaceScope('repo-a::nb-uuid')).toBe(true);
    expect(hasWorkspaceScope('nb-uuid')).toBe(false);
  });
});
