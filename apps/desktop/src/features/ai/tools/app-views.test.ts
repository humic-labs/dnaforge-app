import { describe, expect, it } from 'vitest';
import { appViewsSchema } from './app-views';

describe('saved views use the existing app_views interface', () => {
  it.each([
    { kind: 'list', offset: 0, limit: 20 },
    { kind: 'open', viewId: 'track-view-existing' },
    { kind: 'inspect', tabId: 'tab-existing' },
    { kind: 'inspect-tracks', tabId: 'tab-existing' },
    {
      kind: 'configure-tracks',
      tabId: 'tab-existing',
      expectedRevision: 'current-layout',
      command: { kind: 'set-visibility', trackId: 'promoters', visible: false },
    },
    { kind: 'save', tabId: 'tab-existing', name: 'Genes', expectedRevision: 'current' },
    { kind: 'rename', tabId: 'tab-existing', name: 'New name', expectedRevision: 'current' },
    {
      kind: 'duplicate',
      tabId: 'tab-existing',
      name: 'Independent view',
      expectedRevision: 'current',
    },
  ])('accepts the familiar $kind operation', (operation) => {
    expect(appViewsSchema.safeParse({ operation }).success).toBe(true);
  });

  it('requires an inspected revision before a view can be saved', () => {
    expect(
      appViewsSchema.safeParse({
        operation: { kind: 'save', tabId: 'tab-existing', name: 'Genes' },
      }).success
    ).toBe(false);
  });

  it('keeps ordinary canvas inspection backward compatible', () => {
    expect(appViewsSchema.parse({ operation: { kind: 'inspect' } })).toEqual({
      operation: { kind: 'inspect' },
    });
  });

  it('requires the inspected track revision before changing an annotation layout', () => {
    expect(
      appViewsSchema.safeParse({
        operation: {
          kind: 'configure-tracks',
          tabId: 'tab-existing',
          command: { kind: 'set-visibility', trackId: 'promoters', visible: false },
        },
      }).success
    ).toBe(false);
  });
});
