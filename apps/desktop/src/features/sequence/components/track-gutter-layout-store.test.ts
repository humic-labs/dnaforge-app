import { beforeEach, describe, expect, it } from 'vitest';

import { useTrackGutterLayoutStore } from './track-gutter-layout-store';

describe('track gutter layout per view', () => {
  beforeEach(() => useTrackGutterLayoutStore.setState({ collapsedByTabId: {} }));

  it('starts every new view expanded while keeping an explicit collapse on its own view', () => {
    const first = 'saved-view-first';
    const second = 'saved-view-second';
    const store = useTrackGutterLayoutStore.getState();

    expect(store.collapsedByTabId[first] ?? false).toBe(false);
    store.toggleCollapsed(first);
    expect(useTrackGutterLayoutStore.getState().collapsedByTabId[first]).toBe(true);
    expect(useTrackGutterLayoutStore.getState().collapsedByTabId[second] ?? false).toBe(false);
    store.toggleCollapsed(first);
    expect(useTrackGutterLayoutStore.getState().collapsedByTabId[first]).toBe(false);
  });
});
