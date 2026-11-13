// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GLYPH_SILHOUETTES, SequenceMinimapShapeControl } from '../SequenceMinimapShapeControl';

afterEach(cleanup);

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 600;

const PRESETS = [
  { key: 'circular', value: 0 },
  { key: 'stadium', value: 50 },
  { key: 'linear', value: 100 },
] as const;

function renderAtValue(value: number) {
  const props =
    value >= 92
      ? { mapShape: 'linear' as const, morphToCircle: 0, geometryHeight: MIN_HEIGHT }
      : value <= 25
        ? {
            mapShape: 'circular' as const,
            morphToCircle: 1 - value / 25,
            geometryHeight: MAX_HEIGHT,
          }
        : {
            mapShape: 'circular' as const,
            morphToCircle: 0,
            geometryHeight: MAX_HEIGHT - Math.min(1, (value - 25) / 25) * (MAX_HEIGHT - MIN_HEIGHT),
          };

  return render(
    <SequenceMinimapShapeControl
      geometryHeight={props.geometryHeight}
      minHeight={MIN_HEIGHT}
      maxHeight={MAX_HEIGHT}
      mapShape={props.mapShape}
      morphToCircle={props.morphToCircle}
      onMapShapeChange={() => {}}
      onGeometryHeightChange={() => {}}
      onMorphToCircleChange={() => {}}
    />
  );
}

function thumbRect() {
  const thumb = screen.getByTestId('sequence-map-topology-thumb');
  return {
    el: thumb,
    x: Number(thumb.getAttribute('x')),
    y: Number(thumb.getAttribute('y')),
    width: Number(thumb.getAttribute('width')),
    height: Number(thumb.getAttribute('height')),
    rx: Number(thumb.getAttribute('rx')),
  };
}

const GLYPH_HALF_HEIGHT: Record<string, number> = Object.fromEntries(
  Object.entries(GLYPH_SILHOUETTES).map(([key, metrics]) => [key, metrics.height / 2])
);
const RAIL_HEIGHT = 96;
const railY = (value: number) => (value / 100) * RAIL_HEIGHT;

describe('SequenceMinimapShapeControl — the thumb is always visible', () => {
  it('shows exactly three evenly spaced presets on a compact rail', () => {
    const { container } = renderAtValue(0);
    const markers = Array.from(container.querySelectorAll<HTMLElement>('[data-marker]'));
    expect(markers.map((marker) => marker.dataset.marker)).toEqual([
      'circular',
      'stadium',
      'linear',
    ]);
    expect(
      markers.map((marker) => marker.style.getPropertyValue('--sequence-map-topology-marker-value'))
    ).toEqual(['0', '50', '100']);
    const canvas = container.querySelector('.sequence-map-topology-canvas');
    expect(Number(canvas?.getAttribute('height'))).toBeLessThanOrEqual(100);
  });

  it.each(PRESETS)('renders the thumb at the $key preset', ({ value }) => {
    renderAtValue(value);
    const thumb = thumbRect();

    expect(thumb.el).toBeTruthy();
    expect(thumb.width).toBeGreaterThan(8);
    expect(thumb.height).toBeGreaterThan(8);
    expect(thumb.el.getAttribute('opacity')).toBeNull();
    expect(thumb.el.style.opacity).toBe('');
    expect(thumb.el.style.display).not.toBe('none');
  });

  it('never reintroduces the hide-at-preset plumbing', () => {
    const { container } = renderAtValue(0);
    const control = screen.getByTestId('sequence-minimap-shape-control');
    expect(
      control.getAttribute('data-topology-thumb-visible'),
      'data-topology-thumb-visible drove an opacity:0 rule that hid the dragger at presets'
    ).toBeNull();
    expect(control.getAttribute('data-topology-highlight')).toBeNull();
    expect(container.querySelectorAll('[data-highlighted]')).toHaveLength(0);
  });

  it('never masks or occludes the thumb', () => {
    const { container } = renderAtValue(0);
    expect(
      container.querySelectorAll('.sequence-map-topology-icon-occluder'),
      'an occluder disc hides the thumb passing behind a hollow glyph'
    ).toHaveLength(0);
    expect(
      container.querySelectorAll('mask'),
      'a knockout mask punches the glyph out of the thumb'
    ).toHaveLength(0);
    expect(thumbRect().el.closest('[mask]')).toBeNull();
  });
});

describe('SequenceMinimapShapeControl — the thumb is a concentric field behind each glyph', () => {
  it.each(PRESETS)('fully contains the $key glyph, a few px proud of it', ({ key, value }) => {
    renderAtValue(value);
    const thumb = thumbRect();
    const glyphHalf = GLYPH_HALF_HEIGHT[key]!;
    const glyphTop = railY(value) - glyphHalf;
    const glyphBottom = railY(value) + glyphHalf;

    const topOutset = glyphTop - thumb.y;
    const bottomOutset = thumb.y + thumb.height - glyphBottom;

    expect(topOutset, `thumb must extend above the ${key} glyph`).toBeGreaterThanOrEqual(2);
    expect(bottomOutset, `thumb must extend below the ${key} glyph`).toBeGreaterThanOrEqual(2);
    expect(topOutset, 'the halo should be a few px, not a giant blob').toBeLessThanOrEqual(9);
    expect(bottomOutset).toBeLessThanOrEqual(9);
    expect(Math.abs(topOutset - bottomOutset)).toBeLessThan(0.01);
  });

  it('morphs the thumb silhouette continuously as the value moves between presets', () => {
    const heights: number[] = [];
    for (const value of [0, 10, 20, 25, 30, 40, 50]) {
      renderAtValue(value);
      heights.push(thumbRect().height);
      cleanup();
    }
    for (let i = 1; i < heights.length; i += 1) {
      expect(heights[i]!, `height must fall from value step ${i - 1} to ${i}`).toBeLessThan(
        heights[i - 1]!
      );
    }
    expect(heights[0]! - heights[heights.length - 1]!).toBeGreaterThan(5);
  });
});

describe('SequenceMinimapShapeControl — the rail is gapped, not covered', () => {
  it('stops at each glyph perimeter without running beneath it', () => {
    const { container } = renderAtValue(50);
    const segments = Array.from(container.querySelectorAll('[data-rail-segment]')).map(
      (segment) => ({
        from: Number(segment.getAttribute('y1')),
        to: Number(segment.getAttribute('y2')),
      })
    );
    expect(segments).toHaveLength(2);

    for (const { key, value } of PRESETS) {
      const glyphTop = railY(value) - GLYPH_HALF_HEIGHT[key]!;
      const glyphBottom = railY(value) + GLYPH_HALF_HEIGHT[key]!;
      for (const segment of segments) {
        const overlaps = segment.to > glyphTop && segment.from < glyphBottom;
        expect(overlaps, `rail segment must not cross the ${key} glyph`).toBe(false);
      }
      const gaps = segments
        .map((segment) =>
          segment.to <= glyphTop ? glyphTop - segment.to : segment.from - glyphBottom
        )
        .filter((gap) => gap >= 0);
      expect(
        Math.min(...gaps),
        `rail is clipped too far from the ${key} glyph`
      ).toBeLessThanOrEqual(4);
    }
  });

  it('dashes only the stadium to linear handoff', () => {
    const { container } = renderAtValue(0);
    const styles = Array.from(container.querySelectorAll('[data-rail-segment]')).map((segment) =>
      segment.getAttribute('data-rail-segment-style')
    );
    expect(styles).toEqual(['solid', 'dashed']);
  });
});

describe('SequenceMinimapShapeControl — clicking a preset snaps to it', () => {
  function renderWithSpies(value: number) {
    const calls: { shape?: string; morph?: number; height?: number } = {};
    const props =
      value <= 25
        ? {
            mapShape: 'circular' as const,
            morphToCircle: 1 - value / 25,
            geometryHeight: MAX_HEIGHT,
          }
        : { mapShape: 'circular' as const, morphToCircle: 0, geometryHeight: MIN_HEIGHT };
    render(
      <SequenceMinimapShapeControl
        geometryHeight={props.geometryHeight}
        minHeight={MIN_HEIGHT}
        maxHeight={MAX_HEIGHT}
        mapShape={props.mapShape}
        morphToCircle={props.morphToCircle}
        onMapShapeChange={(shape) => {
          calls.shape = shape;
        }}
        onGeometryHeightChange={(height) => {
          calls.height = height;
        }}
        onMorphToCircleChange={(morph) => {
          calls.morph = morph;
        }}
      />
    );
    return calls;
  }

  it.each([
    { key: 'circular', shape: 'circular', morph: 1, height: MAX_HEIGHT },
    { key: 'stadium', shape: 'circular', morph: 0, height: MIN_HEIGHT },
    { key: 'linear', shape: 'linear', morph: 0, height: MIN_HEIGHT },
  ])('pressing the $key glyph applies exactly that stop', ({ key, shape, morph, height }) => {
    const calls = renderWithSpies(50);
    const glyph = document.querySelector(`.sequence-map-topology-marker[data-marker="${key}"] svg`);
    expect(glyph).toBeTruthy();

    fireEvent.pointerDown(glyph!, { clientY: 0, pointerId: 1, buttons: 1 });

    expect(calls.shape, `pressing ${key} must set its map shape`).toBe(shape);
    expect(calls.morph, `pressing ${key} must set its exact morph`).toBeCloseTo(morph, 6);
    expect(calls.height, `pressing ${key} must set its exact geometry height`).toBeCloseTo(
      height,
      6
    );
  });

  it('does not snap when the press lands on bare rail', () => {
    const calls = renderWithSpies(50);
    const rail = screen.getByTestId('sequence-map-topology-slider');
    fireEvent.pointerDown(rail, { clientY: 40, pointerId: 1, buttons: 1 });
    expect(calls.shape).toBeUndefined();
    expect(calls.morph).toBeUndefined();
  });
});

describe('SequenceMinimapShapeControl — geometry stays inside its bounds', () => {
  function pressRailAt(rail: HTMLElement, clientY: number) {
    rail.getBoundingClientRect = () =>
      ({
        top: 0,
        height: 100,
        left: 0,
        width: 30,
        right: 30,
        bottom: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    rail.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientY, buttons: 1 })
    );
  }

  it.each([50, 60, 76, 80, 85, 91])(
    'value %i never emits a geometry height below minHeight',
    (value) => {
      const heights: number[] = [];
      render(
        <SequenceMinimapShapeControl
          geometryHeight={MAX_HEIGHT}
          minHeight={MIN_HEIGHT}
          maxHeight={MAX_HEIGHT}
          mapShape="circular"
          morphToCircle={0}
          onMapShapeChange={() => {}}
          onGeometryHeightChange={(height) => heights.push(height)}
          onMorphToCircleChange={() => {}}
        />
      );
      pressRailAt(screen.getByTestId('sequence-map-topology-slider'), value);

      expect(heights.length, `pointer press at ${value} must reach applyValue`).toBeGreaterThan(0);
      for (const height of heights) {
        expect(height, `value ${value} emitted geometryHeight ${height}`).toBeGreaterThanOrEqual(
          MIN_HEIGHT
        );
        expect(height).toBeLessThanOrEqual(MAX_HEIGHT);
      }
    }
  );

  it('a press in the hand-off zone still selects the stadium, not a broken shape', () => {
    const heights: number[] = [];
    const morphs: number[] = [];
    render(
      <SequenceMinimapShapeControl
        geometryHeight={MAX_HEIGHT}
        minHeight={MIN_HEIGHT}
        maxHeight={MAX_HEIGHT}
        mapShape="circular"
        morphToCircle={0}
        onMapShapeChange={() => {}}
        onGeometryHeightChange={(h) => heights.push(h)}
        onMorphToCircleChange={(m) => morphs.push(m)}
      />
    );
    pressRailAt(screen.getByTestId('sequence-map-topology-slider'), 85);
    expect(morphs).toEqual([0]);
    expect(heights).toEqual([MIN_HEIGHT]);
  });
});

describe('SequenceMinimapShapeControl — keyboard works in topology mode', () => {
  function renderTopology(mapShape: 'circular' | 'linear') {
    const onMapShapeChange = vi.fn();
    render(
      <SequenceMinimapShapeControl
        geometryHeight={MAX_HEIGHT}
        minHeight={MIN_HEIGHT}
        maxHeight={MAX_HEIGHT}
        mapShape={mapShape}
        morphToCircle={0}
        mode="topology"
        onMapShapeChange={onMapShapeChange}
        onGeometryHeightChange={() => {}}
        onMorphToCircleChange={() => {}}
      />
    );
    return { rail: screen.getByTestId('sequence-map-topology-slider'), onMapShapeChange };
  }

  it.each(['ArrowDown', 'ArrowRight', 'PageDown'])('%s moves circular -> linear', (key) => {
    const { rail, onMapShapeChange } = renderTopology('circular');
    fireEvent.keyDown(rail, { key });
    expect(onMapShapeChange).toHaveBeenCalledWith('linear');
  });

  it.each(['ArrowUp', 'ArrowLeft', 'PageUp'])('%s moves linear -> circular', (key) => {
    const { rail, onMapShapeChange } = renderTopology('linear');
    fireEvent.keyDown(rail, { key });
    expect(onMapShapeChange).toHaveBeenCalledWith('circular');
  });

  it('shape mode keeps its fine-grained 3-unit arrow step', () => {
    const onMorphToCircleChange = vi.fn();
    render(
      <SequenceMinimapShapeControl
        geometryHeight={MAX_HEIGHT}
        minHeight={MIN_HEIGHT}
        maxHeight={MAX_HEIGHT}
        mapShape="circular"
        morphToCircle={1}
        onMapShapeChange={() => {}}
        onGeometryHeightChange={() => {}}
        onMorphToCircleChange={onMorphToCircleChange}
      />
    );
    fireEvent.keyDown(screen.getByTestId('sequence-map-topology-slider'), { key: 'ArrowDown' });
    expect(onMorphToCircleChange).toHaveBeenCalledWith(1 - 3 / 25);
  });
});
