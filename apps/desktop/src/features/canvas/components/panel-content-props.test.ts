import { describe, expect, it } from 'vitest';
import { panelContentPropsEqual as compare } from './panel-content-props';
import type { ComponentProps } from 'react';
import type { PanelContent } from './PanelContent';

const props: ComponentProps<typeof PanelContent> = {
  panelId: 'panel',
  tab: {
    id: 'tab',
    type: 'sequence',
    entityId: 'sequence',
    label: 'pUC19',
    sequenceDocument: { kind: 'managed-sequence', packageId: 'sequence', packageRoot: '/pUC19' },
    viewState: { sequenceWebglMorph: 0 },
  },
};

describe('sequence panel content inputs', () => {
  it('retains a resolved sequence document while its viewer updates its own viewport', () => {
    expect(
      compare(props, {
        ...props,
        tab: {
          ...props.tab!,
          viewState: { sequenceWebglMorph: 0.5, sequenceViewportCenterBp: 1200 },
        },
      })
    ).toBe(true);
  });

  it.each(['label', 'entityId', 'readOnly', 'sequenceDocument', 'quickLookSource', 'loadStatus'])(
    'propagates changes to %s',
    (key) => {
      expect(compare(props, { ...props, tab: { ...props.tab!, [key]: 'changed' } })).toBe(false);
    }
  );

  it('propagates details drawers, panel activity, callbacks and unresolved or other editors', () => {
    for (const viewState of [{ entityDetailsOpen: true }, { entityDetailsEntityId: 'detail' }])
      expect(compare(props, { ...props, tab: { ...props.tab!, viewState } })).toBe(false);
    expect(compare(props, { ...props, isActive: false })).toBe(false);
    expect(compare(props, { ...props, onOpenAssistantSources: () => {} })).toBe(false);
    expect(compare(props, { ...props, tab: { ...props.tab!, sequenceDocument: undefined } })).toBe(
      false
    );
    const text = { ...props, tab: { ...props.tab!, type: 'text' as const } };
    expect(
      compare(text, {
        ...text,
        tab: {
          ...text.tab,
          viewState: {
            textCursor: {
              line: 2,
              column: 3,
              requestId: 'navigation',
            },
          },
        },
      })
    ).toBe(false);
  });
});
