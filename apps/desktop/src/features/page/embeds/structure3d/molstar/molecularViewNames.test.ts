import { describe, expect, it } from 'vitest';
import { requireNamedMolecularViews } from './molecularViewNames';

const story = (...titles: Array<string | undefined>) =>
  JSON.stringify({
    kind: 'multiple',
    snapshots: titles.map((title) => ({
      root: { kind: 'root' },
      metadata: title === undefined ? {} : { title },
    })),
  });

describe('explicit saved molecular view names', () => {
  it('requires every step name even when the collection has a descriptive name', () => {
    expect(() =>
      requireNamedMolecularViews(story('DNA strand routing', undefined), 'Catalytic checkpoint')
    ).toThrow(/snapshots\[1\]\.metadata.title/);
  });
  it.each(['View 1', 'view2', 'SCENE_03', 'Step IV', 'Untitled', '  ', '123'])(
    'rejects the generic or absent name %s',
    (name) => {
      expect(() => requireNamedMolecularViews(story(name), 'Catalytic checkpoint')).toThrow(
        /explicit descriptive name/
      );
    }
  );
  it('accepts explicitly authored descriptive step names', () => {
    expect(() =>
      requireNamedMolecularViews(
        story('DNA strand routing', 'HNH catalytic alignment'),
        'Catalytic checkpoint'
      )
    ).not.toThrow();
  });
  it('accepts an explicitly named standalone view without inventing scene metadata', () => {
    expect(() =>
      requireNamedMolecularViews(
        JSON.stringify({ root: { kind: 'root' } }),
        'Ligand contact geometry'
      )
    ).not.toThrow();
  });
  it('rejects a generic standalone title and reports the stable repair code', () => {
    try {
      requireNamedMolecularViews(JSON.stringify({ root: { kind: 'root' } }), 'View 1');
    } catch (error) {
      expect(error).toMatchObject({ code: 'MVS_VIEW_NAME_REQUIRED' });
      return;
    }
    throw Error('Unnamed view was accepted');
  });
});
