import { afterEach, describe, expect, it } from 'vitest';
import { useStructureViewerPreferences } from './structureViewerPreferences';

const key = 'dnaforge:structure-viewer-preferences';

describe('structure viewer preferences', () => {
  afterEach(() => localStorage.removeItem(key));

  it('shows chain sequences by default, including for a value saved under the old default ', async () => {
    localStorage.setItem(
      key,
      JSON.stringify({ state: { showSequenceByDefault: false }, version: 0 })
    );
    await useStructureViewerPreferences.persist.rehydrate();
    expect(useStructureViewerPreferences.getState().showSequenceByDefault).toBe(true);
  });

  it('keeps a choice made under the current default', async () => {
    localStorage.setItem(
      key,
      JSON.stringify({ state: { showSequenceByDefault: false }, version: 1 })
    );
    await useStructureViewerPreferences.persist.rehydrate();
    expect(useStructureViewerPreferences.getState().showSequenceByDefault).toBe(false);
  });
});
