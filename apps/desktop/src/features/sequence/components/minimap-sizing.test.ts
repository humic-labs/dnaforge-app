// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  computeMinimapSizing,
  withMinimapGeometryHeight,
  withMinimapPaneHeight,
} from './minimap-sizing';

describe('minimap sizing contract', () => {
  const minHeight = 180;
  const geometryMinHeight = 280;
  const maxHeight = 600;

  it('keeps geometry height separate from visible pane height', () => {
    const sizing = computeMinimapSizing({
      paneHeightRaw: minHeight,
      geometryHeightRaw: 420,
      minHeight,
      maxHeight,
    });

    expect(sizing.geometryHeight).toBe(420);
    expect(sizing.minimumHeight).toBe(minHeight);
    expect(sizing.paneHeight).toBe(minHeight);
  });

  it('allows a short pane while clamping geometry to the safer WebGL stadium minimum', () => {
    const sizing = computeMinimapSizing({
      paneHeightRaw: 180,
      geometryHeightRaw: 180,
      minHeight,
      geometryMinHeight,
      maxHeight,
    });

    expect(sizing.paneHeight).toBe(minHeight);
    expect(sizing.geometryHeight).toBe(geometryMinHeight);
  });

  it('does not let manual pane resizing rewrite the stable geometry height', () => {
    const shortPane = computeMinimapSizing({
      paneHeightRaw: minHeight,
      geometryHeightRaw: 500,
      minHeight,
      maxHeight,
    });
    const tallPane = computeMinimapSizing({
      paneHeightRaw: maxHeight,
      geometryHeightRaw: 500,
      minHeight,
      maxHeight,
    });

    expect(shortPane.geometryHeight).toBe(500);
    expect(tallPane.geometryHeight).toBe(500);
    expect(shortPane.paneHeight).toBe(minHeight);
    expect(tallPane.paneHeight).toBe(maxHeight);
  });

  it('allows the visible pane to exceed the shape geometry cap', () => {
    const sizing = computeMinimapSizing({
      paneHeightRaw: 900,
      geometryHeightRaw: 900,
      minHeight,
      maxHeight,
      paneMaxHeight: 1200,
    });

    expect(sizing.paneHeight).toBe(900);
    expect(sizing.geometryHeight).toBe(maxHeight);
  });

  it('updates shape geometry without changing the visible pane height', () => {
    const next = withMinimapGeometryHeight(
      {
        paneHeightRaw: 260,
        geometryHeightRaw: 180,
      },
      600
    );

    expect(next.paneHeightRaw).toBe(260);
    expect(next.geometryHeightRaw).toBe(600);
  });

  it('retains sizing state when repeated pointer input leaves both heights unchanged', () => {
    const state = { paneHeightRaw: 260, geometryHeightRaw: 180 };
    expect(withMinimapGeometryHeight(state, 180)).toBe(state);
    expect(withMinimapPaneHeight(state, 260)).toBe(state);
    expect(withMinimapGeometryHeight(state, 200)).not.toBe(state);
    expect(withMinimapPaneHeight(state, 300)).not.toBe(state);
  });

  it('updates pane height without changing shape geometry', () => {
    const next = withMinimapPaneHeight(
      {
        paneHeightRaw: 260,
        geometryHeightRaw: 600,
      },
      320
    );

    expect(next.paneHeightRaw).toBe(320);
    expect(next.geometryHeightRaw).toBe(600);
  });
});
