// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { resolvePageReference } from './resolve-page-reference';

const PORTABLE = 'corpus-02-part-inventory';
const HERE = 'ws651';
const THERE = 'ws999';
const LOCAL = `${HERE}::${PORTABLE}`;

describe('resolvePageReference', () => {
  it('🟥 resolves the PORTABLE id that shipped dead in 49 of 49 corpus links', () => {
    expect(
      resolvePageReference({
        referencedId: PORTABLE,
        owningScope: HERE,
        pageIds: [LOCAL, `${HERE}::corpus-01-programme-charter`],
      })
    ).toEqual({ kind: 'resolved', pageId: LOCAL });
  });

  it('resolves an id already scoped to THIS workspace', () => {
    expect(
      resolvePageReference({ referencedId: LOCAL, owningScope: HERE, pageIds: [LOCAL] })
    ).toEqual({ kind: 'resolved', pageId: LOCAL });
  });

  it('🟥 re-scopes an id scoped to ANOTHER installation — the shared-notebook case', () => {
    expect(
      resolvePageReference({
        referencedId: `${THERE}::${PORTABLE}`,
        owningScope: HERE,
        pageIds: [LOCAL],
      })
    ).toEqual({ kind: 'resolved', pageId: LOCAL });
  });

  it('prefers the REFERRING notebook’s own workspace when both hold the id', () => {
    const foreign = `${THERE}::${PORTABLE}`;
    expect(
      resolvePageReference({
        referencedId: PORTABLE,
        owningScope: HERE,
        pageIds: [foreign, LOCAL],
      })
    ).toEqual({ kind: 'resolved', pageId: LOCAL });
  });

  it('still resolves when the owning scope is unknown and exactly one page matches', () => {
    expect(
      resolvePageReference({ referencedId: PORTABLE, owningScope: null, pageIds: [LOCAL] })
    ).toEqual({ kind: 'resolved', pageId: LOCAL });
  });

  it('🟥 REFUSES when two workspaces hold the same id and the owner is unknown', () => {
    const a = `${HERE}::${PORTABLE}`;
    const b = `${THERE}::${PORTABLE}`;
    expect(
      resolvePageReference({ referencedId: PORTABLE, owningScope: null, pageIds: [b, a] })
    ).toEqual({ kind: 'ambiguous', referencedRawId: PORTABLE, candidates: [a, b] });
  });

  it('reports not-found rather than inventing a page id', () => {
    expect(
      resolvePageReference({ referencedId: 'corpus-99-nope', owningScope: HERE, pageIds: [LOCAL] })
    ).toEqual({ kind: 'not-found', referencedRawId: 'corpus-99-nope' });
  });

  it('reports not-found for an empty reference instead of resolving to a scope prefix', () => {
    expect(resolvePageReference({ referencedId: '', owningScope: HERE, pageIds: [LOCAL] })).toEqual(
      { kind: 'not-found', referencedRawId: '' }
    );
  });

  it('returns not-found against an empty store rather than throwing', () => {
    expect(
      resolvePageReference({ referencedId: PORTABLE, owningScope: HERE, pageIds: [] })
    ).toEqual({ kind: 'not-found', referencedRawId: PORTABLE });
  });

  it('never returns a bare string a caller could mistake for a page id', () => {
    const outcomes = [
      resolvePageReference({ referencedId: PORTABLE, owningScope: HERE, pageIds: [LOCAL] }),
      resolvePageReference({ referencedId: 'missing', owningScope: HERE, pageIds: [LOCAL] }),
    ];
    for (const outcome of outcomes) {
      expect(typeof outcome).toBe('object');
      expect(outcome).toHaveProperty('kind');
    }
  });
});

describe('only OPEN workspaces may arbitrate a resolution', () => {
  const OPEN = 'ws651';
  const CLOSED = 'ws999';
  const openPage = `${OPEN}::${PORTABLE}`;
  const closedPage = `${CLOSED}::${PORTABLE}`;

  it('🟥 a copy in a CLOSED workspace must not make an open link ambiguous', () => {
    expect(
      resolvePageReference({
        referencedId: PORTABLE,
        owningScope: null,
        pageIds: [closedPage, openPage],
        mountedScopes: [OPEN],
      })
    ).toEqual({ kind: 'resolved', pageId: openPage });
  });

  it('still refuses when BOTH copies are in open workspaces', () => {
    const other = 'ws777';
    const result = resolvePageReference({
      referencedId: PORTABLE,
      owningScope: null,
      pageIds: [openPage, `${other}::${PORTABLE}`],
      mountedScopes: [OPEN, other],
    });
    expect(result.kind).toBe('ambiguous');
  });

  it('does not resolve to a page whose workspace is closed', () => {
    expect(
      resolvePageReference({
        referencedId: PORTABLE,
        owningScope: null,
        pageIds: [closedPage],
        mountedScopes: [OPEN],
      })
    ).toEqual({ kind: 'not-found', referencedRawId: PORTABLE });
  });

  it('keeps bare (unscoped) singleton ids visible regardless of mounted scopes', () => {
    expect(
      resolvePageReference({
        referencedId: PORTABLE,
        owningScope: null,
        pageIds: [PORTABLE],
        mountedScopes: [OPEN],
      })
    ).toEqual({ kind: 'resolved', pageId: PORTABLE });
  });

  it('falls back to every page when the caller cannot supply mounted scopes', () => {
    expect(
      resolvePageReference({
        referencedId: PORTABLE,
        owningScope: OPEN,
        pageIds: [openPage],
        mountedScopes: [],
      })
    ).toEqual({ kind: 'resolved', pageId: openPage });
  });
});
