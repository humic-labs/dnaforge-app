import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '../../canvas/public/store';
import {
  captureSequenceDataLayerViews,
  selectSequenceDataLayerView,
} from './sequence-data-layer-view-commands';
const first = `layer-${'a'.repeat(64)}`;
const second = `layer-${'b'.repeat(64)}`;
const presentation = {
  sampleId: 'value',
  signalVisible: true,
  annotationColors: true,
  style: {
    geometry: 'points' as const,
    colorScale: {
      kind: 'continuous' as const,
      domain: [0, 1] as [number, number],
      colors: ['#000000', '#ffffff'],
      missingColor: '#cccccc',
      transform: 'linear' as const,
    },
  },
};

beforeEach(() => {
  localStorage.clear();
  useCanvasStore.setState({
    panels: {
      main: {
        id: 'main',
        tabs: [
          {
            id: 'ordinary',
            type: 'sequence',
            entityId: 'old-sequence',
            label: 'Existing sequence',
          },
        ],
        activeTabId: 'ordinary',
      },
    },
    focusedPanelId: 'main',
    layout: { type: 'panel', panelId: 'main' },
  });
});

describe('sequence data layer view attachment', () => {
  it('selects a confirmed layer through the existing view owner', () => {
    const [view] = captureSequenceDataLayerViews('old-sequence');
    expect(selectSequenceDataLayerView(view, { project: '/project', layerId: first })).toBe(
      'updated'
    );
    expect(captureSequenceDataLayerViews('old-sequence')[0].selection).toEqual({
      project: '/project',
      layerId: first,
    });
  });

  it('preserves a newer human selection when an earlier AI request finishes', () => {
    const [captured] = captureSequenceDataLayerViews('old-sequence');
    expect(selectSequenceDataLayerView(captured, { project: '/project', layerId: first })).toBe(
      'updated'
    );
    expect(selectSequenceDataLayerView(captured, { project: '/project', layerId: second })).toBe(
      'changed'
    );
    expect(captureSequenceDataLayerViews('old-sequence')[0].selection?.layerId).toBe(first);
  });

  it('treats a human style change on the same layer as a newer choice', () => {
    const [initial] = captureSequenceDataLayerViews('old-sequence');
    expect(selectSequenceDataLayerView(initial, { project: '/project', layerId: first })).toBe(
      'updated'
    );
    const [beforePublication] = captureSequenceDataLayerViews('old-sequence');
    const styled = {
      project: '/project',
      layerId: first,
      presentationByLayerId: { [first]: presentation },
    };
    expect(selectSequenceDataLayerView(beforePublication, styled)).toBe('updated');
    expect(
      selectSequenceDataLayerView(beforePublication, { project: '/project', layerId: second })
    ).toBe('changed');
    expect(captureSequenceDataLayerViews('old-sequence')[0].selection).toEqual(styled);
  });

  it('appends an AI-created layer to existing visible layers without discarding their styles', () => {
    const [initial] = captureSequenceDataLayerViews('old-sequence');
    const styled = {
      project: '/project',
      layerId: first,
      presentationByLayerId: { [first]: presentation },
    };
    expect(selectSequenceDataLayerView(initial, styled)).toBe('updated');
    const [beforePublication] = captureSequenceDataLayerViews('old-sequence');
    expect(
      selectSequenceDataLayerView(beforePublication, { project: '/project', layerId: second })
    ).toBe('updated');
    expect(captureSequenceDataLayerViews('old-sequence')[0].selection).toEqual({
      ...styled,
      layerId: second,
      visibleLayerIds: [first, second],
    });
  });

  it('refuses an AI append beyond the bounded visible layer list', () => {
    const visibleLayerIds = Array.from(
      { length: 64 },
      (_, index) => `layer-${index.toString(16).padStart(64, '0')}`
    );
    const [initial] = captureSequenceDataLayerViews('old-sequence');
    const selection = { project: '/project', layerId: visibleLayerIds[63], visibleLayerIds };
    expect(selectSequenceDataLayerView(initial, selection)).toBe('updated');
    const [beforePublication] = captureSequenceDataLayerViews('old-sequence');
    expect(
      selectSequenceDataLayerView(beforePublication, { project: '/project', layerId: second })
    ).toBe('invalid');
    expect(captureSequenceDataLayerViews('old-sequence')[0].selection).toEqual(selection);
  });

  it('preserves a human visibility change when an earlier AI publication finishes', () => {
    const [initial] = captureSequenceDataLayerViews('old-sequence');
    const both = { project: '/project', layerId: second, visibleLayerIds: [first, second] };
    expect(selectSequenceDataLayerView(initial, both)).toBe('updated');
    const [beforePublication] = captureSequenceDataLayerViews('old-sequence');
    const hiddenFirst = { ...both, visibleLayerIds: [second] };
    expect(selectSequenceDataLayerView(beforePublication, hiddenFirst)).toBe('updated');
    expect(
      selectSequenceDataLayerView(beforePublication, { project: '/project', layerId: first })
    ).toBe('changed');
    expect(captureSequenceDataLayerViews('old-sequence')[0].selection).toEqual(hiddenFirst);
  });

  it('rejects invalid presentation overrides at the view command boundary', () => {
    const [captured] = captureSequenceDataLayerViews('old-sequence');
    expect(
      selectSequenceDataLayerView(captured, {
        project: '/project',
        layerId: first,
        presentationByLayerId: {
          [first]: {
            ...presentation,
            style: {
              ...presentation.style,
              colorScale: { ...presentation.style.colorScale, domain: [1, 0] },
            },
          },
        },
      })
    ).toBe('invalid');
    expect(captureSequenceDataLayerViews('old-sequence')[0].selection).toBeNull();
  });

  it('does not reopen or retarget a closed view after publication', () => {
    const [captured] = captureSequenceDataLayerViews('old-sequence');
    useCanvasStore.setState({ panels: { main: { id: 'main', tabs: [], activeTabId: null } } });
    expect(selectSequenceDataLayerView(captured, { project: '/project', layerId: first })).toBe(
      'closed'
    );
    expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(0);
  });

  it('refuses an invalid layer identity without claiming a view update', () => {
    const [captured] = captureSequenceDataLayerViews('old-sequence');
    expect(
      selectSequenceDataLayerView(captured, { project: '/project', layerId: 'unvalidated-id' })
    ).toBe('invalid');
    expect(captureSequenceDataLayerViews('old-sequence')[0].selection).toBeNull();
  });
});
