import { describe, expect, it } from 'vitest';

import { TrackDataStore } from './track-data-store';

describe('TrackDataStore', () => {
  it('returns null for unknown ids', () => {
    const store = new TrackDataStore();
    expect(store.get('missing')).toBeNull();
    expect(store.has('missing')).toBe(false);
  });

  it('roundtrips set → get with reference equality', () => {
    const store = new TrackDataStore();
    const payload = { bands: [1, 2, 3] };
    store.set('cyto', payload);
    expect(store.get('cyto')).toBe(payload);
    expect(store.has('cyto')).toBe(true);
  });

  it('typed get casts to the requested generic', () => {
    const store = new TrackDataStore();
    store.set('cyto', { count: 3 });
    const typed = store.get<{ count: number }>('cyto');
    expect(typed?.count).toBe(3);
  });

  it('overwrites on repeated set', () => {
    const store = new TrackDataStore();
    store.set('cyto', 'first');
    store.set('cyto', 'second');
    expect(store.get('cyto')).toBe('second');
  });

  it('delete removes the entry', () => {
    const store = new TrackDataStore();
    store.set('cyto', 'x');
    store.delete('cyto');
    expect(store.get('cyto')).toBeNull();
    expect(store.has('cyto')).toBe(false);
  });

  it('clear empties every entry', () => {
    const store = new TrackDataStore();
    store.set('a', 1);
    store.set('b', 2);
    store.clear();
    expect(store.get('a')).toBeNull();
    expect(store.get('b')).toBeNull();
    expect(store.has('a')).toBe(false);
    expect(store.has('b')).toBe(false);
  });

  it('distinguishes null-stored value from missing entry via has()', () => {
    const store = new TrackDataStore();
    store.set('with-null', null);
    expect(store.has('with-null')).toBe(true);
    expect(store.get('with-null')).toBeNull();
    expect(store.has('absent')).toBe(false);
    expect(store.get('absent')).toBeNull();
  });
});
