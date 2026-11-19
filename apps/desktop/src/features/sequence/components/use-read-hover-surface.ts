import { useEffect, useState, type RefObject } from 'react';
import { platform } from '../../../platform';
import type { WindowDisplayColorSpace } from '../../../shared/ipc/window.contract';
import {
  createReadHoverSurface,
  readHoverLayoutScale,
  type ReadHoverSurface,
} from './read-hover-surface';

export function useReadHoverSurface(containerRef: RefObject<HTMLDivElement>, enabled: boolean) {
  const [surface, setSurface] = useState<ReadHoverSurface | null>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container || typeof ResizeObserver === 'undefined') return;
    const bridge = platform();
    const ownerDocument = container.ownerDocument;
    let display: WindowDisplayColorSpace | null = null;
    let layoutScale = 0;
    let activeDisplay: WindowDisplayColorSpace | null = null;
    let activeScale = 0;
    let active: ReadHoverSurface | null = null;
    let request = 0;
    let disposed = false;

    function update() {
      if (disposed || (display === activeDisplay && layoutScale === activeScale)) return;
      active?.dispose();
      activeDisplay = display;
      activeScale = layoutScale;
      active =
        display && layoutScale > 0
          ? createReadHoverSurface({
              document: ownerDocument,
              colorSpace: display,
              layoutScale,
              onContextLost: () => {
                if (!disposed) setSurface(null);
              },
            })
          : null;
      setSurface(active);
    }

    async function readDisplay() {
      const current = ++request;
      let result: WindowDisplayColorSpace | null;
      try {
        result = await bridge.window.getDisplayColorSpace();
      } catch {
        result = null;
      }
      if (current !== request || disposed) return;
      display = result;
      update();
    }

    const observer = new ResizeObserver(([entry]) => {
      const pixels = entry?.devicePixelContentBoxSize?.[0];
      const box = entry?.contentBoxSize?.[0];
      if (!pixels || !box) return;
      layoutScale = readHoverLayoutScale(
        container.getBoundingClientRect(),
        box,
        pixels,
        ownerDocument.defaultView?.devicePixelRatio ?? 0
      );
      update();
    });
    observer.observe(container, { box: 'device-pixel-content-box' });
    const offMove = bridge.on('window:move', readDisplay);
    const offResize = bridge.on('window:resize', readDisplay);
    void readDisplay();
    return () => {
      disposed = true;
      observer.disconnect();
      offMove();
      offResize();
      active?.dispose();
      setSurface(null);
    };
  }, [containerRef, enabled]);
  return surface;
}
