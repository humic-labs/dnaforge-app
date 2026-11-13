// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { MentionIdShape } from '../../../shared/notebook-reference';
import type { ReferenceContext } from './reference-context';
import { planReferenceResolution } from './plan-reference-resolution';

const CTX: ReferenceContext = {
  owningRoot: '/workspaces/beta',
  workspaceScopeKey: 'repo-uuid-beta',
};

function record(ref: {
  path?: string | null;
  entityId?: string | null;
  contentHash?: string | null;
}): MentionIdShape {
  return {
    kind: 'record',
    ref: {
      path: ref.path ?? null,
      entityId: ref.entityId ?? null,
      contentHash: ref.contentHash ?? null,
    },
  };
}

describe('planReferenceResolution — trust boundary', () => {
  it('resolves a well-formed workspace-relative path against the owning root', () => {
    const plan = planReferenceResolution(record({ path: 'sequences/pUC19.gb' }), CTX);

    expect(plan).toEqual({
      kind: 'resolve-path',
      absolutePath: '/workspaces/beta/sequences/pUC19.gb',
      workspaceRelativePath: 'sequences/pUC19.gb',
    });
  });

  it('refuses a parent-directory escape', () => {
    const plan = planReferenceResolution(record({ path: '../../etc/passwd' }), CTX);
    expect(plan).toEqual({ kind: 'unresolvable', reason: 'outside-workspace' });
  });

  it('refuses an escape hidden mid-path', () => {
    const plan = planReferenceResolution(record({ path: 'sequences/../../../etc/passwd' }), CTX);
    expect(plan).toEqual({ kind: 'unresolvable', reason: 'outside-workspace' });
  });

  it('refuses an absolute path, which would ignore the owning root entirely', () => {
    const plan = planReferenceResolution(record({ path: '/etc/passwd' }), CTX);
    expect(plan).toEqual({ kind: 'unresolvable', reason: 'outside-workspace' });
  });

  it('refuses a Windows-style absolute path', () => {
    const plan = planReferenceResolution(record({ path: 'C:\\Windows\\System32' }), CTX);
    expect(plan).toEqual({ kind: 'unresolvable', reason: 'outside-workspace' });
  });

  it('refuses a backslash-separated path rather than guessing its separators', () => {
    const plan = planReferenceResolution(record({ path: 'sequences\\..\\..\\secret' }), CTX);
    expect(plan).toEqual({ kind: 'unresolvable', reason: 'outside-workspace' });
  });

  it('does not let a sibling root with a shared prefix pass containment', () => {
    const plan = planReferenceResolution(record({ path: '../beta-archive/x.gb' }), CTX);
    expect(plan).toEqual({ kind: 'unresolvable', reason: 'outside-workspace' });
  });
});

describe('planReferenceResolution — shapes', () => {
  it('treats a record with an entity but no path as local-only (D9)', () => {
    const plan = planReferenceResolution(record({ entityId: 'entity-42' }), CTX);
    expect(plan).toEqual({ kind: 'local-only' });
  });

  it('prefers the path when a record carries both a path and an entity', () => {
    const plan = planReferenceResolution(
      record({ path: 'sequences/pUC19.gb', entityId: 'entity-42' }),
      CTX
    );
    expect(plan).toMatchObject({ kind: 'resolve-path' });
  });

  it('is unresolvable when a record carries neither a path nor an entity', () => {
    const plan = planReferenceResolution(record({}), CTX);
    expect(plan).toEqual({ kind: 'unresolvable', reason: 'malformed' });
  });

  it('routes a legacy path shape through the same containment check', () => {
    expect(planReferenceResolution({ kind: 'legacy-path', path: '../escape' }, CTX)).toEqual({
      kind: 'unresolvable',
      reason: 'outside-workspace',
    });
    expect(planReferenceResolution({ kind: 'legacy-path', path: 'a/b.gb' }, CTX)).toMatchObject({
      kind: 'resolve-path',
      absolutePath: '/workspaces/beta/a/b.gb',
    });
  });

  it('routes legacy row shapes to their row lookups', () => {
    expect(planReferenceResolution({ kind: 'legacy-sequence-row', dbId: 7 }, CTX)).toEqual({
      kind: 'resolve-sequence-row',
      dbId: 7,
    });
    expect(planReferenceResolution({ kind: 'legacy-primer-row', primerId: 'p1' }, CTX)).toEqual({
      kind: 'resolve-primer-row',
      primerId: 'p1',
    });
  });

  it('passes an already-unresolvable shape straight through as malformed', () => {
    const plan = planReferenceResolution({ kind: 'unresolvable', reason: 'bad attrs' }, CTX);
    expect(plan).toEqual({ kind: 'unresolvable', reason: 'malformed' });
  });

  it('refuses everything when there is no owning root', () => {
    const plan = planReferenceResolution(record({ path: 'sequences/pUC19.gb' }), null);
    expect(plan).toEqual({ kind: 'unresolvable', reason: 'no-owning-root' });
  });
});
