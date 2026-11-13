// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { resolveOwningReferenceContext, scopeKeyFromPageId } from './resolve-owning-root';

const ROOTS = [
  { path: '/workspaces/alpha' },
  { path: '/workspaces/beta' },
  { path: '/workspaces/beta/nested' },
];

describe('scopeKeyFromPageId', () => {
  it('reads the scope prefix from a scoped page id', () => {
    expect(scopeKeyFromPageId('repo-uuid-beta::notebook-7')).toBe('repo-uuid-beta');
  });

  it('returns null for a bare (pre- id', () => {
    expect(scopeKeyFromPageId('notebook-7')).toBeNull();
  });

  it('returns null when the separator is leading, so the scope would be empty', () => {
    expect(scopeKeyFromPageId('::notebook-7')).toBeNull();
  });

  it('keeps only the first segment when the embedded id itself contains a separator', () => {
    expect(scopeKeyFromPageId('beta::alpha::notebook-7')).toBe('beta');
  });
});

describe('resolveOwningReferenceContext', () => {
  it('resolves the root that actually contains the page file', () => {
    const ctx = resolveOwningReferenceContext({
      pageId: 'repo-uuid-beta::notebook-7',
      pageFilePath: '/workspaces/beta/notes/entry.forge/notebook.json',
      roots: ROOTS,
    });

    expect(ctx).toEqual({
      owningRoot: '/workspaces/beta',
      workspaceScopeKey: 'repo-uuid-beta',
    });
  });

  it('picks the MOST SPECIFIC containing root, not the first match', () => {
    const ctx = resolveOwningReferenceContext({
      pageId: 'repo-uuid-nested::notebook-9',
      pageFilePath: '/workspaces/beta/nested/entry.forge/notebook.json',
      roots: ROOTS,
    });

    expect(ctx?.owningRoot).toBe('/workspaces/beta/nested');
  });

  it('does NOT fall back to roots[0] when no root contains the file', () => {
    const ctx = resolveOwningReferenceContext({
      pageId: 'repo-uuid-beta::notebook-7',
      pageFilePath: '/somewhere/else/entry.forge/notebook.json',
      roots: ROOTS,
    });

    expect(ctx).toBeNull();
  });

  it('refuses when the page id carries no scope', () => {
    const ctx = resolveOwningReferenceContext({
      pageId: 'notebook-7',
      pageFilePath: '/workspaces/beta/notes/entry.forge/notebook.json',
      roots: ROOTS,
    });

    expect(ctx).toBeNull();
  });

  it('refuses when the catalog knows no file for the page', () => {
    const ctx = resolveOwningReferenceContext({
      pageId: 'repo-uuid-beta::notebook-7',
      pageFilePath: null,
      roots: ROOTS,
    });

    expect(ctx).toBeNull();
  });

  it('refuses when there are no roots at all', () => {
    const ctx = resolveOwningReferenceContext({
      pageId: 'repo-uuid-beta::notebook-7',
      pageFilePath: '/workspaces/beta/notes/entry.forge/notebook.json',
      roots: [],
    });

    expect(ctx).toBeNull();
  });

  it('does not treat a sibling with a shared prefix as the owner', () => {
    const ctx = resolveOwningReferenceContext({
      pageId: 'repo-uuid-beta::notebook-7',
      pageFilePath: '/workspaces/beta-archive/entry.forge/notebook.json',
      roots: ROOTS,
    });

    expect(ctx).toBeNull();
  });
});
