import { describe, expect, it } from 'vitest';

import { parseResourcePath, parseWorkspacePath } from './path';
import { pathCollisionKey, validateMaterializedTree, validatePathMove } from './path';

function workspacePath(value: string) {
  const parsed = parseWorkspacePath(value);
  if (!parsed.ok) throw new Error(`Expected valid test path: ${value}`);
  return parsed.value;
}

describe('portable paths', () => {
  it.each([
    ['', 'empty'],
    ['/absolute', 'absolute'],
    ['C:/drive', 'drive-qualified'],
    ['a\\b', 'backslash'],
    ['a//b', 'empty-segment'],
    ['a/./b', 'dot-segment'],
    ['a/../b', 'dot-segment'],
    ['a/line\nbreak', 'control-character'],
    ['a/\ud800', 'invalid-unicode'],
    ['a/name?.gb', 'reserved-character'],
    ['a/trailing.', 'trailing-dot-or-space'],
    ['a/trailing ', 'trailing-dot-or-space'],
    ['a/CON', 'reserved-name'],
    ['a/lpt9.txt', 'reserved-name'],
    ['a/COM¹.txt', 'reserved-name'],
    [`a/${'x'.repeat(256)}`, 'segment-too-long'],
    [[...Array<string>(6)].map(() => 'x'.repeat(200)).join('/'), 'path-too-long'],
  ] as const)('rejects %j as %s', (value, kind) => {
    expect(parseWorkspacePath(value)).toEqual({ ok: false, error: { kind } });
  });

  it('normalizes display spelling to NFC and retains slash-separated structure', () => {
    expect(parseWorkspacePath('cafe\u0301/product.gb')).toEqual({
      ok: true,
      value: 'café/product.gb',
    });
    expect(parseResourcePath('.forge/plasmid.json')).toEqual({
      ok: true,
      value: '.forge/plasmid.json',
    });
  });

  it('accepts the portable component boundary and valid replacement scalar', () => {
    expect(parseWorkspacePath('x'.repeat(255)).ok).toBe(true);
    expect(parseWorkspacePath([...Array<string>(4)].map(() => 'x'.repeat(255)).join('/')).ok).toBe(
      true
    );
    expect(parseWorkspacePath('\ufffd').ok).toBe(true);
  });

  it('uses pinned full case folding for collision identity', () => {
    expect(pathCollisionKey(workspacePath('Straße/Product.gb'))).toBe(
      pathCollisionKey(workspacePath('STRASSE/product.GB'))
    );
    expect(pathCollisionKey(workspacePath('Σ/ς/σ'))).toBe(pathCollisionKey(workspacePath('σ/σ/σ')));
  });
});

describe('materialized tree validation', () => {
  it('rejects case and NFC-equivalent collisions', () => {
    expect(
      validateMaterializedTree([
        { owner: 'one', kind: 'file', path: workspacePath('Designs/Straße.gb') },
        { owner: 'two', kind: 'file', path: workspacePath('designs/STRASSE.GB') },
      ])
    ).toEqual({
      ok: false,
      error: { kind: 'path-collision', paths: ['Designs/Straße.gb', 'designs/STRASSE.GB'] },
    });

    expect(
      validateMaterializedTree([
        { owner: 'one', kind: 'file', path: workspacePath('café') },
        { owner: 'two', kind: 'file', path: workspacePath('cafe\u0301') },
      ]).ok
    ).toBe(false);
  });

  it('rejects a file ancestor of another output', () => {
    expect(
      validateMaterializedTree([
        { owner: 'one', kind: 'file', path: workspacePath('a') },
        { owner: 'two', kind: 'file', path: workspacePath('a/b') },
      ])
    ).toEqual({
      ok: false,
      error: { kind: 'file-ancestor-collision', ancestor: 'a', descendant: 'a/b' },
    });
  });

  it('rejects a file ancestor even when another path sorts between it and its descendant', () => {
    expect(
      validateMaterializedTree([
        { owner: 'ancestor', kind: 'file', path: workspacePath('a') },
        { owner: 'interleaved', kind: 'file', path: workspacePath('a!') },
        { owner: 'descendant', kind: 'file', path: workspacePath('a/b') },
      ])
    ).toEqual({
      ok: false,
      error: { kind: 'file-ancestor-collision', ancestor: 'a', descendant: 'a/b' },
    });
  });

  it('allows a case-only self move after removing the old binding', () => {
    const currentPath = workspacePath('Designs/Alpha.gb');
    expect(
      validatePathMove({
        owner: 'resource-alpha',
        currentPath,
        destination: workspacePath('designs/ALPHA.GB'),
        occupied: [{ owner: 'resource-alpha', kind: 'file', path: currentPath }],
      })
    ).toEqual({ ok: true, value: undefined });
  });
});
